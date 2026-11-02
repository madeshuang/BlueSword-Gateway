from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from .config import Item, Settings, Waypoint
from .domain import Detection, Frame, MotionResult, Point, RobotError, TakeSignal, TaskRecord
from .perception import locate
from .ports import RobotBundle
from .skills import SKILLS, STEP_DEFS
from .storage import TaskStore

logger = logging.getLogger(__name__)


class FetchWorkflow:
    def __init__(
        self,
        bundle: RobotBundle,
        settings: Settings,
        waypoints: dict[str, Waypoint],
        store: TaskStore,
        emit: Callable[[dict], None],
    ):
        self.robot, self.detector = bundle.robot, bundle.detector
        self.settings, self.waypoints, self.store, self.emit = settings, waypoints, store, emit
        self.task: TaskRecord | None = None
        # 由大模型编排技能时，台词交给大模型说，工作流不再插入固定话术
        self.narrate = True

    def event(self, value: dict) -> None:
        assert self.task
        event = {**value, "task_id": self.task.id, "at": time.time()}
        self.store.append(self.task.id, event)
        self.emit(event)
        trace = getattr(getattr(self.robot, "scene", None), "trace", None)
        if trace is not None:
            trace.event(event)

    def snapshot(self) -> None:
        assert self.task
        self.store.save(self.task)
        self.event({"type": "task", "task": self.task.model_dump()})

    def message(self, text: str) -> None:
        assert self.task
        identifier = f"{self.task.id}-{time.time_ns()}"
        self.event({"type": "assistant_start", "id": identifier})
        self.event({"type": "assistant_delta", "id": identifier, "text": text})
        self.event({"type": "assistant_end", "id": identifier})

    async def call(self, action: Awaitable, timeout: float | None = None):
        try:
            async with asyncio.timeout(timeout or self.settings.motion_timeout):
                return await action
        except TimeoutError as exc:
            raise RobotError("timeout", "操作超时，已中止任务并请求停止运动") from exc

    async def motion(self, action: Awaitable, *, navigation: bool = False) -> MotionResult:
        result = await self.call(action)
        if not isinstance(result, MotionResult) or not result.completed:
            raise RobotError("motion_failed", getattr(result, "detail", "动作没有完成反馈"))
        if navigation and (
            not math.isfinite(result.error_m) or result.error_m > self.settings.navigation_tolerance
        ):
            raise RobotError("navigation_accuracy", "导航完成但停靠误差超出限制")
        return result

    @asynccontextmanager
    async def step(self, identifier: str, detail: str = ""):
        assert self.task
        step = next(s for s in self.task.steps if s.id == identifier)
        step.status, step.detail = "active", detail
        self.store.save(self.task)
        self.event(
            {"type": "task_step", "id": identifier, "status": "active", "detail": detail, "gdk": step.gdk}
        )
        yield step
        step.status = "done"
        self.store.save(self.task)
        self.event({"type": "task_step", "id": identifier, "status": "done", "detail": step.detail})

    async def scan(self, item: Item, *, search: bool) -> tuple[Frame, Detection]:
        # Bounded search of shelf layers; yaw/pitch radians, waist displacement meters.
        poses = [(0, 0, 0), (-0.15, 0, 0), (0.15, 0, 0.12), (0, 0.10, -0.10)]
        for yaw, pitch, waist in poses if search else [(None, None, None)]:
            if yaw is not None:
                await self.motion(self.robot.observe(yaw, pitch, waist))
            frame = await self.call(self.robot.capture())
            detections = await self.call(self.detector.detect(frame, item))
            valid = [
                d for d in detections if math.isfinite(d.score) and d.score >= self.settings.confidence_min
            ]
            # Preserve instance identity once selected; do not silently grab a different product.
            matching = [d for d in valid if d.id == item.id]
            self.event({"type": "camera", "src": frame.preview_src})
            self.event(
                {
                    "type": "vision",
                    "detections": [d.event(item.id) for d in valid],
                    "scanning": not bool(matching),
                    "caption": f"识别到 {len(valid)} 个物品；目标：{item.name}",
                }
            )
            if matching:
                return frame, max(matching, key=lambda d: d.score)
        raise RobotError("target_not_found", f"已检查不同角度和层高，仍未找到{item.name}")

    def reachable(self, point: Point) -> bool:
        return all(
            low <= value <= high
            for value, (low, high) in zip(
                (point.x, point.y, point.z),
                (self.settings.grasp_x, self.settings.grasp_y, self.settings.grasp_z),
            )
        )

    async def locate_target(self, frame, detection):
        # Only the Blender demonstration exposes this proposed perception SDK.
        estimator = getattr(self.detector, "estimate_grasp_pose", None)
        if estimator is not None:
            return await self.call(estimator(frame, detection, self.settings.frame_max_age))
        return locate(frame, detection, self.settings.frame_max_age)

    async def align(self, item: Item, point: Point) -> Point:
        for _ in range(self.settings.max_adjustments):
            if self.reachable(point):
                return point
            if not (
                self.settings.grasp_x[0] <= point.x <= self.settings.grasp_x[1]
                and self.settings.grasp_z[0] <= point.z <= self.settings.grasp_z[1]
            ):
                raise RobotError("unreachable", "目标距离或高度超出抓取范围")
            low, high = self.settings.grasp_y
            desired_y = min(high - 0.04, max(low + 0.04, point.y))
            dy = point.y - desired_y
            if abs(dy) > self.settings.max_lateral_move:
                raise RobotError("alignment_limit", "所需横移距离超出本次任务限制")
            await self.motion(self.robot.relative_move(0, dy, 0))
            # Never reuse pre-motion camera coordinates/TF after moving the base.
            frame, detection = await self.scan(item, search=False)
            point = await self.locate_target(frame, detection)
        if not self.reachable(point):
            raise RobotError("unreachable", "横移后目标仍不可达")
        return point

    # —— 步骤实现：每个步骤是若干 GDK 原语的组合（见 skills.STEP_DEFS），技能按顺序编排步骤
    async def _nav(self, ctx: dict, step) -> None:
        await self.motion(self.robot.navigate(self.waypoints[ctx["item"].shelf]))
        step.detail = "已到达地图引导点"

    async def _precision(self, ctx: dict, step) -> None:
        result = await self.motion(
            self.robot.high_precision_navi(self.waypoints[ctx["item"].shelf]), navigation=True
        )
        step.detail = f"停靠误差 {result.error_m * 100:.1f} cm"

    async def _scan(self, ctx: dict, step) -> None:
        item = ctx["item"]
        self.event({"type": "vision", "scanning": True, "detections": [], "caption": "正在寻找目标"})
        ctx["frame"], ctx["detection"] = await self.scan(item, search=True)
        step.detail = f"已找到{item.name} · 置信度 {ctx['detection'].score:.2f}"

    async def _locate(self, ctx: dict, step) -> None:
        point = ctx["point"] = await self.locate_target(ctx["frame"], ctx["detection"])
        step.detail = f"base_link ({point.x:.3f}, {point.y:.3f}, {point.z:.3f}) m"

    async def _align(self, ctx: dict, step) -> None:
        old = ctx["point"]
        ctx["point"] = await self.align(ctx["item"], old)
        step.detail = "目标已可达" if old == ctx["point"] else "横移完成，已重新计算坐标"

    async def _grasp(self, ctx: dict, step) -> None:
        assert self.task
        point = ctx["point"]
        await self.motion(self.robot.gripper(False))
        await self.motion(self.robot.arm_move("pregrasp", point.shift(dx=-0.10)))
        await self.motion(self.robot.arm_move("approach", point))
        await self.motion(self.robot.gripper(True))
        self.task.holding = bool(await self.call(self.robot.is_holding()))
        if not self.task.holding:
            raise RobotError("grasp_unverified", "夹爪闭合，但没有检测到稳定持物")
        step.detail = "已确认稳定持物"

    async def _retreat(self, ctx: dict, step) -> None:
        point = ctx["point"]
        await self.motion(self.robot.arm_move("lift", point.shift(dz=0.08)))
        await self.motion(self.robot.arm_move("retreat", point.shift(dx=-0.14, dz=0.08)))
        await self.motion(self.robot.arm_move("carry"))
        step.detail = "已进入持物导航姿态"

    async def _deliver(self, ctx: dict, step) -> None:
        handover = self.waypoints["handover"]
        await self.motion(self.robot.navigate(handover))
        await self.motion(self.robot.high_precision_navi(handover), navigation=True)
        frame = await self.call(self.robot.capture())
        self.event({"type": "camera", "src": frame.preview_src})
        self.event({"type": "vision", "detections": [], "scanning": False, "caption": "已返回递物点"})
        step.detail = "已到达递物点"

    async def _handover(self, ctx: dict, step) -> None:
        item = ctx["item"]
        if not await self.call(self.robot.is_holding()):
            raise RobotError("object_lost", "返回途中持物反馈丢失")
        await self.motion(self.robot.arm_move("handover"))
        if self.narrate:
            self.message(f"{item.name}已经递出，请接稳后取走。")
        started = time.time_ns()
        signal = await self.call(self.robot.wait_for_take(), self.settings.handover_timeout)
        if (
            not isinstance(signal, TakeSignal)
            or not signal.supported
            or signal.timestamp_ns < started
            or not 0 <= time.time_ns() - signal.timestamp_ns <= 2_000_000_000
        ):
            raise RobotError("take_unverified", "没有收到本次递物的有效接物反馈，保持夹爪")
        step.detail = "已检测到接物支撑反馈"

    async def _release(self, ctx: dict, step) -> None:
        assert self.task
        await self.motion(self.robot.gripper(False))
        self.task.holding = bool(await self.call(self.robot.is_holding()))
        if self.task.holding:
            raise RobotError("release_unverified", "松爪后仍有持物反馈")
        await self.motion(self.robot.arm_move("stow"))
        step.detail = "物品已交接，手臂已收回"

    async def run(self, task: TaskRecord, item: Item) -> TaskRecord:
        self.task = task
        skill = SKILLS[task.skill]
        impl = {
            "nav": self._nav,
            "precision": self._precision,
            "scan": self._scan,
            "locate": self._locate,
            "align": self._align,
            "grasp": self._grasp,
            "retreat": self._retreat,
            "deliver": self._deliver,
            "handover": self._handover,
            "release": self._release,
        }
        self.snapshot()
        self.event({"type": "phase", "phase": "acting"})
        if self.narrate:
            self.message(f"收到，我会去货架拿取{item.name}，然后回到递物点。")
        try:
            health = await self.call(self.robot.health())
            if not health.get("online") or health.get("stopped"):
                raise RobotError("not_ready", "机器人未就绪，需要先检查状态")
            if skill.requires_holding:
                if not health.get("holding") or not await self.call(self.robot.is_holding()):
                    raise RobotError("not_holding", "机器人手里没有物品，需要先执行取货")
                task.holding = True
            else:
                if health.get("holding"):
                    raise RobotError("not_ready", "机器人仍在持物，需要先卸货或检查状态")
                await self.motion(self.robot.prepare(item))
            ctx: dict = {"item": item}
            for step_id in skill.steps:
                if step_id == "plan":
                    continue
                async with self.step(step_id, STEP_DEFS[step_id].label) as step:
                    await impl[step_id](ctx, step)
            task.status = "completed"
            if self.narrate:
                self.message(f"{item.name}已交到你手上，取物任务完成。")
        except asyncio.CancelledError:
            await self.abort("cancelled", "cancelled", "任务已取消，已请求停止运动并保持夹爪状态")
        except RobotError as exc:
            await self.abort("failed", exc.code, str(exc))
        except Exception:
            logger.exception("Unexpected execution error for task %s", task.id)
            await self.abort("failed", "internal_error", "执行发生异常，已请求停止，请检查后端日志")
        finally:
            task.finished_at = time.time()
            self.snapshot()
            self.event({"type": "vision", "scanning": False})
            if self.narrate:
                self.event({"type": "phase", "phase": "listening"})
        return task

    async def abort(self, status: str, code: str, message: str) -> None:
        assert self.task
        self.store.set_recovery(True)
        self.task.status = status
        self.task.recovery_required = True
        self.task.error = {"code": code, "message": message}
        try:
            async with asyncio.timeout(5):
                await self.robot.stop()
                health = await self.robot.health()
                self.task.holding = bool(health.get("holding", True))
        except Exception:
            self.task.holding = True  # Unknown physical state: never assume empty.
            self.task.error["stop"] = "未能确认停止；需要现场检查"
            logger.exception("Failed to confirm stop")
        for step in self.task.steps:
            if step.status == "active":
                step.status, step.detail = "failed", message
                self.event({"type": "task_step", "id": step.id, "status": "failed", "detail": message})
        if self.narrate:
            self.message(message + "。请先检查并复位，再开始下一次任务。")
