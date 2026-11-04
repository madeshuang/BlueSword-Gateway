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
from .language import item_label, language_of, order_label, robot_error_text
from .order_dialogue import apply_decision, change_message

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



async def serve_conversation(ws: Transport, settings, manager, agent, take, recover, *, boot_id=""):
    bus = manager.bus
    owner = uuid.uuid4().hex
    queue = bus.subscribe()
    session = agent.session(owner) if agent else None
    turn: asyncio.Task | None = None
    # 机器人动作前的确认：id → 等待用户答复的 future
    pending: dict[str, tuple[asyncio.Future, dict]] = {}
    muted_tasks: set[str] = set()
    editing: asyncio.Task | None = None
    edit_version = 0
    language = "zh"

    def emit(event):
        if not queue.full():
            queue.put_nowait(event)

    def say(text: str, english: str | None = None):
        text = english if language == "en" and english else text
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
            "show_camera": settings.show_camera,
            "boot_id": boot_id,
            "recovery_required": manager.store.recovery_required,
        }
    )
    # Snapshot restores progress on reconnection, without replaying a motion request.
    # 只恢复仍在执行、或需要工作人员处理的任务；已结束的旧任务不推送，避免一连上就弹出右侧面板
    if manager.active and (manager.busy or manager.active.recovery_required):
        emit({"type": "task", "task": manager.active.model_dump()})
    if manager.active and manager.remote_visual.get("task_id") == manager.active.id and (manager.busy or manager.active.recovery_required):
        emit({"type":"camera", "task_id":manager.active.id, "src":manager.remote_visual["src"]})
        emit({"type":"vision", "task_id":manager.active.id, "detections":[], "caption":manager.remote_visual["caption"], "scanning":False})
    phase = {"type": "phase", "phase": "acting" if manager.busy else "listening" if manager.store.recovery_required else "idle"}
    if manager.active and (manager.busy or manager.store.recovery_required):
        phase["task_id"] = manager.active.id
    emit(phase)

    async def request_confirm(plan: dict) -> bool:
        """Ask the visitor before any robot motion; timeout or disconnect counts as declined."""
        while True:
            if plan.get("_items"):
                target = order_label([TaskLine(**line) for line in plan["_items"]], manager.items, language)
                plan.update(describe_plan("fetch", target, language))
            identifier = uuid.uuid4().hex
            future = asyncio.get_running_loop().create_future()
            pending[identifier] = (future, plan)
            plan["_deadline"] = asyncio.get_running_loop().time() + settings.confirm_timeout
            visible = {key: value for key, value in plan.items() if not key.startswith("_")}
            emit({"type": "confirm_request", "id": identifier, "timeout_s": settings.confirm_timeout, **visible})
            emit({"type": "phase", "phase": "listening"})
            try:
                while True:
                    remaining = max(0.01, plan["_deadline"] - asyncio.get_running_loop().time())
                    try:
                        approved = await asyncio.wait_for(asyncio.shield(future), remaining)
                        break
                    except TimeoutError:
                        if asyncio.get_running_loop().time() >= plan["_deadline"]:
                            raise
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
            say(plan.pop("_change_message", f"这单是{plan['target']}，确认后出发。"), f'Updated to {plan["target"]}. Say "yes" or tap Confirm when ready.')

    def answer_confirm(identifier: str | None, approved: bool) -> bool:
        targets = [identifier] if identifier else list(pending)
        answered = False
        if editing and not editing.done() and approved:
            say("正在听清新的要求，清单更新后再确认吧。", "Please wait for the updated order before confirming.")
            return False
        for key in targets:
            entry = pending.get(key)
            future = entry[0] if entry else None
            if future and not future.done():
                future.set_result(approved)
                answered = True
        return answered

    async def handle_rules(text: str, request_id: str | None) -> None:
        if language == "en" and any(phrase in text.casefold() for phrase in ("inventory", "what is available", "what do you have")):
            stock = manager.stock
            say("", "Available stock: " + ", ".join(f"{item_label(item, 'en')}: {stock.get(item.id, 0)}" for item in manager.items.values()) + ".")
            return
        intent = resolve(text, manager.items)
        if intent.kind == "cancel":
            await manager.cancel()
        elif intent.kind == "inventory":
            identifier = uuid.uuid4().hex
            emit({"type": "assistant_start", "id": identifier})
            emit({"type": "assistant_delta", "id": identifier, "text": f"这是{intent.category or '全部物品'}的剩余库存。"})
            emit({"type": "skill", "id": identifier, "call_id": uuid.uuid4().hex,
                  "name": "check_inventory", "title": "查询库存", "target": intent.category or "全部",
                  "status": "done", "stock": [{"name": name, "count": count}
                                             for name, count in manager.inventory(intent.category).items()]})
            emit({"type": "assistant_end", "id": identifier})
        elif manager.busy:
            raise RobotError("busy", "正在执行取物，请等待完成或点击停止任务")
        elif intent.kind == "fetch":
            lines = intent.items or [TaskLine(item_id=intent.item_id)]
            plan = {**describe_plan("fetch", order_label(lines, manager.items, language), language), "_items": [line.model_dump() for line in lines]}
            if not await request_confirm(plan):
                say("好的，这次先不拿了。需要的时候再叫我。", "Okay, I've cancelled this order. Let me know if you need anything else.")
                return
            if language == "en":
                result = await manager.run_order([TaskLine(**line) for line in plan["_items"]], request_id or uuid.uuid4().hex, owner)
                if result.status == "completed" and not result.recovery_required and not result.completion_note:
                    say("", "The robot reports that your order has been delivered. Please collect it at the delivery point.")
                else:
                    say("", "I couldn't confirm the complete delivery. Please ask on-site staff to check the items and robot.")
                emit({"type": "phase", "phase": "listening"})
            else:
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
            say(robot_error_text(exc, language))
        except TimeoutError:
            say("读取机器人数据超时，请重试。", "The robot didn't reply in time. Please try again.")

    async def agent_turn(text: str, request_id: str | None) -> None:
        assert session is not None
        try:
            await session.turn(text, emit, request_confirm, request_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("LLM turn failed type=%s", type(exc).__name__)
            attempted = session.order_attempted
            if attempted or manager.busy or manager.store.recovery_required:
                say("回复暂时没接上，取物情况请看任务卡片。", "My reply was interrupted. Please check the task card for the robot's reported status.")
                return
            say("对话服务暂时没接上，本次没有下单，请稍后重试。", "My language service is unavailable. No order was placed. Please try again shortly.")
            emit({"type": "phase", "phase": "listening"})

    sending = asyncio.create_task(sender())
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 8192:
                say("输入过长，请缩短后重试。", "That message is too long. Please shorten it and try again.")
                continue
            try:
                event = ClientEvent.model_validate_json(raw)
                if event.type == "confirm_response":
                    if not event.approved and event.id in pending:
                        edit_version += 1
                        if editing:
                            editing.cancel()
                    answer_confirm(event.id, bool(event.approved))
                elif event.type == "reset":
                    edit_version += 1
                    if editing:
                        editing.cancel()
                    if manager.active:
                        muted_tasks.add(manager.active.id)
                    if turn and not turn.done():
                        turn.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await turn
                    language = "zh"
                    if session:
                        session.reset()
                    emit({"type": "session_end", "task_id": manager.active.id if manager.active else None})
                elif event.type == "cancel_task":
                    await manager.cancel(event.task_id)
                elif event.type == "mock_take":
                    await take()
                elif event.type == "mock_recover":
                    await recover()
                    say("模拟器已复位，可以开始新的取物任务。", "The simulator has been reset and is ready for a new order.")
                elif event.type == "wake_manual":
                    if manager.busy:
                        raise RobotError("busy", "正在执行取物，请稍候")
                    emit({"type": "wake"})
                    say("我在，说‘你好，布鲁’就可以和我说话。" if settings.speech_mode == "local"
                        else "我在，点一下麦克风就可以和我说话。")
                elif event.type == "text_input":
                    language = language_of(event.text, language)
                    if session:
                        session.language = language
                    if not event.text.strip():
                        say("请输入想要拿取的物品。", "Please tell me which item you would like.")
                        continue
                    if pending:
                        future, plan = next(iter(pending.values()))
                        if future.done():
                            say("清单正在更新，请看最新的确认内容。", "The order is updating. Please check the latest confirmation.")
                            continue
                        plan["_deadline"] = asyncio.get_running_loop().time() + settings.confirm_timeout
                        emit({"type": "confirm_refresh", "id": next(iter(pending)), "timeout_s": settings.confirm_timeout})
                        # Cancelling always invalidates an in-flight interpretation.
                        if confirmation_reply(event.text) is False:
                            edit_version += 1
                            if editing:
                                editing.cancel()
                            answer_confirm(None, False)
                            continue
                        if editing and not editing.done():
                            say("正在处理上一句调整，请等清单更新后再说。", "Please wait for your previous change to finish.")
                            continue
                        edit_version += 1
                        version = edit_version
                        async def revise(text, future, plan, version):
                            previous = [TaskLine(**line) for line in plan.get("_items", [])]
                            discussion = plan.setdefault("_discussion", [])
                            try:
                                if session and previous and language != "en":
                                    decision = await session.interpret_pending(text, previous, discussion)
                                    if future.done() or version != edit_version:
                                        return
                                    discussion.append({"role": "user", "content": text})
                                    if decision.kind in {"approve", "cancel"}:
                                        future.set_result(decision.kind == "approve")
                                        return
                                    if decision.kind == "reply":
                                        reply_text = decision.reply or "想怎么调整？再告诉我一下吧。"
                                        discussion.append({"role": "assistant", "content": reply_text})
                                        say(reply_text)
                                        return
                                    changed = apply_decision(decision, previous, manager.items)
                                else:
                                    changed = revise_order(text, previous, manager.items) if previous else None
                                    if changed is None:
                                        reply = confirmation_reply(text)
                                        if reply is None:
                                            say("原清单保留着。可以继续调整，选好后再确认。", "Your order is unchanged. You can add, remove or replace an item, or say yes to confirm.")
                                        else:
                                            future.set_result(reply)
                                        return
                                if future.done() or version != edit_version:
                                    return
                                if not changed:
                                    future.set_result(False)
                                    return
                                plan.update(describe_plan("fetch", order_label(changed, manager.items, language), language))
                                plan["_items"] = [line.model_dump() for line in changed]
                                plan.setdefault("_updates", []).append(text)
                                plan["_change_message"] = change_message(previous, changed, manager.items, language)
                                discussion.append({"role": "assistant", "content": plan["_change_message"]})
                                future.set_result("updated")
                            except ValueError as exc:
                                if not future.done() and version == edit_version:
                                    say(str(exc) if not isinstance(exc, ValidationError) else "这次调整还没确认清楚，原清单保留着。请再说一下想怎么改。", "I could not apply that change. Your order is unchanged; please specify up to two items from the catalog.")
                            except Exception:
                                logger.exception("Pending order interpretation failed")
                                if not future.done() and version == edit_version:
                                    say("刚才没听清调整，原清单保留着，可以再说一次。", "I could not understand that change. Your order is unchanged; please try again.")
                        editing = asyncio.create_task(revise(event.text, future, plan, version))
                    elif resolve(event.text, manager.items).kind == "cancel":
                        # 停止指令不经过大模型，立即生效
                        await manager.cancel()
                    elif turn and not turn.done():
                        say("我还在处理上一句话，请稍等一下。", "I'm still processing your previous request. Please wait a moment.")
                    elif session is None:
                        turn = asyncio.create_task(rules_turn(event.text, event.request_id))
                    else:
                        turn = asyncio.create_task(agent_turn(event.text, event.request_id))
            except ValidationError:
                say("消息格式无效，请使用 text_input、cancel_task 或 reset 等约定事件。", "That message format is invalid. Please use the page controls.")
            except RobotError as exc:
                say(robot_error_text(exc, language))
            except TimeoutError:
                say("读取机器人数据超时，请重试。", "The robot didn't reply in time. Please try again.")
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket session failed")
    finally:
        if editing:
            editing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await editing
        if turn and not turn.done():
            turn.cancel()
        bus.unsubscribe(queue)
        sending.cancel()
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await sending
        if turn:
            with contextlib.suppress(asyncio.CancelledError):
                await turn
