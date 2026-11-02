"""Decoding for the Image/Transform structures documented in GDK 2.2.3."""

import base64
import io
import math

import numpy as np
from PIL import Image

from ..domain import Frame, Intrinsics, RobotError, Transform
from .profile import Profile


def field(obj, key):
    return obj[key] if isinstance(obj, dict) else getattr(obj, key)


def xyz(obj):
    value = np.array([field(obj, k) for k in "xyz"], dtype=float)
    if not np.isfinite(value).all():
        raise RobotError("invalid_feedback", "反馈坐标不是有限数值")
    return value


def quaternion(obj):
    q = np.array([field(obj, k) for k in "xyzw"], dtype=float)
    if not np.isfinite(q).all() or abs(np.linalg.norm(q) - 1) > 1e-3:
        raise RobotError("invalid_quaternion", "SDK 四元数未归一化")
    return q


def rotation(q):
    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def pose_components(pose):
    return xyz(field(pose, "position")), quaternion(field(pose, "orientation"))


def yaw_of(pose):
    x, y, z, w = quaternion(field(pose, "orientation"))
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def angle_error(a, b):
    return abs(math.atan2(math.sin(a - b), math.cos(a - b)))


def name(value):
    # Python examples use strings; type chapter also documents enums.
    return str(getattr(value, "name", value)).split(".")[-1].upper()


def decode_image(image, *, depth=False):
    h, w = int(field(image, "height")), int(field(image, "width"))
    if h <= 0 or w <= 0 or h * w > 16_000_000:
        raise RobotError("image_shape", "相机尺寸无效")
    encoding = name(field(image, "encoding"))
    fmt = name(field(image, "color_format"))
    data = field(image, "data")
    if depth and encoding == "JPEG":
        raise RobotError("image_encoding", "深度图不能使用有损 JPEG")
    if encoding in {"JPEG", "PNG"}:
        with Image.open(io.BytesIO(bytes(data))) as im:
            if im.size != (w, h):
                raise RobotError("image_shape", "压缩图像与元数据尺寸不匹配")
            arr = np.asarray(im if depth else im.convert("RGB")).copy()
        if depth and arr.dtype != np.dtype("uint16"):
            raise RobotError("image_encoding", "PNG 深度图必须为 16 位灰度")
    else:
        if encoding not in {"UNCOMPRESSED", "RGB8", "BGR8", "MONO16", "32FC1"}:
            raise RobotError("image_encoding", f"未支持的图像编码 {encoding}")
        if depth:
            dtype = np.dtype("<f4") if encoding == "32FC1" or fmt == "32FC1" else np.dtype("<u2")
            if (
                dtype.itemsize == 2
                and fmt not in {"GRAY16", "RS2_FORMAT_Z16", "MONO16"}
                and encoding != "MONO16"
            ):
                raise RobotError("image_encoding", f"未支持的深度格式 {encoding}/{fmt}")
            shape = (h, w)
        else:
            if fmt not in {"RGB", "BGR", "RGB8", "BGR8"} and encoding not in {"RGB8", "BGR8"}:
                raise RobotError("image_encoding", f"未支持的彩色格式 {encoding}/{fmt}")
            dtype, shape = np.dtype("u1"), (h, w, 3)
        arr = np.asarray(data) if isinstance(data, np.ndarray) else np.frombuffer(data, dtype=dtype)
        if arr.dtype != dtype or arr.size != math.prod(shape):
            raise RobotError("image_encoding", "图像缓冲区类型或长度不匹配")
        arr = arr.reshape(shape).copy()
        if not depth and (fmt in {"BGR", "BGR8"} or encoding == "BGR8"):
            arr = arr[..., ::-1]
    if arr.shape != ((h, w) if depth else (h, w, 3)):
        raise RobotError("image_shape", "图像与元数据尺寸不匹配")
    return arr


def tf_matrix(stamped_tf, expected_frame):
    if field(stamped_tf, "frame_id") != "base_link" or field(stamped_tf, "child_frame_id") != expected_frame:
        raise RobotError("tf_frame", "需要从 base_link 到已标定光学坐标系的 TF")
    transform = field(stamped_tf, "transform")
    matrix = np.eye(4)
    matrix[:3, :3] = rotation(quaternion(field(transform, "rotation")))
    matrix[:3, 3] = xyz(field(transform, "translation"))
    return matrix


def make_frame(color, depth, intrinsic, stamped_tf, profile: Profile, depth_intrinsic=None, depth_tf=None):
    stamps = [
        int(field(obj, "timestamp_ns")) + profile.timestamp_offset_ns for obj in (color, depth, stamped_tf)
    ]
    if depth_tf is not None:
        stamps.append(int(field(depth_tf, "timestamp_ns")) + profile.timestamp_offset_ns)
    if max(stamps) - min(stamps) > 50_000_000:
        raise RobotError("rgbd_tf_sync", "RGB、深度和 TF 时间戳相差超过 50 ms")
    matrix = tf_matrix(stamped_tf, profile.optical_frame)
    rgb, depth_array = decode_image(color), decode_image(depth, depth=True)
    depth_m = depth_array.astype(float) * profile.depth_unit_m
    if profile.camera_registered_rectified:
        if rgb.shape[:2] != depth_array.shape:
            raise RobotError("rgbd_alignment", "RGB 与深度尺寸不同，需要先完成注册")
        # Native distorted images cannot simply be declared rectified in a profile.
        if any(not math.isfinite(float(v)) or abs(float(v)) > 1e-8 for v in field(intrinsic, "distortion")):
            raise RobotError("camera_distortion", "相机仍有畸变；请配置原始 RGB-D 配准模式")
    else:
        from .rgbd import rectify_register

        if depth_intrinsic is None or depth_tf is None:
            raise RobotError("depth_calibration", "原始 RGB-D 配准需要深度内参和同步光学 TF")
        color_from_depth = np.linalg.inv(matrix) @ tf_matrix(depth_tf, profile.depth_optical_frame)
        rgb, depth_m = rectify_register(rgb, depth_m, intrinsic, depth_intrinsic, color_from_depth)
    fx, fy, cx, cy = field(intrinsic, "intrinsic")
    if not all(math.isfinite(v) for v in (fx, fy, cx, cy)) or min(fx, fy) <= 0:
        raise RobotError("camera_intrinsics", "相机内参无效")
    output = io.BytesIO()
    Image.fromarray(rgb).save(output, format="PNG")
    encoded = output.getvalue()
    return Frame(
        depth_m=depth_m,
        intrinsics=Intrinsics(fx, fy, cx, cy, rgb.shape[1], rgb.shape[0]),
        transform=Transform(matrix, profile.optical_frame, "base_link", stamps[2]),
        timestamp_ns=stamps[0],
        camera_frame=profile.optical_frame,
        rgb=encoded,
        preview_src="data:image/png;base64," + base64.b64encode(encoded).decode(),
    )
