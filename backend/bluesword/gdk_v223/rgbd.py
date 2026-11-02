"""Register native head RGB-D to a rectified color image.

Pinhole/Brown-Conrady model from the GDK CameraIntrinsic layout and OpenCV:
https://docs.opencv.org/4.12.0/d9/d0c/group__calib3d.html
Depth is camera-axis Z, not radial range. Invalid/occluded samples remain NaN.
"""

import cv2
import numpy as np

from ..domain import RobotError
from .geometry import field


def calibration(intrinsic):
    values = np.asarray(field(intrinsic, "intrinsic"), dtype=float)
    distortion = np.asarray(field(intrinsic, "distortion"), dtype=float)
    if (
        values.shape != (4,)
        or len(distortion) not in {0, 5}
        or not np.isfinite(values).all()
        or not np.isfinite(distortion).all()
        or min(values[:2]) <= 0
    ):
        raise RobotError("camera_calibration", "只支持已标定的头部 RGB-D 针孔模型和 5 参数畸变")
    fx, fy, cx, cy = values
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]]), distortion


def rectify_register(rgb, depth_m, color_intrinsic, depth_intrinsic, color_from_depth):
    kc, dc = calibration(color_intrinsic)
    kd, dd = calibration(depth_intrinsic)
    rectified = cv2.undistort(rgb, kc, dc if dc.size else None, None, kc)
    h, w = depth_m.shape
    v, u = np.indices((h, w), dtype=np.float64)
    valid = np.isfinite(depth_m) & (depth_m > 0)
    pixels = np.column_stack([u[valid], v[valid]]).reshape(-1, 1, 2)
    output = np.full(rgb.shape[:2], np.inf)
    if pixels.size:
        normalized = cv2.undistortPoints(pixels, kd, dd if dd.size else None).reshape(-1, 2)
        points = np.column_stack([normalized, np.ones(len(normalized))]) * depth_m[valid, None]
        points = points @ color_from_depth[:3, :3].T + color_from_depth[:3, 3]
        points = points[np.isfinite(points).all(axis=1) & (points[:, 2] > 0)]
        projected = points @ kc.T
        uv = np.rint(projected[:, :2] / projected[:, 2, None])
        ch, cw = output.shape
        inside = (uv[:, 0] >= 0) & (uv[:, 0] < cw) & (uv[:, 1] >= 0) & (uv[:, 1] < ch)
        uv = uv[inside].astype(np.int64)
        # Z-buffer: retain nearest visible surface; never invent depth in holes.
        np.minimum.at(output, (uv[:, 1], uv[:, 0]), points[inside, 2])
    output[~np.isfinite(output)] = np.nan
    return rectified, output
