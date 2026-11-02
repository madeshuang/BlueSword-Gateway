from __future__ import annotations

import asyncio
import math
import time
from dataclasses import asdict
from html import escape
from urllib.parse import quote

import numpy as np

from .config import Item, Settings, Waypoint
from .domain import (
    Command,
    Detection,
    Frame,
    Intrinsics,
    MotionResult,
    Point,
    RobotError,
    TakeSignal,
    Transform,
)


class MockRobot:
    """Stateful robot test double; validates ordering and emits reproducible RGB-D/TF.

    This is an interface/geometry simulation, not dynamics, collision checking,
    real detection, grasp planning, or a verified GDK implementation.
    """

    name = "机器人模拟器 · Mock"
    mode = "mock"

    def __init__(self, settings: Settings, waypoints: dict[str, Waypoint], items: dict[str, Item]):
        self.settings, self.waypoints, self.items = settings, waypoints, items
        self.commands: list[Command] = []
        self.command_sink = None
        self.connected = False
        self.holding = False
        self.stopped = False
        self.arm_stage = "stow"
        self.at_shelf = False
        self.lateral = 0.0
        self.yaw = self.pitch = self.waist = 0.0
        self.captures = 0
        self.take_ready = asyncio.Event()
        self.take_confirmed = False
        self.k = Intrinsics(600, 600, 500, 312.5, 1000, 625)
        self.objects: dict[str, np.ndarray] = {}
        for item in items.values():
            x, y, w, h = item.box
            self.objects[item.id] = np.array(
                [
                    0.62,
                    -(x + w / 2 - 0.5) * 1000 * 0.62 / 600,
                    1.1 - (y + h / 2 - 0.5) * 625 * 0.62 / 600,
                ]
            )

    async def _command(self, name: str, **arguments) -> None:
        if not self.connected:
            raise RobotError("disconnected", "机器人未连接")
        if self.stopped:
            raise RobotError("stopped", "机器人已停止，需要复位模拟器")
        command = Command(name, arguments, time.time_ns())
        self.commands.append(command)
        if self.command_sink:
            self.command_sink(asdict(command))
        await asyncio.sleep(self.settings.mock_delay)

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        await self.stop()
        self.connected = False

    async def health(self) -> dict:
        return {
            "online": self.connected,
            "holding": self.holding,
            "stopped": self.stopped,
            "mode": self.mode,
            "name": self.name,
        }

    async def prepare(self, item: Item) -> MotionResult:
        if self.holding or self.arm_stage != "stow":
            raise RobotError("not_ready", "机器人未处于空闲收臂状态")
        await self._command("prepare", item_id=item.id)
        return MotionResult(True)

    async def navigate(self, waypoint: Waypoint) -> MotionResult:
        if self.arm_stage not in {"stow", "carry"}:
            raise RobotError("arm_not_stowed", "手臂未收回，不能导航")
        await self._command("navigate", waypoint=waypoint.model_dump())
        if self.settings.scenario == "nav_failure":
            return MotionResult(False, detail="模拟导航受阻")
        if self.settings.scenario == "nav_timeout":
            await asyncio.Event().wait()
        self.at_shelf = waypoint.name != self.waypoints["handover"].name
        self.lateral = 0
        self.captures = 0
        self.yaw = self.pitch = self.waist = 0
        if self.at_shelf:
            self.take_ready.clear()
            self.take_confirmed = False
        return MotionResult(True, error_m=0.02)

    async def high_precision_navi(self, waypoint: Waypoint) -> MotionResult:
        await self._command("high_precision_navi", waypoint=waypoint.model_dump())
        if self.settings.scenario == "precision_unavailable":
            raise RobotError("unsupported_capability", "当前模拟 GDK 不支持高精导航")
        return MotionResult(True, error_m=0.008)

    async def observe(self, yaw: float, pitch: float, waist_m: float) -> MotionResult:
        await self._command("observe", yaw=yaw, pitch=pitch, waist_m=waist_m)
        self.yaw, self.pitch, self.waist = yaw, pitch, waist_m
        return MotionResult(True)

    async def capture(self) -> Frame:
        await self._command("capture_rgbd")
        self.captures += 1
        timestamp = time.time_ns()
        if self.settings.scenario == "stale_frame":
            timestamp -= 10_000_000_000
        cy, sy, cp, sp = math.cos(self.yaw), math.sin(self.yaw), math.cos(self.pitch), math.sin(self.pitch)
        rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
        ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
        optical_to_base = np.array([[0, 0, 1], [-1, 0, 0], [0, -1, 0]])
        matrix = np.eye(4)
        matrix[:3, :3] = rz @ ry @ optical_to_base
        matrix[:3, 3] = [0, 0, 1.1 + self.waist]
        detections = []
        depth = np.zeros((self.k.height, self.k.width), dtype=np.float32)
        visible = self.settings.scenario != "not_found"
        if self.settings.scenario == "search" and self.captures < 3:
            visible = False
        if self.at_shelf and visible:
            for item in self.items.values():
                base = self.objects[item.id] - np.array([0, self.lateral, 0])
                camera = matrix[:3, :3].T @ (base - matrix[:3, 3])
                if camera[2] <= 0:
                    continue
                u = self.k.fx * camera[0] / camera[2] + self.k.cx
                v = self.k.fy * camera[1] / camera[2] + self.k.cy
                w, h = item.box[2:]
                x, y = u / self.k.width - w / 2, v / self.k.height - h / 2
                if min(x, y) < 0 or x + w > 1 or y + h > 1:
                    continue
                detections.append(Detection(item.id, item.name, 0.96, (float(x), float(y), w, h)))
                depth[
                    int(y * self.k.height) : math.ceil((y + h) * self.k.height),
                    int(x * self.k.width) : math.ceil((x + w) * self.k.width),
                ] = camera[2]
        if self.settings.scenario == "bad_depth":
            depth[:] = np.nan
        if self.settings.scenario == "tf_error":
            matrix[0, 0] = np.nan
        return Frame(
            depth,
            self.k,
            Transform(matrix, "head_color_optical_frame", "base_link", timestamp),
            timestamp,
            preview_src=self._preview(detections),
            mock_detections=detections,
        )

    def _preview(self, detections: list[Detection]) -> str:
        shapes = ['<rect width="1000" height="625" fill="#111b29"/>']
        if self.at_shelf:
            shapes.append('<rect x="50" y="60" width="820" height="530" fill="#192638" stroke="#5a7188"/>')
            for y in (206, 388, 569):
                shapes.append(f'<rect x="50" y="{y}" width="820" height="12" fill="#52677f"/>')
            for d in detections:
                x, y, w, h = d.box
                shapes.append(
                    f'<rect x="{x * 1000:.1f}" y="{y * 625:.1f}" width="{w * 1000:.1f}" '
                    f'height="{h * 625:.1f}" rx="8" fill="#537eac"/>'
                )
                shapes.append(
                    f'<text x="{(x + w / 2) * 1000:.1f}" y="{(y + h / 2) * 625:.1f}" '
                    f'text-anchor="middle" fill="white" font-size="18">{escape(d.label)}</text>'
                )
        else:
            shapes.append(
                '<text x="500" y="310" text-anchor="middle" fill="#b7c9dd" font-size="28">模拟递物点</text>'
            )
        shapes.append(
            '<text x="960" y="600" text-anchor="end" fill="#9eb3c9" font-size="18">MOCK · 合成相机画面</text>'
        )
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 625">' + "".join(shapes) + "</svg>"
        return "data:image/svg+xml," + quote(svg)

    async def relative_move(self, dx: float, dy: float, dyaw: float) -> MotionResult:
        if self.arm_stage != "stow" or self.holding:
            raise RobotError("unsafe_alignment", "调整底盘时手臂必须收起且未持物")
        if dx != 0 or dyaw != 0 or abs(dy) > self.settings.max_lateral_move:
            raise RobotError("move_limit", "底盘调整超出本任务允许范围")
        await self._command("relative_move", dx=dx, dy=dy, dyaw=dyaw)
        self.lateral += dy
        return MotionResult(True)

    async def arm_move(self, stage: str, target: Point | None = None) -> MotionResult:
        allowed = {"stow", "pregrasp", "approach", "lift", "retreat", "carry", "handover"}
        if stage not in allowed:
            raise RobotError("arm_stage", "未知手臂动作")
        if stage in {"lift", "retreat", "carry", "handover"} and not self.holding:
            raise RobotError("empty_gripper", "夹爪没有确认持物")
        if stage == "handover" and self.at_shelf:
            raise RobotError("wrong_location", "尚未返回递物点")
        if stage in {"pregrasp", "approach", "lift", "retreat"} and target is None:
            raise RobotError("missing_pose", "抓取阶段缺少位置")
        await self._command("arm_move", stage=stage, target=asdict(target) if target else None)
        self.arm_stage = stage
        return MotionResult(True)

    async def gripper(self, closed: bool) -> MotionResult:
        if closed and self.arm_stage != "approach":
            raise RobotError("grasp_order", "必须完成接近动作后闭合夹爪")
        if not closed and self.holding and not (self.arm_stage == "handover" and self.take_confirmed):
            raise RobotError("release_without_take", "没有接物反馈，保持夹爪")
        await self._command("gripper", closed=closed)
        self.holding = closed and self.settings.scenario != "grasp_failure"
        return MotionResult(True)

    async def is_holding(self) -> bool:
        await self._command("grasp_feedback")
        return self.holding

    async def wait_for_take(self) -> TakeSignal:
        if self.arm_stage != "handover" or not self.holding:
            raise RobotError("handover_order", "必须先持物递出")
        await self._command("wait_for_take")
        if self.settings.scenario == "handover_timeout":
            await asyncio.Event().wait()
        if self.settings.auto_take:
            await asyncio.sleep(max(0.02, self.settings.mock_delay * 2))
        else:
            await self.take_ready.wait()
        self.take_confirmed = True
        return TakeSignal(True, time.time_ns(), "mock_receiver_support")

    def confirm_take(self) -> None:
        if self.arm_stage != "handover" or not self.holding:
            raise RobotError("not_waiting", "当前没有等待接物的任务")
        self.take_ready.set()

    async def stop(self) -> None:
        command = Command("stop", {"hold_gripper": True}, time.time_ns())
        self.commands.append(command)
        if self.command_sink:
            self.command_sink(asdict(command))
        self.stopped = True

    def recover(self) -> None:
        # Explicit simulator reset, NOT a real-world release/recovery action.
        self.stopped = self.holding = self.take_confirmed = False
        self.arm_stage = "stow"
        self.take_ready.clear()


class MockDetector:
    async def detect(self, frame: Frame, item: Item | None) -> list[Detection]:
        return frame.mock_detections
