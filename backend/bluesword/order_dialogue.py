"""Interpretation proposes edits; this module alone applies them to the draft."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .domain import TaskLine, TaskRequest


class Edit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["add", "remove", "replace", "set"]
    item_id: str
    count: int = Field(default=1, ge=1, le=2, strict=True)
    source_id: str | None = None


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["edit", "reply", "approve", "cancel"]
    reply: str = Field(default="", max_length=500)
    edits: list[Edit] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def consistent_intent(self):
        if self.kind != "edit" and self.edits:
            raise ValueError("只有清单调整可以携带修改操作")
        return self


def apply_decision(decision: Decision, current: list[TaskLine], items: dict) -> list[TaskLine]:
    if decision.kind != "edit" or not decision.edits:
        raise ValueError("这次还没听清要怎么改，原清单先保留着。")
    counts = {line.item_id: line.count for line in current}
    setting = any(edit.action == "set" for edit in decision.edits)
    if setting:
        if any(edit.action != "set" for edit in decision.edits):
            raise ValueError("这次清单还不够明确，原清单先保留着。")
        counts = {}
    for edit in decision.edits:
        if edit.item_id not in items:
            raise ValueError("目录里没有这件物品，原清单先保留着。")
        if edit.action == "remove":
            if edit.item_id not in counts:
                raise ValueError("这件不在清单里，原清单先保留着。")
            del counts[edit.item_id]
        else:
            if edit.action == "replace":
                if edit.source_id not in counts:
                    raise ValueError("还没确定要替换哪一件，原清单先保留着。")
                del counts[edit.source_id]
            counts[edit.item_id] = counts.get(edit.item_id, 0) + edit.count
    if not counts:
        return []
    if sum(counts.values()) > 2:
        raise ValueError("这单最多拿两件，原清单先保留着。想先拿哪两件？")
    return TaskRequest(items=[TaskLine(item_id=k, count=v) for k, v in counts.items()], request_id="draft").items


def change_message(previous: list[TaskLine], current: list[TaskLine], items: dict) -> str:
    before = {line.item_id: line.count for line in previous}
    after = {line.item_id: line.count for line in current}
    added = [f"{items[k].name} × {n - before.get(k, 0)}" for k, n in after.items() if n > before.get(k, 0)]
    removed = [f"{items[k].name} × {n - after.get(k, 0)}" for k, n in before.items() if n > after.get(k, 0)]
    kept = [f"{items[k].name} × {n}" for k, n in after.items() if before.get(k) == n]
    parts = []
    if removed:
        parts.append("已去掉" + "、".join(removed))
    if added:
        parts.append("已加上" + "、".join(added))
    if kept and (added or removed):
        parts.append("保留" + "、".join(kept))
    label = "、".join(f"{items[k].name} × {n}" for k, n in after.items())
    return "，".join(parts) + ("。" if parts else "") + f"这单是{label}，确认后出发。"
