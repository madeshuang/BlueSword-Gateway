"""两进程场景：网关（lanjian_http）⇄ 模拟兰剑机器人（gdk_mock + 回报器），全程只走 HTTP 协议。"""

import asyncio
import socket
import threading
import time

import httpx
import pytest
import uvicorn

from bluesword.app import create_app
from bluesword.config import Settings


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, settings: Settings, port: int):
        self.server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        while not self.server.started:
            time.sleep(0.02)
        return self

    def __exit__(self, *_):
        self.server.should_exit = True
        self.thread.join(5)


@pytest.fixture
def pair():
    robot_port, gateway_port = free_port(), free_port()
    robot = Settings(robot_mode="gdk_mock", db_path=":memory:", simulation_speed=30, auto_take=True,
                     gateway_url=f"http://127.0.0.1:{gateway_port}")
    gateway = Settings(robot_mode="lanjian_http", db_path=":memory:",
                       robot_dispatch_url=f"http://127.0.0.1:{robot_port}/api/task/dispatch", remote_task_timeout=60)
    with Server(robot, robot_port), Server(gateway, gateway_port):
        yield gateway_port


async def test_pick_then_unload_over_protocol_with_stage_reports(pair):
    from bluesword.domain import TaskRequest  # noqa: F401  (协议走 HTTP，不直接调用)

    base = f"http://127.0.0.1:{pair}"
    async with httpx.AsyncClient(trust_env=False, base_url=base, timeout=60) as client:
        assert (await client.get("/health")).json()["online"] is True
        pick = (await client.post("/api/tasks", json={"item_id": "oreo", "request_id": "p1", "skill": "pick"})).json()
        for _ in range(600):
            task = (await client.get(f"/api/tasks/{pick['id']}")).json()
            if task["status"] != "running":
                break
            await asyncio.sleep(0.05)
        assert task["status"] == "completed", task
        assert [s["id"] for s in task["steps"]] == ["plan", "navigate_to_shelf", "detect", "grasp"]
        assert all(s["status"] == "done" for s in task["steps"])
        assert "停靠误差" in task["steps"][1]["detail"]  # 回报里带着机器人侧的真实数据
        assert task["holding"]

        unload = (await client.post("/api/tasks", json={"item_id": "oreo", "request_id": "u1", "skill": "unload"})).json()
        for _ in range(600):
            task = (await client.get(f"/api/tasks/{unload['id']}")).json()
            if task["status"] != "running":
                break
            await asyncio.sleep(0.05)
        assert task["status"] == "completed", task
        assert [s["id"] for s in task["steps"]] == ["plan", "navigate_to_delivery", "place"]

        log = (await client.get("/api/robot/protocol")).json()
        paths = [(e["direction"], e["path"]) for e in log]
        assert paths[0] == ("out", "/api/task/dispatch")
        assert log[0]["body"]["action"] == "pick" and log[0]["body"]["taskId"] == pick["id"]
        assert ("in", "/api/task/progress") in paths and ("in", "/api/task/finished") in paths
        assert all(e["body"].get("taskId") in (pick["id"], unload["id"]) for e in log)


async def test_unreachable_robot_is_uncertain_not_resent():
    port = free_port()
    gateway = Settings(robot_mode="lanjian_http", db_path=":memory:", robot_timeout=0.5,
                       robot_dispatch_url=f"http://127.0.0.1:{free_port()}/api/task/dispatch")
    with Server(gateway, port):
        async with httpx.AsyncClient(trust_env=False, base_url=f"http://127.0.0.1:{port}", timeout=10) as client:
            task = (await client.post("/api/tasks", json={"item_id": "oreo", "request_id": "x", "skill": "pick"})).json()
            for _ in range(100):
                task = (await client.get(f"/api/tasks/{task['id']}")).json()
                if task["status"] != "running":
                    break
                await asyncio.sleep(0.05)
            assert task["status"] == "failed" and task["error"]["code"] == "dispatch_uncertain"
            assert (await client.get("/health")).json()["recovery_required"] is True
            log = (await client.get("/api/robot/protocol")).json()
            assert len([e for e in log if e["path"] == "/api/task/dispatch"]) == 1  # 不自动重发
