"""网关侧（lanjian_http 模式）：机器人在另一个进程，通过兰剑协议下发任务、接收回报。

技能（取货 / 卸货 / 取物）→ POST dispatch → 等待 progress / finished / error 回调。
回调报文由 app.py 的 /api/task/* 接口放进 TaskManager.remote_inbox。
"""

from __future__ import annotations

import asyncio
import collections
import logging
import time
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

from .config import Item, Settings
from .domain import RobotError, TaskLine, TaskRecord
from .protocol import SKILL_TO_ACTION, STAGE_GDK, STAGE_LABEL, stages_for
from .skills import SKILLS
from .storage import TaskStore

logger = logging.getLogger(__name__)


class ProtocolLog:
    """最近的协议报文，供前端“机器人通信”面板展示。"""

    def __init__(self, emit: Callable[[dict], None], store: TaskStore | None = None, retention_days: int = 30):
        self.emit, self.store, self.retention_days = emit, store, retention_days
        self.entries: collections.deque[dict] = collections.deque(maxlen=200)
        self.pruned_at = time.monotonic()
        if store:
            store.init_protocol(retention_days)
            self.entries.extend(reversed(list(store.protocol_rows(limit=200))))

    @staticmethod
    def clean(value):
        if isinstance(value, dict):
            return {str(k): ("<REDACTED>" if any(word in str(k).lower() for word in ("token", "secret", "password", "authorization", "api_key"))
                            else {name: value[k].get(name) for name in ("mime", "width", "height")} if k == "image" and isinstance(value[k], dict)
                            else ProtocolLog.clean(v)) for k, v in value.items()}
        if isinstance(value, list):
            return [ProtocolLog.clean(v) for v in value[:100]]
        if isinstance(value, str):
            return "<image omitted>" if value.startswith("data:image/") else value[:4000]
        return value

    def add(self, direction: str, path: str, body: dict, reply: dict | None = None) -> None:
        entry = {"direction": direction, "path": path, "body": self.clean(body), "reply": self.clean(reply), "at": time.time()}
        if self.store:
            if time.monotonic() - self.pruned_at > 3600:
                self.store.prune_protocol(self.retention_days)
                self.pruned_at = time.monotonic()
            entry = self.store.log_protocol(entry)
        self.entries.append(entry)
        # Detailed protocol data is read only through the staff API.


class RemoteRobot:
    """lanjian_http 模式下的机器人端口：只有状态查询，动作全部通过协议下发。"""

    mode = "lanjian_http"
    supports_mock_controls = False

    def __init__(self, settings: Settings):
        self.settings = settings
        parts = urlsplit(settings.robot_dispatch_url)
        self.base = f"{parts.scheme}://{parts.netloc}" if parts.netloc else ""
        self.name = f"机器人 · {parts.netloc or '未配置'}"
        self.client = httpx.AsyncClient(trust_env=False)
        self.holding = False
        self.health_cache: dict = {}
        self.protocol_log: ProtocolLog | None = None
        self.health_at = 0.0

    async def connect(self) -> None:
        if not self.settings.robot_dispatch_url:
            raise RuntimeError("lanjian_http 模式需要配置 BLUESWORD_ROBOT_DISPATCH_URL")

    async def close(self) -> None:
        await self.client.aclose()

    async def health(self, refresh: bool = False) -> dict:
        if self.settings.robot_protocol == "vlm":
            if refresh or time.monotonic() - self.health_at > 2:
                online, busy = False, None
                try:
                    response = await self.client.get(self.base + "/api/health", timeout=self.settings.robot_timeout)
                    body = response.json()
                    online = response.is_success and body.get("success") is True and type(body.get("busy")) is bool
                    busy = body.get("busy") if online else None
                    if self.protocol_log:
                        self.protocol_log.add("out", "/api/health", {}, {"http_status": response.status_code, "body": body})
                except Exception as exc:
                    if self.protocol_log:
                        self.protocol_log.add("out", "/api/health", {}, {"error": type(exc).__name__})
                self.health_cache = {"online": online, "robot_busy": busy}
                self.health_at = time.monotonic()
            return {**self.health_cache, "holding": None, "telemetry_available": False,
                    "stopped": False, "mode": self.mode, "name": self.name}
        return {"online": bool(self.settings.robot_dispatch_url), "holding": self.holding,
                "telemetry_available": False, "stopped": False, "mode": self.mode, "name": self.name}

    async def stop(self) -> None:
        logger.warning("v1.1 协议没有取消接口：网关只能停止跟踪，机器人侧需现场确认")

    async def capture(self):
        raise RobotError("no_camera", "当前协议没有提供机器人相机画面，暂时看不到货架")

    async def is_holding(self) -> bool:
        return self.holding

    def confirm_take(self) -> None:
        raise RobotError("mock_only", "接物由机器人侧传感器确认")

    def recover(self) -> None:
        self.holding = False


class NullDetector:
    async def detect(self, frame, item):
        return []


class RemoteWorkflow:
    """把一次技能执行变成：下发 → 接单 → 阶段回报 → 完成 / 故障。"""

    def __init__(self, robot: RemoteRobot, settings: Settings, store: TaskStore, emit, inbox: asyncio.Queue,
                 log: ProtocolLog):
        self.robot, self.settings, self.store, self.emit, self.inbox, self.log = robot, settings, store, emit, inbox, log
        self.narrate = True
        self.task: TaskRecord | None = None

    def event(self, value: dict) -> None:
        assert self.task
        event = {**value, "task_id": self.task.id, "at": time.time()}
        self.store.append(self.task.id, event)
        self.emit(event)

    def snapshot(self) -> None:
        assert self.task
        self.store.save(self.task)
        self.event({"type": "task", "task": self.task.model_dump()})

    def set_step(self, step_id: str, status: str, detail: str | None = None) -> None:
        assert self.task
        step = next((s for s in self.task.steps if s.id == step_id), None)
        if step is None:
            return
        step.status = status
        if detail is not None:
            step.detail = detail
        self.store.save(self.task)
        self.event({"type": "task_step", "id": step_id, "status": status, "detail": step.detail, "gdk": step.gdk})

    async def run(self, task: TaskRecord, item: Item, items: dict[str, Item] | None = None) -> TaskRecord:
        self.task = task
        self.snapshot()
        self.event({"type": "phase", "phase": "acting"})
        while not self.inbox.empty():  # 丢弃上一单迟到的回调
            self.inbox.get_nowait()
        catalog = items or {item.id: item}
        lines = task.items or [TaskLine(item_id=item.id)]
        body: dict = {"items": [{"location": catalog[line.item_id].location,
                                 "item": (catalog[line.item_id].robot_item or catalog[line.item_id].name) if self.settings.robot_protocol == "vlm" else line.item_id,
                                 "count": line.count} for line in lines]}
        if self.settings.robot_protocol == "vlm":
            # Multiple display slots may refer to the same robot SKU (e.g. two yogurts).
            combined: dict[str, dict] = {}
            for line in body["items"]:
                if line["item"] in combined:
                    combined[line["item"]]["count"] += line["count"]
                else:
                    combined[line["item"]] = dict(line)
            body["items"] = list(combined.values())
        if self.settings.robot_protocol in ("progress", "vlm"):
            body["taskId"] = task.id
        action = SKILL_TO_ACTION[task.skill]
        if action:
            body["action"] = action
        try:
            await self._dispatch(body)
            await self._follow()
        except asyncio.CancelledError:
            self._fail("cancelled", "cancelled", "已停止跟踪这次任务；当前协议没有取消接口，请工作人员到现场确认机器人状态")
        except RobotError as exc:
            self._fail("failed", exc.code, str(exc))
        finally:
            task.finished_at = time.time()
            self.snapshot()
            if self.narrate:
                self.event({"type": "phase", "phase": "listening"})
        return task

    async def _dispatch(self, body: dict) -> None:
        assert self.task
        try:
            response = await self.robot.client.post(self.settings.robot_dispatch_url, json=body,
                                                    timeout=self.settings.robot_timeout)
            answer = response.json()
        except Exception as exc:
            self.log.add("out", "/api/task/dispatch", body, {"error": "无回复"})
            # 不能确认是否接单：不自动重发，交给工作人员核对（沿用网关 v1.1 的规则）
            raise RobotError("dispatch_uncertain", "没能确认机器人是否接单，请工作人员核对后再试") from exc
        self.log.add("out", "/api/task/dispatch", body, answer)
        if not response.is_success or not isinstance(answer, dict) or type(answer.get("success")) is not bool:
            raise RobotError("dispatch_uncertain", "还没确认是否接单，请现场同事帮忙看一下。")
        if not answer["success"]:
            raise RobotError("rejected", f"机器人没有接单：{answer.get('data') or '未说明原因'}")
        self.task.last_progress_at = self.task.last_progress_at or time.time()
        self.set_step("plan", "done", "机器人已接单")
        self.snapshot()

    async def _follow(self) -> None:
        assert self.task
        deadline = time.monotonic() + self.settings.remote_task_timeout if self.settings.remote_task_timeout else None
        while True:
            remaining = deadline - time.monotonic() if deadline is not None else None
            if remaining is not None and remaining <= 0:
                raise RobotError("result_timeout", "等待机器人完成通知超时，请工作人员核对")
            try:
                kind, body = await asyncio.wait_for(self.inbox.get(), remaining)
            except TimeoutError:
                continue
            if (self.settings.robot_protocol in ("progress", "vlm") and body.get("taskId") != self.task.id) or body.get("taskId") not in (None, self.task.id):
                continue  # 不是这一单的回报
            if kind == "progress":
                stage, status = body.get("stage"), body.get("status")
                mapped = {"started": "active", "done": "done", "failed": "failed"}.get(status)
                if stage and mapped:
                    if not any(s.id == stage for s in self.task.steps):
                        self.task.steps.append(type(self.task.steps[0])(
                            id=stage, label=body.get("label") or stage, gdk=STAGE_GDK.get(stage, [])))
                    self.set_step(stage, mapped, body.get("detail") or ("进行中" if mapped == "active" else None))
                    self.task.last_progress_at = time.time()
                    self.snapshot()
            elif kind == "finished":
                if body.get("result") not in (None, "success"):
                    continue
                if self.settings.robot_protocol == "vlm":
                    from .vlm import completion
                    completion(self.task)
                    self.store.set_recovery(self.task.recovery_required)
                else:
                    self.task.status = "completed"
                self.robot.holding = SKILLS[self.task.skill].leaves_holding
                self.task.holding = self.robot.holding
                return
            elif kind == "error":
                holding = body.get("holding")
                self.robot.holding = bool(holding) if holding is not None else True
                stage = body.get("stage")
                where = f"（{STAGE_LABEL.get(stage, stage)}阶段）" if stage else ""
                raise RobotError("robot_error", f"机器人报告故障{where}：{body.get('message', '未说明')}")

    def _fail(self, status: str, code: str, message: str) -> None:
        assert self.task
        rejected = code == "rejected"
        self.task.status = status
        self.task.error = {"code": code, "message": message}
        self.task.holding = self.robot.holding
        if not rejected:  # 被拒单说明机器人没动，不需要复位；其余情况都要现场核对
            self.task.recovery_required = True
            self.store.set_recovery(True)
        for step in self.task.steps:
            if step.status == "active":
                self.set_step(step.id, "failed", message)


def remote_steps(skill: str, item: Item, protocol: str = "progress"):
    """lanjian_http 模式下任务清单 = 接单 + 机器人会回报的阶段。"""
    from .domain import TaskStep

    steps = [TaskStep(id="plan", label="下发任务", status="pending", detail=f"目标：{item.name}")]
    if protocol == "vlm":
        return steps
    for stage in stages_for(SKILLS[skill].steps):
        steps.append(TaskStep(id=stage, label=STAGE_LABEL[stage], gdk=STAGE_GDK[stage]))
    return steps
