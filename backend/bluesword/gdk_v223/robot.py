"""Genie 02 GDK v2.2.3 adapter; command acceptance is never motion completion.

The supplied manual has no Robot.stop or timestamped take detector. Stop uses
PNC cancellation + a measured joint hold (requires hardware validation). A site
take sensor is injected rather than synthesizing a release signal from a timer.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Protocol

import numpy as np

from ..config import Item, Settings, Waypoint
from ..domain import MotionResult, Point, RobotError, TakeSignal
from .geometry import angle_error, field, make_frame, pose_components, yaw_of
from .profile import JOINT_LIMITS, Pose, Profile


class TakeSensor(Protocol):
    async def wait_for_take(self, *, since_ns: int) -> TakeSignal:
        """Return fresh, debounced physical support evidence in Unix nanoseconds."""
        ...


class GdkRobot:
    name = "Genie 02 · GDK 2.2.3"
    mode = "gdk"

    def __init__(self, sdk, profile: Profile, settings: Settings, take_sensor: TakeSensor):
        self.sdk, self.profile, self.settings, self.take_sensor = sdk, profile, settings, take_sensor
        self.online = self.stopped = self.released = False
        self.initialized = False
        self.pending: set[asyncio.Future] = set()
        self.sdk_lock = asyncio.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gdk-v223")
        self.command_sink = None
        self.item: Item | None = None
        self.stage: str | None = None
        self.take_verified = False
        self.take_timestamp_ns = 0
        self.grasp_confirmed = False
        self.joint_method = "joint_control_request"

    async def _call(self, function, *args, mutation=False, stopping=False):
        async with self.sdk_lock:
            if mutation and self.stopped and not stopping:
                raise RobotError("stopped", "机器人已锁定，拒绝发送旧指令")
            return await self._invoke(function, *args)

    async def _invoke(self, function, *args):
        # Shield preserves the SDK future when the caller is cancelled. stop()
        # drains it before sending hold commands; it cannot run later unnoticed.
        if any(not pending.done() for pending in self.pending):
            raise RobotError("sdk_busy", "SDK 调用仍未退出，拒绝排队发送新指令")
        future = asyncio.get_running_loop().run_in_executor(self.executor, partial(function, *args))
        self.pending.add(future)

        def finished(done):
            self.pending.discard(done)
            if not done.cancelled():
                done.exception()  # Retrieve exceptions after a caller times out.

        future.add_done_callback(finished)
        try:
            async with asyncio.timeout(self.profile.sdk_call_timeout):
                return await asyncio.shield(future)
        except TimeoutError as exc:
            self.stopped = True
            raise RobotError("sdk_call_timeout", "SDK 调用阻塞，停止状态尚未确认") from exc
        except asyncio.CancelledError:
            raise
        except RobotError:
            raise
        except Exception as exc:
            raise RobotError("sdk_error", f"{function.__name__}: {exc}") from exc

    def _success(self, result):
        if result is not None and result != 0 and result != self.sdk.GDKRes.kSuccess:
            raise RobotError("sdk_rejected", f"SDK 拒绝请求，返回 {result}")

    async def _command(self, owner, method, argument, audit, *, stopping=False):
        if self.stopped and not stopping:
            raise RobotError("stopped", "机器人已锁定，需要现场检查")
        if self.command_sink:
            self.command_sink({"name": method, "arguments": audit, "timestamp_ns": time.time_ns()})
        result = await self._call(
            getattr(owner, method),
            *([] if argument is None else [argument]),
            mutation=True,
            stopping=stopping,
        )
        self._success(result)
        return result

    async def connect(self):
        if not self.profile.calibrated:
            raise RobotError("calibration_required", "GDK 标定配置未完成，未初始化机器人")
        try:
            self._success(await self._call(self.sdk.gdk_init))
            self.initialized = True
            for name in ("Robot", "Camera", "TF", "Slam", "Pnc", "Map"):
                setattr(self, name.lower(), await self._call(getattr(self.sdk, name)))
            required = [
                (
                    self.robot,
                    (
                        "get_joint_states",
                        "get_whole_body_status",
                        "get_end_state",
                        "get_motion_control_status",
                        "move_ee_pos",
                        "end_effector_pose_control",
                    ),
                ),
                (
                    self.pnc,
                    ("normal_navi", "high_precision_navi", "relative_move", "get_task_state", "cancel_task"),
                ),
                (
                    self.camera,
                    ("get_latest_image", "get_nearest_image", "get_camera_intrinsic", "close_camera"),
                ),
                (self.tf, ("get_all_tf_from_base_link",)),
                (self.slam, ("get_odom_info",)),
                (self.map, ("get_curr_map",)),
            ]
            for owner, names in required:
                for name in names:
                    if not callable(getattr(owner, name, None)):
                        raise RobotError("sdk_capability", f"SDK 缺少手册接口 {name}")
            # Both names appear in this manual; select before issuing any command.
            self.joint_method = next(
                (
                    n
                    for n in ("joint_control_request", "joint_control")
                    if callable(getattr(self.robot, n, None))
                ),
                "",
            )
            if not self.joint_method:
                raise RobotError("sdk_capability", "SDK 缺少 JointControlReq 接口")
            await asyncio.sleep(self.profile.startup_delay)
            await self._guard()
            await self._check_map()
            self.online = True
        except BaseException:
            await self.close()
            raise

    async def close(self):
        # Never release the SDK under an active native call.
        if self.pending:
            async with asyncio.timeout(self.profile.sdk_call_timeout):
                await asyncio.shield(asyncio.gather(*self.pending, return_exceptions=True))
        if self.initialized:
            camera = getattr(self, "camera", None)
            if camera is not None:
                await self._call(camera.close_camera)
            for attr in ("robot", "camera", "tf", "slam", "pnc", "map"):
                if hasattr(self, attr):
                    delattr(self, attr)
            del camera
            self._success(await self._call(self.sdk.gdk_release))
            self.initialized = False
        self.online = False
        self.executor.shutdown(wait=False, cancel_futures=True)

    def _fresh(self, timestamp):
        age = (time.time_ns() - int(timestamp) - self.profile.timestamp_offset_ns) / 1e9
        if not 0 <= age <= self.profile.feedback_max_age:
            raise RobotError("stale_feedback", "SDK 状态时间戳过期或时钟未映射")

    async def _joints(self):
        raw = await self._call(self.robot.get_joint_states)
        self._fresh(field(raw, "timestamp"))
        states = {field(j, "name"): j for j in field(raw, "states")}
        if not JOINT_LIMITS.keys() <= states.keys():
            raise RobotError("joint_feedback", "关节状态不完整，无法验证动作或停止")
        for joint in states.values():
            if field(joint, "error_code") or not all(
                math.isfinite(float(field(joint, key))) for key in ("position", "velocity")
            ):
                raise RobotError("joint_feedback", "关节反馈有故障或非法数值")
        return int(field(raw, "timestamp")), states

    async def _guard(self):
        body = await self._call(self.robot.get_whole_body_status)
        self._fresh(field(body, "timestamp"))
        errors = (
            "right_arm_error",
            "left_arm_error",
            "right_arm_estop",
            "left_arm_estop",
            "right_end_error",
            "left_end_error",
            "waist_error",
            "lift_error",
            "neck_error",
            "chassis_error",
        )
        if any(field(body, key) for key in errors):
            raise RobotError("robot_fault", "机器人故障或急停状态，拒绝运动")
        motion = await self._call(self.robot.get_motion_control_status)
        if (
            field(motion, "error_code")
            or field(motion, "collision_pairs_1")
            or field(motion, "collision_pairs_2")
        ):
            raise RobotError("motion_fault", "运动控制器报告故障或碰撞")
        return await self._joints()

    async def health(self):
        await self._guard()
        return {
            "online": self.online,
            "holding": await self.is_holding(),
            "stopped": self.stopped,
            "name": self.name,
            "mode": self.mode,
        }

    async def _check_map(self):
        current = await self._call(self.map.get_curr_map)
        if not field(current, "is_curr_map") or int(field(current, "id")) != self.profile.map_id:
            raise RobotError("wrong_map", "当前地图与标定地图不一致")

    async def _odom(self):
        odom = await self._call(self.slam.get_odom_info)
        if field(odom, "loc_state") != 1 or field(odom, "is_sliping"):
            raise RobotError("localization", "定位丢失或底盘打滑")
        pose = field(field(odom, "pose"), "pose")
        position, _ = pose_components(pose)
        return position, yaw_of(pose), bool(field(odom, "is_stationary"))

    async def _settle(self, check, *, guard=True):
        count, last_stamp = 0, -1
        async with asyncio.timeout(self.profile.action_timeout):
            while True:
                stamp, _ = await (self._guard() if guard else self._joints())
                good = await check()
                if stamp > last_stamp:
                    count = count + 1 if good else 0
                    last_stamp = stamp
                if count >= self.profile.settled_samples:
                    return MotionResult(True)
                await asyncio.sleep(self.profile.poll_interval)

    async def prepare(self, item: Item):
        if item.id not in self.profile.grasps:
            raise RobotError("grasp_profile", f"没有 {item.id} 的标定抓取模板")
        await self._check_map()
        await self._guard()
        _, _, stationary = await self._odom()
        end = await self._end(self.profile.arm)
        if (
            not stationary
            or abs(field(end, "position") - self.profile.gripper.open_position)
            > self.profile.gripper.position_tolerance
        ):
            raise RobotError("not_ready", "任务开始需要静止底盘和已确认打开的空夹爪")
        self.item, self.take_verified = item, False
        return await self.arm_move("stow")

    def _sdk_pose(self, target, xyz, quaternion):
        for key, value in zip("xyz", xyz):
            setattr(target.position, key, float(value))
        for key, value in zip("xyzw", quaternion):
            setattr(target.orientation, key, float(value))

    async def _navigate(self, method, x, y, yaw, *, relative=False):
        if self.stage not in {"stow", "carry"}:
            raise RobotError("arm_not_stowed", "底盘运动前必须确认收臂")
        await self._check_map()
        await self._guard()
        position, heading, stationary = await self._odom()
        if not stationary:
            raise RobotError("base_moving", "新导航前底盘尚未静止")
        c, s = math.cos(heading), math.sin(heading)
        goal = (
            (position[0] + c * x - s * y, position[1] + s * x + c * y, heading + yaw)
            if relative
            else (x, y, yaw)
        )
        tx, ty, tyaw = x, y, yaw
        if not relative and self.profile.navigation_frame == "base_link":
            dx, dy = x - position[0], y - position[1]
            tx, ty, tyaw = c * dx + s * dy, -s * dx + c * dy, yaw - heading
        req = self.sdk.NaviReq()
        self._sdk_pose(req.target, (tx, ty, 0), (0, 0, math.sin(tyaw / 2), math.cos(tyaw / 2)))
        old = await self._call(self.pnc.get_task_state)
        if int(field(old, "state")) not in {0, 7, 8, 9}:
            raise RobotError("pnc_busy", "PNC 已有未结束任务")
        old_id, seen_new = int(field(old, "id")), False
        error = float("inf")
        await self._command(self.pnc, method, req, {"x": tx, "y": ty, "yaw": tyaw})

        async def arrived():
            nonlocal seen_new, error
            state = await self._call(self.pnc.get_task_state)
            code = int(field(state, "state"))
            seen_new |= int(field(state, "id")) != old_id or code in {1, 2}
            if seen_new and code in {7, 8}:
                raise RobotError("navigation_failed", str(field(state, "message")))
            current, angle, still = await self._odom()
            error = float(np.linalg.norm(current[:2] - np.array(goal[:2])))
            return (
                seen_new
                and code == 9
                and still
                and error <= self.settings.navigation_tolerance
                and angle_error(angle, goal[2]) <= self.profile.angle_tolerance
            )

        await self._settle(arrived)
        return MotionResult(True, error_m=error)

    async def navigate(self, waypoint: Waypoint):
        self._waypoint_map(waypoint)
        return await self._navigate("normal_navi", waypoint.x, waypoint.y, waypoint.yaw)

    async def high_precision_navi(self, waypoint: Waypoint):
        self._waypoint_map(waypoint)
        return await self._navigate("high_precision_navi", waypoint.x, waypoint.y, waypoint.yaw)

    def _waypoint_map(self, waypoint):
        if str(self.profile.map_id) != waypoint.map_id:
            raise RobotError("wrong_map", "目标点不属于当前标定地图；示例地图不能用于实机")

    async def relative_move(self, dx, dy, dyaw):
        if (
            not all(math.isfinite(v) for v in (dx, dy, dyaw))
            or max(abs(dx), abs(dy)) > self.settings.max_lateral_move
        ):
            raise RobotError("alignment_limit", "相对运动超出限制")
        return await self._navigate("relative_move", dx, dy, dyaw, relative=True)

    async def _joint_move(self, positions, *, stopping=False):
        for joint, value in positions.items():
            if joint not in JOINT_LIMITS or not JOINT_LIMITS[joint][0] <= value <= JOINT_LIMITS[joint][1]:
                raise RobotError("joint_limit", f"关节 {joint} 超出手册限位")
        req = self.sdk.JointControlReq()
        req.joint_names = list(positions)
        req.joint_positions = list(positions.values())
        req.joint_velocities = [0.0] * len(positions)
        req.life_time = self.profile.command_lifetime
        req.detail = "bluesword measured hold" if stopping else "bluesword calibrated observation"
        await self._command(self.robot, self.joint_method, req, {"positions": positions}, stopping=stopping)

        async def settled():
            _, joints = await self._joints()
            return all(
                abs(field(joints[k], "position") - v) <= self.profile.joint_tolerance
                and abs(field(joints[k], "velocity")) <= self.profile.velocity_tolerance
                for k, v in positions.items()
            )

        return await self._settle(settled, guard=not stopping)

    async def observe(self, yaw, pitch, waist_m):
        names = {
            (0, 0, 0): "center",
            (-0.15, 0, 0): "left",
            (0.15, 0, 0.12): "upper",
            (0, 0.10, -0.10): "lower",
        }
        key = names.get((yaw, pitch, waist_m))
        if key is None:
            raise RobotError("observation_profile", "搜索位置没有标定；不能把腰部米数直接当作关节弧度")
        await self._guard()
        return await self._joint_move(self.profile.observations[key])

    async def capture(self):
        color = await self._call(self.camera.get_latest_image, self.sdk.CameraType.kHeadColor, 1000)
        depth = await self._call(
            self.camera.get_nearest_image, self.sdk.CameraType.kHeadDepth, field(color, "timestamp_ns"), 1000
        )
        intrinsic = await self._call(self.camera.get_camera_intrinsic, self.sdk.CameraType.kHeadColor)
        depth_intrinsic = None
        if not self.profile.camera_registered_rectified:
            depth_intrinsic = await self._call(
                self.camera.get_camera_intrinsic, self.sdk.CameraType.kHeadDepth
            )
        transforms = await self._call(self.tf.get_all_tf_from_base_link)
        matching = [
            t
            for t in transforms
            if field(t, "child_frame_id") == self.profile.optical_frame
            and field(t, "frame_id") == "base_link"
        ]
        if not matching:
            raise RobotError("tf_missing", "未找到带时间戳的 base_link → 光学坐标系 TF")
        stamped = min(matching, key=lambda t: abs(field(t, "timestamp_ns") - field(color, "timestamp_ns")))
        depth_tf = None
        if not self.profile.camera_registered_rectified:
            depth_matching = [
                t
                for t in transforms
                if field(t, "frame_id") == "base_link"
                and field(t, "child_frame_id") == self.profile.depth_optical_frame
            ]
            if not depth_matching:
                raise RobotError("tf_missing", "原始 RGB-D 缺少深度光学坐标系 TF")
            depth_tf = min(
                depth_matching, key=lambda t: abs(field(t, "timestamp_ns") - field(depth, "timestamp_ns"))
            )
        frame = await asyncio.to_thread(
            make_frame, color, depth, intrinsic, stamped, self.profile, depth_intrinsic, depth_tf
        )
        self._fresh(field(color, "timestamp_ns"))
        return frame

    async def arm_move(self, stage: str, target: Point | None = None):
        if stage in self.profile.poses:
            pose = self.profile.poses[stage]
        elif stage in {"pregrasp", "approach", "lift", "retreat"} and target is not None and self.item:
            grasp = self.profile.grasps[self.item.id]
            pose = Pose(
                position=tuple(target.array() + np.array(grasp.offset_base_m)), quaternion=grasp.quaternion
            )
        else:
            raise RobotError("arm_profile", "缺少此阶段的末端位姿")
        await self._guard()
        req = self.sdk.EndEffectorPose()
        req.life_time = self.profile.command_lifetime
        req.group = getattr(
            self.sdk.EndEffectorControlGroup, "kLeftArm" if self.profile.arm == "left" else "kRightArm"
        )
        self._sdk_pose(getattr(req, f"{self.profile.arm}_end_effector_pose"), pose.position, pose.quaternion)
        await self._command(
            self.robot, "end_effector_pose_control", req, {"stage": stage, **pose.model_dump()}
        )

        async def settled():
            status = await self._call(self.robot.get_motion_control_status)
            names = list(field(status, "frame_names"))
            if self.profile.end_effector_frame not in names:
                raise RobotError("ee_frame", "末端反馈中缺少标定坐标系")
            current = field(status, "frame_poses")[names.index(self.profile.end_effector_frame)]
            position, q = pose_components(current)
            rotation_error = 2 * math.acos(min(1.0, abs(float(np.dot(q, pose.quaternion)))))
            _, joints = await self._joints()
            side = "_arm_l_" if self.profile.arm == "left" else "_arm_r_"
            still = all(
                abs(field(v, "velocity")) <= self.profile.velocity_tolerance
                for k, v in joints.items()
                if side in k
            )
            return (
                np.linalg.norm(position - np.array(pose.position)) <= self.profile.position_tolerance
                and rotation_error <= self.profile.angle_tolerance
                and still
            )

        result = await self._settle(settled)
        self.stage = stage
        if stage == "handover":
            self.take_verified = False
        return result

    async def _end(self, side):
        state = field(await self._call(self.robot.get_end_state), f"{side}_end_state")
        if not field(state, "controlled"):
            raise RobotError("gripper_feedback", "夹爪未受控")
        # The other gripper is required to be a single-joint device as well:
        # move_ee_pos has one scalar per side, so a multi-joint hand needs its own driver.
        values = field(state, "end_states")
        if len(values) != 1 or self.profile.gripper.state_index != 0:
            raise RobotError("gripper_model", "此适配器只支持双侧单关节夹爪")
        value = values[0]
        if (
            not field(value, "enable")
            or field(value, "err_code")
            or not all(math.isfinite(float(field(value, k))) for k in ("position", "velocity", "effort"))
        ):
            raise RobotError("gripper_feedback", "夹爪反馈异常")
        return value

    def _contact(self, value):
        profile = self.profile.gripper
        return (
            profile.contact_position[0] <= field(value, "position") <= profile.contact_position[1]
            and abs(field(value, "effort")) >= profile.min_contact_effort
            and abs(field(value, "velocity")) <= profile.velocity_tolerance
        )

    async def is_holding(self):
        return self._contact(await self._end(self.profile.arm))

    async def gripper(self, closed: bool):
        await self._guard()
        if not closed and (self.grasp_confirmed or await self.is_holding()):
            if not self.take_verified or not 0 <= time.time_ns() - self.take_timestamp_ns <= 2_000_000_000:
                raise RobotError("release_unverified", "没有本次接物证据，拒绝松开持物夹爪")
        profile = self.profile.gripper
        target = profile.closed_position if closed else profile.open_position
        other_side = "left" if self.profile.arm == "right" else "right"
        other = await self._end(other_side)
        req = {
            f"{self.profile.arm}_ee_state": {"joint_position": target},
            f"{other_side}_ee_state": {"joint_position": float(field(other, "position"))},
        }
        await self._command(self.robot, "move_ee_pos", req, req)

        async def settled():
            end = await self._end(self.profile.arm)
            return (
                self._contact(end)
                if closed
                else (
                    abs(field(end, "position") - target) <= profile.position_tolerance
                    and abs(field(end, "velocity")) <= profile.velocity_tolerance
                )
            )

        result = await self._settle(settled)
        if closed:
            self.take_verified = False
            self.grasp_confirmed = True
        else:
            self.released = True
            self.grasp_confirmed = False
        return result

    async def wait_for_take(self):
        if self.stage != "handover" or not await self.is_holding():
            raise RobotError("handover_state", "递物姿态或持物反馈无效")
        since = time.time_ns()
        pending = asyncio.create_task(self.take_sensor.wait_for_take(since_ns=since))
        try:
            while not pending.done():
                await self._guard()
                if not await self.is_holding():
                    raise RobotError("object_lost", "等待接物期间持物反馈丢失")
                await asyncio.wait({pending}, timeout=self.profile.poll_interval)
            signal = await pending
        finally:
            if not pending.done():
                pending.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pending
        if (
            not isinstance(signal, TakeSignal)
            or not signal.supported
            or not since <= signal.timestamp_ns <= time.time_ns()
            or time.time_ns() - signal.timestamp_ns > 2_000_000_000
        ):
            raise RobotError("take_unverified", "接物传感器未返回本次有效支撑证据")
        self.take_verified = True
        self.take_timestamp_ns = signal.timestamp_ns
        return signal

    async def stop(self):
        self.stopped = True
        if self.pending:
            async with asyncio.timeout(self.profile.sdk_call_timeout):
                await asyncio.shield(asyncio.gather(*self.pending, return_exceptions=True))
        await self._command(self.pnc, "cancel_task", None, {}, stopping=True)
        _, joints = await self._joints()
        # Explicitly excludes end-effector joints: no gripper release on failure.
        await self._joint_move({k: float(field(joints[k], "position")) for k in JOINT_LIMITS}, stopping=True)

        async def stopped():
            state = await self._call(self.pnc.get_task_state)
            _, _, stationary = await self._odom()
            return int(field(state, "state")) in {0, 7, 8, 9} and stationary

        await self._settle(stopped, guard=False)
