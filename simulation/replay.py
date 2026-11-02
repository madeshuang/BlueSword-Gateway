"""Restore text overlays when opening the baked .blend; no backend required."""
import bisect
import json
import sys
from pathlib import Path

import bpy
from bpy.app.handlers import persistent

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_bridge import STAGES

frames = json.loads(bpy.data.texts["ReplaySnapshots.json"].as_string())
times = [state["t"] for state in frames]


@persistent
def overlay(scene):
    index = min(len(frames)-1, bisect.bisect_left(times, (scene.frame_current-1)/scene.render.fps))
    state = frames[index]
    task = state.get("task")
    done = sum(step["status"] == "done" for step in task["steps"]) if task else 0
    title = STAGES.get(state["stage"], state["stage"])
    if task and task["status"] == "completed":
        title = "任务完成 · 物品已交到用户手中"
    bpy.data.objects["HUD stage"].data.body = title
    bpy.data.objects["HUD command"].data.body = "GDK  /  "+state["command"]
    x, y, _ = state["base"]
    bpy.data.objects["HUD coords"].data.body = f"BASE  {x:.2f}, {y:.2f} m   |   {done}/11"
    bpy.data.objects["HUD mode"].data.body = "GENIE G2  ·  任务记录回放"


bpy.app.handlers.frame_change_pre.append(overlay)
bpy.context.scene.frame_set(1)
