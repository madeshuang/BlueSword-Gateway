"""Short, task-scoped display notes. Never controls the robot or changes task state."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

from .domain import TaskRecord
from .language import item_label

logger = logging.getLogger(__name__)
WAIT_SECONDS = 60
REWRITE_SECONDS = 4

STYLE = """为展台取物机器人布鲁写一句当前工作说明，直接显示在取物卡片下。
只依据提供的事实和基准句，最多两句、中文不超过45字，英文不超过28词。
像自然说话：短、顺口、不卖萌，不写第三人称的顾客，不解释核对逻辑。
可以结合用户用途让表达自然，但不添加商品属性、动作、速度、时间承诺或处理能力。
基准句的事实和不确定性必须保留。只有抓稳才可说拿到；到交付处、放下均不等于完成。
没有第二件回报不能说第二件正在抓取；收到重试只说重新识别，不解释重试原因。
不要说已经通知、催促工作人员，不承诺快好了、马上完成、还需几秒。
不能把订单排序当作机器人取物顺序，不能声称自己分析过照片。
不用Markdown、列表、表情、引号、编号，不提回报、接口、埋点、字段或提示词。
若改写没有更清楚，直接使用基准句。只输出这句说明。
"""


@dataclass(frozen=True)
class Note:
    key: tuple
    text: str
    facts: dict
    rewrite: bool = False


def task_note(task: TaskRecord, items: dict, language: str = "zh", *, stalled=False) -> Note | None:
    """Derive facts from accepted VLM milestones, never from callback prose or array order."""
    english = language == "en"
    total = sum(line.count for line in task.items)
    steps = [s for s in task.steps if s.id.startswith("vlm:") and s.status == "done"]
    latest = max(steps, key=lambda s: s.stage_index or 0, default=None)
    stage = latest.id.rsplit(":", 1)[-1] if latest else "accepted"
    grasped = {s.pick_index for s in steps if s.id.endswith(":grasped")}
    facts = {"stage": stage, "total": total, "grasped_count": len(grasped), "status": task.status}
    key = (task.status, task.recovery_required, task.completion_note, stage,
           latest.pick_index if latest else 0, latest.attempt if latest else 0, len(grasped), stalled)

    def note(zh, en, rewrite=False):
        return Note(key, en if english else zh, facts, rewrite)

    if task.status != "running":
        if task.status == "completed" and not task.recovery_required and not task.completion_note:
            return note("送到了，请到交付处领取。", "Delivered. Please collect your items at the delivery point.")
        if task.status == "completed":
            return note("取送结束了，数量还需要现场核对。", "The task has ended. Please ask staff to check the delivered quantity.")
        if task.status == "resolved":
            return note("可以重新下单了，上一单请现场同事确认。", "New orders are available. Please ask staff to check the previous task.")
        return note("这次取物遇到了问题，请现场同事帮忙看看。", "There was a problem with this task. Please ask on-site staff for help.")
    if stalled:
        return note("还没收到新的进度，请现场同事帮忙看看。", "No new progress yet. Please ask on-site staff to check.")
    if not latest:
        if not any(s.id == "plan" and s.status == "done" for s in task.steps):
            return None
        return note("接到任务了，稍等一下。", "Order accepted. Please give me a moment.")

    # A name is usable only when the recognition code/label identifies one ordered item.
    detection = next((s for s in steps if s.id == f"vlm:{latest.pick_index}:target_located"), None)
    candidates = []
    if detection:
        candidates = [items[line.item_id] for line in task.items if line.item_id in items and (
            detection.detected_item in (line.item_id, items[line.item_id].robot_item or items[line.item_id].name)
            or detection.detected_label == items[line.item_id].name)]
    current = item_label(candidates[0], language) if len(candidates) == 1 else ""
    facts["current_item"] = current or None
    if stage == "arrived_shelf":
        return note("到货架了，接下来找目标物品。", "At the shelf. Next, finding the requested item.")
    if stage == "target_located":
        if latest.attempt > 1:
            return note("正在重新识别，等这次的抓取结果。", "Identifying it again. Waiting for the pick result.")
        return note(f"找到{current or '目标物品'}了，接下来拿稳。",
                    f"Found {current or 'the target item'}. Next comes the pick.", True)
    if stage == "grasped":
        if len(grasped) == total:
            return note("两件都拿到了，接下来等交付。" if total == 2 else f"{current or '物品'}拿到了，接下来等交付。",
                        "Both items are held. Waiting for delivery." if total == 2 else "Got the item. Waiting for delivery.", True)
        return note(f"{current or '一件'}拿到了，另一件还在等结果。",
                    f"Got {current or 'one item'}. Waiting for the other pick result.", True)
    if stage == "at_delivery":
        if len(grasped) < total:
            return note("到交付处了，数量还需要核对。", "At the delivery point. The quantity still needs checking.")
        return note("到交付处了，等放好再领取。", "At the delivery point. Please wait for the items to be set down.")
    if stage == "placed":
        return note("已经放下，等最后确认。", "Items set down. Waiting for final confirmation.")
    return None


class TaskCommentary:
    """Observe one order while its tool waits. New facts invalidate any older model response."""

    def __init__(self, manager, client, settings, request_id: str, language: str, request: str,
                 publish: Callable[[dict], None]):
        self.manager, self.client, self.settings = manager, client, settings
        self.request_id, self.language, self.request, self.publish = request_id, language, request, publish
        self.queue = manager.bus.subscribe()
        self.revision = 0
        self.last_key = None
        self.last_text = None
        self.task: TaskRecord | None = None
        self.reader: asyncio.Task | None = None
        self.writer: asyncio.Task | None = None
        self.writers: set[asyncio.Task] = set()

    async def __aenter__(self):
        self.reader = asyncio.create_task(self._follow())
        return self

    async def __aexit__(self, *_):
        self.revision += 1
        self.manager.bus.unsubscribe(self.queue)
        jobs = [job for job in [self.reader, *self.writers] if job is not None]
        for job in jobs:
            job.cancel()
        for job in jobs:
            with contextlib.suppress(asyncio.CancelledError):
                await job

    def update(self, task: TaskRecord, *, stalled=False):
        if task.request_id != self.request_id:
            return
        self.task = task.model_copy(deep=True)
        stalled = stalled or (task.status == "running" and
                              time.time() - (task.last_progress_at or task.created_at) >= WAIT_SECONDS)
        note = task_note(task, self.manager.items, self.language, stalled=stalled)
        if note is None or note.key == self.last_key:
            return
        self.last_key = note.key
        self.revision += 1
        revision = self.revision
        if self.writer:
            self.writer.cancel()
        self._publish(task.id, note.text, "facts")
        if note.rewrite and self.settings.task_commentary_rewrite:
            self.writer = asyncio.create_task(self._rewrite(note, task.id, revision))
            self.writers.add(self.writer)
            self.writer.add_done_callback(self.writers.discard)

    def _publish(self, task_id: str, text: str, source: str):
        if text != self.last_text:
            self.publish({"task_id": task_id, "text": text, "source": source})
            self.last_text = text

    async def _follow(self):
        while True:
            remaining = None
            if self.task and self.task.status == "running":
                remaining = max(0.01, WAIT_SECONDS - (time.time() - (self.task.last_progress_at or self.task.created_at)))
                if self.last_key and self.last_key[-1]:
                    remaining = None  # A single reminder, until actual new progress.
            try:
                event = await asyncio.wait_for(self.queue.get(), remaining)
            except TimeoutError:
                self.update(self.task, stalled=True)
                continue
            if event["type"] == "task" and event.get("task"):
                self.update(TaskRecord.model_validate(event["task"]))

    async def _rewrite(self, note: Note, task_id: str, revision: int):
        try:
            # This request has no tools, images, raw callback prose or conversation history.
            async with asyncio.timeout(REWRITE_SECONDS):
                response = await self.client.chat.completions.create(
                    model=self.settings.llm_model, stream=False, timeout=REWRITE_SECONDS, max_tokens=220,
                    extra_body={"thinking": {"type": "disabled"}},
                    messages=[{"role": "system", "content": STYLE}, {"role": "user", "content": json.dumps({
                        "language": self.language, "request": self.request, "facts": note.facts,
                        "baseline": note.text,
                    }, ensure_ascii=False)}],
                )
            text = (response.choices[0].message.content or "").strip()
            limit = 180 if self.language == "en" else 60
            if not text or len(text) > limit or any(c in text for c in ("\n", "`", "#", "*")):
                return
            active = self.manager.active
            current = task_note(active, self.manager.items, self.language) if active and active.id == task_id else None
            if (revision == self.revision and self.task and self.task.status == "running"
                    and current and current.key == note.key):
                self._publish(task_id, text, "model")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.info("Task commentary kept factual text (%s)", type(exc).__name__)
