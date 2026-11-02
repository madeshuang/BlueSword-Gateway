"""Run inside Blender to verify scene reconstruction and recorded joint motion."""
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from live_bridge import View

frames = json.loads((ROOT.parent / "output/blender/demo.json").read_text())["frames"]
view = View()
view.apply(frames[-1])
assert (bpy.data.objects["TargetItem"].location-Vector((.6, -.18, 1.1))).length < 1e-5

held = next(state for state in frames if state["held"] and state["stage"] == "waiting_for_take")
view = View()
for _ in range(5):
    view.apply(held)
assert (bpy.data.objects["TargetItem"].location-Vector((.6, -.18, 1.1))).length < .012
assert view.model.q["idx71_gripper_r_inner_joint1"] > .5

view = View()
maximum = 0
for state in frames:
    view.apply(state)
    maximum = max(maximum, view.ik_error)
    for joint in view.model.joints:
        if "_arm_" in joint["name"]:
            assert joint["low"]-1e-8 <= view.model.q[joint["name"]] <= joint["high"]+1e-8
assert maximum < .012, maximum
assert not view.attached
report = {"recorded_states": len(frames), "max_display_ik_error_m": maximum,
          "late_held_join": "passed", "late_completed_join": "passed", "joint_limits": "passed"}
(ROOT.parent / "output/blender/scene-check.json").write_text(json.dumps(report, indent=2)+"\n")
print("SCENE_CHECK", json.dumps(report))
