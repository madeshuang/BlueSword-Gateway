import asyncio
import time
import uuid

import pytest

from bluesword.domain import MotionResult, RobotError, TakeSignal, TaskRequest


async def run_task(manager, item="oreo"):
    await manager.start(TaskRequest(item_id=item, request_id=uuid.uuid4().hex))
    return await manager.job


@pytest.mark.parametrize("item", ["oreo", "water", "poker", "tissue", "chips", "yogurt1", "yogurt2"])
async def test_full_fetch_for_every_shelf_item(make_manager, item):
    manager = await make_manager()
    result = await run_task(manager, item)
    assert result.status == "completed", result.error
    assert all(step.status == "done" for step in result.steps)
    assert not result.holding
    commands = manager.bundle.robot.commands
    names = [c.name for c in commands]
    stages = [c.arguments["stage"] for c in commands if c.name == "arm_move"]
    assert stages == ["pregrasp", "approach", "lift", "retreat", "carry", "handover", "stow"]
    assert names.count("navigate") == 2
    assert names.count("high_precision_navi") == 2
    assert names.index("wait_for_take") < max(i for i, c in enumerate(commands) if c.name == "gripper")
    assert len(manager.store.events(result.id)) > 30


async def test_lateral_move_reobserves_before_grasp(make_manager):
    manager = await make_manager()
    result = await run_task(manager, "oreo")
    assert result.status == "completed"
    commands = manager.bundle.robot.commands
    align = next(i for i, c in enumerate(commands) if c.name == "relative_move")
    assert commands[align + 1].name == "capture_rgbd"
    approach = next(
        c.arguments["target"] for c in commands if c.name == "arm_move" and c.arguments["stage"] == "approach"
    )
    assert approach["y"] == pytest.approx(0.18, abs=0.002)


async def test_bounded_search_moves_head_and_waist(make_manager):
    manager = await make_manager(scenario="search")
    result = await run_task(manager)
    assert result.status == "completed", result.error
    poses = [c.arguments for c in manager.bundle.robot.commands if c.name == "observe"]
    assert len(poses) == 3
    assert poses[-1]["waist_m"] > 0


@pytest.mark.parametrize(
    "scenario,code",
    [
        ("not_found", "target_not_found"),
        ("bad_depth", "invalid_depth"),
        ("stale_frame", "stale_frame"),
        ("tf_error", "invalid_tf"),
        ("nav_failure", "motion_failed"),
        ("nav_timeout", "timeout"),
        ("precision_unavailable", "unsupported_capability"),
        ("grasp_failure", "grasp_unverified"),
        ("handover_timeout", "timeout"),
    ],
)
async def test_failure_never_reports_success_or_releases_held_object(make_manager, scenario, code):
    manager = await make_manager(scenario=scenario)
    result = await run_task(manager)
    assert result.status == "failed"
    assert result.error["code"] == code
    assert result.recovery_required and manager.store.recovery_required
    assert manager.bundle.robot.commands[-1].name == "stop"
    if scenario == "handover_timeout":
        assert result.holding
        grippers = [c.arguments["closed"] for c in manager.bundle.robot.commands if c.name == "gripper"]
        assert grippers == [False, True]
    if scenario in {
        "not_found",
        "bad_depth",
        "stale_frame",
        "tf_error",
        "precision_unavailable",
        "nav_failure",
        "nav_timeout",
    }:
        assert not any(c.name == "arm_move" for c in manager.bundle.robot.commands)
    with pytest.raises(RobotError, match="复位"):
        await manager.start(TaskRequest(item_id="water", request_id="after-failure"))


async def test_manual_take_does_not_release_before_signal(make_manager):
    manager = await make_manager(auto_take=False, handover_timeout=2)
    await manager.start(TaskRequest(item_id="yogurt1", request_id="manual-take"))
    async with asyncio.timeout(1):
        while not any(c.name == "wait_for_take" for c in manager.bundle.robot.commands):
            await asyncio.sleep(0.001)
    assert manager.active.status == "running"
    assert manager.bundle.robot.holding
    assert [c.arguments["closed"] for c in manager.bundle.robot.commands if c.name == "gripper"] == [
        False,
        True,
    ]
    manager.bundle.robot.confirm_take()
    result = await manager.job
    assert result.status == "completed"
    assert not manager.bundle.robot.holding


async def test_stale_take_signal_is_rejected(make_manager):
    manager = await make_manager()

    async def stale():
        return TakeSignal(True, time.time_ns() - 10_000_000_000, "old-feedback")

    manager.bundle.robot.wait_for_take = stale
    result = await run_task(manager)
    assert result.error["code"] == "take_unverified"
    assert result.holding


async def test_nav_precision_nan_is_rejected(make_manager):
    manager = await make_manager()

    async def bad_accuracy(_waypoint):
        return MotionResult(True, error_m=float("nan"))

    manager.bundle.robot.high_precision_navi = bad_accuracy
    result = await run_task(manager)
    assert result.error["code"] == "navigation_accuracy"
    assert not any(c.name == "arm_move" for c in manager.bundle.robot.commands)


async def test_busy_idempotency_and_cancel_before_first_await(make_manager):
    manager = await make_manager(mock_delay=0.02)
    req = TaskRequest(item_id="oreo", request_id="unique")
    task = await manager.start(req, owner="socket-one")
    same = await manager.start(req)
    assert task.id == same.id
    with pytest.raises(RobotError, match="不同物品"):
        await manager.start(TaskRequest(item_id="water", request_id="unique"))
    with pytest.raises(RobotError, match="正在执行"):
        await manager.start(TaskRequest(item_id="water", request_id="different"))
    await manager.cancel(owner="other-observer")
    assert manager.busy
    await asyncio.gather(manager.cancel(owner="socket-one"), manager.cancel(owner="socket-one"))
    assert manager.active.status == "cancelled"
    assert not manager.busy
    count = len(manager.bundle.robot.commands)
    await asyncio.sleep(0.03)
    assert len(manager.bundle.robot.commands) == count


async def test_cancel_while_holding_keeps_gripper_closed(make_manager):
    manager = await make_manager(auto_take=False, handover_timeout=2)
    await manager.start(TaskRequest(item_id="oreo", request_id="cancel-held"))
    async with asyncio.timeout(1):
        while not any(c.name == "wait_for_take" for c in manager.bundle.robot.commands):
            await asyncio.sleep(0.001)
    await manager.cancel()
    assert manager.active.status == "cancelled"
    assert manager.active.holding
    assert manager.bundle.robot.commands[-1].name == "stop"
    await manager.recover_mock()
    assert not manager.store.recovery_required
    assert not manager.bundle.robot.holding


async def test_unreachable_height_does_not_try_an_arm_motion(make_manager):
    manager = await make_manager(grasp_z=(0.6, 0.7))
    result = await run_task(manager, "yogurt1")
    assert result.error["code"] == "unreachable"
    assert not any(c.name == "arm_move" for c in manager.bundle.robot.commands)


async def test_process_restart_marks_unfinished_without_replaying(make_manager, tmp_path):
    first = await make_manager(db_path=str(tmp_path / "tasks.sqlite3"), mock_delay=0.03)
    record = await first.start(TaskRequest(item_id="oreo", request_id="crashed-request"))
    await first.cancel()
    record.status = "running"  # Simulate the last durable write before a process crash.
    first.store.save(record)
    second = await make_manager(db_path=str(tmp_path / "tasks.sqlite3"))
    assert second.store.get(record.id).status == "interrupted"
    assert second.store.recovery_required
    assert [c.name for c in second.bundle.robot.commands] == ["stop"]
    duplicate = await second.start(TaskRequest(item_id="oreo", request_id="crashed-request"))
    assert duplicate.status == "interrupted"
    assert not second.busy
