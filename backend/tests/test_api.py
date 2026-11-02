import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bluesword.app import create_app
from bluesword.config import Settings, load_scene
from bluesword.drivers import create_bundle
from bluesword.intents import resolve


def settings(**overrides):
    return Settings(
        **(dict(catalog_path=str(Path(__file__).parent / "fixtures/geometry-catalog.json"), db_path=":memory:", mock_delay=0, motion_timeout=0.5, handover_timeout=0.2) | overrides)
    )


def test_websocket_frontend_contract_full_task():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "device"
            backend = ws.receive_json()
            assert backend["mode"] == "mock"
            assert backend["glossary"]["pick_item"] == "取货" and backend["glossary"]["yogurt"] == "安慕希"
            assert ws.receive_json()["type"] == "phase"
            ws.send_json({"type": "text_input", "text": "帮我拿一瓶矿泉水", "request_id": "ws-one"})
            seen = []
            for _ in range(200):
                event = ws.receive_json()
                seen.append(event)
                if event["type"] == "confirm_request":
                    assert "矿泉水" in event["message"]
                    ws.send_json({"type": "confirm_response", "id": event["id"], "approved": True})
                if event["type"] == "task" and event["task"]["status"] == "completed":
                    break
            else:
                pytest.fail("No completed task event")
            task = seen[-1]["task"]
            assert task["item_id"] == "water"
            assert any(e["type"] == "vision" and e.get("detections") for e in seen)
            assert any(e["type"] == "task_step" and e["id"] == "grasp" for e in seen)
            # User text is already inserted by the frontend; server must not echo as ASR.
            assert not any(e["type"] == "asr" for e in seen)
            assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "completed"


def test_api_input_idempotency_busy_and_audit():
    with TestClient(create_app(settings(mock_delay=0.01))) as client:
        assert client.post("/api/tasks", json={"item_id": "oreo"}).status_code == 422
        assert client.post("/api/tasks", json={"item_id": "unknown", "request_id": "x"}).status_code == 404
        body = {"item_id": "oreo", "request_id": "idempotent"}
        first = client.post("/api/tasks", json=body).json()
        assert client.post("/api/tasks", json=body).json()["id"] == first["id"]
        assert client.post("/api/tasks", json={"item_id": "water", "request_id": "new"}).status_code == 409
        result = client.post(f"/api/tasks/{first['id']}/cancel").json()
        assert result["status"] == "cancelled"
        assert client.get("/health").json()["recovery_required"]
        events = client.get(f"/api/tasks/{first['id']}/events").json()
        assert any(e["type"] == "robot_command" and e["name"] == "stop" for e in events)
        assert client.post("/api/mock/recover").status_code == 200
        assert not client.get("/health").json()["recovery_required"]


def test_socket_disconnect_keeps_owned_task_and_reconnect_restores_snapshot():
    with TestClient(create_app(settings(mock_delay=0.02))) as client:
        with client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_json({"type": "text_input", "text": "拿奥利奥", "request_id": "disconnect"})
            request = ws.receive_json()
            assert request["type"] == "confirm_request"
            ws.send_json({"type": "confirm_response", "id": request["id"], "approved": True})
            event = ws.receive_json()
            while event["type"] != "task":
                event = ws.receive_json()
            task_id = event["task"]["id"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = client.get(f"/api/tasks/{task_id}").json()
            if result["status"] == "completed":
                break
            time.sleep(0.005)
        assert result["status"] == "completed"
        with client.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "device"
            assert not ws.receive_json()["recovery_required"]
            assert ws.receive_json()["type"] == "phase"


def test_malformed_ws_does_not_break_connection():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_text("{not valid JSON")
            assert ws.receive_json()["type"] == "assistant_start"
            assert "格式无效" in ws.receive_json()["text"]
            assert ws.receive_json()["type"] == "assistant_end"


def test_optional_auth():
    with TestClient(create_app(settings(api_token="local-test-token"))) as client:
        assert client.get("/health").status_code == 401
        assert client.get("/health", headers={"Authorization": "Bearer local-test-token"}).status_code == 200
        with pytest.raises(Exception):
            with client.websocket_connect("/ws?token=wrong"):
                pass


async def test_gdk_mode_does_not_silently_fall_back_to_mock(monkeypatch):
    monkeypatch.delenv("BLUESWORD_GDK_CONFIG", raising=False)
    with pytest.raises(RuntimeError, match="requires BLUESWORD_GDK_CONFIG"):
        await create_bundle(settings(robot_mode="gdk"))


@pytest.mark.parametrize(
    "text,kind,item_id",
    [
        ("帮我拿一瓶矿泉水", "fetch", "water"),
        ("我想吃点甜的", "fetch", "oreo"),
        ("不要拿安慕希", "chat", None),
        ("给我酸奶和矿泉水", "fetch", "yogurt1"),
        ("矿泉水多少钱", "chat", None),
        ("拿两瓶酸奶", "fetch", "yogurt1"),
        ("你看到了什么", "look", None),
        ("停止任务", "cancel", None),
    ],
)
def test_exhibition_intents(text, kind, item_id):
    _, items = load_scene()
    result = resolve(text, items)
    assert (result.kind, result.item_id) == (kind, item_id)


def _drain_until(ws, kind, limit=60):
    for _ in range(limit):
        event = ws.receive_json()
        if event["type"] == kind:
            return event
    pytest.fail(f"no {kind} event")


def test_robot_never_moves_without_confirmation():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_json({"type": "text_input", "text": "帮我拿奥利奥"})
            request = _drain_until(ws, "confirm_request")
            assert request["steps"] and request["note"]
            assert client.get("/api/tasks").json() == []  # 未确认前没有任何任务
            ws.send_json({"type": "confirm_response", "id": request["id"], "approved": False})
            assert _drain_until(ws, "confirm_closed")["reason"] == "declined"
            assert "先不拿" in _drain_until(ws, "assistant_delta")["text"]
            assert client.get("/api/tasks").json() == []


def test_spoken_confirmation_starts_task():
    with TestClient(create_app(settings())) as client:
        with client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_json({"type": "text_input", "text": "拿瓶矿泉水"})
            _drain_until(ws, "confirm_request")
            ws.send_json({"type": "text_input", "text": "可以"})
            assert _drain_until(ws, "confirm_closed")["reason"] == "approved"
            assert _drain_until(ws, "task")["task"]["item_id"] == "water"


def test_confirmation_timeout_counts_as_declined():
    with TestClient(create_app(settings(confirm_timeout=0.2))) as client:
        with client.websocket_connect("/ws") as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_json({"type": "text_input", "text": "拿薯片"})
            _drain_until(ws, "confirm_request")
            assert _drain_until(ws, "confirm_closed")["reason"] == "timeout"
            assert client.get("/api/tasks").json() == []


def test_new_conversation_clears_confirmation_but_not_running_order():
    with TestClient(create_app(settings(mock_delay=0.005))) as client:
        with client.websocket_connect('/ws') as ws:
            for _ in range(3):
                ws.receive_json()
            ws.send_json({'type': 'text_input', 'text': '两瓶矿泉水', 'request_id': 'reset-before'})
            _drain_until(ws, 'confirm_request')
            ws.send_json({'type': 'reset'})
            _drain_until(ws, 'session_end')
            assert client.get('/api/tasks').json() == []
            ws.send_json({'type': 'text_input', 'text': '两瓶矿泉水', 'request_id': 'reset-after'})
            confirm = _drain_until(ws, 'confirm_request')
            assert '× 2' in confirm['target']
            ws.send_json({'type': 'confirm_response', 'id': confirm['id'], 'approved': True})
            task = _drain_until(ws, 'task')['task']
            ws.send_json({'type': 'reset'})
            assert _drain_until(ws, 'session_end')['task_id'] == task['id']
            for _ in range(400):
                event = ws.receive_json()
                assert event['type'] not in ('assistant_start', 'assistant_delta', 'assistant_end')
                if event['type'] == 'task' and event['task']['status'] == 'completed':
                    break
            else:
                pytest.fail('order did not finish after reset')
            assert client.get('/api/inventory').json()['矿泉水'] == 1
