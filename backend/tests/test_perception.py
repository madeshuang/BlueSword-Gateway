import time

import numpy as np
import pytest

from bluesword.domain import Detection, Frame, Intrinsics, RobotError, Transform
from bluesword.perception import locate


def frame():
    timestamp = time.time_ns()
    matrix = np.array([[0, 0, 1, 0.1], [-1, 0, 0, 0.2], [0, -1, 0, 1.0], [0, 0, 0, 1]])
    return Frame(
        np.full((100, 200), 0.8),
        Intrinsics(100, 100, 100, 50, 200, 100),
        Transform(matrix, "head_color_optical_frame", "base_link", timestamp),
        timestamp,
    )


def test_optical_to_base_uses_rotation_translation_and_meters():
    point = locate(frame(), Detection("item", "item", 0.9, (0.55, 0.3, 0.1, 0.2)))
    # Pixel center (120,40) -> optical (.16,-.08,.8) -> base (.9,.04,1.08)
    assert point.array() == pytest.approx([0.9, 0.04, 1.08])


def test_median_depth_rejects_outliers_and_ignores_a_few_invalid_pixels():
    f = frame()
    f.depth_m[38, 118] = 1.8
    f.depth_m[39, 119] = np.nan
    assert locate(f, Detection("i", "i", 0.9, (0.55, 0.3, 0.1, 0.2))).x == pytest.approx(0.9)


@pytest.mark.parametrize("box", [(0.9, 0.1, 0.4, 0.1), (-0.1, 0, 0.1, 0.1), (0, 0, 0, 0.1)])
def test_invalid_detection_box_is_rejected(box):
    with pytest.raises(RobotError):
        locate(frame(), Detection("i", "i", 0.9, box))


def test_stale_tf_and_wrong_direction_are_rejected():
    f = frame()
    f.transform = Transform(f.transform.matrix, "base_link", "head_color_optical_frame", f.timestamp_ns)
    with pytest.raises(RobotError, match="不匹配"):
        locate(f, Detection("i", "i", 0.9, (0.4, 0.4, 0.2, 0.2)))
    f.transform = Transform(f.transform.matrix, f.camera_frame, "base_link", f.timestamp_ns - 1_000_000_000)
    with pytest.raises(RobotError, match="不同步"):
        locate(f, Detection("i", "i", 0.9, (0.4, 0.4, 0.2, 0.2)))
