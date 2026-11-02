"""API-shaped test double. Synthetic calibration MUST NOT be used on hardware.

Unlike MockRobot this replaces agibot_gdk, so tests exercise the real adapter's
request types, units, polling, decoding and completion checks.
"""

import asyncio
import copy
import math
import time
from types import SimpleNamespace as NS

import numpy as np

from ..config import Settings, load_scene
from ..domain import Detection, TakeSignal
from ..ports import RobotBundle
from .geometry import pose_components, yaw_of
from .profile import JOINT_LIMITS, Profile
from .robot import GdkRobot


def sdk_pose(x=0, y=0, z=0, yaw=0):
    return NS(position=NS(x=x, y=y, z=z), orientation=NS(x=0, y=0, z=math.sin(yaw / 2), w=math.cos(yaw / 2)))


def fake_profile(items):
    return Profile(
        calibrated=True,
        map_id=1,
        navigation_frame="map",
        arm="right",
        end_effector_frame="fake_right_tcp",
        optical_frame="fake_head_color_optical",
        camera_registered_rectified=True,
        depth_unit_m=0.001,
        timestamp_offset_ns=0,
        gripper={
            "state_index": 0,
            "open_position": 0,
            "closed_position": 1,
            "contact_position": (0.3, 0.7),
            "min_contact_effort": 0.2,
            "position_tolerance": 0.01,
            "velocity_tolerance": 0.01,
        },
        poses={
            k: {"position": p, "quaternion": (0, 0, 0, 1)}
            for k, p in {
                "stow": (0.2, -0.2, 0.8),
                "carry": (0.25, -0.2, 0.9),
                "handover": (0.6, 0, 1),
            }.items()
        },
        grasps={k: {"offset_base_m": (0, 0, 0), "quaternion": (0, 0, 0, 1)} for k in items},
        observations={
            k: {"idx11_head_joint1": yaw, "idx02_body_joint2": waist}
            for k, yaw, waist in [("center", 0, 0), ("left", -0.15, 0), ("upper", 0.15, 0.1), ("lower", 0, 0)]
        },
        startup_delay=0,
        poll_interval=0.001,
        settled_samples=2,
        action_timeout=0.15,
        sdk_call_timeout=0.2,
    )


class FakeSdk:
    GDKRes = NS(kSuccess=0)
    CameraType = NS(kHeadColor=1, kHeadDepth=2)
    EndEffectorControlGroup = NS(kLeftArm=4, kRightArm=8, kBothArms=12)

    class NaviReq:
        def __init__(self):
            self.target = sdk_pose()

    class JointControlReq:
        pass

    class EndEffectorPose:
        def __init__(self):
            self.left_end_effector_pose, self.right_end_effector_pose = sdk_pose(), sdk_pose()

    def __init__(self, profile, scenario="success"):
        self.profile, self.scenario = profile, scenario
        self.calls = []
        self.initialized = self.released = False
        self.base = sdk_pose()
        self.joints = {name: 0.0 for name in JOINT_LIMITS}
        self.ee = sdk_pose(*profile.poses["stow"].position)
        self.ends = {"left": 0.12, "right": 0.0}
        self.effort = 0
        self.pnc_state = NS(id=0, state=0, type=0, message="idle")
        self.target = None
        self.nav_polls = 0
        self.color_stamp = 0
        self.lateral = 0.0
        self.relative_calls = 0
        self.capture_count = 0

    def record(self, name, req=None):
        self.calls.append((name, copy.deepcopy(req)))

    def gdk_init(self):
        self.initialized = True
        self.record("gdk_init")
        return 0

    def gdk_release(self):
        self.record("gdk_release")
        self.released = True
        return 0

    def Robot(self):
        return FakeRobot(self)

    def Pnc(self):
        return FakePnc(self)

    def Slam(self):
        return FakeSlam(self)

    def Camera(self):
        return FakeCamera(self)

    def TF(self):
        return FakeTF(self)

    def Map(self):
        return FakeMap(self)


class FakeRobot:
    def __init__(self, sdk):
        self.s = sdk

    def get_joint_states(self):
        stamp = time.time_ns() - (10_000_000_000 if self.s.scenario == "stale_feedback" else 0)
        return {
            "timestamp": stamp,
            "nums": len(self.s.joints),
            "states": [
                {"name": k, "position": v, "velocity": 0, "error_code": 0} for k, v in self.s.joints.items()
            ],
        }

    def get_whole_body_status(self):
        return {
            "timestamp": time.time_ns(),
            **{
                key: 0
                for key in (
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
            },
        }

    def get_motion_control_status(self):
        return NS(
            frame_names=[self.s.profile.end_effector_frame],
            frame_poses=[copy.deepcopy(self.s.ee)],
            error_code=0,
            error_msg="",
            collision_pairs_1=[],
            collision_pairs_2=[],
            mode=5,
        )

    def get_end_state(self):
        return {
            f"{side}_end_state": {
                "controlled": True,
                "end_states": [
                    {
                        "position": value,
                        "velocity": 0,
                        "effort": self.s.effort if side == "right" else 0,
                        "enable": True,
                        "err_code": 0,
                    }
                ],
            }
            for side, value in self.s.ends.items()
        }

    def move_ee_pos(self, req):
        self.s.record("move_ee_pos", req)
        for side in self.s.ends:
            value = req[f"{side}_ee_state"]["joint_position"]
            if side == "right" and value == self.s.profile.gripper.closed_position:
                self.s.ends[side] = value if self.s.scenario == "grasp_failure" else 0.5
                self.s.effort = 0 if self.s.scenario == "grasp_failure" else 0.4
            else:
                self.s.ends[side] = value
                if side == "right":
                    self.s.effort = 0
        return 0

    def joint_control_request(self, req):
        self.s.record("joint_control_request", req)
        self.s.joints.update(zip(req.joint_names, req.joint_positions))
        return 0

    def end_effector_pose_control(self, req):
        self.s.record("end_effector_pose_control", req)
        if self.s.scenario != "arm_stall":
            self.s.ee = copy.deepcopy(req.right_end_effector_pose)
        return 0


class FakePnc:
    def __init__(self, sdk):
        self.s = sdk

    def get_task_state(self):
        self.s.nav_polls += 1
        if self.s.pnc_state.state == 2 and self.s.nav_polls >= 2:
            self.s.pnc_state.state = 8 if self.s.scenario == "nav_failure" else 9
            if self.s.pnc_state.state == 9:
                self.s.base = self.s.target
        return copy.deepcopy(self.s.pnc_state)

    def _move(self, method, req):
        self.s.record(method, req)
        if self.s.scenario == "old_nav_success":
            return
        relative = method == "relative_move" or self.s.profile.navigation_frame == "base_link"
        if relative:
            p, _ = pose_components(self.s.base)
            heading = yaw_of(self.s.base)
            t, _ = pose_components(req.target)
            x, y = (
                p[0] + math.cos(heading) * t[0] - math.sin(heading) * t[1],
                p[1] + math.sin(heading) * t[0] + math.cos(heading) * t[1],
            )
            self.s.target = sdk_pose(x, y, 0, heading + yaw_of(req.target))
        else:
            self.s.target = copy.deepcopy(req.target)
        if method == "relative_move":
            self.s.relative_calls += 1
            self.s.lateral += req.target.position.y
        self.s.pnc_state = NS(id=self.s.pnc_state.id + 1, state=2, type=1, message="fake navigation")
        self.s.nav_polls = 0

    def normal_navi(self, req):
        self._move("normal_navi", req)

    def high_precision_navi(self, req):
        self._move("high_precision_navi", req)

    def relative_move(self, req):
        self._move("relative_move", req)

    def cancel_task(self):
        self.s.record("cancel_task")
        self.s.pnc_state.state = 7


class FakeSlam:
    def __init__(self, sdk):
        self.s = sdk

    def get_odom_info(self):
        return NS(
            pose=NS(pose=copy.deepcopy(self.s.base)),
            loc_state=1,
            is_sliping=False,
            is_stationary=self.s.pnc_state.state not in {1, 2},
        )


class FakeMap:
    def __init__(self, sdk):
        self.s = sdk

    def get_curr_map(self):
        return NS(id=self.s.profile.map_id, name="SYNTHETIC MAP", is_curr_map=True)


class FakeCamera:
    def __init__(self, sdk):
        self.s = sdk

    def get_latest_image(self, camera_type, timeout_ms):
        assert camera_type == FakeSdk.CameraType.kHeadColor
        self.s.color_stamp = time.time_ns()
        self.s.capture_count += 1
        return NS(
            timestamp_ns=self.s.color_stamp,
            width=640,
            height=480,
            encoding="rgb8",
            color_format="RGB",
            bit_depth=8,
            data=np.zeros((480, 640, 3), dtype=np.uint8),
        )

    def get_nearest_image(self, camera_type, timestamp_ns, timeout_ms):
        assert camera_type == FakeSdk.CameraType.kHeadDepth and timestamp_ns == self.s.color_stamp
        return NS(
            timestamp_ns=timestamp_ns,
            width=640,
            height=480,
            encoding="mono16",
            color_format="GRAY16",
            bit_depth=16,
            data=np.full((480, 640), 650, dtype=np.uint16),
        )

    def get_camera_intrinsic(self, camera_type):
        return NS(intrinsic=[500.0, 500.0, 320.0, 240.0], distortion=[0, 0, 0, 0, 0])

    def close_camera(self):
        self.s.record("close_camera")


class FakeTF:
    def __init__(self, sdk):
        self.s = sdk

    def get_all_tf_from_base_link(self):
        stamp = self.s.color_stamp + (100_000_000 if self.s.scenario == "tf_unsynced" else 0)
        return [
            NS(
                frame_id="base_link",
                child_frame_id=self.s.profile.optical_frame,
                timestamp_ns=stamp,
                transform=NS(translation=NS(x=0, y=0, z=1.2), rotation=NS(x=0.5, y=-0.5, z=0.5, w=-0.5)),
            )
        ]


class FakeDetector:
    def __init__(self, sdk):
        self.s = sdk

    async def detect(self, frame, item):
        # Only this synthetic detector has access to simulator ground truth.
        y = 0.32 - self.s.lateral
        u, v = 320 - 500 * y / 0.65, 240 + 500 * 0.18 / 0.65
        return (
            [Detection(item.id, item.name, 0.98, (u / 640 - 0.04, v / 480 - 0.04, 0.08, 0.08))]
            if item
            else []
        )


class FakeTakeSensor:
    def __init__(self, scenario):
        self.scenario = scenario

    async def wait_for_take(self, *, since_ns):
        if self.scenario == "handover_timeout":
            await asyncio.Event().wait()
        if self.scenario == "stale_take":
            return TakeSignal(True, since_ns - 1, "FAKE stale sensor")
        return TakeSignal(True, time.time_ns(), "FAKE support sensor")


def create_fake_bundle(settings: Settings, scenario="success"):
    waypoints, items = load_scene()
    profile = fake_profile(items)
    sdk = FakeSdk(profile, scenario)
    robot = GdkRobot(sdk, profile, settings, FakeTakeSensor(scenario))
    robot.mode = "mock"
    robot.name = "GDK 2.2.3 API 模拟器（无硬件）"
    waypoints = {key: value.model_copy(update={"map_id": "1"}) for key, value in waypoints.items()}
    return RobotBundle(robot, FakeDetector(sdk)), sdk, waypoints
