"""Malformed external responses use fallback without executing unconfirmed orders."""
import asyncio
import json

import httpx
import pytest
from openai import AsyncOpenAI
from test_agent import FakeStream, chunk
from test_llm_fallback import Client

from bluesword.agent import AgentSession
from bluesword.config import Settings
from bluesword.domain import TaskLine
from bluesword.llm import ModelRouter


def sdk_client(payloads, *, stream=False):
    pending = iter(payloads)
    def respond(request):
        body = next(pending)
        if stream:
            frames = [{'id': 'shape-test', 'object': 'chat.completion.chunk', 'created': 0,
                       'model': 'synthetic', **part} for part in body]
            data = ''.join('data: ' + json.dumps(part) + '\n\n' for part in frames) + 'data: [DONE]\n\n'
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, text=data)
        return httpx.Response(200, json={'id': 'shape-test', 'object': 'chat.completion',
                                       'created': 0, 'model': 'synthetic', **body})
    return AsyncOpenAI(api_key='synthetic', base_url='https://synthetic.invalid', max_retries=0,
                       http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))


@pytest.mark.parametrize("bad", [
    {"choices": None}, {"choices": {}}, {"choices": [None]},
    {"choices": [{"index": 0, "delta": None, "finish_reason": "stop"}]},
    *[{"choices": [{"index": 0, "delta": delta, "finish_reason": "tool_calls"}]} for delta in [
        {"content": []}, {"reasoning_content": {}}, {"tool_calls": {}},
        *[{"tool_calls": [{"index": index, "id": "invalid-index-order", "function": {
            "name": "fetch_items", "arguments": '{"items":[{"item_id":"water","count":1}]}'}}]} for index in [-1, "invalid-index"]],
        {"tool_calls": [{"index": 0, "id": []}]},
        {"tool_calls": [{"index": 0, "function": []}]},
        {"tool_calls": [{"index": 0, "function": {"name": [], "arguments": {}}}]},
    ]],
])
async def test_invalid_stream_falls_back_to_visible_reply_without_confirmation(make_manager, bad):
    manager = await make_manager()
    primary = sdk_client([[bad]], stream=True)
    backup = Client([FakeStream([chunk(content='备用完整回复')])])
    router = ModelRouter(Settings(llm_primary_budget=3, llm_idle_timeout=2), {'deepseek': primary, 'qwen': backup})
    session = AgentSession(primary, router.settings, manager, 'shape-session', router)
    events, confirmations = [], []
    async def confirm(plan):
        confirmations.append(plan)
        return True
    try:
        await session.turn('你好', events.append, confirm)
        assert any(e['type'] == 'assistant_delta' and e['text'] == '备用完整回复' for e in events)
        assert sum(e['type'] == 'assistant_abort' for e in events) == 1
        assert len(backup.requests) == 1 and not confirmations
        assert router.reason == 'deepseek: InvalidOutput'
        assert not manager.store.recent()
    finally:
        await router.close()


@pytest.mark.parametrize("bad", [
    {"choices": None}, {"choices": []}, {"choices": {}}, {"choices": {"0": {"message": {"content": "wrong shape"}}}}, {"choices": [None]},
    {"choices": [{"index": 0, "message": None}]},
    {"choices": [{"index": 0, "message": {"role": "assistant", "content": []}}]},
])
async def test_invalid_pending_falls_back_without_changing_or_approving_order(make_manager, bad):
    manager = await make_manager()
    primary = sdk_client([bad])
    backup = sdk_client([{'choices': [{'index': 0, 'finish_reason': 'stop',
                         'message': {'role': 'assistant', 'content': '{"kind":"reply","reply":"请问换哪件？"}'}}]}])
    router = ModelRouter(Settings(llm_primary_budget=3, llm_idle_timeout=2), {'deepseek': primary, 'qwen': backup})
    session = AgentSession(primary, router.settings, manager, 'shape-session', router)
    original = [TaskLine(item_id='water')]
    try:
        result = await session.interpret_pending('换个口味', original, [])
        assert result.kind == 'reply' and result.reply == '请问换哪件？'
        assert original == [TaskLine(item_id='water')]
        assert not manager.store.recent()
    finally:
        await router.close()


async def test_malformed_probe_keeps_recovering_then_switches_new_responses_back():
    ok = {'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': 'OK'}}]}
    primary = sdk_client([{'choices': [{'index': 0, 'message': None}]}, ok, ok])
    router = ModelRouter(Settings(llm_cooldown=0.01, llm_primary_budget=3), {'deepseek': primary, 'qwen': Client([])})
    router.failed('deepseek', httpx.ReadTimeout('Synthetic outage'))
    try:
        assert router.selected() == 'qwen'
        await asyncio.wait_for(asyncio.shield(router.probe_task), 2)
        assert router.selected() == 'deepseek' and router.status()['recovery_successes'] == 2
    finally:
        # Close is part of the expected public behavior, even after a malformed probe.
        await router.close()
        assert primary.is_closed()


async def test_valid_empty_reasoning_and_fragmented_tool_chunks_keep_primary(make_manager):
    manager = await make_manager(split_skills=False)
    def frame(delta, finish=None):
        return {'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
    primary = sdk_client([
        [{'choices': []}, frame({'role': 'assistant', 'content': ''}), frame({}),
         frame({'reasoning_content': '核对物品。'}),
         frame({'tool_calls': [{'index': 0, 'id': 'one-order', 'type': 'function',
                'function': {'name': 'fetch_items', 'arguments': '{"items":['}}]}),
         frame({'tool_calls': [{'index': 0, 'function': {'arguments': '{"item_id":"water","count":1}]}'}}]}),
         frame({}, 'tool_calls'), {'choices': []}],
        [frame({'content': '好的，这次不取。'}), frame({}, 'stop')],
    ], stream=True)
    backup = Client([])
    router = ModelRouter(Settings(llm_primary_budget=3, llm_idle_timeout=2), {'deepseek': primary, 'qwen': backup})
    session = AgentSession(primary, router.settings, manager, 'valid-stream', router)
    events, confirmations = [], []
    async def deny(plan):
        confirmations.append(plan)
        return False
    try:
        await session.turn('拿一瓶水', events.append, deny)
        assert len(confirmations) == 1 and not manager.store.recent()
        assert not backup.requests and router.selected() == 'deepseek'
        assert any(e['type'] == 'assistant_delta' and e['text'] == '好的，这次不取。' for e in events)
        assert not any(e['type'] == 'assistant_abort' for e in events)
    finally:
        await router.close()
