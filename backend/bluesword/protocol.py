"""兰剑机器人协议 v1.1 + 提案等级二（任务编号、阶段回报）。网关侧与机器人侧共用。

  网关 → 机器人  POST /api/task/dispatch  {taskId, action?, items:[{location, item, count}]}
  机器人 → 网关  POST /api/task/progress  {taskId, stage, status, item?, label?, detail?, ts}
  机器人 → 网关  POST /api/task/finished  {taskId, result:"success"}
  机器人 → 网关  POST /api/task/error     {taskId, message, stage?, holding?}
  回复统一为     {code: 1, data: ..., success: bool}
"""

from __future__ import annotations

# 提案里建议的 5 个回报阶段，及其对应的机器人内部步骤（见 skills.STEP_DEFS）
STAGES: list[tuple[str, str, tuple[str, ...]]] = [
    ("navigate_to_shelf", "前往货架", ("nav", "precision")),
    ("detect", "识别目标", ("scan", "locate", "align")),
    ("grasp", "抓取", ("grasp", "retreat")),
    ("navigate_to_delivery", "返回交付处", ("deliver",)),
    ("place", "放下物品", ("handover", "release")),
]
STAGE_LABEL = {stage: label for stage, label, _ in STAGES}
STAGE_OF_STEP = {step: stage for stage, _, steps in STAGES for step in steps}

# 网关侧展示用：每个阶段背后机器人大致调用的 GDK 接口（来自提案表格）
STAGE_GDK = {
    "navigate_to_shelf": ["Pnc.normal_navi", "Pnc.high_precision_navi", "Pnc.get_task_state"],
    "detect": ["Camera.get_latest_image", "识别模型", "TF.get_all_tf_from_base_link"],
    "grasp": ["Robot.end_effector_pose_control", "Robot.move_ee_pos", "Robot.get_end_state"],
    "navigate_to_delivery": ["Pnc.normal_navi", "Pnc.high_precision_navi"],
    "place": ["Robot.end_effector_pose_control", "Robot.move_ee_pos"],
}

# 下发报文的 action ↔ 我们的技能
ACTION_TO_SKILL = {None: "fetch", "fetch": "fetch", "pick": "pick", "place": "unload"}
SKILL_TO_ACTION = {"fetch": None, "pick": "pick", "unload": "place"}


def stages_for(skill_steps: tuple[str, ...]) -> list[str]:
    """某个技能会经过的回报阶段（按顺序）。"""
    return [stage for stage, _, steps in STAGES if any(s in skill_steps for s in steps)]


def reply(success: bool, data: str = "OK") -> dict:
    return {"code": 1, "data": data, "success": success}
