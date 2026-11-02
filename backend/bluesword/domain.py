from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator


class RobotError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    z: float

    def array(self) -> np.ndarray:
        return np.array([self.x, self.y, self.z])

    def shift(self, dx: float = 0, dy: float = 0, dz: float = 0) -> Point:
        return Point(self.x + dx, self.y + dy, self.z + dz)


@dataclass(frozen=True)
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int


@dataclass(frozen=True)
class Transform:
    """T_target_source, evaluated at the RGB-D capture timestamp, in meters."""

    matrix: np.ndarray
    source: str
    target: str
    timestamp_ns: int


@dataclass(frozen=True)
class Detection:
    id: str
    label: str
    score: float
    box: tuple[float, float, float, float]

    def event(self, target_id: str | None = None) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "score": self.score,
            "box": list(self.box),
            "target": self.id == target_id,
        }


@dataclass
class Frame:
    """Depth is meters, registered to a rectified color image; TF uses the same timestamp."""

    depth_m: np.ndarray
    intrinsics: Intrinsics
    transform: Transform
    timestamp_ns: int
    camera_frame: str = "head_color_optical_frame"
    rgb: bytes | None = None
    preview_src: str | None = None
    # Used exclusively by the mock detector; real detections must come from image inference.
    mock_detections: list[Detection] = field(default_factory=list)


@dataclass(frozen=True)
class MotionResult:
    completed: bool
    error_m: float = 0
    detail: str = ""


@dataclass(frozen=True)
class TakeSignal:
    supported: bool
    timestamp_ns: int
    source: str


class TaskStep(BaseModel):
    id: str
    label: str
    status: Literal["pending", "active", "done", "failed"] = "pending"
    detail: str = ""
    gdk: list[str] = Field(default_factory=list)
    stage_index: int | None = None
    pick_index: int | None = None
    attempt: int = 0
    startedAt: float | None = None


class TaskLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str = Field(min_length=1, max_length=80)
    count: int = Field(default=1, ge=1, le=2, strict=True)


class TaskRecord(BaseModel):
    id: str
    request_id: str
    item_id: str
    items: list[TaskLine] = Field(default_factory=list)
    skill: Literal["fetch", "pick", "unload"] = "fetch"
    title: str
    status: Literal["running", "completed", "failed", "cancelled", "interrupted", "resolved"] = "running"
    steps: list[TaskStep]
    error: dict[str, str] | None = None
    completion_note: str | None = None
    holding: bool = False
    recovery_required: bool = False
    created_at: float
    last_progress_at: float | None = None
    finished_at: float | None = None


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_id: str | None = Field(default=None, min_length=1, max_length=80)
    items: list[TaskLine] = Field(default_factory=list, max_length=2)
    request_id: str = Field(min_length=1, max_length=100)
    skill: Literal["fetch", "pick", "unload"] = "fetch"


    @model_validator(mode="after")
    def order(self):
        if not self.items:
            if not self.item_id:
                raise ValueError("请先选择想拿的物品")
            self.items = [TaskLine(item_id=self.item_id)]
        elif self.item_id and self.item_id != self.items[0].item_id:
            raise ValueError("物品清单不一致")
        if len({line.item_id for line in self.items}) != len(self.items):
            raise ValueError("同一种物品请合并数量")
        if sum(line.count for line in self.items) > 2:
            raise ValueError("每单最多两件")
        if self.skill != "fetch" and (len(self.items) != 1 or self.items[0].count != 1):
            raise ValueError("拆分技能只支持单件；两件请使用完整取物")
        self.item_id = self.items[0].item_id
        return self


@dataclass(frozen=True)
class Command:
    name: str
    arguments: dict[str, Any]
    timestamp_ns: int


STEPS = [
    ("plan", "理解意图"),
    ("nav", "导航至货架"),
    ("precision", "精确停靠"),
    ("scan", "扫描货架"),
    ("locate", "计算三维坐标"),
    ("align", "调整抓取位置"),
    ("grasp", "抓取并验证"),
    ("retreat", "抬起与收臂"),
    ("deliver", "返回递物点"),
    ("handover", "递出并等待接物"),
    ("release", "松爪与收臂"),
]
