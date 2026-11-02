"""A paced GDK mock with a read-only Blender visualization stream.

This is command/kinematic visualization, not contact or sensor simulation.
The renderer never owns the task or supplies fabricated hardware feedback.
"""

import asyncio
import copy
import math
import time

from .config import Settings, load_scene
from .demo_perception import DemoPerceptionSDK
from .demo_trace import DemoTrace
from .domain import RobotError, TakeSignal
from .gdk_v223.fake import FakeSdk, fake_profile, sdk_pose
from .gdk_v223.profile import Pose
from .gdk_v223.robot import GdkRobot
from .ports import RobotBundle


class SceneState:
    def __init__(self, speed=1.0):
        self.speed = speed
        self.trace = DemoTrace()
        self.seq = 0
        self.reset()

    def reset(self):
        self.trace.reset()
        self.value = {
            "base": [0.0, 0.0, 0.0],
            "tcp": [0.3, -0.28, 1.05],
            "head_yaw": 0.0,
            "waist": 0.0,
            "grip": 0.0,
        }
        self.source = copy.deepcopy(self.value)
        self.start = time.monotonic()
        self.duration = 0.0
        self.command = "ready"
        self.arguments = {}
        self.stage = "ready"
        self.item_id, self.item_name = "oreo", "奥利奥"
        self.held = self.delivered = self.awaiting_take = self.stopped = False
        self.seq += 1

    def sample(self):
        fraction = min(1.0, max(0.0, (time.monotonic() - self.start) / max(self.duration, 1e-9)))
        blend = fraction * fraction * (3 - 2 * fraction)
        result = {}
        for key, target in self.value.items():
            source = self.source[key]
            result[key] = (
                [a + (b - a) * blend for a, b in zip(source, target)]
                if isinstance(target, list)
                else source + (target - source) * blend
            )
        return {
            **result,
            "seq": self.seq,
            "command": self.command,
            "arguments": self.arguments,
            "stage": self.stage,
            "progress": fraction,
            "held": self.held,
            "delivered": self.delivered,
            "awaiting_take": self.awaiting_take,
            "stopped": self.stopped,
            "item_id": self.item_id,
            "item_name": self.item_name,
            "shelf_object": [2.65, -0.32, 1.02],
            "mode": "gdk_mock",
            "model": "AGIBOT Genie G2 crsB / swiftpicker",
            "at": time.time(),
            "trace": self.trace.snapshot(),
        }

    def begin(self, method, audit):
        current = self.sample()
        self.source = {key: current[key] for key in self.value}
        self.value = copy.deepcopy(self.source)
        duration = 0.0
        self.command, self.arguments = method, copy.deepcopy(audit)
        if method in {"normal_navi", "high_precision_navi", "relative_move"}:
            x, y, yaw = audit["x"], audit["y"], audit["yaw"]
            if method == "relative_move":
                bx, by, angle = self.value["base"]
                x, y, yaw = (
                    bx + math.cos(angle) * x - math.sin(angle) * y,
                    by + math.sin(angle) * x + math.cos(angle) * y,
                    angle + yaw,
                )
            distance = math.dist(self.value["base"][:2], [x, y])
            self.value["base"] = [x, y, yaw]
            duration = max(0.8, distance / 0.48)
            self.stage = (
                "navigate"
                if method == "normal_navi"
                else "precision"
                if method == "high_precision_navi"
                else "align"
            )
        elif method == "end_effector_pose_control":
            self.value["tcp"] = list(audit["position"])
            self.stage = audit["stage"]
            duration = 1.1 if self.stage not in {"handover", "carry"} else 1.5
        elif method in {"joint_control_request", "joint_control"} and not self.stopped:
            joints = audit["positions"]
            self.value["head_yaw"] = joints.get("idx11_head_joint1", self.value["head_yaw"])
            self.value["waist"] = joints.get("idx02_body_joint2", self.value["waist"])
            self.stage, duration = "scan", 1.2
        elif method == "move_ee_pos":
            self.value["grip"] = audit["right_ee_state"]["joint_position"]
            self.stage, duration = ("close_gripper" if self.value["grip"] else "open_gripper"), 0.65
        self.duration = duration / self.speed
        self.start = time.monotonic()
        self.seq += 1
        return self.duration

    def freeze(self):
        current = self.sample()
        self.value = {key: current[key] for key in self.value}
        self.source = copy.deepcopy(self.value)
        self.duration = 0
        self.stopped = True
        self.awaiting_take = False
        self.command, self.stage = "cancel_task", "stopped"
        self.seq += 1
        return current


class SimTakeSensor:
    def __init__(self, scene, settings):
        self.scene, self.settings = scene, settings
        self.taken = asyncio.Event()

    def confirm(self):
        if not self.scene.awaiting_take:
            raise RobotError("not_handing_over", "机器人尚未进入递物等待阶段")
        self.taken.set()

    async def wait_for_take(self, *, since_ns):
        self.taken.clear()
        self.scene.awaiting_take = True
        self.scene.command = "wait_for_take"
        self.scene.stage = "waiting_for_take"
        self.scene.seq += 1
        trace = self.scene.trace
        entry = trace.begin("sensor", "HandoverSensor.wait_for_take", "等待用户接稳 · 模拟传感器",
                            {"mode": "自动示例反馈" if self.settings.auto_take else "网页按钮确认"})
        try:
            if self.settings.auto_take and self.settings.scenario != "handover_timeout":
                try:
                    await asyncio.wait_for(self.taken.wait(), 2.0 / self.scene.speed)
                except TimeoutError:
                    pass
            else:
                await self.taken.wait()
            signal = TakeSignal(True, time.time_ns(), "Blender demo: simulated support signal")
            trace.finish(entry, {"supported": True, "timestamp_ns": signal.timestamp_ns,
                                 "source": "模拟接物确认"})
            return signal
        except BaseException as exc:
            trace.fail(entry, exc)
            raise
        finally:
            self.scene.awaiting_take = False


class SimulationRobot(GdkRobot):
    name = "Genie G2 · Blender / GDK 模拟联动"
    mode = "gdk_mock"
    supports_mock_controls = True

    def __init__(self, sdk, profile, settings, waypoints):
        self.scene = SceneState(settings.simulation_speed)
        sensor = SimTakeSensor(self.scene, settings)
        super().__init__(sdk, profile, settings, sensor)
        self.scene_waypoints = waypoints
        self.motion_entry = None

    async def _call(self, function, *args, **kwargs):
        name = function.__name__
        # Show sensor inputs; omit repetitive safety polling from the presentation.
        if name not in {"get_latest_image", "get_nearest_image", "get_camera_intrinsic",
                        "get_all_tf_from_base_link"}:
            return await super()._call(function, *args, **kwargs)
        owner = "TF" if name.startswith("get_all_tf") else "Camera"
        titles = {"get_latest_image": "采集头部 RGB 图像", "get_nearest_image": "获取同步深度图",
                  "get_camera_intrinsic": "读取相机内参", "get_all_tf_from_base_link": "读取坐标变换"}
        entry = self.scene.trace.begin("gdk", owner + "." + name, titles[name], {"args": list(args)})
        try:
            result = await super()._call(function, *args, **kwargs)
            if owner == "TF":
                summary = {"transforms": [{"from": t.frame_id, "to": t.child_frame_id,
                                          "timestamp_ns": t.timestamp_ns} for t in result]}
            elif name == "get_camera_intrinsic":
                summary = {"intrinsic": result.intrinsic, "distortion": result.distortion}
            else:
                summary = {k: getattr(result, k) for k in ("width", "height", "encoding", "timestamp_ns")}
            self.scene.trace.finish(entry, summary)
            return result
        except BaseException as exc:
            self.scene.trace.fail(entry, exc)
            raise

    async def _command(self, owner, method, argument, audit, *, stopping=False):
        prefix = "Pnc" if method in {"normal_navi", "high_precision_navi", "relative_move", "cancel_task"} else "Robot"
        titles = {"normal_navi": "下发地图导航", "high_precision_navi": "下发高精度停靠",
                  "relative_move": "横移调整可达范围", "end_effector_pose_control": "下发手臂末端位姿",
                  "move_ee_pos": "控制夹爪", "joint_control_request": "控制头部 / 腰部关节",
                  "cancel_task": "取消导航任务"}
        trace = self.scene.trace
        entry = trace.begin("gdk", prefix + "." + method, titles.get(method, method), audit)
        self.motion_entry = None if stopping else entry
        try:
            result = await super()._command(owner, method, argument, audit, stopping=stopping)
            trace.accepted(entry, {"return": result, "meaning": "请求已接受；等待动作反馈"})
            if stopping:
                trace.finish(entry, feedback={"request_accepted": True})
            else:
                duration = self.scene.begin(method, audit)
                await asyncio.sleep(duration)
                if method == "move_ee_pos":
                    closed = bool(audit["right_ee_state"]["joint_position"])
                    if closed:
                        self.scene.held = self.sdk.effort > 0
                    elif self.scene.held:
                        self.scene.held, self.scene.delivered = False, True
        except BaseException as exc:
            trace.fail(entry, exc)
            self.motion_entry = None
            raise

    async def _settle(self, check, *, guard=True):
        entry = self.motion_entry
        try:
            result = await super()._settle(check, guard=guard)
            if entry:
                feedback_api = ("Pnc.get_task_state + Slam.get_odom_info" if entry["name"].startswith("Pnc.")
                                else "Robot.get_end_state" if entry["name"].endswith("move_ee_pos")
                                else "Robot.get_motion_control_status + get_joint_states")
                self.scene.trace.finish(entry, feedback={"completed": result.completed,
                                                         "verified_by": feedback_api,
                                                         "source": "FakeSdk 模拟反馈"})
            return result
        except BaseException as exc:
            if entry:
                self.scene.trace.fail(entry, exc)
            raise
        finally:
            self.motion_entry = None

    async def prepare(self, item):
        self.scene.item_id, self.scene.item_name = item.id, item.name
        self.scene.delivered = False
        self.sdk.lateral = 0
        return await super().prepare(item)

    async def stop(self):
        current = self.scene.freeze()
        # Keep the synthetic SDK and visible partial movement consistent at cancel.
        self.sdk.base = sdk_pose(*current["base"][:2], yaw=current["base"][2])
        self.sdk.ee = sdk_pose(*current["tcp"])
        self.scene.held = self.sdk.effort > 0
        await super().stop()

    def confirm_take(self):
        self.take_sensor.confirm()

    def recover(self):
        self.sdk.__init__(self.profile, self.settings.scenario)
        self.sdk.initialized = True
        self.stopped = self.grasp_confirmed = self.take_verified = False
        self.item = self.stage = None
        self.motion_entry = None
        self.scene.reset()


def create_simulation_bundle(settings: Settings):
    waypoints, items = load_scene()
    # This scene represents the provided exhibition layout, not arbitrary real maps.
    waypoints = {key: value.model_copy(update={"map_id": "1"}) for key, value in waypoints.items()}
    profile = fake_profile(items)
    for stage, position in {
        "stow": (0.3, -0.28, 1.05),
        "carry": (0.35, -0.28, 1.08),
        "handover": (0.6, -0.18, 1.1),
    }.items():
        profile.poses[stage] = Pose(position=position, quaternion=(0, 0, 0, 1))
    profile.action_timeout = max(1, settings.motion_timeout * 0.8)
    profile.sdk_call_timeout = 2
    sdk = FakeSdk(profile, settings.scenario)
    robot = SimulationRobot(sdk, profile, settings, waypoints)
    return RobotBundle(robot, DemoPerceptionSDK(sdk, robot.scene))
