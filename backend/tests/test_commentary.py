import asyncio
import time
from types import SimpleNamespace as NS

import httpx
import pytest

from bluesword.agent import AgentSession
from bluesword.commentary import TaskCommentary, task_note
from bluesword.config import Settings, load_scene
from bluesword.domain import TaskLine, TaskRecord, TaskStep
from bluesword.service import EventBus
from bluesword.vlm import Progress, apply_progress


@pytest.fixture
def order():
    return TaskRecord(id="task", request_id="request", item_id="water", title="水和薯片",
                      created_at=time.time(), items=[TaskLine(item_id="water"), TaskLine(item_id="chips")],
                      steps=[TaskStep(id="plan", label="下发任务", status="done")])


def report(task, stage, index, pick, **extra):
    apply_progress(task, Progress.model_validate({
        "taskId": task.id, "stage": stage, "stageIndex": index,
        "stageTotal": 3 * sum(line.count for line in task.items) + 2,
        "pickIndex": pick, "message": "这是机器人自由文本，不可作为判断依据", **extra,
    }))


def test_names_follow_recognition_not_order_and_missing_results_stay_unknown(order):
    _, items = load_scene()
    report(order, "target_located", 2, 1, detection={"item": "chips", "label": "薯片", "attempt": 1})
    assert task_note(order, items).text == "找到薯片了，接下来拿稳。"
    report(order, "grasped", 3, 1)
    note = task_note(order, items)
    assert note.text == "薯片拿到了，另一件还在等结果。"
    assert note.facts["grasped_count"] == 1
    report(order, "at_delivery", 7, 0)
    assert task_note(order, items).text == "到交付处了，数量还需要核对。"
    report(order, "placed", 8, 0)
    assert "最后确认" in task_note(order, items).text
    order.status, order.recovery_required, order.completion_note = "completed", True, "数量待现场核对"
    assert task_note(order, items).text == "取送结束了，数量还需要现场核对。"
    assert not task_note(order, items).rewrite


def test_same_item_needs_two_distinct_grasps_and_unknown_name_is_not_guessed(order):
    _, items = load_scene()
    order.items = [TaskLine(item_id="water", count=2)]
    report(order, "grasped", 3, 1)
    note = task_note(order, items)
    assert note.text == "一件拿到了，另一件还在等结果。"
    assert note.facts["current_item"] is None
    report(order, "grasped", 6, 2)
    assert task_note(order, items).text == "两件都拿到了，接下来等交付。"
    assert task_note(order, items, "en").text == "Both items are held. Waiting for delivery."


def test_retry_does_not_invent_failure_cause(order):
    _, items = load_scene()
    report(order, "target_located", 2, 1, detection={"item": "chips", "label": "薯片", "attempt": 2})
    assert task_note(order, items).text == "正在重新识别，等这次的抓取结果。"
    order.status = "failed"
    assert not task_note(order, items).rewrite
    assert "现场同事" in task_note(order, items).text


class DelayedModel:
    def __init__(self, *, ignore_cancel=False, fail=False):
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.ignore_cancel, self.fail = ignore_cancel, fail
        self.requests = []
        self.text = "找到薯片了，接下来拿稳。"
        self.chat = NS(completions=NS(create=self.create))

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            if not self.ignore_cancel:
                raise
            await self.release.wait()
        if self.fail:
            raise RuntimeError("controlled model outage")
        return NS(choices=[NS(message=NS(content=self.text))])


async def test_new_progress_and_terminal_result_win_over_late_model(order):
    _, items = load_scene()
    manager = NS(bus=EventBus(), items=items, active=order)
    model, events = DelayedModel(ignore_cancel=True), []
    async with TaskCommentary(manager, model, Settings(), "request", "zh", "拿水和薯片", events.append) as notes:
        report(order, "target_located", 2, 1, detection={"item": "chips", "label": "薯片", "attempt": 1})
        notes.update(order)
        await model.started.wait()
        # Transport/state updates continue while the model is blocked.
        report(order, "placed", 8, 0)
        notes.update(order)
        order.status = "completed"
        order.recovery_required, order.completion_note = True, "数量待核对"
        notes.update(order)
        before = len(events)
        model.release.set()
        await asyncio.gather(*notes.writers)
        assert len(events) == before
        assert events[-1]["text"] == "取送结束了，数量还需要现场核对。"
    assert manager.bus.subscribers == set()
    assert all("tools" not in r for r in model.requests)
    assert "自由文本" not in str(model.requests)


async def test_wait_reminder_once_duplicate_does_not_clear_it_and_new_progress_resumes(order, monkeypatch):
    import bluesword.commentary as module
    monkeypatch.setattr(module, "WAIT_SECONDS", 0.02)
    _, items = load_scene()
    manager = NS(bus=EventBus(), items=items, active=order)
    model, events = DelayedModel(), []
    async with TaskCommentary(manager, model, Settings(), "request", "zh", "拿水", events.append) as notes:
        notes.update(order)
        # Feed through the actual subscriber so it can schedule the no-progress reminder.
        manager.bus.emit({"type": "task", "task": order.model_dump()})
        async with asyncio.timeout(1):
            while not any("新的进度" in e["text"] for e in events):
                await asyncio.sleep(0.005)
        count = len(events)
        notes.update(order)
        await asyncio.sleep(0.04)
        assert len(events) == count
        report(order, "arrived_shelf", 1, 1)
        notes.update(order)
        assert events[-1]["text"] == "到货架了，接下来找目标物品。"
        assert model.requests == []


async def test_model_failure_keeps_fact_note_and_ignores_other_orders(order):
    _, items = load_scene()
    manager = NS(bus=EventBus(), items=items, active=order)
    model, events = DelayedModel(fail=True), []
    model.release.set()
    async with TaskCommentary(manager, model, Settings(), "request", "zh", "拿薯片", events.append) as notes:
        notes.update(order.model_copy(update={"request_id": "another-request"}))
        assert not events
        report(order, "target_located", 2, 1)
        notes.update(order)
        await asyncio.gather(*notes.writers)
        assert len(events) == 1 and events[0]["source"] == "facts"


async def test_model_reply_is_bounded_and_keeps_facts_on_timeout(order, monkeypatch):
    import bluesword.commentary as module
    monkeypatch.setattr(module, "REWRITE_SECONDS", 0.02)
    _, items = load_scene()
    manager = NS(bus=EventBus(), items=items, active=order)
    model, events = DelayedModel(), []
    async with TaskCommentary(manager, model, Settings(), "request", "zh", "拿薯片", events.append) as notes:
        report(order, "target_located", 2, 1)
        notes.update(order)
        await asyncio.gather(*notes.writers)
        assert len(events) == 1 and events[0]["source"] == "facts"
        model.release.set()
        model.text = "一件拿到了，另一件还没确认。"
        report(order, "grasped", 3, 1)
        notes.update(order)
        await asyncio.gather(*notes.writers)
        assert events[-1]["source"] == "model"
        assert model.requests[-1]["extra_body"] == {"thinking": {"type": "disabled"}}
    assert manager.bus.subscribers == set()


async def test_agent_order_comments_before_finish_without_extra_dispatch(make_manager):
    manager = await make_manager(robot_mode="lanjian_http", robot_protocol="vlm", split_skills=False,
                                 robot_dispatch_url="http://robot.test/api/task/dispatch")
    sent, events = [], []
    accepted = asyncio.Event()

    def respond(request):
        if request.url.path.endswith("health"):
            return httpx.Response(200, json={"success": True, "busy": False})
        sent.append(request)
        accepted.set()
        return httpx.Response(200, json={"success": True})

    await manager.bundle.robot.client.aclose()
    manager.bundle.robot.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    model = DelayedModel()
    session = AgentSession(model, manager.settings, manager, "test")
    session.request_id = "one-order"
    running = asyncio.create_task(session._tool("fetch_items", {"items": [{"item_id": "water", "count": 1}]},
                                                events.append, "拿一瓶水"))
    await accepted.wait()
    task = manager.active
    report(task, "target_located", 2, 1)
    manager.bus.emit({"type": "task", "task": task.model_dump()})
    await model.started.wait()
    assert events and not running.done()
    manager.remote_inbox.put_nowait(("finished", {"taskId": task.id, "result": "success"}))
    result = await asyncio.wait_for(running, 1)
    assert result["status"] == "completed"
    assert len(sent) == 1
    assert events[-1]["text"] == "送到了，请到交付处领取。"
    assert manager.bus.subscribers == set()
