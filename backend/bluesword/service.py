from __future__ import annotations

import asyncio
import time
import uuid

from .config import Settings, load_scene
from .domain import RobotError, TaskRecord, TaskRequest, TaskStep
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
        self.lock = asyncio.Lock()
        self.active: TaskRecord | None = None
        self.owner: str | None = None
        self.job: asyncio.Task | None = None
        self.started = asyncio.Event()
        self.cancelling = False
        self.inspection_owner: str | None = None
        # 取货成功后手里的物品；卸货需要它。未知时（异常/重启）保持 None，并由复位流程处理。
        self.held_item_id: str | None = None
        # 展台库存（网关本地维护）：递出成功后减一，工作人员补货后重置
        self.stock: dict[str, int] = {item_id: item.stock for item_id, item in self.items.items()}
        # lanjian_http 模式：机器人回调报文的收件箱与协议日志
        self.remote_inbox: asyncio.Queue = asyncio.Queue()
        from .remote import ProtocolLog

        self.protocol = ProtocolLog(bus.emit)

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

    async def start(self, request: TaskRequest, owner: str | None = None, *, narrate: bool = True) -> TaskRecord:
        async with self.lock:
            previous = self.store.by_request(request.request_id)
            if previous:
                if previous.item_id != request.item_id:
                    raise RobotError("request_conflict", "同一 request_id 不能用于不同物品")
                return previous
            if request.item_id not in self.items:
                raise RobotError("unknown_item", "物品不在展会货架配置中")
            if previous is None and request.skill == "unload" and request.item_id != self.held_item_id:
                raise RobotError("not_holding", "机器人手里没有这件物品，需要先执行取货")
            if previous is None and request.skill != "unload" and self.held_item_id:
                raise RobotError("holding", "机器人手里还有物品，需要先卸货")
            if previous is None and request.skill != "unload" and self.stock.get(request.item_id, 0) <= 0:
                raise RobotError("out_of_stock", f"{self.items[request.item_id].name}已经没有库存了")
            if self.busy or self.inspection_owner:
                raise RobotError("busy", "机器人正在执行任务，请等待完成或先停止任务")
            if self.store.recovery_required:
                raise RobotError("recovery_required", "上次任务中止，需要先检查并复位")
            item = self.items[request.item_id]
            skill = SKILLS[request.skill]
            title = {"fetch": f"拿取{item.name}", "pick": f"取货 · {item.name}", "unload": f"卸货 · {item.name}"}
            task = TaskRecord(
                id=uuid.uuid4().hex,
                request_id=request.request_id,
                item_id=item.id,
                skill=skill.name,
                title=title[skill.name],
                created_at=time.time(),
                steps=remote_steps(skill.name, item)
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
            self.store.save(task)
            self.active, self.owner = task, owner
            self.cancelling = False
            self.started.clear()
            self.job = asyncio.create_task(self._execute(task, narrate), name=f"{skill.name}-{task.id}")
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
            result = await workflow.run(task, self.items[task.item_id])
            if result.status == "completed":
                self.held_item_id = result.item_id if SKILLS[result.skill].leaves_holding else None
                if result.skill in ("fetch", "unload"):  # 东西交到观众手里才算出库
                    self.stock[result.item_id] = max(0, self.stock.get(result.item_id, 0) - 1)
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
        for key, item in self.items.items():
            if item_id in (None, key):
                self.stock[key] = item.stock
        return self.inventory()

    async def shutdown(self) -> None:
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
