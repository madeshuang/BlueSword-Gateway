import json

import httpx
import pytest
from fastapi.testclient import TestClient
from test_agent import FakeClient, chunk
from test_api import _drain_until, settings

from bluesword import speech
from bluesword.agent import AgentSession, dangling_promise
from bluesword.app import create_app
from bluesword.config import Settings, load_scene
from bluesword.domain import TaskLine
from bluesword.intents import confirmation_reply, resolve, revise_order
from bluesword.language import language_of
from bluesword.wake import command_text


@pytest.mark.parametrize("text", ["Yes.", "YES, PLEASE!", "Confirm", "go ahead", "Sure", "Okay"])
def test_english_approval_is_explicit(text):
    assert confirmation_reply(text) is True


@pytest.mark.parametrize("text", ["No.", "No, thanks!", "Cancel", "No, cancel.", "Please cancel", "not now"])
def test_english_decline(text):
    assert confirmation_reply(text) is False


@pytest.mark.parametrize("text", ["Yes?", "yes, add chips", "yes but only one", "sure, change it to water",
                                   "okay, cancel the water", "don't confirm", "yes if it is free"])
def test_qualifications_never_approve(text):
    assert confirmation_reply(text) is None


@pytest.mark.parametrize("text,expected", [
    ("Hello, Blue! Bring me water.", "Bring me water."), ("HELLO BLUE.", ""),
    ("你好，布鲁，拿瓶水", "拿瓶水"), ("Hello blueberry", "Hello blueberry"),
])
def test_wake_prefix_preserves_commands(text, expected):
    assert command_text(text) == expected


@pytest.mark.parametrize("text,expected", [("Can I have 矿泉水?", "en"), ("帮我拿Oreo", "zh"),
                                           ("请用英文回复", "en"), ("Chinese please", "zh")])
def test_reply_language(text, expected):
    assert language_of(text) == expected
    assert language_of("2", "en") == "en"


@pytest.mark.parametrize("text,expected", [
    ("Yes, add one pack of chips.", [("water", 1), ("chips", 1)]),
    ("Change it to two bottles of water.", [("water", 2)]),
    ("Actually, make it two.", [("water", 2)]),
    ("One more, please.", [("water", 2)]),
    ("Replace it with one pack of Oreo cookies.", [("oreo", 1)]),
])
def test_english_pending_edits(text, expected):
    _, items = load_scene()
    result = revise_order(text, [TaskLine(item_id="water")], items)
    assert [(line.item_id, line.count) for line in result] == expected


@pytest.mark.parametrize("text", ["Add two packs of chips", "Change it to three waters", "Add coffee",
                                   "Change it to one water and one coffee", "Add zero chips",
                                   "Add water or chips", "Don't add chips", "Add a dozen chips"])
def test_invalid_english_edit_retains_current_order(text):
    _, items = load_scene()
    current = [TaskLine(item_id="water")]
    with pytest.raises(ValueError):
        revise_order(text, current, items)
    assert current == [TaskLine(item_id="water")]


def test_remove_and_ambiguous_shorthand():
    _, items = load_scene()
    current = [TaskLine(item_id="water"), TaskLine(item_id="chips")]
    assert revise_order("Remove chips", current, items) == [current[0]]
    with pytest.raises(ValueError):
        revise_order("one more", current, items)
    assert resolve("Could you bring me a bottle of water?", items).items == [TaskLine(item_id="water")]
    order = resolve("Please bring me two bottles of water.", items)
    assert order.items == [TaskLine(item_id="water", count=2)]
    assert resolve("please stop", items).kind == "cancel"


@pytest.mark.parametrize("use_model", [False, True])
def test_english_order_edit_stale_confirmation_and_single_dispatch(monkeypatch, use_model):
    if use_model:
        class Agent:
            def __init__(self, manager):
                self.manager = manager

            def session(self, owner):
                return AgentSession(FakeClient([
                    [chunk(call=(0, "fetch", "fetch_items", '{"items":[{"item_id":"water","count":1}]}'))],
                    [chunk(content="Your order has been delivered.")],
                ]), self.manager.settings, self.manager, owner)

            async def close(self):
                pass
        monkeypatch.setattr("bluesword.app.create_agent", lambda _settings, manager: Agent(manager))
    with TestClient(create_app(settings())) as client, client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "text_input", "text": "Bring me one bottle of water.", "request_id": "english-order"})
        first = _drain_until(ws, "confirm_request")
        assert first["language"] == "en" and first["target"] == "bottled water × 1"
        assert "Allow Blue" in first["message"]
        ws.send_json({"type": "text_input", "text": "Yes, add one pack of chips."})
        assert _drain_until(ws, "confirm_closed")["reason"] == "updated"
        latest = _drain_until(ws, "confirm_request")
        assert latest["target"] == "bottled water × 1, potato chips × 1"
        assert client.get("/api/tasks").json() == []
        ws.send_json({"type": "confirm_response", "id": first["id"], "approved": True})
        ws.send_json({"type": "text_input", "text": "Add one more pack of chips."})
        _drain_until(ws, "assistant_delta")
        assert client.get("/api/tasks").json() == []
        ws.send_json({"type": "text_input", "text": "Yes, please."})
        assert _drain_until(ws, "confirm_closed")["reason"] == "approved"
        for _ in range(500):
            event = ws.receive_json()
            if event["type"] == "task" and event["task"]["status"] == "completed":
                break
        else:
            pytest.fail("English order did not finish")
        tasks = client.get("/api/tasks").json()
        assert len(tasks) == 1
        assert tasks[0]["items"] == [{"item_id": "water", "count": 1}, {"item_id": "chips", "count": 1}]


def test_english_no_cancels_without_dispatch():
    with TestClient(create_app(settings())) as client, client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "text_input", "text": "Bring me water."})
        _drain_until(ws, "confirm_request")
        ws.send_json({"type": "text_input", "text": "No, cancel."})
        assert _drain_until(ws, "confirm_closed")["reason"] == "declined"
        assert "cancelled" in _drain_until(ws, "assistant_delta")["text"]
        assert client.get("/api/tasks").json() == []


@pytest.mark.parametrize("text,language", [("Hello, your water is ready.", "English"),
                                           ("水拿到了，请接稳。", "Chinese"), ("这是你的 Oreo。", "Auto")])
async def test_tts_uses_reply_language(monkeypatch, text, language):
    def respond(request):
        assert json.loads(request.content)["input"]["language_type"] == language
        return httpx.Response(200, content=b"RIFFtest", headers={"content-type": "audio/wav"})
    original = httpx.AsyncClient
    monkeypatch.setattr(speech.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond)))
    assert await speech.synthesize(text, Settings(speech_api_key="test")) == b"RIFFtest"


async def test_agent_language_can_switch_and_opening_line_is_english(make_manager):
    manager = await make_manager(split_skills=False)
    client = FakeClient([
        [chunk(call=(0, "fetch", "fetch_items", '{"items":[{"item_id":"water","count":1}]}'))],
        [chunk(content="Okay, cancelled.")], [chunk(content="你好！")],
    ])
    session = AgentSession(client, manager.settings, manager, "english-test")
    events, plans = [], []
    async def decline(plan):
        plans.append(plan)
        return False
    await session.turn("Bring me a bottle of water.", events.append, decline)
    assert plans[0]["language"] == "en"
    assert 'Say "yes"' in next(e["text"] for e in events if e["type"] == "assistant_delta")
    assert "必须使用英语" in client.requests[0]["messages"][0]["content"]
    await session.turn("请用中文回复", events.append, decline)
    assert "本轮请用简体中文" in client.requests[-1]["messages"][0]["content"]
    assert dangling_promise("I'll bring you water. Tap Confirm.", manager.items)
    assert not dangling_promise("Would you like me to bring you water?", manager.items)
