"""Bake recorded mock state to .blend keyframes and render a preview movie."""
import bisect
import json
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from live_bridge import View

OUT = ROOT.parent / "output/blender"
recording = json.loads((OUT / "demo.json").read_text())
frames = recording["frames"]
times = [state["t"] for state in frames]
scene = bpy.context.scene
scene.render.fps = 12
scene.frame_start, scene.frame_end = 1, int(times[-1]*scene.render.fps)+1
view = View()
maximum_error = 0
for index in range(scene.frame_start, scene.frame_end+1):
    state = frames[min(len(frames)-1, bisect.bisect_left(times, (index-1)/scene.render.fps))]
    view.apply(state, keyframe=index)
    maximum_error = max(maximum_error, view.ik_error)
print("BAKED", scene.frame_end, "frames; max display IK error", maximum_error)

# Text strings cannot be keyframed, so install a documented replay handler.
# It is embedded as source for convenience but not marked auto-run.
data = bpy.data.texts.new("ReplaySnapshots.json")
data.write(json.dumps(frames, ensure_ascii=False))
from bpy.app.handlers import persistent


@persistent
def overlay(scene):
    state = frames[min(len(frames)-1, bisect.bisect_left(times, (scene.frame_current-1)/scene.render.fps))]
    from live_bridge import STAGES
    task = state.get("task")
    title = STAGES.get(state["stage"], state["stage"])
    if task and task["status"] == "completed":
        title = "任务完成 · 物品已交到用户手中"
    bpy.data.objects["HUD stage"].data.body = title
    bpy.data.objects["HUD command"].data.body = "GDK  /  "+state["command"]
    x, y, _ = state["base"]
    done = sum(s["status"] == "done" for s in task["steps"]) if task else 0
    bpy.data.objects["HUD coords"].data.body = f"BASE  {x:.2f}, {y:.2f} m   |   {done}/11"


bpy.app.handlers.frame_change_pre.append(overlay)
scene.frame_set(1)
scene["animation_source"] = "Recorded /api/simulation state from a completed GDK mock task"
scene["max_display_ik_error_m"] = maximum_error
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "lanjian_gdk_animation.blend"))

if "--render" in sys.argv:
    scene.render.resolution_percentage = 70
    scene.eevee.taa_render_samples = 16
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.filepath = str(OUT / "lanjian_fetch_demo.mp4")
    bpy.ops.render.render(animation=True)
else:
    # Contact sheet source frames cover travel, scan, grip, delivery and completion.
    for title, wanted in [("navigation", "navigate"), ("scan", "scan"), ("grasp", "close_gripper"),
                          ("handover", "waiting_for_take"), ("complete", "stow")]:
        indices = [i for i, state in enumerate(frames) if state["stage"] == wanted]
        if indices:
            selected = indices[-1] if title == "complete" else indices[len(indices)//2]
            scene.frame_set(int(frames[selected]["t"]*scene.render.fps)+1)
            scene.render.filepath = str(OUT / (title+".png"))
            bpy.ops.render.render(write_still=True)
