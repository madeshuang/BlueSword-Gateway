"""The robot team's v1.2 contract, with an HTTP robot substitute (no hardware)."""

import base64
import io
import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from bluesword.app import create_app
from bluesword.config import Settings, load_scene


def picture(color="blue"):
    output = io.BytesIO()
    Image.new("RGB", (640, 400), color).save(output, format="JPEG")
    return {
        "mime": "image/jpeg",
        "width": 640,
        "height": 400,
        "data": base64.b64encode(output.getvalue()).decode(),
    }


@pytest.fixture
def gateway(tmp_path):
    # This fixture deliberately keeps the demo products; onsite defaults use the JSON catalog.
    catalog = tmp_path / "catalog.json"
    _, items = load_scene()
    catalog.write_text(json.dumps([
        {"id": item.id, "name": item.name, "initialStock": item.stock, "category": item.category}
        for item in items.values()
    ]), encoding="utf-8")
    settings = Settings(
        robot_mode="lanjian_http",
        robot_protocol="vlm",
        db_path=str(tmp_path / "vlm.sqlite"),
        robot_dispatch_url="http://robot.test:8080/api/task/dispatch",
        remote_task_timeout=30,
        operator_token="onsite",
        catalog_path=str(catalog),
    )
    sent = []

    def respond(request):
        if request.url.path == "/api/health":
            return httpx.Response(200, json={"code": 1, "success": True, "data": "ok", "busy": False})
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True, "data": "received"})

    with TestClient(create_app(settings)) as client:
        client.app.state.manager.bundle.robot.client = httpx.AsyncClient(
            transport=httpx.MockTransport(respond)
        )
        yield client, sent


def start(client, count=2):
    lines = (
        [{"item_id": "water", "count": 1}, {"item_id": "chips", "count": 1}]
        if count == 2
        else [{"item_id": "water", "count": 1}]
    )
    response = client.post("/api/tasks", json={"items": lines, "request_id": "vlm-test"})
    assert response.status_code == 202, response.text
    return response.json()["id"]


def progress(identifier, stage, index, pick, total=8, **extra):
    return {
        "taskId": identifier,
        "stage": stage,
        "stageIndex": index,
        "stageTotal": total,
        "pickIndex": pick,
        "message": f"现场回报：{stage}",
        **extra,
    }


def final(client, identifier):
    for _ in range(200):
        task = client.get("/api/tasks/" + identifier).json()
        if task["status"] != "running":
            return task
        time.sleep(0.005)
    pytest.fail("no terminal task")


def test_vlm_whole_order_progress_image_retry_reconnect_and_finish(gateway):
    client, sent = gateway
    identifier = start(client)
    assert sent == [
        {
            "taskId": identifier,
            "items": [
                {"item": "矿泉水", "count": 1, "location": ""},
                {"item": "薯片", "count": 1, "location": ""},
            ],
        }
    ]
    # Robot prioritizes chips, even though water was first in the submitted list.
    first = progress(
        identifier,
        "target_located",
        2,
        1,
        detection={"item": "shupian", "label": "薯片", "attempt": 1},
        image=picture(),
    )
    assert client.post("/api/task/progress", json=first).json()["success"]
    first_at = client.get("/api/tasks/" + identifier).json()["last_progress_at"]
    assert first_at is not None
    assert client.post("/api/task/progress", json=first).json()["success"]
    assert client.get("/api/tasks/" + identifier).json()["last_progress_at"] == first_at
    retry = progress(
        identifier,
        "target_located",
        2,
        1,
        detection={"item": "shupian", "label": "薯片", "attempt": 2},
        image=picture("green"),
    )
    assert client.post("/api/task/progress", json=retry).json()["success"]
    task = client.get("/api/tasks/" + identifier).json()
    assert len(task["steps"]) == 2 and task["steps"][1]["attempt"] == 2
    assert task["last_progress_at"] > first_at
    assert task["steps"][1]["startedAt"] == first_at
    assert task["status"] == "running"
    with client.websocket_connect("/ws") as ws:
        seen = [ws.receive_json() for _ in range(6)]
        camera = next(e for e in seen if e["type"] == "camera")
        assert camera["src"] == "data:image/jpeg;base64," + retry["image"]["data"]
        assert any("薯片" in e.get("caption", "") for e in seen)
    # A callback for a different order never changes this one.
    wrong = {**first, "taskId": "previous-order"}
    assert not client.post("/api/task/progress", json=wrong).json()["success"]
    for stage, index, pick in [
        ("grasped", 3, 1),
        ("arrived_shelf", 4, 2),
        ("target_located", 5, 2),
        ("grasped", 6, 2),
        ("at_delivery", 7, 0),
        ("placed", 8, 0),
    ]:
        assert client.post("/api/task/progress", json=progress(identifier, stage, index, pick)).json()[
            "success"
        ]
    assert client.get("/api/tasks/" + identifier).json()["status"] == "running"  # placed is not finished
    assert client.post("/api/task/finished", json={"taskId": identifier, "result": "success"}).json()[
        "success"
    ]
    task = final(client, identifier)
    assert task["status"] == "completed" and not task["recovery_required"]
    assert client.get("/api/inventory").json()["矿泉水"] == 2
    log = client.get("/api/robot/protocol", headers={"X-Operator-Token": "onsite"}).json()
    assert len([e for e in log if e["path"].endswith("/progress")]) == 10  # 包含重复进度和旧任务回报，便于通信排查
    assert retry["image"]["data"] not in json.dumps(log)
    assert retry["image"]["data"] not in json.dumps(client.get("/api/tasks/" + identifier + "/events").json())


def test_skipped_grasp_does_not_claim_two_deliveries_or_refund(gateway):
    client, _ = gateway
    identifier = start(client)
    for stage, index, pick in [
        ("grasped", 3, 1),
        ("target_located", 5, 2),
        ("at_delivery", 7, 0),
        ("placed", 8, 0),
    ]:
        assert client.post("/api/task/progress", json=progress(identifier, stage, index, pick)).json()[
            "success"
        ]
    client.post("/api/task/finished", json={"taskId": identifier, "result": "success"})
    task = final(client, identifier)
    assert task["status"] == "completed" and task["recovery_required"]
    assert "数量" in task["completion_note"]
    assert client.get("/health").json()["recovery_required"]
    with client.websocket_connect("/ws") as ws:
        snapshot = [ws.receive_json() for _ in range(4)]
        assert snapshot[-1] == {"type": "phase", "phase": "listening"}
        assert snapshot[-2]["task"]["completion_note"]
    assert client.get("/api/inventory").json()["薯片"] == 2
    assert (
        client.post(
            "/api/operator/resolve",
            headers={"X-Operator-Token": "onsite"},
            json={"task_id": identifier, "confirmation": "已核对机器人和物品"},
        ).status_code
        == 200
    )
    assert client.get("/api/inventory").json()["薯片"] == 2


def test_invalid_progress_and_late_duplicates_do_not_change_task(gateway):
    client, _ = gateway
    identifier = start(client, 1)
    body = progress(identifier, "target_located", 2, 1, total=5, image=picture())
    body["image"]["data"] = "not jpeg"
    assert client.post("/api/task/progress", json=body).status_code == 422
    assert (
        client.post("/api/task/progress", json=progress(identifier, "placed", 3, 0, total=5)).status_code
        == 422
    )
    assert (
        client.post("/api/task/progress", json=progress(identifier, "grasped", 3, 1, total=8)).status_code
        == 422
    )
    assert not client.post("/api/task/finished", json={"result": "success"}).json()["success"]
    client.post("/api/task/finished", json={"taskId": identifier, "result": "success"})
    completed = final(client, identifier)
    assert not client.post("/api/task/progress", json=progress(identifier, "grasped", 3, 1, total=5)).json()[
        "success"
    ]
    assert client.get("/api/tasks/" + identifier).json() == completed


@pytest.mark.parametrize(
    "response", [{"success": True, "busy": True}, {"success": True}, {"success": "true", "busy": False}]
)
def test_health_preflight_prevents_dispatch_and_stock_reservation(gateway, response):
    client, sent = gateway
    manager = client.app.state.manager
    manager.bundle.robot.client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=response))
    )
    result = client.post("/api/tasks", json={"item_id": "water", "request_id": "preflight"})
    assert result.status_code == 409
    assert client.get("/api/tasks").json() == [] and not sent
    assert client.get("/api/inventory").json()["矿泉水"] == 3


def test_fault_is_terminal_and_previous_order_cannot_complete_new_order(gateway):
    client, _ = gateway
    first = start(client, 1)
    client.post("/api/task/finished", json={"taskId": first, "result": "success"})
    final(client, first)
    second = client.post("/api/tasks", json={"item_id": "water", "request_id": "next-order"}).json()["id"]
    assert not client.post("/api/task/finished", json={"taskId": first, "result": "success"}).json()[
        "success"
    ]
    assert client.get("/api/tasks/" + second).json()["status"] == "running"
    assert client.post("/api/task/progress", json=progress(second, "target_located", 2, 1, total=5)).json()["success"]
    assert client.post("/api/task/error", json={"taskId": second, "message": "抓取失败"}).json()["success"]
    failed = final(client, second)
    assert failed["status"] == "failed" and failed["recovery_required"]
    assert all(step["status"] == "done" for step in failed["steps"])
    assert "抓取失败" in failed["error"]["message"]
    with client.websocket_connect("/ws") as ws:
        snapshot = [ws.receive_json() for _ in range(4)]
        restored = next(event["task"] for event in snapshot if event["type"] == "task")
        assert restored["error"] == failed["error"]
        assert restored["last_progress_at"] == failed["last_progress_at"]
    assert not client.post("/api/task/finished", json={"taskId": second, "result": "success"}).json()[
        "success"
    ]
    assert client.get("/api/tasks/" + second).json() == failed


def test_same_robot_product_in_two_display_slots_is_one_wire_line(gateway):
    client, sent = gateway
    response = client.post(
        "/api/tasks",
        json={
            "request_id": "same-sku",
            "items": [{"item_id": "yogurt1", "count": 1}, {"item_id": "yogurt2", "count": 1}],
        },
    )
    assert response.status_code == 202
    assert sent[0]["items"] == [{"item": "安慕希", "count": 2, "location": ""}]


def test_booth_catalog_default_and_json_replacement_preserve_inventory(tmp_path):
    settings = Settings(
        robot_mode="lanjian_http", robot_protocol="vlm",
        robot_dispatch_url="http://robot.test:8080/api/task/dispatch",
        db_path=str(tmp_path / "catalog.sqlite"), api_token="test-gateway",
    )
    catalog = json.loads(
        (Path(__file__).resolve().parents[2] / "config/booth-catalog.example.json").read_text(encoding="utf-8")
    )
    replacement = tmp_path / "replacement.json"
    sent = []

    def respond(request):
        if request.url.path == "/api/health":
            return httpx.Response(200, json={"success": True, "busy": False})
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"code": 1, "data": "received", "success": True})

    for revision in range(2):
        if revision:
            row = next(row for row in catalog if row["id"] == "shupian")
            row.update(name="替换后的薯片", robotItem="chips_next", initialStock=9)
            replacement.write_text(json.dumps([row]), encoding="utf-8")
            settings.catalog_path = str(replacement)
        with TestClient(create_app(settings)) as client:
            manager = client.app.state.manager
            client.portal.call(manager.bundle.robot.client.aclose)
            manager.bundle.robot.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
            assert client.get("/api/items").status_code == 401
            headers = {"Authorization": "Bearer test-gateway"}
            actual = client.get("/api/items", headers=headers).json()
            assert {row["id"] for row in actual} == ({"shupian"} if revision else {row["id"] for row in catalog})
            label = "替换后的薯片" if revision else "乐事薯片"
            assert client.get("/api/inventory", headers=headers).json()[label] == 3 - revision
            response = client.post("/api/tasks", headers=headers, json={
                "items": [{"item_id": "shupian", "count": 1}], "request_id": f"catalog-{revision}",
            })
            assert response.status_code == 202
            identifier = response.json()["id"]
            assert sent[-1] == {"taskId": identifier, "items": [{
                "item": "chips_next" if revision else "shupian", "count": 1, "location": "待配置",
            }]}
            # Robot v1.2 sends no Bearer token, even when the browser API is protected.
            assert client.post("/api/task/progress", json=progress(identifier, "placed", 5, 0, total=5)).status_code == 200
            assert client.post("/api/task/finished", json={"taskId": identifier, "result": "success"}).json()["success"]
            client.headers.update(headers)
            assert final(client, identifier)["status"] == "completed"
