"""Two real localhost HTTP services; only the robot and camera are synthetic."""

import asyncio
import base64
import io

import httpx
import pytest
from PIL import Image
from test_lanjian_protocol import Server, free_port

from bluesword.config import Settings
from bluesword.vlm import Progress
from bluesword.vlm_simulator import create_simulator


@pytest.mark.parametrize("scenario,lines", [
    ("success", [{"item_id": "shupian", "count": 1}]),
    ("success", [{"item_id": "shupian", "count": 2}]),
    ("success", [{"item_id": "shupian", "count": 1}, {"item_id": "aoliao", "count": 1}]),
    ("partial", [{"item_id": "shupian", "count": 2}]),
    ("error", [{"item_id": "shupian", "count": 1}]),
])
async def test_vlm_http_simulator_roundtrip(scenario, lines):
    robot_port, gateway_port = free_port(), free_port()
    gateway_url, robot_url = f"http://127.0.0.1:{gateway_port}", f"http://127.0.0.1:{robot_port}"
    simulator = create_simulator(gateway_url, delay=0.02, scenario=scenario)
    settings = Settings(robot_mode="lanjian_http", robot_protocol="vlm", db_path=":memory:",
                        robot_dispatch_url=robot_url + "/api/task/dispatch", remote_task_timeout=10)
    with Server(None, robot_port, app=simulator), Server(settings, gateway_port) as gateway:
        async with httpx.AsyncClient(trust_env=False, base_url=gateway_url) as client:
            health = (await client.get(robot_url + "/api/health")).json()
            assert health == {"code": 1, "data": "ok", "success": True, "busy": False}
            task = (await client.post("/api/tasks", json={"request_id": "demo", "items": lines})).json()
            assert task["status"] == "running"
            # Gateway acceptance may precede the asynchronous robot dispatch.
            for _ in range(100):
                busy = (await client.get(robot_url + "/api/health")).json()["busy"]
                if busy:
                    break
                await asyncio.sleep(0.005)
            assert busy
            denied = await client.post(robot_url + "/api/task/dispatch", json={
                "taskId": "extra", "items": [{"item": "乐事薯片"}],
            })
            assert denied.json()["success"] is False
            for _ in range(200):
                task = (await client.get("/api/tasks/" + task["id"])).json()
                if task["status"] != "running":
                    break
                await asyncio.sleep(0.02)
            assert task["status"] == ("failed" if scenario == "error" else "completed"), task
            assert task["recovery_required"] == (scenario != "success")
            log = (await client.get("/api/robot/protocol")).json()
            reports = [entry["body"] for entry in log if entry["path"] == "/api/task/progress"]
            assert reports and all(body["taskId"] == task["id"] for body in reports)
            for body in reports:
                Progress.model_validate({key: value for key, value in body.items() if key != "image"})
            # Same stage/pick appears twice on the wire but only once in the task timeline.
            located = [step for step in task["steps"] if step["id"].endswith(":target_located")]
            assert located and all(step["attempt"] == 2 for step in located)
            assert not any("status" in body for body in reports)  # never the legacy progress shape
            visual = gateway.server.config.app.state.manager.remote_visual
            assert visual["caption"].startswith("模拟")
            with Image.open(io.BytesIO(base64.b64decode(visual["src"].split(",", 1)[1]))) as image:
                assert image.format == "JPEG" and image.size == (640, 400)
            if len(lines) == 2:
                assert reports[1]["detection"]["item"] == "aoliao"  # actual order, not request order
            if scenario == "partial":
                assert not any(body["stageIndex"] == 6 for body in reports)
                assert "数量" in task["completion_note"]


async def test_simulator_accepts_names_and_rejects_invalid_orders():
    port = free_port()
    simulator = create_simulator("http://127.0.0.1:1", delay=10)
    with Server(None, port, app=simulator):
        async with httpx.AsyncClient(trust_env=False, base_url=f"http://127.0.0.1:{port}") as client:
            for items in ([], [{"item": "shupian", "count": 3}],
                          [{"item": "shupian", "count": True}],
                          [{"item": "shupian"}, {"item": "shupian"}]):
                response = await client.post("/api/task/dispatch", json={"taskId": "invalid", "items": items})
                assert response.status_code == 422
            for items in ([{"item": "不存在"}], [{"item": "shupian"}, {"item": "乐事薯片"}]):
                response = await client.post("/api/task/dispatch", json={"taskId": "invalid", "items": items})
                assert response.json()["success"] is False
            response = await client.post("/api/task/dispatch", json={
                "task_id": "by-name", "items": [{"item": "乐事薯片", "count": 2}],
            })
            assert response.json() == {"code": 1, "data": "received", "success": True}
