"""Fault injection at generation boundaries; all robot execution is in-memory mock."""
import asyncio
import json
import time
from types import SimpleNamespace as NS

import httpx
import pytest
from openai import APIStatusError, AsyncOpenAI
from test_agent import FakeStream, chunk

from bluesword.agent import AgentSession
from bluesword.config import Settings
from bluesword.domain import TaskLine
from bluesword.llm import ModelRouter, ModelUnavailable, ResponseBudget
from bluesword.order_dialogue import apply_decision

ORDER = '{"items":[{"item_id":"water","count":1}]}'


class BrokenStream:
    def __init__(self, prefix=(), keepalive=False, eof=False):
        self.prefix, self.keepalive, self.eof, self.closed = prefix, keepalive, eof, False

    def __aiter__(self):
        return self.generate()

    async def generate(self):
        for value in self.prefix:
            yield value
        if self.eof:
            return
        while self.keepalive:
            await asyncio.sleep(0.005)
            yield NS(choices=[])
        await asyncio.sleep(10)

    async def close(self):
        self.closed = True


class Client:
    def __init__(self, responses):
        self.responses, self.requests = list(responses), []
        self.chat = NS(completions=NS(create=self.create))

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def close(self):
        pass


def options(**kwargs):
    return Settings(llm_idle_timeout=0.03, llm_primary_budget=0.1, llm_cooldown=60, **kwargs)


@pytest.mark.parametrize("failure", ["first", "keepalive", "reasoning", "content", "arguments", "eof", "http"])
async def test_incomplete_attempt_is_aborted_before_single_confirmation(make_manager, failure):
    manager = await make_manager(split_skills=False)
    prefix = {
        "reasoning": [chunk(reasoning="思考到一半")],
        "content": [chunk(content="我准备拿")],
        "arguments": [chunk(call=(0, "partial", "fetch_items", '{"items":['))],
        "eof": [chunk(call=(0, "partial", "fetch_items", ORDER))],
    }.get(failure, [])
    broken = BrokenStream(prefix, keepalive=failure == "keepalive", eof=failure == "eof")
    failed = APIStatusError("unavailable", response=httpx.Response(503, request=httpx.Request("POST", "https://test")), body=None)
    primary = Client([failed if failure == "http" else broken])
    backup = Client([FakeStream([chunk(reasoning="确认所需物品。"), chunk(call=(0, "ready", "fetch_items", ORDER))]),
                     FakeStream([chunk(content="好的，这次不取。")])])
    router = ModelRouter(options(), {"deepseek": primary, "qwen": backup})
    session = AgentSession(primary, router.settings, manager, "test", router)
    events, confirmations = [], []

    async def deny(plan):
        confirmations.append(plan)
        return False

    try:
        await session.turn("一瓶水", events.append, deny, "request-once")
        assert len(confirmations) == 1 and not manager.store.recent()
        aborted = next(e["id"] for e in events if e["type"] == "assistant_abort")
        assert not any(e["type"] in {"assistant_end", "skill"} and e.get("id") == aborted for e in events)
        assert "partial" not in json.dumps(session.history)
        assert len(primary.requests) == 1
        assert backup.requests[0]["extra_body"] == {"enable_thinking": True, "reasoning_effort": "low"}
        if failure != "http":
            assert broken.closed
    finally:
        await router.close()


async def test_completed_read_tools_are_retained_when_next_generation_fails(make_manager):
    manager = await make_manager(split_skills=False)
    primary = Client([FakeStream([chunk(call=(0, "stock", "check_inventory", '{}'))]), BrokenStream()])
    backup = Client([FakeStream([chunk(call=(0, "order", "fetch_items", ORDER))]), FakeStream([chunk(content="取消了。")])])
    router = ModelRouter(options(), {"deepseek": primary, "qwen": backup})
    session = AgentSession(primary, router.settings, manager, "test", router)
    events = []

    async def deny(_plan):
        return False

    try:
        await session.turn("一瓶水", events.append, deny)
        tools = [m for m in backup.requests[0]["messages"] if m["role"] == "tool"]
        assert len(tools) == 1 and json.loads(tools[0]["content"])["stock"]["矿泉水"] == 3
        assert len([e for e in events if e["type"] == "skill" and e["name"] == "check_inventory" and e["status"] == "done"]) == 1
    finally:
        await router.close()


async def test_failure_after_dispatch_cannot_repeat_order(make_manager):
    manager = await make_manager(split_skills=False)
    primary = Client([FakeStream([chunk(call=(0, "first", "fetch_items", ORDER))]), BrokenStream()])
    backup = Client([FakeStream([chunk(call=(0, "duplicate", "fetch_items", ORDER))]), FakeStream([chunk(content="请看任务结果。")])])
    router = ModelRouter(options(), {"deepseek": primary, "qwen": backup})
    session = AgentSession(primary, router.settings, manager, "test", router)
    confirmations = []

    async def approve(plan):
        confirmations.append(plan)
        return True

    try:
        await session.turn("一瓶水", lambda e: None, approve, "same-request")
        assert len(confirmations) == 1 and len(manager.store.recent()) == 1
        assert manager.stock["water"] == 2
        prior = next(m for m in backup.requests[0]["messages"] if m["role"] == "tool")
        assert json.loads(prior["content"])["status"] == "completed"
    finally:
        await router.close()


async def test_confirmation_and_robot_execution_do_not_consume_model_budget(make_manager, monkeypatch):
    manager = await make_manager(split_skills=False)
    monkeypatch.setattr("bluesword.agent.ResponseBudget", lambda seconds, provider="": ResponseBudget(3.08, provider))
    primary = Client([FakeStream([chunk(call=(0, "first", "fetch_items", ORDER))]), FakeStream([chunk(content="已收到完成回报。")])])
    session = AgentSession(primary, options(), manager, "test")

    async def approve(_plan):
        await asyncio.sleep(0.12)
        return True

    await session.turn("一瓶水", lambda e: None, approve)
    assert manager.store.recent()[0].status == "completed"
    assert len(primary.requests) == 2


async def test_both_providers_share_one_deadline_and_close_streams(make_manager):
    manager = await make_manager()
    primary_stream, backup_stream = BrokenStream(keepalive=True), BrokenStream(keepalive=True)
    router = ModelRouter(options(), {"deepseek": Client([primary_stream]), "qwen": Client([backup_stream])})
    session = AgentSession(router.clients["deepseek"], router.settings, manager, "test", router)
    budget = ResponseBudget(3.05)
    started = time.monotonic()
    events = []
    try:
        with pytest.raises(ModelUnavailable):
            await session._stream_round([], events.append, budget=budget)
        assert time.monotonic() - started < 0.2
        assert primary_stream.closed and backup_stream.closed
        assert len([e for e in events if e["type"] == "assistant_abort"]) == 2
        assert not manager.store.recent()
    finally:
        await router.close()


async def test_pending_edit_falls_back_without_approval_or_order_change(make_manager):
    manager = await make_manager(split_skills=False)
    primary = Client([TimeoutError()])
    decision = {"kind": "edit", "edits": [{"action": "add", "item_id": "chips", "count": 1}]}
    backup = Client([NS(choices=[NS(message=NS(content=json.dumps(decision)))])])
    router = ModelRouter(options(), {"deepseek": primary, "qwen": backup})
    session = AgentSession(primary, router.settings, manager, "test", router)
    original = [TaskLine(item_id="water")]
    try:
        result = await session.interpret_pending("好，再加一包薯片", original, [])
        assert result.kind == "edit"
        assert [x.item_id for x in apply_decision(result, original, manager.items)] == ["water", "chips"]
        assert original == [TaskLine(item_id="water")] and not manager.store.recent()
    finally:
        await router.close()


async def test_cancelled_generation_does_not_start_backup(make_manager):
    manager = await make_manager()
    stream = BrokenStream([chunk(content="半句")])
    router = ModelRouter(options(), {"deepseek": Client([stream]), "qwen": Client([])})
    session = AgentSession(router.clients["deepseek"], router.settings, manager, "test", router)
    events = []
    task = asyncio.create_task(session._stream_round([], events.append))
    await asyncio.sleep(0.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed and not router.clients["qwen"].requests and not router.primary_open
    assert events[-1]["type"] == "assistant_abort"
    await router.close()


async def test_recovery_requires_two_probes_and_only_changes_new_responses():
    ok = NS(choices=[NS(message=NS(content="OK"))])
    primary = Client([ok, ok])
    router = ModelRouter(Settings(llm_cooldown=0.015), {"deepseek": primary, "qwen": Client([])})
    router.failed("deepseek", TimeoutError())
    current = ResponseBudget(20, provider=router.selected())
    try:
        await asyncio.sleep(0.022)
        assert router.primary_open and router.recovery_successes == 1
        await asyncio.sleep(0.022)
        assert router.selected() == "deepseek"
        assert current.provider == "qwen" and len(primary.requests) == 2
    finally:
        await router.close()


@pytest.mark.parametrize("status", [400, 422])
@pytest.mark.parametrize("provider", ["deepseek", "qwen"])
async def test_request_error_in_one_session_does_not_disable_other_sessions(make_manager, status, provider, caplog):
    manager = await make_manager()
    error = APIStatusError("private-prompt", response=httpx.Response(status, request=httpx.Request("POST", "https://test")),
                           body={"message": "private-prompt"})
    replies = [error, FakeStream([chunk(content="正常会话回复")])]
    primary = Client(replies if provider == "deepseek" else [])
    backup = Client(replies if provider == "qwen" else [FakeStream([chunk(content="本次备用回复")]),
                                                       FakeStream([chunk(content="不应影响下个会话")])])
    router = ModelRouter(options(llm_routing="auto" if provider == "deepseek" else "qwen"),
                         {"deepseek": primary, "qwen": backup})
    failed_session = AgentSession(primary, router.settings, manager, "bad-session", router)
    healthy_session = AgentSession(primary, router.settings, manager, "healthy-session", router)
    events = []
    try:
        if provider == "deepseek":
            result = await failed_session._stream_round([{"role": "user", "content": "合成错误请求"}], events.append)
            assert result[-1] == "本次备用回复"
        else:
            with pytest.raises(ModelUnavailable):
                await failed_session._stream_round([{"role": "user", "content": "合成错误请求"}], events.append)
        result = await healthy_session._stream_round([{"role": "user", "content": "你好"}], events.append)
        assert result[-1] == "正常会话回复"
        assert not router.blocked and not router.primary_open and router.probe_task is None
        assert len(router.clients[provider].requests) == 2
        assert "private-prompt" not in caplog.text + json.dumps(router.status())
        assert not manager.store.recent()
    finally:
        await router.close()


@pytest.mark.parametrize("status", [400, 422])
async def test_request_error_preserves_existing_recovery_state(status):
    router = ModelRouter(options(), {"deepseek": Client([]), "qwen": Client([])})
    router.failed("deepseek", TimeoutError())
    router.recovery_successes = 1
    before, task = router.status(), router.probe_task
    try:
        error = APIStatusError("invalid request", response=httpx.Response(status, request=httpx.Request("POST", "https://test")), body=None)
        router.failed("deepseek", error)
        assert router.status() == before and router.probe_task is task
    finally:
        await router.close()


@pytest.mark.parametrize("status", [400, 422])
async def test_request_error_in_probe_does_not_permanently_disable_recovery(status):
    error = APIStatusError("invalid request", response=httpx.Response(status, request=httpx.Request("POST", "https://test")), body=None)
    ok = NS(choices=[NS(message=NS(content="OK"))])
    primary = Client([error, ok, ok])
    router = ModelRouter(Settings(llm_cooldown=0.001), {"deepseek": primary, "qwen": Client([])})
    router.failed("deepseek", TimeoutError())
    try:
        await asyncio.wait_for(router.probe_task, timeout=1)
        assert router.selected() == "deepseek" and not router.blocked
        assert router.recovery_successes == 2 and len(primary.requests) == 3
    finally:
        await router.close()


@pytest.mark.parametrize("status", [401, 403, 404])
async def test_permission_error_is_not_probed_and_does_not_expose_body(status):
    router = ModelRouter(options(), {"deepseek": Client([]), "qwen": Client([])})
    error = APIStatusError("secret-key-and-prompt", response=httpx.Response(status, request=httpx.Request("POST", "https://test")), body=None)
    router.failed("deepseek", error)
    assert router.probe_task is None and router.selected() == "qwen"
    assert router.blocked == {"deepseek"}
    assert "secret" not in json.dumps(router.status())
    await router.close()


@pytest.mark.parametrize("backup", ["missing", "disabled", "blocked"])
async def test_primary_recovers_on_next_request_without_usable_backup(make_manager, backup):
    manager = await make_manager()
    primary = Client([TimeoutError(), FakeStream([chunk(content="正常回复")])])
    clients = {"deepseek": primary}
    if backup == "blocked":
        clients["qwen"] = Client([])
    router = ModelRouter(options(llm_fallback_enabled=backup != "disabled"), clients)
    if backup == "blocked":
        router.blocked.add("qwen")
    try:
        first = AgentSession(primary, router.settings, manager, "first", router)
        with pytest.raises(ModelUnavailable):
            await first._stream_round([], lambda e: None)
        second = AgentSession(primary, router.settings, manager, "second", router)
        result = await second._stream_round([], lambda e: None)
        assert result[-1] == "正常回复" and len(primary.requests) == 2
    finally:
        await router.close()


@pytest.mark.parametrize("status", [401, 403, 404])
@pytest.mark.parametrize("in_flight", [False, True])
async def test_config_error_stops_existing_probe_and_ignores_late_success(status, in_flight):
    entered, cancelled = asyncio.Event(), asyncio.Event()
    calls = []

    class ProbeClient:
        async def create(self, **kwargs):
            calls.append(kwargs)
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                # Simulate a transport that returns a buffered result during cancellation.
                return NS(choices=[NS(message=NS(content="OK"))])

        async def close(self):
            pass

    primary = ProbeClient()
    primary.chat = NS(completions=primary)
    router = ModelRouter(Settings(llm_cooldown=0.001 if in_flight else 60),
                         {"deepseek": primary, "qwen": Client([])})
    router.failed("deepseek", TimeoutError())
    try:
        if in_flight:
            await asyncio.wait_for(entered.wait(), 1)
            router.recovery_successes = 1
        error = APIStatusError("synthetic", response=httpx.Response(status, request=httpx.Request("POST", "https://test")), body=None)
        router.failed("deepseek", error)
        # Yield to cancellation without timing out or cancelling the probe ourselves.
        for _ in range(5):
            await asyncio.sleep(0)
        assert router.probe_task.done()
        assert len(calls) == int(in_flight)
        assert cancelled.is_set() == in_flight
        assert router.primary_open and router.blocked == {"deepseek"}
        assert router.recovery_successes == 0 and router.retry_at == 0
        assert f"HTTP {status}" in router.status()["reason"]
        router.failed("deepseek", TimeoutError())
        assert f"HTTP {status}" in router.status()["reason"]
    finally:
        await router.close()


@pytest.mark.parametrize("status", [400, 422])
async def test_rejected_history_does_not_poison_next_turn(make_manager, status):
    manager = await make_manager()

    class ContextClient(Client):
        async def create(self, **kwargs):
            self.requests.append(kwargs)
            if any("被拒绝的历史" in (m.get("content") or "") for m in kwargs["messages"]):
                raise APIStatusError("synthetic context rejection", response=httpx.Response(status,
                    request=httpx.Request("POST", "https://test")), body=None)
            return FakeStream([chunk(content="你好，欢迎。")])

    primary = ContextClient([])
    router = ModelRouter(options(), {"deepseek": primary})
    session = AgentSession(primary, router.settings, manager, "test", router)

    async def no_confirm(_plan):
        pytest.fail("No action was requested")

    try:
        with pytest.raises(ModelUnavailable):
            await session.turn("被拒绝的历史", lambda e: None, no_confirm)
        events = []
        await session.turn("你好", events.append, no_confirm)
        assert any(e.get("text") == "你好，欢迎。" for e in events)
        assert len(primary.requests) == 2 and not manager.store.recent()
    finally:
        await router.close()


async def test_context_repair_keeps_completed_order_fact_without_reexecution(make_manager):
    manager = await make_manager(split_skills=False)
    error = APIStatusError("synthetic context rejection", response=httpx.Response(400,
        request=httpx.Request("POST", "https://test")), body=None)
    primary = Client([FakeStream([chunk(call=(0, "order", "fetch_items", ORDER))]), error,
                      FakeStream([chunk(content="机器人已经完成上一单。")])])
    router = ModelRouter(options(), {"deepseek": primary})
    session = AgentSession(primary, router.settings, manager, "test", router)
    confirmations = []
    execute = session._tool

    async def uncertain_quantity(name, args):
        result = await execute(name, args)
        result.update(ok=False, recovery_required=True, completion_note="synthetic-private-detail: 数量尚需核对")
        return result

    session._tool = uncertain_quantity

    async def approve(plan):
        confirmations.append(plan)
        return True

    try:
        with pytest.raises(ModelUnavailable):
            await session.turn("一瓶水", lambda e: None, approve, "already-dispatched")
        assert session.order_attempted
        await session.turn("上一单怎么样了", lambda e: None, approve)
        history = primary.requests[-1]["messages"]
        assert not any(m.get("tool_calls") or m["role"] == "tool" for m in history)
        content = json.dumps(history, ensure_ascii=False)
        assert "completed" in content and "water" in content
        assert '"completion_note": "数量待现场核对"' in "".join(m.get("content") or "" for m in history)
        assert "synthetic-private-detail" not in content
        assert len(confirmations) == 1 and len(manager.store.recent()) == 1 and manager.stock["water"] == 2
    finally:
        await router.close()


async def test_pending_context_repair_preserves_open_confirmation_and_current_order(make_manager):
    manager = await make_manager(split_skills=False)
    error = APIStatusError("synthetic context rejection", response=httpx.Response(400,
        request=httpx.Request("POST", "https://test")), body=None)
    decision = NS(choices=[NS(message=NS(content='{"kind":"reply","reply":"原清单保留。"}'))])
    primary = Client([FakeStream([chunk(call=(0, "order", "fetch_items", ORDER))]), error, decision,
                      FakeStream([chunk(content="已完成。")])])
    router = ModelRouter(options(), {"deepseek": primary})
    session = AgentSession(primary, router.settings, manager, "test", router)

    async def approve(plan):
        discussion = [{"role": "user", "content": "被拒绝的历史"}]
        history = json.dumps(session.history)
        current = [TaskLine(**line) for line in plan["_items"]]
        with pytest.raises(ModelUnavailable):
            await session.interpret_pending("它什么口味", current, discussion)
        # The waiting turn still owns an open tool call; do not remove it mid-confirmation.
        assert json.dumps(session.history) == history
        assert (await session.interpret_pending("保留水，问一下规格", current, discussion)).kind == "reply"
        payload = json.loads(primary.requests[-1]["messages"][-1]["content"])
        assert payload["current_order"] == [{"item_id": "water", "count": 1}]
        assert payload["discussion"] == []
        return True

    try:
        await session.turn("一瓶水", lambda e: None, approve, "pending-context")
        history = primary.requests[-1]["messages"]
        assert not any(m["role"] == "tool" for m in history)
        assert "completed" in json.dumps(history)
        assert len(manager.store.recent()) == 1
    finally:
        await router.close()


async def test_primary_time_is_cumulative_across_tool_rounds():
    router = ModelRouter(Settings(llm_primary_budget=0.05), {"deepseek": Client([]), "qwen": Client([])})
    budget, calls = ResponseBudget(20), []

    async def generate(provider):
        calls.append(provider)
        if provider == "deepseek":
            await asyncio.sleep(0.03)
        return provider

    try:
        assert await router.run(budget, generate) == "deepseek"
        assert await router.run(budget, generate) == "qwen"
        assert calls == ["deepseek", "deepseek", "qwen"]
        assert router.selected() == "deepseek" and not router.primary_open
        assert router.probe_task is None and not router.reason
    finally:
        await router.close()


async def test_progressing_stream_budget_switch_only_affects_current_response(make_manager):
    manager = await make_manager()

    class ProgressStream(BrokenStream):
        async def generate(self):
            while True:
                yield chunk(reasoning="仍在思考")
                await asyncio.sleep(0.005)

    stream = ProgressStream()
    primary = Client([stream, FakeStream([chunk(content="下一位访客的回复")])])
    backup = Client([FakeStream([chunk(content="备用完成回复")]),
                     FakeStream([chunk(content="本轮继续由备用回复")])])
    router = ModelRouter(Settings(llm_primary_budget=0.04, llm_idle_timeout=0.5),
                         {"deepseek": primary, "qwen": backup})
    first = AgentSession(primary, router.settings, manager, "first", router)
    budget, events = ResponseBudget(20), []
    try:
        assert (await first._stream_round([], events.append, budget=budget))[-1] == "备用完成回复"
        assert stream.closed
        assert len([e for e in events if e["type"] == "assistant_abort"]) == 1
        assert budget.provider == "qwen"
        assert not router.primary_open and router.probe_task is None and not router.reason
        assert (await first._stream_round([], events.append, budget=budget))[-1] == "本轮继续由备用回复"
        second = AgentSession(primary, router.settings, manager, "second", router)
        assert (await second._stream_round([], events.append))[-1] == "下一位访客的回复"
        assert len(primary.requests) == 2 and len(backup.requests) == 2
        assert not manager.store.recent()
    finally:
        await router.close()


@pytest.mark.parametrize("budget_kind", ["primary", "response"])
async def test_already_spent_budget_does_not_change_provider_health(budget_kind):
    router = ModelRouter(Settings(), {"deepseek": Client([]), "qwen": Client([])})
    budget, calls = ResponseBudget(20), []
    if budget_kind == "primary":
        budget.primary_used = router.settings.llm_primary_budget
    else:
        budget.deadline = time.monotonic() - 1

    async def generate(provider):
        calls.append(provider)
        return provider

    try:
        if budget_kind == "primary":
            assert await router.run(budget, generate) == "qwen"
            assert calls == ["qwen"]
        else:
            with pytest.raises(ModelUnavailable):
                await router.run(budget, generate)
            assert not calls
        assert router.selected() == "deepseek" and not router.primary_open
        assert router.probe_task is None and not router.reason and router.retry_at == 0
        assert await router.run(ResponseBudget(20), generate) == "deepseek"
    finally:
        await router.close()


@pytest.mark.parametrize("route", ["deepseek_only", "both", "qwen_during_recovery"])
async def test_response_deadline_preserves_shared_health_and_recovery(route):
    clients = {"deepseek": Client([])}
    if route != "deepseek_only":
        clients["qwen"] = Client([])
    router = ModelRouter(Settings(), clients)
    if route == "qwen_during_recovery":
        router.failed("deepseek", httpx.ReadError("Synthetic outage"))
        await asyncio.sleep(0)
        router.recovery_successes = 1
    before = (router.primary_open, router.reason, router.probe_task, router.retry_at,
              router.recovery_successes)
    calls = []

    async def generate(provider):
        calls.append(provider)
        await asyncio.Event().wait()

    try:
        with pytest.raises(ModelUnavailable):
            await router.run(ResponseBudget(3.03), generate)
        assert calls == ["qwen" if route == "qwen_during_recovery" else "deepseek"]
        assert (router.primary_open, router.reason, router.probe_task, router.retry_at,
                router.recovery_successes) == before
    finally:
        await router.close()


@pytest.mark.parametrize("failure", ["idle", "transport", "provider_timeout"])
async def test_service_timeouts_still_trigger_shared_cooldown(failure):
    router = ModelRouter(Settings(llm_timeout=0.03 if failure == "provider_timeout" else 90),
                         {"deepseek": Client([]), "qwen": Client([])})

    async def generate(provider):
        if provider == "qwen":
            return "backup"
        if failure == "idle":
            async with asyncio.timeout(0.01):
                await asyncio.Event().wait()
        elif failure == "transport":
            raise httpx.ReadTimeout("Synthetic transport timeout")
        else:
            await asyncio.Event().wait()

    try:
        assert await router.run(ResponseBudget(20), generate) == "backup"
        assert router.primary_open and router.selected() == "qwen"
        assert router.probe_task is not None and router.reason
    finally:
        await router.close()


async def test_real_sdk_drops_truncated_sse_before_backup(make_manager):
    manager = await make_manager()
    payload = {"id": "broken", "object": "chat.completion.chunk", "created": 0, "model": "test",
               "choices": [{"index": 0, "delta": {"content": "半句"}, "finish_reason": None}]}
    # HTTP ends cleanly but generation has no terminal finish_reason.
    transport = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"},
                                                                  text="data: " + json.dumps(payload) + "\n\n"))
    primary = AsyncOpenAI(api_key="synthetic", base_url="https://controlled.invalid/v1", max_retries=0,
                         http_client=httpx.AsyncClient(transport=transport))
    router = ModelRouter(options(), {"deepseek": primary, "qwen": Client([FakeStream([chunk(content="完整回复")])])})
    session = AgentSession(primary, router.settings, manager, "test", router)
    events = []
    try:
        result = await session._stream_round([{"role": "user", "content": "你好"}], events.append)
        assert result[-1] == "完整回复"
        assert len([e for e in events if e["type"] == "assistant_abort"]) == 1
        assert len(router.clients["qwen"].requests) == 1
    finally:
        await router.close()


async def test_read_query_timeout_does_not_switch_models_or_dispatch(make_manager, monkeypatch):
    manager = await make_manager(split_skills=False)
    monkeypatch.setattr("bluesword.agent.ResponseBudget", lambda seconds, provider="": ResponseBudget(3.05, provider))
    primary = Client([FakeStream([chunk(call=(0, "stock", "check_inventory", '{}'))])])
    backup = Client([])
    router = ModelRouter(options(), {"deepseek": primary, "qwen": backup})
    session = AgentSession(primary, router.settings, manager, "test", router)

    async def slow_read(*args):
        await asyncio.sleep(10)

    session._tool = slow_read
    events = []
    try:
        with pytest.raises(ModelUnavailable):
            await session.turn("查询库存", events.append, slow_read)
        assert not backup.requests and not manager.store.recent()
        assert any(e['type'] == 'skill' and e['status'] == 'failed' for e in events)
        assert any(e['type'] == 'assistant_end' for e in events)
        assert not any(m.get('tool_calls') for m in session.history)
    finally:
        await router.close()


def test_operator_model_status_is_authenticated_and_secret_free():
    from fastapi.testclient import TestClient

    from bluesword.app import create_app

    app = create_app(Settings(db_path=":memory:", operator_token="staff-only"))
    with TestClient(app) as client:
        assert client.get('/api/operator/llm').status_code == 403
        response = client.get('/api/operator/llm', headers={'X-Operator-Token': 'staff-only'})
        assert response.status_code == 200 and response.json()['provider'] == 'rules'
        assert 'staff-only' not in response.text
