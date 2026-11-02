"""机器人侧（模拟兰剑）：接收 v1.1 任务下发，并按提案等级二回报阶段进度。

现有的 GDK 任务流程（FetchWorkflow + GDK 适配器）完全不改；这里只做两件事：
1. /api/task/dispatch 把下发报文转成一次技能执行；
2. Reporter 订阅流程里本来就有的步骤事件，翻译成 5 个阶段的回报，异步发给网关。
   回报超时 1 秒、失败直接丢弃，不影响机器人执行——对应提案里“只加几行回报”的说法。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

import httpx
from fastapi import FastAPI, Request

from .config import Settings
from .domain import RobotError, TaskLine, TaskRequest
from .protocol import ACTION_TO_SKILL, STAGE_LABEL, STAGE_OF_STEP, reply, stages_for
from .skills import SKILLS

logger = logging.getLogger(__name__)
FINAL = {"completed", "failed", "cancelled", "interrupted"}


class Reporter:
    """把一个任务的步骤事件翻译成阶段回报，按顺序发给网关。"""

    def __init__(self, gateway_url: str, task_id: str, skill: str, item_id: str, client: httpx.AsyncClient):
        self.base = gateway_url.rstrip("/")
        self.task_id, self.item_id, self.client = task_id, item_id, client
        self.steps = SKILLS[skill].steps
        self.stages = stages_for(self.steps)
        self.started: set[str] = set()
        self.details: dict[str, list[str]] = {}  # 每个阶段内各步骤的细节，阶段完成时一起回报

    async def post(self, path: str, body: dict) -> None:
        try:
            await self.client.post(self.base + path, json=body, timeout=1)
        except Exception as exc:  # 网关不可达：丢弃，不重试
            logger.info("report %s dropped: %s", path, exc)

    def _last_step_of(self, stage: str) -> str:
        return [s for s in self.steps if STAGE_OF_STEP.get(s) == stage][-1]

    async def on_event(self, event: dict) -> bool:
        """处理一个事件；任务结束时返回 True。"""
        kind = event.get("type")
        base = {"taskId": self.task_id, "item": self.item_id}
        if kind == "task_step":
            stage = STAGE_OF_STEP.get(event["id"])
            if not stage:
                return False
            now = int(time.time() * 1000)
            if event["status"] == "active" and stage not in self.started:
                self.started.add(stage)
                await self.post("/api/task/progress", {**base, "stage": stage, "status": "started",
                                                       "label": STAGE_LABEL[stage], "ts": now})
            elif event["status"] == "done":
                if event.get("detail"):
                    self.details.setdefault(stage, []).append(event["detail"])
                if event["id"] == self._last_step_of(stage):
                    await self.post("/api/task/progress", {**base, "stage": stage, "status": "done",
                                                           "label": STAGE_LABEL[stage],
                                                           "detail": "，".join(self.details.get(stage, [])), "ts": now})
            elif event["status"] == "failed":
                await self.post("/api/task/progress", {**base, "stage": stage, "status": "failed",
                                                       "label": STAGE_LABEL[stage], "detail": event.get("detail", ""),
                                                       "ts": now})
        elif kind == "task" and event.get("task") and event["task"]["id"] == event.get("task_id"):
            task = event["task"]
            if task["status"] == "completed":
                await self.post("/api/task/finished", {"taskId": self.task_id, "result": "success"})
                return True
            if task["status"] in FINAL:
                failed = next((s["id"] for s in task["steps"] if s["status"] == "failed"), None)
                await self.post("/api/task/error", {
                    "taskId": self.task_id,
                    "message": (task.get("error") or {}).get("message", "任务未完成"),
                    "stage": STAGE_OF_STEP.get(failed or "", None),
                    "holding": bool(task.get("holding")),
                })
                return True
        return False


def mount_robot_api(app: FastAPI, settings: Settings) -> None:
    client = httpx.AsyncClient(trust_env=False)  # 局域网直连，不走系统代理

    @app.post("/api/task/dispatch")
    async def dispatch(request: Request):
        manager = app.state.manager
        try:
            body = await request.json()
            items = body["items"]
            action = body.get("action")
            if action not in ACTION_TO_SKILL:
                return reply(False, f"不支持的 action：{action}")
            lines = [TaskLine(item_id=line["item"], count=line.get("count", 1)) for line in items]
            order = TaskRequest(items=lines, request_id="validate", skill=ACTION_TO_SKILL[action])
            item_id = order.item_id
        except Exception:
            return reply(False, "报文不合法")
        task_id = str(body.get("taskId") or uuid.uuid4().hex)
        skill = ACTION_TO_SKILL[action]
        queue = manager.bus.subscribe()  # 先订阅，避免漏掉第一条步骤事件
        try:
            task = await manager.start(TaskRequest(items=order.items, request_id=task_id, skill=skill), narrate=False)
        except RobotError as exc:
            manager.bus.unsubscribe(queue)
            return reply(False, str(exc))
        if settings.gateway_url:
            reporter = Reporter(settings.gateway_url, task_id, skill, item_id, client)

            async def pump():
                try:
                    while True:
                        event = await queue.get()
                        if event.get("task_id") == task.id and await reporter.on_event(event):
                            return
                finally:
                    manager.bus.unsubscribe(queue)

            asyncio.create_task(pump(), name=f"report-{task_id}")
        else:
            manager.bus.unsubscribe(queue)
        return reply(True, "received")
