"""Proposed perception SDK, with explicit demonstration implementations.

detect_objects(rgbd, target) -> detections
estimate_grasp_pose(rgbd, detection) -> base_link pose

No learned detection or grasp inference is implemented. Detection is scripted;
translation uses the existing depth/TF projection on synthetic frames, and
orientation comes from the demo's configured grasp. Replace these two functions
when the real perception SDK is ready.
"""

import asyncio

from .domain import Detection
from .perception import locate


class DemoPerceptionSDK:
    def __init__(self, sdk, scene):
        self.sdk, self.scene = sdk, scene

    async def detect_objects(self, rgbd, target):
        trace = self.scene.trace
        entry = trace.begin("perception", "PerceptionSDK.detect_objects", "识别货架上的目标物 · 占位函数",
                            {"rgbd": "head_rgbd", "target": target.name if target else "all"})
        try:
            await asyncio.sleep(.6 / self.scene.speed)
            detections = []
            if target:
                y = -.32 - self.sdk.lateral
                u, v = 320 - 500 * y / .65, 240 + 500 * .18 / .65
                detections = [Detection(target.id, target.name, .98,
                                        (u / 640 - .04, v / 480 - .04, .08, .08))]
            trace.finish(entry, {"objects": [d.event() for d in detections], "source": "示例识别结果"})
            return detections
        except BaseException as exc:
            trace.fail(entry, exc)
            raise

    async def estimate_grasp_pose(self, rgbd, detection, max_age):
        trace = self.scene.trace
        entry = trace.begin("perception", "PerceptionSDK.estimate_grasp_pose", "输出抓取位姿 · 占位函数",
                            {"target": detection.label, "inputs": ["depth", "intrinsics", "TF"],
                             "output_frame": "base_link"})
        try:
            point = locate(rgbd, detection, max_age)
            grasp = self.sdk.profile.grasps[detection.id]
            await asyncio.sleep(.7 / self.scene.speed)
            trace.finish(entry, {"frame": "base_link", "unit": "m", "position": list(point.array()),
                                 "quaternion_xyzw": list(grasp.quaternion),
                                 "pregrasp_offset_m": [-.1, 0, 0],
                                 "source": "示例抓取位姿；姿态为预设值"})
            # The existing workflow uses translation and the matching configured orientation.
            return point
        except BaseException as exc:
            trace.fail(entry, exc)
            raise

    async def detect(self, frame, item):
        return await self.detect_objects(frame, item)
