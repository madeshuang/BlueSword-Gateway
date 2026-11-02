"""Robot-team VLM HTTP v1.2: validate reported milestones; never infer motion."""

from __future__ import annotations

import base64
import binascii
import io
import time
from typing import Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .domain import TaskRecord, TaskStep

LABELS = {
    "arrived_shelf": "到达货架",
    "target_located": "识别目标",
    "grasped": "抓稳物品",
    "at_delivery": "到达交付处",
    "placed": "放下物品",
}


class DetectionReport(BaseModel):
    item: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=100)
    attempt: int = Field(ge=1, strict=True)


class ReportImage(BaseModel):
    mime: Literal["image/jpeg"]
    width: Literal[640]
    height: int = Field(ge=1, le=1280, strict=True)
    data: str = Field(min_length=1, max_length=300_000)

    @model_validator(mode="after")
    def valid_jpeg(self):
        try:
            raw = base64.b64decode(self.data, validate=True)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "JPEG" or image.size != (self.width, self.height):
                    raise ValueError("图片尺寸或类型不一致")
                image.verify()
        except (ValueError, binascii.Error, OSError) as exc:
            raise ValueError("识别图片无效") from exc
        return self


class Progress(BaseModel):
    model_config = ConfigDict(extra="ignore")
    taskId: str
    stage: Literal["arrived_shelf", "target_located", "grasped", "at_delivery", "placed"]
    stageIndex: int = Field(ge=1, le=8, strict=True)
    stageTotal: Literal[5, 8]
    pickIndex: int = Field(ge=0, le=2, strict=True)
    message: str = Field(min_length=1, max_length=1000)
    detection: DetectionReport | None = None
    image: ReportImage | None = None

    @model_validator(mode="after")
    def correct_milestone(self):
        units = (self.stageTotal - 2) // 3
        if self.stage in ("at_delivery", "placed"):
            expected = self.stageTotal - (self.stage == "at_delivery")
            if self.pickIndex != 0 or self.stageIndex != expected:
                raise ValueError("交付阶段序号不正确")
        else:
            expected = (
                (self.pickIndex - 1) * 3
                + ("arrived_shelf", "target_located", "grasped").index(self.stage)
                + 1
            )
            if not 1 <= self.pickIndex <= units or self.stageIndex != expected:
                raise ValueError("取物阶段序号不正确")
        if self.stage != "target_located" and (self.image or self.detection):
            raise ValueError("只有识别阶段可以带图片和识别信息")
        return self


def apply_progress(task: TaskRecord, report: Progress) -> bool:
    """Upsert milestones, allowing skipped indices and newer recognition attempts."""
    total = sum(line.count for line in task.items) or 1
    if report.stageTotal != 3 * total + 2:
        raise ValueError("阶段总数与本单数量不一致")
    identifier = f"vlm:{report.pickIndex}:{report.stage}"
    previous = next((step for step in task.steps if step.id == identifier), None)
    cursor = max((step.stage_index or 0 for step in task.steps), default=0)
    attempt = report.detection.attempt if report.detection else 0
    if report.stageIndex < cursor or (previous and attempt <= previous.attempt):
        return False
    task.last_progress_at = time.time()
    label = LABELS[report.stage]
    if report.pickIndex:
        label = f"第{report.pickIndex}件 · {label}"
    step = TaskStep(
        id=identifier,
        label=label,
        status="done",
        detail=report.message,
        stage_index=report.stageIndex,
        pick_index=report.pickIndex,
        attempt=attempt,
        detected_item=report.detection.item if report.detection else None,
        detected_label=report.detection.label if report.detection else None,
        startedAt=previous.startedAt if previous else task.last_progress_at,
    )
    if previous:
        task.steps[task.steps.index(previous)] = step
    else:
        task.steps.append(step)
    return True


def failure_refunds(task: TaskRecord, items: dict) -> dict[str, int] | None:
    """Temporary onsite policy: use received grasp milestones to settle explicit faults."""
    remaining = {line.item_id: line.count for line in task.items}
    grasped = {s.pick_index for s in task.steps if s.id.endswith(':grasped') and s.status == 'done'}
    total = sum(remaining.values())
    if len(grasped) >= total:
        return {}
    # Later delivery milestones can mean grasp reports were lost; do not refund them.
    if any(s.id in ('vlm:0:at_delivery', 'vlm:0:placed') and s.status == 'done' for s in task.steps):
        return None
    for pick in sorted(grasped):
        candidates = [key for key, count in remaining.items() if count]
        product_codes = {items[key].robot_item or items[key].name for key in candidates}
        if len(product_codes) > 1:
            observed = next((s for s in task.steps if s.id == f'vlm:{pick}:target_located'), None)
            if not observed:
                return None
            candidates = [key for key in candidates if
                          (observed.detected_item and observed.detected_item in (key, items[key].robot_item or items[key].name))
                          or (observed.detected_label and observed.detected_label == items[key].name)]
            if len(candidates) != 1:
                return None
        if not candidates:
            return None
        remaining[candidates[0]] -= 1
    return {key: count for key, count in remaining.items() if count}


def completion(task: TaskRecord) -> None:
    """Finished is terminal, but v1.2 may have delivered only one of two items."""
    task.status = "completed"
    task.error = None
    task.recovery_required = False
    task.completion_note = None
    if sum(line.count for line in task.items) == 2:
        grasped = {s.pick_index for s in task.steps if s.id.endswith(":grasped") and s.status == "done"}
        placed = any(s.id == "vlm:0:placed" and s.status == "done" for s in task.steps)
        if grasped != {1, 2} or not placed:
            task.completion_note = "机器人报告取送结束，这单实际送达的数量还需要现场核对一下。"
            task.recovery_required = True


def log_body(body: dict) -> dict:
    """Keep metadata in the protocol log, never duplicate base64 into logs/SQLite."""
    if not isinstance(body.get("image"), dict):
        return body
    picture = body["image"]
    return {**body, "image": {key: picture.get(key) for key in ("mime", "width", "height")}}
