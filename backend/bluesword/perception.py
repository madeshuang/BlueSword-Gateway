from __future__ import annotations

import time

import numpy as np

from .domain import Detection, Frame, Point, RobotError


def locate(frame: Frame, detection: Detection, max_age: float = 2) -> Point:
    """Median depth in an interior patch -> optical XYZ -> base_link XYZ."""
    k, tf = frame.intrinsics, frame.transform
    age = (time.time_ns() - frame.timestamp_ns) / 1e9
    if age < -0.1 or age > max_age:
        raise RobotError("stale_frame", "相机帧已过期，请重新采集")
    if tf.source != frame.camera_frame or tf.target != "base_link":
        raise RobotError("tf_frame", "TF 坐标系不匹配")
    if abs(tf.timestamp_ns - frame.timestamp_ns) > 50_000_000:
        raise RobotError("tf_time", "TF 与相机帧不同步")
    matrix = np.asarray(tf.matrix)
    if (
        matrix.shape != (4, 4)
        or not np.isfinite(matrix).all()
        or not np.allclose(matrix[3], [0, 0, 0, 1])
        or not np.allclose(matrix[:3, :3].T @ matrix[:3, :3], np.eye(3), atol=1e-5)
        or not np.isclose(np.linalg.det(matrix[:3, :3]), 1, atol=1e-5)
    ):
        raise RobotError("invalid_tf", "TF 不是有效的刚体变换")
    if (
        not np.isfinite([k.fx, k.fy, k.cx, k.cy]).all()
        or min(k.fx, k.fy) <= 0
        or frame.depth_m.shape != (k.height, k.width)
    ):
        raise RobotError("intrinsics", "相机内参或对齐深度尺寸无效")
    x, y, w, h = detection.box
    if (
        not np.isfinite(detection.box).all()
        or min(x, y) < 0
        or min(w, h) <= 0
        or x + w > 1.00001
        or y + h > 1.00001
    ):
        raise RobotError("detection_box", "目标检测框无效")
    u, v = (x + w / 2) * k.width, (y + h / 2) * k.height
    ui, vi = min(k.width - 1, int(u)), min(k.height - 1, int(v))
    radius = max(1, min(3, int(min(w * k.width, h * k.height) / 4)))
    patch = frame.depth_m[max(0, vi - radius) : vi + radius + 1, max(0, ui - radius) : ui + radius + 1]
    valid = patch[np.isfinite(patch) & (patch >= 0.1) & (patch <= 2.0)]
    if valid.size < max(1, patch.size * 0.6):
        raise RobotError("invalid_depth", "目标区域有效深度不足，不能生成抓取坐标")
    z = float(np.median(valid))
    optical = np.array([(u - k.cx) * z / k.fx, (v - k.cy) * z / k.fy, z, 1.0])
    base = matrix @ optical
    return Point(*map(float, base[:3]))
