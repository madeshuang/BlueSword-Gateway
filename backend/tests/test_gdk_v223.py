import asyncio
import threading
import time
from types import SimpleNamespace as NS

import numpy as np
import pytest
import pytest_asyncio

from bluesword.config import Settings
from bluesword.domain import RobotError, TaskRequest
from bluesword.gdk_v223.fake import create_fake_bundle, sdk_pose
from bluesword.gdk_v223.geometry import decode_image, field
from bluesword.perception import locate
from bluesword.service import EventBus, TaskManager
from bluesword.storage import TaskStore


@pytest_asyncio.fixture
async def gdk_manager():
    managers = []

    async def make(scenario="success"):
        settings = Settings(robot_mode="gdk", db_path=":memory:", motion_timeout=1, handover_timeout=0.06)
        bundle, sdk, waypoints = create_fake_bundle(settings, scenario)
        manager = TaskManager(bundle, settings, TaskStore(":memory:"), EventBus())
        manager.waypoints = waypoints
        managers.append(manager)
        await manager.initialize()
        return manager, sdk

    yield make
    for manager in managers:
        await manager.shutdown()
        manager.store.close()


async def test_full_workflow_uses_documented_sdk_requests_and_reobserves(gdk_manager):
    manager, sdk = await gdk_manager()
    record = await manager.start(TaskRequest(item_id="oreo", request_id="sdk-full"))
    result = await manager.job
    assert result.status == "completed", result.error
    assert all(step.status == "done" for step in result.steps)
    assert sdk.relative_calls == 1 and sdk.capture_count == 3
    commands = [name for name, _ in sdk.calls]
    assert commands.count("normal_navi") == 2
    assert commands.count("high_precision_navi") == 2
    assert "cancel_task" not in commands
    grippers = [req for name, req in sdk.calls if name == "move_ee_pos"]
    assert [req["right_ee_state"]["joint_position"] for req in grippers] == [0, 1, 0]
    assert all(req["left_ee_state"]["joint_position"] == 0.12 for req in grippers)
    arm = [req for name, req in sdk.calls if name == "end_effector_pose_control"]
    assert all(req.group == sdk.EndEffectorControlGroup.kRightArm for req in arm)
    assert arm[2].right_end_effector_pose.position.y == pytest.approx(0.18)
    assert any(
        e["name"] == "relative_move" for e in manager.store.events(record.id) if e["type"] == "robot_command"
    )


@pytest.mark.parametrize(
    "scenario,holding",
    [
        ("nav_failure", False),
        ("grasp_failure", False),
        ("tf_unsynced", False),
        ("handover_timeout", True),
        ("stale_take", True),
        ("arm_stall", False),
    ],
)
async def test_failed_sdk_feedback_stops_without_releasing(gdk_manager, scenario, holding):
    manager, sdk = await gdk_manager(scenario)
    await manager.start(TaskRequest(item_id="oreo", request_id=scenario))
    result = await manager.job
    assert result.status == "failed"
    assert result.holding == holding
    assert result.recovery_required
    assert "stop" not in result.error, result.error
    names = [name for name, _ in sdk.calls]
    assert "cancel_task" in names
    stop_index = names.index("cancel_task")
    assert "move_ee_pos" not in names[stop_index:]
    if holding:
        assert sdk.ends["right"] == 0.5
    hold = next(req for name, req in sdk.calls[stop_index:] if name == "joint_control_request")
    assert not any("ee" in name for name in hold.joint_names)


async def test_previous_navigation_success_is_not_new_completion(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    await robot.prepare(manager.items["oreo"])
    sdk.scenario = "old_nav_success"
    sdk.base = sdk_pose(2, 0)
    sdk.pnc_state = NS(id=42, state=9, type=1, message="OLD completed task")
    with pytest.raises(TimeoutError):
        await robot.high_precision_navi(manager.waypoints["shelf"])


async def test_nav_checks_heading_even_when_position_is_correct(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    await robot.prepare(manager.items["oreo"])
    original = robot.pnc.get_task_state

    def wrong_heading():
        value = original()
        if value.state == 9:
            sdk.base = sdk_pose(2, 0, yaw=0.5)
        return value

    robot.pnc.get_task_state = wrong_heading
    with pytest.raises(TimeoutError):
        await robot.navigate(manager.waypoints["shelf"])


async def test_base_frame_navigation_converts_map_target(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    robot.profile.navigation_frame = "base_link"
    sdk.base = sdk_pose(1, 0, yaw=np.pi / 2)
    await robot.prepare(manager.items["oreo"])
    await robot.navigate(manager.waypoints["shelf"])
    req = next(req for name, req in sdk.calls if name == "normal_navi")
    assert req.target.position.x == pytest.approx(0, abs=1e-8)
    assert req.target.position.y == pytest.approx(-1)
    assert sdk.base.position.x == pytest.approx(2)


async def test_frame_decoding_and_tf_produce_expected_base_coordinate(gdk_manager):
    manager, _ = await gdk_manager()
    frame = await manager.bundle.robot.capture()
    detection = (await manager.bundle.detector.detect(frame, manager.items["oreo"]))[0]
    point = locate(frame, detection, 1)
    assert point.array() == pytest.approx([0.65, 0.32, 1.02])
    assert frame.rgb.startswith(b"\x89PNG")
    assert frame.preview_src.startswith("data:image/png;base64,")
    assert frame.timestamp_ns == frame.transform.timestamp_ns


async def test_unsynchronized_tf_is_not_retimestamped(gdk_manager):
    manager, sdk = await gdk_manager("tf_unsynced")
    with pytest.raises(RobotError, match="50 ms"):
        await manager.bundle.robot.capture()
    assert sdk.color_stamp > 0


async def test_distorted_rgbd_requires_preprocessing(gdk_manager):
    manager, _ = await gdk_manager()
    manager.bundle.robot.camera.get_camera_intrinsic = lambda _: NS(
        intrinsic=[500, 500, 320, 240], distortion=[0.1, 0, 0, 0, 0]
    )
    with pytest.raises(RobotError, match="畸变"):
        await manager.bundle.robot.capture()


async def test_search_joint_limits_checked_before_sending(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    robot.profile.observations["upper"]["idx11_head_joint1"] = 2
    with pytest.raises(RobotError, match="限位"):
        await robot.observe(0.15, 0, 0.12)
    assert not any(name == "joint_control_request" for name, _ in sdk.calls)


async def test_release_needs_signal_even_if_grip_feedback_drops(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    await robot.gripper(True)
    sdk.effort = 0
    with pytest.raises(RobotError, match="接物证据"):
        await robot.gripper(False)
    assert sdk.ends["right"] == 0.5


async def test_cancel_drains_native_call_before_sending_hold(gdk_manager):
    manager, sdk = await gdk_manager()
    robot = manager.bundle.robot
    await robot.prepare(manager.items["oreo"])
    started, finish = threading.Event(), threading.Event()
    original = robot.pnc.normal_navi

    def slow_navigation(req):
        started.set()
        finish.wait(0.5)
        original(req)

    robot.pnc.normal_navi = slow_navigation
    navigation = asyncio.create_task(robot.navigate(manager.waypoints["shelf"]))
    try:
        async with asyncio.timeout(0.3):
            while not started.is_set():
                await asyncio.sleep(0.001)
        navigation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await navigation
        stop = asyncio.create_task(robot.stop())
        await asyncio.sleep(0.01)
        assert "cancel_task" not in [n for n, _ in sdk.calls]
        finish.set()
        await stop
        names = [n for n, _ in sdk.calls]
        assert names.index("normal_navi") < names.index("cancel_task") < len(names) - 1
        assert names[-1] == "joint_control_request"
        with pytest.raises(RobotError, match="锁定"):
            await robot.gripper(False)
    finally:
        finish.set()


async def test_concurrent_health_poll_does_not_abort_navigation(gdk_manager):
    manager, _ = await gdk_manager()
    robot = manager.bundle.robot
    await robot.prepare(manager.items["oreo"])
    results = await asyncio.gather(robot.navigate(manager.waypoints["shelf"]), robot.health(), robot.health())
    assert results[0].completed
    assert all(r["online"] for r in results[1:])


async def test_calibration_required_before_gdk_init():
    bundle, sdk, _ = create_fake_bundle(Settings())
    bundle.robot.profile.calibrated = False
    try:
        with pytest.raises(RobotError, match="标定"):
            await bundle.robot.connect()
        assert not sdk.initialized
    finally:
        await bundle.robot.close()


async def test_missing_capability_fails_and_releases_sdk():
    bundle, sdk, _ = create_fake_bundle(Settings())
    original = sdk.Pnc

    def no_precision():
        pnc = original()
        pnc.high_precision_navi = None
        return pnc

    sdk.Pnc = no_precision
    with pytest.raises(RobotError, match="high_precision_navi"):
        await bundle.robot.connect()
    assert sdk.released
    assert [name for name, _ in sdk.calls][-2:] == ["close_camera", "gdk_release"]


async def test_old_joint_samples_rejected_before_motion():
    bundle, sdk, _ = create_fake_bundle(Settings(), "stale_feedback")
    with pytest.raises(RobotError, match="时间戳"):
        await bundle.robot.connect()
    assert sdk.released
    assert not any(name == "end_effector_pose_control" for name, _ in sdk.calls)


def test_bgr_raw_decoder_and_buffer_validation():
    raw = NS(width=1, height=1, encoding="bgr8", color_format="BGR", data=b"\x01\x02\x03")
    assert decode_image(raw).tolist() == [[[3, 2, 1]]]
    raw.data = b"\x01"
    with pytest.raises(RobotError, match="长度"):
        decode_image(raw)
    assert field({"timestamp": 12}, "timestamp") == field(NS(timestamp=12), "timestamp")


def test_lossy_depth_and_unknown_encoding_are_rejected():
    raw = NS(width=1, height=1, encoding="JPEG", color_format="GRAY16", data=b"")
    with pytest.raises(RobotError, match="JPEG"):
        decode_image(raw, depth=True)
    raw.encoding = "vendor_unknown"
    with pytest.raises(RobotError, match="编码"):
        decode_image(raw, depth=True)


async def test_sdk_timeout_does_not_release_under_native_call():
    bundle, sdk, _ = create_fake_bundle(Settings())
    robot = bundle.robot
    await robot.connect()
    robot.profile.sdk_call_timeout = 0.01
    finish = threading.Event()
    try:
        with pytest.raises(RobotError, match="阻塞"):
            await robot._call(lambda: finish.wait(0.5))
        with pytest.raises(TimeoutError):
            await robot.stop()
        assert not sdk.released and robot.pending
        assert "cancel_task" not in [n for n, _ in sdk.calls]
    finally:
        finish.set()
        robot.profile.sdk_call_timeout = 0.2
        await robot.close()


async def test_stale_take_signal_cannot_unlock_release(gdk_manager):
    manager, sdk = await gdk_manager("stale_take")
    robot = manager.bundle.robot
    await robot.gripper(True)
    await robot.arm_move("handover")
    with pytest.raises(RobotError, match="支撑证据"):
        await robot.wait_for_take()
    with pytest.raises(RobotError, match="接物证据"):
        await robot.gripper(False)
    assert sdk.ends["right"] == 0.5


async def test_accepted_arm_command_requires_convergence(gdk_manager):
    manager, sdk = await gdk_manager("arm_stall")
    robot = manager.bundle.robot
    with pytest.raises(TimeoutError):
        await robot.arm_move("handover")
    assert robot.stage is None
    assert len([n for n, _ in sdk.calls if n == "end_effector_pose_control"]) == 1


async def test_stale_release_authorization_expires(gdk_manager):
    manager, _ = await gdk_manager()
    robot = manager.bundle.robot
    await robot.gripper(True)
    robot.take_verified = True
    robot.take_timestamp_ns = time.time_ns() - 3_000_000_000
    with pytest.raises(RobotError, match="接物证据"):
        await robot.gripper(False)


def test_rgbd_registration_identity_preserves_depth_and_invalid_holes():
    from bluesword.gdk_v223.rgbd import rectify_register

    rgb = np.full((4, 6, 3), 20, dtype=np.uint8)
    depth = np.full((4, 6), 0.8)
    depth[1, 2] = 0
    intrinsic = NS(intrinsic=[100, 100, 3, 2], distortion=[0] * 5)
    rectified, registered = rectify_register(rgb, depth, intrinsic, intrinsic, np.eye(4))
    assert np.array_equal(rectified, rgb)
    assert np.isnan(registered[1, 2])
    assert registered[0, 0] == pytest.approx(0.8)
    assert np.isfinite(registered).sum() == depth.size - 1


def test_rgbd_registration_respects_camera_baseline_and_z_buffer():
    from bluesword.gdk_v223.rgbd import rectify_register

    rgb = np.zeros((4, 6, 3), dtype=np.uint8)
    depth = np.zeros((4, 6))
    depth[1, 0], depth[1, 1] = 0.5, 1.0
    intrinsic = NS(intrinsic=[100, 100, 0, 0], distortion=[0] * 5)
    transform = np.eye(4)
    transform[0, 3] = 0.01
    _, registered = rectify_register(rgb, depth, intrinsic, intrinsic, transform)
    # Both project to color u=2; nearer depth must win, not last writer.
    assert registered[1, 2] == pytest.approx(0.5)
    assert np.isfinite(registered).sum() == 1


async def test_native_rgbd_path_reads_both_intrinsics_and_tfs(gdk_manager):
    import copy

    manager, _ = await gdk_manager()
    robot = manager.bundle.robot
    robot.profile.camera_registered_rectified = False
    robot.profile.depth_optical_frame = "fake_depth_optical"
    original = robot.tf.get_all_tf_from_base_link

    def transforms():
        values = original()
        depth = copy.deepcopy(values[0])
        depth.child_frame_id = robot.profile.depth_optical_frame
        return [*values, depth]

    robot.tf.get_all_tf_from_base_link = transforms
    frame = await robot.capture()
    assert frame.depth_m.shape == (480, 640)
    assert np.nanmedian(frame.depth_m) == pytest.approx(0.65)
    assert frame.camera_frame == robot.profile.optical_frame


def test_rgbd_nonzero_distortion_recovers_known_point():
    from bluesword.gdk_v223.rgbd import rectify_register

    rgb = np.zeros((101, 101, 3), dtype=np.uint8)
    depth = np.zeros((101, 101))
    # Undistorted x=0.4 -> x_d=0.416 with k1=0.25, u_d=91.6 -> pixel 92.
    depth[50, 92] = 1
    color = NS(intrinsic=[100, 100, 50, 50], distortion=[0] * 5)
    depth_intrinsic = NS(intrinsic=[100, 100, 50, 50], distortion=[0.25, 0, 0, 0, 0])
    _, registered = rectify_register(rgb, depth, color, depth_intrinsic, np.eye(4))
    assert registered[50, 90] == pytest.approx(1)
    assert np.isnan(registered[50, 92])
