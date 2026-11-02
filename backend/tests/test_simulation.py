import asyncio

import pytest
from fastapi.testclient import TestClient

from bluesword.app import create_app
from bluesword.config import Settings
from bluesword.domain import RobotError, TaskRequest
from bluesword.simulation import SceneState


async def test_gdk_simulation_completes_and_reports_delivery(make_manager):
    manager = await make_manager(robot_mode="gdk_mock", simulation_speed=30, motion_timeout=2)
    await manager.start(TaskRequest(item_id="oreo", request_id="blender-complete"))
    result = await manager.job
    assert result.status == "completed", result.error
    state = manager.bundle.robot.scene.sample()
    assert state["delivered"] and not state["held"]
    assert state["base"] == pytest.approx([0, 0, 0])
    assert state["tcp"] == pytest.approx([0.3, -0.28, 1.05])
    commands = [e for e in manager.store.events(result.id) if e["type"] == "robot_command"]
    assert any(e["name"] == "relative_move" and e["arguments"]["y"] < 0 for e in commands)
    trace = state["trace"]["entries"]
    assert trace[0]["name"] == "Agent.plan_fetch"
    assert all(entry["status"] == "completed" for entry in trace)
    nav = next(e for e in trace if e["name"] == "Pnc.normal_navi")
    assert nav["result"]["return"] is None and nav["feedback"]["completed"]  # PNC mock returns void.
    estimates = [e for e in trace if e["name"] == "PerceptionSDK.estimate_grasp_pose"]
    assert len(estimates) == 2  # Initial pose, then a fresh pose after the lateral movement.
    assert estimates[0]["result"]["position"] == pytest.approx([.65, -.32, 1.02])
    assert estimates[1]["result"]["position"] == pytest.approx([.65, -.18, 1.02])
    assert estimates[1]["result"]["frame"] == "base_link"
    approach = next(e for e in trace if e["arguments"].get("stage") == "approach")
    assert approach["result"]["return"] == 0
    assert approach["arguments"]["position"] == pytest.approx(estimates[1]["result"]["position"])
    assert any(e["name"] == "Camera.get_nearest_image" for e in trace)


async def test_stop_freezes_partial_navigation_and_recovery_resets(make_manager):
    manager = await make_manager(robot_mode="gdk_mock", simulation_speed=3, motion_timeout=5)
    await manager.start(TaskRequest(item_id="oreo", request_id="blender-stop"))
    scene = manager.bundle.robot.scene
    async with asyncio.timeout(2):
        while scene.command != "normal_navi":
            await asyncio.sleep(0.005)
    await asyncio.sleep(0.1)
    nav = next(e for e in scene.sample()["trace"]["entries"] if e["name"] == "Pnc.normal_navi")
    assert nav["status"] == "accepted" and nav["feedback"] is None
    await manager.cancel()
    first = scene.sample()
    assert 0 < first["base"][0] < 2
    await asyncio.sleep(0.05)
    assert scene.sample()["base"] == first["base"]
    assert scene.stopped and manager.store.recovery_required
    nav = next(e for e in scene.sample()["trace"]["entries"] if e["name"] == "Pnc.normal_navi")
    assert nav["status"] == "cancelled" and nav["feedback"] is None
    await manager.recover_mock()
    assert not scene.stopped and not manager.store.recovery_required
    assert scene.sample()["base"] == [0, 0, 0]
    assert scene.sample()["trace"]["entries"] == []


async def test_manual_take_is_required_and_rejects_early_confirmation(make_manager):
    manager = await make_manager(
        robot_mode="gdk_mock", simulation_speed=30, auto_take=False, motion_timeout=2, handover_timeout=2
    )
    robot = manager.bundle.robot
    with pytest.raises(RobotError, match="尚未"):
        robot.confirm_take()
    await manager.start(TaskRequest(item_id="oreo", request_id="blender-take"))
    async with asyncio.timeout(3):
        while not robot.scene.awaiting_take:
            await asyncio.sleep(0.01)
    assert robot.scene.held and not robot.scene.delivered
    entry = robot.scene.sample()["trace"]["entries"][-1]
    assert entry["name"] == "HandoverSensor.wait_for_take" and entry["status"] == "calling"
    robot.confirm_take()
    result = await manager.job
    assert result.status == "completed"
    assert robot.scene.delivered


def test_readonly_simulation_endpoint_and_mode_isolation():
    with TestClient(create_app(Settings(robot_mode="gdk_mock", db_path=":memory:"))) as client:
        state = client.get("/api/simulation").json()
        assert state["mode"] == "gdk_mock"
        assert state["task"] is None and not state["held"]
        assert client.get("/health").json()["mode"] == "gdk_mock"
    with TestClient(create_app(Settings(robot_mode="mock", db_path=":memory:"))) as client:
        assert client.get("/api/simulation").status_code == 409


def test_scene_snapshot_interpolation_and_copy_isolation(monkeypatch):
    now = [10.0]
    monkeypatch.setattr("bluesword.simulation.time.monotonic", lambda: now[0])
    scene = SceneState()
    duration = scene.begin("normal_navi", {"x": 2.0, "y": 0.0, "yaw": 0.0})
    now[0] += duration / 2
    sample = scene.sample()
    assert sample["base"][0] == pytest.approx(1)
    scene.freeze()
    now[0] += 10
    assert scene.sample()["base"][0] == pytest.approx(1)
