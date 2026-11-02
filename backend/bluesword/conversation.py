"""One conversation implementation for browser sessions and the native voice station."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from typing import Literal, Protocol

from fastapi import WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import describe_plan, glossary
from .domain import RobotError, TaskLine, TaskRequest
from .intents import confirmation_reply, resolve, revise_order

logger = logging.getLogger(__name__)


class Transport(Protocol):
    async def receive_text(self) -> str: ...
    async def send_json(self, event: dict) -> None: ...
    async def close(self, code: int = 1000) -> None: ...


class ClientEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal[
        "text_input", "wake_manual", "reset", "cancel_task", "mock_take", "mock_recover", "confirm_response"
    ]
    text: str = Field(default="", max_length=2000)
    id: str | None = Field(default=None, max_length=100)
    approved: bool | None = None
    request_id: str | None = Field(default=None, min_length=1, max_length=100)
    task_id: str | None = Field(default=None, max_length=100)



async def serve_conversation(ws: Transport, settings, manager, agent, take, recover):
    bus = manager.bus
    owner = uuid.uuid4().hex
    queue = bus.subscribe()
    session = agent.session(owner) if agent else None
    turn: asyncio.Task | None = None
    # 机器人动作前的确认：id → 等待用户答复的 future
    pending: dict[str, tuple[asyncio.Future, dict]] = {}
    muted_tasks: set[str] = set()

    def emit(event):
        if not queue.full():
            queue.put_nowait(event)

    def say(text: str):
        identifier = uuid.uuid4().hex
        emit({"type": "assistant_start", "id": identifier})
        emit({"type": "assistant_delta", "id": identifier, "text": text})
        emit({"type": "assistant_end", "id": identifier})

    async def sender():
        while True:
            event = await queue.get()
            if event.get("task_id") in muted_tasks and event["type"] in ("assistant_start", "assistant_delta", "assistant_end", "phase"):
                continue
            if event["type"] == "transport_overflow":
                await ws.close(code=1013)
                return
            await ws.send_json(event)

    emit({"type": "device", "online": True, "name": manager.bundle.robot.name})
    emit(
        {
            "type": "backend",
            "mode": settings.robot_mode,
            "glossary": glossary(manager.items),
            "recovery_required": manager.store.recovery_required,
        }
    )
    # Snapshot restores progress on reconnection, without replaying a motion request.
    # 只恢复仍在执行、或需要工作人员处理的任务；已结束的旧任务不推送，避免一连上就弹出右侧面板
    if manager.active and (manager.busy or manager.active.recovery_required):
        emit({"type": "task", "task": manager.active.model_dump()})
    if manager.active and manager.remote_visual.get("task_id") == manager.active.id and (manager.busy or manager.active.recovery_required):
        emit({"type":"camera", "src":manager.remote_visual["src"]})
        emit({"type":"vision", "detections":[], "caption":manager.remote_visual["caption"], "scanning":False})
    emit({"type": "phase", "phase": "acting" if manager.busy else "listening" if manager.store.recovery_required else "idle"})

    async def request_confirm(plan: dict) -> bool:
        """Ask the visitor before any robot motion; timeout or disconnect counts as declined."""
        while True:
            identifier = uuid.uuid4().hex
            future = asyncio.get_running_loop().create_future()
            pending[identifier] = (future, plan)
            visible = {key: value for key, value in plan.items() if not key.startswith("_")}
            emit({"type": "confirm_request", "id": identifier, "timeout_s": settings.confirm_timeout, **visible})
            emit({"type": "phase", "phase": "listening"})
            try:
                approved = await asyncio.wait_for(future, settings.confirm_timeout)
                reason = "updated" if approved == "updated" else "approved" if approved else "declined"
            except TimeoutError:
                approved, reason = False, "timeout"
            except asyncio.CancelledError:
                emit({"type": "confirm_closed", "id": identifier, "reason": "cancelled"})
                raise
            finally:
                pending.pop(identifier, None)
            emit({"type": "confirm_closed", "id": identifier, "reason": reason})
            if reason != "updated":
                return bool(approved)
            if plan.get("_skill"):
                emit({**plan["_skill"], "target": plan["target"], "status": "pending", "detail": "等待用户确认"})
            say(f"好，这单改为{plan['target']}，确认后我再出发。")

    def answer_confirm(identifier: str | None, approved: bool) -> bool:
        targets = [identifier] if identifier else list(pending)
        answered = False
        for key in targets:
            entry = pending.get(key)
            future = entry[0] if entry else None
            if future and not future.done():
                future.set_result(approved)
                answered = True
        return answered

    async def handle_rules(text: str, request_id: str | None) -> None:
        intent = resolve(text, manager.items)
        if intent.kind == "cancel":
            await manager.cancel()
        elif manager.busy:
            raise RobotError("busy", "正在执行取物，请等待完成或点击停止任务")
        elif intent.kind == "fetch":
            lines = intent.items or [TaskLine(item_id=intent.item_id)]
            plan = {**describe_plan("fetch", manager.order_label(lines)), "_items": [line.model_dump() for line in lines]}
            if not await request_confirm(plan):
                say("好的，这次先不拿了。需要的时候再叫我。")
                return
            await manager.start(
                TaskRequest(items=plan["_items"], request_id=request_id or uuid.uuid4().hex), owner
            )
        elif intent.kind == "look":
            detections = await manager.inspect(owner)
            say(
                "当前画面有：" + "、".join(d.label for d in detections)
                if detections
                else "当前相机没有识别到货架物品。可以直接告诉我想拿什么，我会先导航到货架。"
            )
        else:
            say(intent.text)

    async def rules_turn(text: str, request_id: str | None) -> None:
        try:
            await handle_rules(text, request_id)
        except RobotError as exc:
            say(str(exc))
        except TimeoutError:
            say("读取机器人数据超时，请重试。")

    async def agent_turn(text: str, request_id: str | None) -> None:
        assert session is not None
        try:
            await session.turn(text, emit, request_confirm, request_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("LLM turn failed; falling back to rules")
            attempted = session.order_attempted
            session.reset()
            if attempted or manager.busy or manager.store.recovery_required:
                say("回复暂时没接上，取物情况请看任务卡片。")
                return
            say("刚才没听明白，再告诉我想拿什么吧。")
            try:
                await handle_rules(text, request_id)
            except RobotError as exc:
                say(str(exc))
            emit({"type": "phase", "phase": "listening"})

    sending = asyncio.create_task(sender())
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 8192:
                say("输入过长，请缩短后重试。")
                continue
            try:
                event = ClientEvent.model_validate_json(raw)
                if event.type == "confirm_response":
                    answer_confirm(event.id, bool(event.approved))
                elif event.type == "reset":
                    if manager.active:
                        muted_tasks.add(manager.active.id)
                    if turn and not turn.done():
                        turn.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await turn
                    if session:
                        session.reset()
                    emit({"type": "session_end"})
                    if manager.active and (manager.busy or manager.store.recovery_required):
                        emit({"type":"task", "task":manager.active.model_dump()})
                    if manager.busy or manager.store.recovery_required:
                        emit({"type":"phase", "phase":"acting" if manager.busy else "listening"})
                elif event.type == "cancel_task":
                    await manager.cancel(event.task_id)
                elif event.type == "mock_take":
                    await take()
                elif event.type == "mock_recover":
                    await recover()
                    say("模拟器已复位，可以开始新的取物任务。")
                elif event.type == "wake_manual":
                    if manager.busy:
                        raise RobotError("busy", "正在执行取物，请稍候")
                    emit({"type": "wake"})
                    say("我在，说‘你好，布鲁’就可以和我说话。" if settings.speech_mode == "local"
                        else "我在，点一下麦克风就可以和我说话。")
                elif event.type == "text_input":
                    if not event.text.strip():
                        say("请输入想要拿取的物品。")
                        continue
                    if pending:
                        # Revise the unconfirmed whole order; never treat embedded “嗯/可以” as approval.
                        future, plan = next(iter(pending.values()))
                        if future.done():
                            say("清单正在更新，请看最新的确认内容。")
                            continue
                        try:
                            changed = revise_order(event.text, [TaskLine(**line) for line in plan["_items"]], manager.items) if "_items" in plan else None
                        except ValueError as exc:
                            say(str(exc))
                            continue
                        if changed is not None:
                            plan.update(describe_plan("fetch", manager.order_label(changed)))
                            plan["_items"] = [line.model_dump() for line in changed]
                            plan.setdefault("_updates", []).append(event.text)
                            future.set_result("updated")
                            continue
                        reply = confirmation_reply(event.text)
                        if reply is None:
                            say("可以继续调整这单。说“再来一个薯片”或“改成一包饼干”，选好后说“可以”就好。")
                        else:
                            answer_confirm(None, reply)
                    elif resolve(event.text, manager.items).kind == "cancel":
                        # 停止指令不经过大模型，立即生效
                        await manager.cancel()
                    elif turn and not turn.done():
                        say("我还在处理上一句话，请稍等一下。")
                    elif session is None:
                        turn = asyncio.create_task(rules_turn(event.text, event.request_id))
                    else:
                        turn = asyncio.create_task(agent_turn(event.text, event.request_id))
            except ValidationError:
                say("消息格式无效，请使用 text_input、cancel_task 或 reset 等约定事件。")
            except RobotError as exc:
                say(str(exc))
            except TimeoutError:
                say("读取机器人数据超时，请重试。")
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket session failed")
    finally:
        if turn and not turn.done():
            turn.cancel()
        bus.unsubscribe(queue)
        sending.cancel()
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await sending
        if turn:
            with contextlib.suppress(asyncio.CancelledError):
                await turn
