"""Site calibration, deliberately without usable hardware motion defaults."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CalibratedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Pose(CalibratedModel):
    position: tuple[float, float, float]
    quaternion: tuple[float, float, float, float]  # xyzw, base_link

    @model_validator(mode="after")
    def unit_quaternion(self):
        if abs(sum(v * v for v in self.quaternion) - 1) > 1e-4:
            raise ValueError("Quaternion must be normalized (xyzw)")
        return self


class Grasp(CalibratedModel):
    # Offset from the observed surface point to the commanded end-effector frame.
    offset_base_m: tuple[float, float, float]
    quaternion: tuple[float, float, float, float]

    @model_validator(mode="after")
    def valid_rotation(self):
        Pose(position=self.offset_base_m, quaternion=self.quaternion)
        return self


class Gripper(CalibratedModel):
    state_index: int = Field(ge=0)
    open_position: float
    closed_position: float
    contact_position: tuple[float, float]
    min_contact_effort: float = Field(gt=0)
    position_tolerance: float = Field(gt=0)
    velocity_tolerance: float = Field(gt=0)

    @model_validator(mode="after")
    def valid_range(self):
        lo, hi = self.contact_position
        if lo >= hi or lo <= self.open_position <= hi or lo <= self.closed_position <= hi:
            raise ValueError("Contact interval must exclude empty open/closed positions")
        return self


class Profile(CalibratedModel):
    calibrated: bool = False
    sdk_version: Literal["2.2.3"] = "2.2.3"
    map_id: int
    navigation_frame: Literal["map", "base_link"]
    arm: Literal["left", "right"]
    end_effector_frame: str = Field(min_length=1)
    optical_frame: str = Field(min_length=1)
    depth_optical_frame: str = ""
    camera_registered_rectified: bool
    depth_unit_m: float = Field(gt=0)
    timestamp_offset_ns: int
    gripper: Gripper
    poses: dict[str, Pose]  # stow, carry, handover
    grasps: dict[str, Grasp]  # per item
    observations: dict[str, dict[str, float]]  # center, left, upper, lower; absolute radians
    detector_factory: str = ""
    take_sensor_factory: str = ""
    startup_delay: float = Field(default=3, ge=0)
    poll_interval: float = Field(default=0.05, gt=0)
    feedback_max_age: float = Field(default=0.5, gt=0)
    sdk_call_timeout: float = Field(default=2, gt=0)
    action_timeout: float = Field(default=15, gt=0)
    command_lifetime: float = Field(default=3, gt=0)
    position_tolerance: float = Field(default=0.015, gt=0)
    angle_tolerance: float = Field(default=0.04, gt=0)
    joint_tolerance: float = Field(default=0.025, gt=0)
    velocity_tolerance: float = Field(default=0.025, gt=0)
    settled_samples: int = Field(default=3, ge=2)

    @model_validator(mode="after")
    def required_calibration(self):
        if not {"stow", "carry", "handover"} <= self.poses.keys():
            raise ValueError("Calibrated stow/carry/handover poses are required")
        if not {"center", "left", "upper", "lower"} <= self.observations.keys():
            raise ValueError("Four calibrated head/waist search joint poses are required")
        if any(not values for values in self.observations.values()):
            raise ValueError("Observation joint poses cannot be empty")
        if not self.camera_registered_rectified and not self.depth_optical_frame:
            raise ValueError("Native RGB-D registration requires the calibrated depth optical frame")
        return self


# Joint limits from PDF physical page 67 (printed page 69).
JOINT_LIMITS = {
    "idx01_body_joint1": (-1.082104, 0.000174),
    "idx02_body_joint2": (-0.000174, 2.652900),
    "idx03_body_joint3": (-1.919862, 1.570970),
    "idx04_body_joint4": (-0.436332, 0.436332),
    "idx05_body_joint5": (-3.045599, 3.045599),
    "idx11_head_joint1": (-1.570970, 1.570970),
    "idx12_head_joint2": (-0.349240, 0.349240),
    "idx13_head_joint3": (-0.534773, 0.534773),
}
for side, prefix in (("l", 2), ("r", 6)):
    for number, limits in enumerate(
        [
            (-3.071796, 3.071796),
            (-2.059505, 2.059505),
            (-3.071796, 3.071796),
            (-2.495838, 1.012308),
            (-3.071796, 3.071796),
            (-1.012308, 1.012308),
            (-1.535907, 1.535907),
        ],
        1,
    ):
        JOINT_LIMITS[f"idx{prefix}{number}_arm_{side}_joint{number}"] = limits
