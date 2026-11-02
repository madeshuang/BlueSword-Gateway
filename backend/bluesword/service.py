from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path

from .config import Item, Settings, load_scene
from .domain import RobotError, TaskLine, TaskRecord, TaskRequest, TaskStep
from .mock import MockRobot
from .ports import RobotBundle
from .remote import RemoteWorkflow, remote_steps
from .skills import SKILLS, STEP_DEFS
from .storage import TaskStore
from .workflow import FetchWorkflow


class EventBus:
    def __init__(self):
        self.subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue = asyncio.Queue(maxsize=512)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def emit(self, event: dict) -> None:
        for queue in tuple(self.subscribers):
            if queue.full():
                # Slow clients reconnect to a fresh task snapshot; never stall robot control.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "transport_overflow"})
                self.unsubscribe(queue)
            else:
                queue.put_nowait(event)


class TaskManager:
    def __init__(self, bundle: RobotBundle, settings: Settings, store: TaskStore, bus: EventBus):
        self.bundle, self.settings, self.store, self.bus = bundle, settings, store, bus
        self.waypoints, self.items = load_scene()
        self.waypoints = getattr(bundle.robot, "scene_waypoints", self.waypoints)
        catalog_path = settings.catalog_path
        if not catalog_path and settings.robot_mode == "lanjian_http" and settings.robot_protocol == "vlm":
            catalog_path = str(Path(__file__).resolve().parents[2] / "config/booth-catalog.example.json")
        if catalog_path:
            raw = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
            if not isinstance(raw, list) or not raw:
                raise ValueError("物品目录必须是非空数组")
            self.items = {}
            for row in raw:
                item = Item(id=row["id"], name=row["name"], name_en=row.get("nameEn", ""),
                            aliases_en=row.get("aliasesEn", []), aliases=[row["name"], *row.get("aliases", [])],
                            location=row.get("location", ""), robot_item=row.get("robotItem", row["name"]), box=(0, 0, 0.1, 0.1), stock=row["initialStock"], category=row["category"])
                if item.id in self.items:
                    raise ValueError(f"物品目录 id 重复：{item.id}")
                self.items[item.id] = item
        if settings.robot_mode == "lanjian_http" and settings.robot_protocol != "vlm" and any(item.location.strip() in ("", "待配置") for item in self.items.values()):
            raise ValueError("现场模式请配置物品 location 或 BLUESWORD_CATALOG_PATH")
        self.store.init_inventory(self.items)
        self.lock = asyncio.Lock()
        self.active: TaskRecord | None = None
        self.owner: str | None = None
        self.job: asyncio.Task | None = None
        self.started = asyncio.Event()
        self.cancelling = False
        self.inspection_owner: str | None = None
        # 取货成功后手里的物品；卸货需要它。未知时（异常/重启）保持 None，并由复位流程处理。
        self.held_item_id: str | None = None
        # 库存在发单前持久化预留；只有明确拒单才自动退回。

        # lanjian_http 模式：机器人回调报文的收件箱与协议日志
        self.remote_inbox: asyncio.Queue = asyncio.Queue()
        self.remote_visual: dict = {}
        from .remote import ProtocolLog

        self.protocol = ProtocolLog(bus.emit)

    @property
    def stock(self) -> dict[str, int]:
        return self.store.inventory()

    @property
    def busy(self) -> bool:
        return self.job is not None and not self.job.done()

    async def initialize(self) -> None:
        await self.bundle.robot.connect()
        unfinished = self.store.running()
        if unfinished:
            self.store.set_recovery(True)
            await self.bundle.robot.stop()
            for task in unfinished:
                task.status, task.recovery_required = "interrupted", True
                task.error = {
                    "code": "process_restart",
                    "message": "服务重启，任务未自动重放；需要检查机器人状态",
                }
                task.finished_at = time.time()
                for step in task.steps:
                    if step.status == "active":
                        step.status = "failed"
                        step.detail = "服务中断"
                self.store.save(task)
                self.active = task
        if self.active is None and self.store.recovery_required:
            self.active = next((t for t in self.store.recent() if t.recovery_required), None)

    async def start(self, request: TaskRequest, owner: str | None = None, *, narrate: bool = True) -> TaskRecord:
        async with self.lock:
            previous = self.store.by_request(request.request_id)
            if previous:
                prior_items = previous.items or [TaskLine(item_id=previous.item_id)]
                if sorted((x.item_id,x.count) for x in prior_items) != sorted((x.item_id,x.count) for x in request.items) or previous.skill != request.skill:
                    raise RobotError("request_conflict", "同一 request_id 不能用于不同物品")
                return previous
            if self.settings.robot_mode == "lanjian_http" and request.skill != "fetch" and not self.settings.split_skills:
                raise RobotError("unsupported_skill", "当前机器人使用完整取物任务。")
            if any(line.item_id not in self.items for line in request.items):
                raise RobotError("unknown_item", "物品不在展会货架配置中")
            if previous is None and request.skill == "unload" and request.item_id != self.held_item_id:
                raise RobotError("not_holding", "机器人手里没有这件物品，需要先执行取货")
            if previous is None and request.skill != "unload" and self.held_item_id:
                raise RobotError("holding", "机器人手里还有物品，需要先卸货")
            if request.skill != "unload":
                for line in request.items:
                    if self.stock.get(line.item_id, 0) < line.count:
                        raise RobotError("out_of_stock", f"{self.items[line.item_id].name}数量不够了，换个选择吧。")
            if self.busy or self.inspection_owner:
                raise RobotError("busy", "机器人正在执行任务，请等待完成或先停止任务")
            if self.store.recovery_required:
                raise RobotError("recovery_required", "这次需要现场同事帮忙看一下。")
            if self.settings.robot_mode == "lanjian_http" and self.settings.robot_protocol == "vlm":
                if request.skill != "fetch":
                    raise RobotError("unsupported_skill", "当前机器人使用完整取物任务。")
                health = await self.bundle.robot.health(refresh=True)
                if not health["online"]:
                    raise RobotError("robot_offline", "暂时没连上机器人，稍后再试试。")
                if health.get("robot_busy"):
                    raise RobotError("busy", "机器人还在忙，稍等一下再来吧。")
            item = self.items[request.item_id]
            skill = SKILLS[request.skill]
            title = {"fetch": f"拿取{item.name}", "pick": f"取货 · {item.name}", "unload": f"卸货 · {item.name}"}
            task = TaskRecord(
                id=uuid.uuid4().hex,
                request_id=request.request_id,
                item_id=item.id,
                items=request.items,
                skill=skill.name,
                title=title[skill.name] if request.skill != "fetch" else "拿取" + self.order_label(request.items),
                created_at=time.time(),
                steps=remote_steps(skill.name, item, self.settings.robot_protocol)
                if self.settings.robot_mode == "lanjian_http"
                else [
                    TaskStep(
                        id=id_,
                        label=STEP_DEFS[id_].label,
                        status="done" if id_ == "plan" else "pending",
                        detail=f"目标：{item.name}" if id_ == "plan" else "",
                        gdk=STEP_DEFS[id_].gdk,
                    )
                    for id_ in skill.steps
                ],
            )
            if self.settings.robot_mode != "lanjian_http" and sum(x.count for x in request.items) > 1:
                task.steps = [TaskStep(id=f"{n}:{step}", label=f"{self.items[item_id].name} · {STEP_DEFS[step].label}",
                                      gdk=STEP_DEFS[step].gdk, status="done" if step == "plan" else "pending")
                              for n,item_id in enumerate([x.item_id for x in request.items for _ in range(x.count)],1)
                              for step in skill.steps]
            self.store.create_task(task, reserve=request.skill != "unload")
            self.active, self.owner = task, owner
            if self.settings.robot_mode == "lanjian_http":
                self.remote_visual.clear()
                self.bus.emit({"type":"camera", "src":None})
                self.bus.emit({"type":"vision", "detections":[], "caption":"", "scanning":False})
            self.cancelling = False
            self.started.clear()
            self.job = asyncio.create_task(self._execute(task, narrate), name=f"{skill.name}-{task.id}")
            return task

    def order_label(self, lines: list[TaskLine]) -> str:
        return "、".join(f"{self.items[line.item_id].name} × {line.count}" for line in lines)

    async def run_order(self, lines: list[TaskLine], request_id: str, owner: str | None = None) -> TaskRecord:
        task = await self.start(TaskRequest(items=lines, request_id=request_id), owner, narrate=False)
        if self.active is task and self.job is not None:
            await asyncio.shield(self.job)
        return task

    async def run_skill(self, skill: str, item_id: str, owner: str | None = None) -> TaskRecord:
        """Start a skill and wait for its final record (used by the LLM agent)."""
        task = await self.start(
            TaskRequest(item_id=item_id, request_id=uuid.uuid4().hex, skill=skill), owner, narrate=False
        )
        job = self.job
        if job is not None and self.active is task:
            await asyncio.shield(job)
        return task

    async def _execute(self, task: TaskRecord, narrate: bool = True) -> TaskRecord:
        self.started.set()
        robot = self.bundle.robot
        trace = getattr(getattr(robot, "scene", None), "trace", None)
        if trace is not None:
            trace.reset(task)
        if hasattr(robot, "command_sink"):
            robot.command_sink = lambda command: self.store.append(
                task.id, {"type": "robot_command", **command}
            )
        if self.settings.robot_mode == "lanjian_http":
            workflow = RemoteWorkflow(
                self.bundle.robot, self.settings, self.store, self.bus.emit, self.remote_inbox, self.protocol
            )
        else:
            workflow = FetchWorkflow(self.bundle, self.settings, self.waypoints, self.store, self.bus.emit)
        workflow.narrate = narrate
        try:
            result = await workflow.run(task, self.items[task.item_id], self.items)
            if result.status == "completed":
                self.held_item_id = result.item_id if SKILLS[result.skill].leaves_holding else None
                self.store.settle_stock(task.id)
            elif (result.error or {}).get("code") == "rejected":
                self.store.settle_stock(task.id, refund=True)
            return result
        finally:
            if hasattr(robot, "command_sink"):
                robot.command_sink = None
            self.owner = None

    async def cancel(self, task_id: str | None = None, *, owner: str | None = None) -> TaskRecord | None:
        if not self.busy or not self.active:
            return self.active
        if task_id and task_id != self.active.id:
            raise RobotError("task_conflict", "指定任务已不是当前执行任务")
        if owner is not None and self.owner != owner:
            return self.active
        if self.settings.robot_mode == "lanjian_http":
            raise RobotError("stop_unavailable", "这边还不能直接让机器人停下，请现场同事帮忙。")
        job = self.job
        await self.started.wait()
        if not self.cancelling and not job.done():
            self.cancelling = True
            job.cancel()
        await asyncio.shield(job)
        return self.active

    async def recover_mock(self) -> None:
        async with self.lock:
            if self.busy or self.inspection_owner:
                raise RobotError("busy", "请先停止当前任务")
            if not (
                isinstance(self.bundle.robot, MockRobot)
                or getattr(self.bundle.robot, "supports_mock_controls", False)
            ):
                raise RobotError("mock_only", "此接口只能复位模拟器")
            self.bundle.robot.recover()
            self.store.set_recovery(False)
            self.active = None
            self.held_item_id = None
            self.bus.emit({"type": "task", "task": None})
            self.bus.emit({"type": "phase", "phase": "listening"})

    @property
    def categories(self) -> list[str]:
        return list(dict.fromkeys(item.category for item in self.items.values()))

    def inventory(self, category: str | None = None) -> dict[str, int]:
        """按物品名汇总的库存（同名多件，如两瓶安慕希，合并计数）；可只看某一类。"""
        totals: dict[str, int] = {}
        for item_id, item in self.items.items():
            if category and item.category != category:
                continue
            totals[item.name] = totals.get(item.name, 0) + self.stock.get(item_id, 0)
        return totals

    def restock(self, item_id: str | None = None) -> dict[str, int]:
        if item_id is not None and item_id not in self.items:
            raise RobotError("unknown_item", "没有找到这件物品。")
        self.store.restock([item for key,item in self.items.items() if item_id in (None,key)])
        return self.inventory()

    async def resolve_remote(self, expected_task_id: str | None) -> None:
        async with self.lock:
            if self.settings.robot_mode != "lanjian_http":
                raise RobotError("mode", "模拟器请使用复位。")
            if (self.active.id if self.active else None) != expected_task_id or (not self.active and not self.store.recovery_required):
                raise RobotError("task_conflict", "任务已变化，请重新核对。")
            if not self.busy and not self.store.recovery_required:
                raise RobotError("task_conflict", "任务已结束，不需要恢复接单。")
            if self.busy:
                self.job.cancel()
                await asyncio.shield(self.job)
            if self.active:
                self.active.status = "resolved"
                self.active.recovery_required = False
                self.store.save(self.active)
                self.store.settle_stock(self.active.id)  # 现场处理不退库存
            self.store.set_recovery(False)
            self.held_item_id = None
            self.bus.emit({"type":"task", "task":self.active.model_dump() if self.active else None})
            self.bus.emit({"type":"phase", "phase":"listening"})

    async def shutdown(self) -> None:
        if self.settings.robot_mode == "lanjian_http" and self.busy:
            self.job.cancel()
            await asyncio.shield(self.job)
        else:
            await self.cancel()
        await self.bundle.robot.close()

    async def inspect(self, owner: str) -> list:
        async with self.lock:
            if self.busy or self.inspection_owner:
                raise RobotError("busy", "机器人正在执行任务，当前视野已经显示在右侧")
            if self.store.recovery_required:
                raise RobotError("recovery_required", "请先复位机器人，再读取画面")
            self.inspection_owner = owner
        try:
            async with asyncio.timeout(self.settings.motion_timeout):
                frame = await self.bundle.robot.capture()
                detections = await self.bundle.detector.detect(frame, None)
            self.bus.emit({"type": "camera", "src": frame.preview_src})
            self.bus.emit(
                {
                    "type": "vision",
                    "detections": [d.event() for d in detections],
                    "scanning": False,
                    "caption": "、".join(d.label for d in detections) or "当前画面没有识别到货架物品",
                }
            )
            return detections
        finally:
            self.inspection_owner = None
