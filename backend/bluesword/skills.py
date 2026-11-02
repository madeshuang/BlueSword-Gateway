"""Skill catalogue: skills are ordered compositions of steps; steps are compositions of GDK primitives.

    skill ("取货" / "卸货")  →  steps (导航、扫描、抓取…)  →  GDK 2.2.3 primitive calls

The LLM may only choose a skill and an allowlisted item; it never emits motion
parameters. Each step is implemented in FetchWorkflow and reaches the robot only
through RobotPort, whose GDK driver (gdk_v223/robot.py) maps to the SDK calls below.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SkillName = Literal["fetch", "pick", "unload"]

# Primitive → GDK 2.2.3 calls actually issued by gdk_v223/robot.py for that RobotPort method.
GDK_PRIMITIVES: dict[str, list[str]] = {
    "navigate": ["Pnc.normal_navi", "Pnc.get_task_state"],
    "dock": ["Pnc.high_precision_navi", "Pnc.get_task_state"],
    "observe": ["Robot.joint_control_request"],
    "capture": ["Camera.get_latest_image", "Camera.get_nearest_image", "TF.get_all_tf_from_base_link"],
    "intrinsics": ["Camera.get_camera_intrinsic"],
    "shift": ["Pnc.relative_move"],
    "arm": ["Robot.end_effector_pose_control"],
    "gripper": ["Robot.move_ee_pos"],
    "hold_check": ["Robot.get_end_state"],
}


@dataclass(frozen=True)
class StepDef:
    label: str
    primitives: tuple[str, ...]

    @property
    def gdk(self) -> list[str]:
        calls: list[str] = []
        for primitive in self.primitives:
            for call in GDK_PRIMITIVES.get(primitive, [primitive]):
                if call not in calls:
                    calls.append(call)
        return calls


STEP_DEFS: dict[str, StepDef] = {
    "plan": StepDef("理解意图", ()),
    "nav": StepDef("导航至货架", ("navigate",)),
    "precision": StepDef("精确停靠", ("dock",)),
    "scan": StepDef("扫描货架", ("observe", "capture", "视觉检测")),
    "locate": StepDef("计算三维坐标", ("intrinsics", "深度反投影")),
    "align": StepDef("调整抓取位置", ("shift", "capture")),
    "grasp": StepDef("抓取并验证", ("gripper", "arm", "hold_check")),
    "retreat": StepDef("抬起与收臂", ("arm",)),
    "deliver": StepDef("返回递物点", ("navigate", "dock", "capture")),
    "handover": StepDef("递出并等待接物", ("hold_check", "arm", "接物传感器")),
    "release": StepDef("松爪与收臂", ("gripper", "hold_check", "arm")),
}


@dataclass(frozen=True)
class Skill:
    name: SkillName
    title: str
    description: str
    steps: tuple[str, ...]
    requires_holding: bool
    leaves_holding: bool

    def gdk(self) -> list[str]:
        calls: list[str] = []
        for step in self.steps:
            for call in STEP_DEFS[step].gdk:
                if call not in calls:
                    calls.append(call)
        return calls


PICK_STEPS = ("plan", "nav", "precision", "scan", "locate", "align", "grasp", "retreat")
UNLOAD_STEPS = ("deliver", "handover", "release")

SKILLS: dict[SkillName, Skill] = {
    "pick": Skill(
        "pick",
        "取货",
        "导航到货架 → 视觉定位 → 抓取并确认持物 → 收臂，结束时机器人持有物品",
        PICK_STEPS,
        requires_holding=False,
        leaves_holding=True,
    ),
    "unload": Skill(
        "unload",
        "卸货",
        "带着物品回到递物点 → 递出 → 确认用户接稳后松爪 → 收臂",
        UNLOAD_STEPS,
        requires_holding=True,
        leaves_holding=False,
    ),
    "fetch": Skill(
        "fetch",
        "取物",
        "取货 + 卸货的完整流程",
        PICK_STEPS + UNLOAD_STEPS,
        requires_holding=False,
        leaves_holding=False,
    ),
}
