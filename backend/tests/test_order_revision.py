"""An unconfirmed order can change; approvals always apply to the latest full list."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_agent import FakeClient, chunk
from test_api import _drain_until, settings

from bluesword.agent import AgentSession
from bluesword.app import create_app
from bluesword.config import load_scene
from bluesword.domain import TaskLine
from bluesword.intents import confirmation_reply, revise_order


@pytest.mark.parametrize("text", ["嗯，再来一个薯片吧。", "可以再来一个薯片", "饼干不要了", "改成两包薯片", "可以吗", "好的，再拿一包薯片"])
def test_order_edits_are_never_implicit_approval(text):
    assert confirmation_reply(text) is None


@pytest.mark.parametrize("text,expected", [
    ("再来一个薯片吧。", [("oreo", 1), ("chips", 1)]),
    ("嗯，再来一个饼干", [("oreo", 2)]),
    ("改成两包薯片", [("chips", 2)]),
])
def test_explicit_edit_keeps_whole_order_limit(text, expected):
    _, items = load_scene()
    result = revise_order(text, [TaskLine(item_id="oreo")], items)
    assert [(line.item_id, line.count) for line in result] == expected


def test_invalid_or_ambiguous_edit_retains_original():
    _, items = load_scene()
    original = [TaskLine(item_id="oreo"), TaskLine(item_id="chips")]
    for text in ("再来一个薯片", "换成三包饼干", "再来一个可乐", "饼干换成薯片还是矿泉水", "薯片好吃吗",
                 "饼干改成薯片", "改成一个薯片和一个可乐"):
        with pytest.raises(ValueError):
            revise_order(text, original, items)
        assert original == [TaskLine(item_id="oreo"), TaskLine(item_id="chips")]
    assert revise_order("饼干不要了", original, items) == [TaskLine(item_id="chips")]
    with pytest.raises(ValueError, match="哪一种"):
        revise_order("再来一个", original, items)


def test_unnamed_addition_refers_to_the_only_product():
    _, items = load_scene()
    assert revise_order("再来一个", [TaskLine(item_id="chips")], items) == [TaskLine(item_id="chips", count=2)]
    assert revise_order("再来一个薯片", [TaskLine(item_id="oreo")], items) == [TaskLine(item_id="oreo"), TaskLine(item_id="chips")]


@pytest.mark.parametrize("use_model", [False, True])
def test_addition_updates_confirmation_and_dispatches_only_latest_order(monkeypatch, use_model):
    sessions = []
    if use_model:
        class ScriptedAgent:
            def __init__(self, manager):
                self.manager = manager

            def session(self, owner):
                client = FakeClient([
                    [chunk(call=(0, "order", "fetch_items", '{"items":[{"item_id":"oreo","count":1}]}'))],
                    [chunk(content="好了，拿好哦。")],
                ])
                session = AgentSession(client, self.manager.settings, self.manager, owner)
                sessions.append(session)
                return session

            async def close(self):
                pass

        monkeypatch.setattr("bluesword.app.create_agent", lambda settings, manager: ScriptedAgent(manager))
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "text_input", "text": "嗯，来一个饼干", "request_id": "editable"})
            first = _drain_until(ws, "confirm_request")
            assert "奥利奥 × 1" in first["target"]
            ws.send_json({"type": "text_input", "text": "嗯，再来一个薯片吧。"})
            assert _drain_until(ws, "confirm_closed")["reason"] == "updated"
            latest = _drain_until(ws, "confirm_request")
            assert latest["target"] == "奥利奥 × 1、薯片 × 1"
            assert latest["id"] != first["id"]
            assert not any(key.startswith("_") for key in latest)
            assert client.get("/api/tasks").json() == []
            # A stale click must not authorize the amended list. An excessive edit keeps it intact.
            ws.send_json({"type": "confirm_response", "id": first["id"], "approved": True})
            ws.send_json({"type": "text_input", "text": "再来一包薯片"})
            assert "最多拿两件" in _drain_until(ws, "assistant_delta")["text"]
            assert client.get("/api/tasks").json() == []
            ws.send_json({"type": "confirm_response", "id": latest["id"], "approved": True})
            _drain_until(ws, "confirm_closed")
            for _ in range(500):
                event = ws.receive_json()
                if event["type"] == "task" and event["task"]["status"] == "completed":
                    break
            else:
                pytest.fail("amended order did not finish")
            tasks = client.get("/api/tasks").json()
            assert len(tasks) == 1
            assert tasks[0]["items"] == [{"item_id": "oreo", "count": 1}, {"item_id": "chips", "count": 1}]
            if use_model:
                # Wait for the result to reach the model before checking its history.
                _drain_until(ws, "assistant_end")
                result = json.loads(next(message["content"] for message in sessions[0].history if message["role"] == "tool"))
                assert result["confirmed_items"] == tasks[0]["items"]
                assert result["order_updates"] == ["嗯，再来一个薯片吧。"]


def test_replacement_removal_and_reset_never_dispatch():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "text_input", "text": "一个饼干和一个薯片"})
            _drain_until(ws, "confirm_request")
            for text, expected in [("饼干不要了", "薯片 × 1"), ("改成两包饼干", "奥利奥 × 2")]:
                ws.send_json({"type": "text_input", "text": text})
                assert _drain_until(ws, "confirm_closed")["reason"] == "updated"
                latest = _drain_until(ws, "confirm_request")
                assert latest["target"] == expected
            ws.send_json({"type": "reset"})
            _drain_until(ws, "session_end")
            ws.send_json({"type": "confirm_response", "id": latest["id"], "approved": True})
            ws.send_json({"type": "text_input", "text": "你是谁"})
            _drain_until(ws, "assistant_end")
            assert client.get("/api/tasks").json() == []


def test_catalog_aliases_apply_to_pending_edits():
    catalog = Path(__file__).resolve().parents[2] / "config/booth-catalog.example.json"
    with TestClient(create_app(settings(catalog_path=str(catalog)))) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "text_input", "text": "来一个饼干"})
            assert "奥利奥饼干" in _drain_until(ws, "confirm_request")["target"]
            ws.send_json({"type": "text_input", "text": "再来一个薯片吧"})
            _drain_until(ws, "confirm_closed")
            assert _drain_until(ws, "confirm_request")["target"] == "奥利奥饼干 × 1、乐事薯片 × 1"
            ws.send_json({"type": "text_input", "text": "取消"})
            assert _drain_until(ws, "confirm_closed")["reason"] == "declined"
            assert client.get("/api/tasks").json() == []
