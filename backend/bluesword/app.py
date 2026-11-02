from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import create_agent, describe_plan, glossary
from .config import Settings
from .domain import RobotError, TaskLine, TaskRequest
from .drivers import create_bundle
from .intents import confirmation_reply, resolve, revise_order
from .mock import MockRobot
from .order_dialogue import apply_decision, change_message
from .protocol import reply
from .robot_api import mount_robot_api
from .service import EventBus, TaskManager
from .speech import mount_speech
from .storage import TaskStore
from .vlm import Progress, apply_progress, completion, log_body

logger = logging.getLogger(__name__)


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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.boot_id = uuid.uuid4().hex
        db_path = settings.db_path
        if settings.robot_mode in {"mock", "gdk_mock"} and db_path != ":memory:":
            path = Path(db_path)
            db_path = str(path.with_name(f"{path.stem}.{settings.robot_mode}{path.suffix}"))
        store = TaskStore(db_path)
        manager = None
        agent = None
        try:
            bundle = await create_bundle(settings)
            bus = EventBus()
            manager = TaskManager(bundle, settings, store, bus)
            await manager.initialize()
            agent = create_agent(settings, manager)
            app.state.manager, app.state.bus, app.state.agent = manager, bus, agent
            yield
        finally:
            if agent:
                await agent.close()
            if manager:
                await manager.shutdown()
            store.close()

    app = FastAPI(title="BlueSword Fetch Agent", version="0.1.0", lifespan=lifespan)
    mount_speech(app, settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type", "X-Operator-Token"],
    )

    async def authorize(authorization: str | None = Header(default=None)):
        if settings.api_token and not secrets.compare_digest(
            authorization or "", f"Bearer {settings.api_token}"
        ):
            raise HTTPException(401, "Invalid API token")

    @app.exception_handler(RobotError)
    async def robot_error(_request, exc: RobotError):
        code = 404 if exc.code == "unknown_item" else 409
        return JSONResponse(status_code=code, content={"code": exc.code, "message": str(exc)})

    async def operator(x_operator_token: str | None = Header(default=None)):
        if not settings.operator_token or not secrets.compare_digest(x_operator_token or "", settings.operator_token):
            raise HTTPException(403, "请填写工作人员口令。")

    @app.post("/api/operator/resolve", dependencies=[Depends(authorize), Depends(operator)])
    async def resolve_task(request: Request):
        body = await request.json()
        if not isinstance(body, dict) or body.get("confirmation") != "已核对机器人和物品":
            raise HTTPException(400, "请先核对机器人和物品。")
        await app.state.manager.resolve_remote(body.get("task_id"))
        return {"resolved": True}

    @app.get("/health", dependencies=[Depends(authorize)])
    async def health():
        manager = app.state.manager
        return {
            **await manager.bundle.robot.health(),
            "busy": manager.busy,
            "recovery_required": manager.store.recovery_required,
            "intent_provider": f"deepseek:{settings.llm_model}" if app.state.agent else "rules",
        }

    @app.get("/api/inventory", dependencies=[Depends(authorize)])
    async def inventory(category: str | None = None):
        return app.state.manager.inventory(category)

    @app.post("/api/inventory/reset", dependencies=[Depends(authorize), Depends(operator)])
    async def restock(item_id: str | None = None):
        """工作人员补货后重置库存（不带 item_id 表示全部补满）。"""
        return app.state.manager.restock(item_id)

    @app.get("/api/items", dependencies=[Depends(authorize)])
    async def items():
        return [item.model_dump() for item in app.state.manager.items.values()]

    @app.get("/api/simulation", dependencies=[Depends(authorize)])
    async def simulation():
        manager = app.state.manager
        scene = getattr(manager.bundle.robot, "scene", None)
        if settings.robot_mode != "gdk_mock" or scene is None:
            raise HTTPException(409, "Start the backend with BLUESWORD_ROBOT_MODE=gdk_mock")
        return {
            **scene.sample(),
            "task": manager.active.model_dump() if manager.active else None,
            "recovery_required": manager.store.recovery_required,
        }

    @app.post("/api/tasks", status_code=202, dependencies=[Depends(authorize)])
    async def start_task(request: TaskRequest):
        return await app.state.manager.start(request)

    @app.get("/api/tasks", dependencies=[Depends(authorize)])
    async def tasks():
        return app.state.manager.store.recent()

    @app.get("/api/tasks/{task_id}", dependencies=[Depends(authorize)])
    async def get_task(task_id: str):
        task = app.state.manager.store.get(task_id)
        if not task:
            raise HTTPException(404, "Task not found")
        return task

    @app.get("/api/tasks/{task_id}/events", dependencies=[Depends(authorize)])
    async def task_events(task_id: str):
        await get_task(task_id)
        return app.state.manager.store.events(task_id)

    @app.post("/api/tasks/{task_id}/cancel", dependencies=[Depends(authorize)])
    async def cancel_task(task_id: str):
        task = await get_task(task_id)
        if task.status != "running":
            return task
        return await app.state.manager.cancel(task_id)

    @app.post("/api/mock/take", dependencies=[Depends(authorize)])
    async def mock_take():
        robot = app.state.manager.bundle.robot
        if not (isinstance(robot, MockRobot) or getattr(robot, "supports_mock_controls", False)):
            raise RobotError("mock_only", "此接口只能模拟接物反馈")
        robot.confirm_take()
        return {"accepted": True}

    @app.post("/api/mock/recover", dependencies=[Depends(authorize)])
    async def mock_recover():
        if settings.robot_mode == "lanjian_http":
            raise HTTPException(409, "请通过现场协助核对当前任务。")
        await app.state.manager.recover_mock()
        return {"recovered": True}

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        origin = ws.headers.get("origin")
        same_origin = {f"http://{ws.headers.get('host')}", f"https://{ws.headers.get('host')}"}
        if origin and origin not in settings.allowed_origins and origin not in same_origin:
            await ws.close(code=1008)
            return
        if settings.api_token and not secrets.compare_digest(
            ws.query_params.get("token", ""), settings.api_token
        ):
            await ws.close(code=1008)
            return
        await ws.accept()
        manager, bus = app.state.manager, app.state.bus
        owner = uuid.uuid4().hex
        queue = bus.subscribe()
        session = app.state.agent.session(owner) if app.state.agent else None
        turn: asyncio.Task | None = None
        # 机器人动作前的确认：id → 等待用户答复的 future
        pending: dict[str, tuple[asyncio.Future, dict]] = {}
        muted_tasks: set[str] = set()
        editing: asyncio.Task | None = None
        edit_version = 0

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
                "show_camera": settings.show_camera,
                "boot_id": app.state.boot_id,
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
                say(plan.pop("_change_message", f"这单是{plan['target']}，确认后出发。"))

        def answer_confirm(identifier: str | None, approved: bool) -> bool:
            targets = [identifier] if identifier else list(pending)
            answered = False
            if editing and not editing.done() and approved:
                say("正在听清新的要求，清单更新后再确认吧。")
                return False
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
                        await mock_take()
                    elif event.type == "mock_recover":
                        await mock_recover()
                        say("模拟器已复位，可以开始新的取物任务。")
                    elif event.type == "wake_manual":
                        if manager.busy:
                            raise RobotError("busy", "正在执行取物，请稍候")
                        emit({"type": "wake"})
                        say("我在，点一下麦克风就可以和我说话。")
                    elif event.type == "text_input":
                        if not event.text.strip():
                            say("请输入想要拿取的物品。")
                            continue
                        if pending:
                            future, plan = next(iter(pending.values()))
                            if future.done():
                                say("清单正在更新，请看最新的确认内容。")
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
                                say("正在处理上一句调整，请等清单更新后再说。")
                                continue
                            edit_version += 1
                            version = edit_version
                            async def revise(text, future, plan, version):
                                previous = [TaskLine(**line) for line in plan.get("_items", [])]
                                discussion = plan.setdefault("_discussion", [])
                                try:
                                    if session and previous:
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
                                                say("原清单保留着。可以继续调整，选好后再确认。")
                                            else:
                                                future.set_result(reply)
                                            return
                                    if future.done() or version != edit_version:
                                        return
                                    if not changed:
                                        future.set_result(False)
                                        return
                                    plan.update(describe_plan("fetch", manager.order_label(changed)))
                                    plan["_items"] = [line.model_dump() for line in changed]
                                    plan.setdefault("_updates", []).append(text)
                                    plan["_change_message"] = change_message(previous, changed, manager.items)
                                    discussion.append({"role": "assistant", "content": plan["_change_message"]})
                                    future.set_result("updated")
                                except ValueError as exc:
                                    if not future.done() and version == edit_version:
                                        say(str(exc) if not isinstance(exc, ValidationError) else "这次调整还没确认清楚，原清单保留着。请再说一下想怎么改。")
                                except Exception:
                                    logger.exception("Pending order interpretation failed")
                                    if not future.done() and version == edit_version:
                                        say("刚才没听清调整，原清单保留着，可以再说一次。")
                            editing = asyncio.create_task(revise(event.text, future, plan, version))
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

    if settings.robot_mode == "lanjian_http":
        # 网关侧：接收机器人回调（v1.1 + 提案等级二），回复格式与 v1.1 一致
        for kind in ("progress", "finished", "error"):

            async def callback(request: Request):
                request.state.protocol_body = {"note": "报文无法解析或超过大小限制"}
                kind = request.url.path.rsplit("/", 1)[-1]
                manager = app.state.manager
                try:
                    raw = bytearray()
                    async for part in request.stream():
                        raw.extend(part)
                        if len(raw) > 400_000:
                            return JSONResponse(status_code=413, content=reply(False, "报文过大"))
                    import json
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise ValueError
                    request.state.protocol_body = body
                except Exception:
                    return reply(False, "报文不合法")
                if kind == "finished" and (body.get("result") != "success" or any(k not in ("taskId","result") for k in body)):
                    return reply(False, "完成通知内容不正确")
                if kind == "error" and (not isinstance(body.get("message"),str) or not body["message"].strip()):
                    return reply(False, "请提供故障描述")
                active = manager.active
                if active and (active.status in ("completed", "resolved") or (settings.robot_protocol == "vlm" and (active.error or {}).get("code") == "robot_error")):
                    return reply(False, "本次任务已结束")
                if not active or (active.status != "running" and not active.recovery_required):
                    if kind == "error" and not body.get("taskId") and settings.robot_protocol == "v1":
                        # A robot fault also blocks orders when no order is in flight.
                        manager.active = None
                        manager.store.set_recovery(True)
                        manager.bus.emit({"type":"task", "task":None})
                        manager.bus.emit({"type":"backend", "mode":settings.robot_mode,
                                          "recovery_required":True, "glossary":glossary(manager.items)})
                        return reply(True)
                    return reply(False,"当前没有等待结果的任务")
                if body.get("taskId") not in (None,active.id) or (settings.robot_protocol in ("progress", "vlm") and body.get("taskId") != active.id):
                    return reply(False,"任务编号不一致")
                answer = reply(True)
                if settings.robot_protocol == "vlm" and kind == "progress":
                    try:
                        progress = Progress.model_validate(body)
                        changed = apply_progress(active, progress)
                    except (ValidationError, ValueError):
                        return JSONResponse(status_code=422, content=reply(False, "进度内容不正确"))
                    if not changed:
                        return answer
                    manager.store.save(active)
                    manager.store.append(active.id, {"type":"robot_progress", **log_body(body)})
                    manager.bus.emit({"type":"task", "task":active.model_dump()})
                    if progress.image:
                        caption = progress.detection.label if progress.detection else "目标识别照片"
                        if progress.detection:
                            caption += f" · 第{progress.pickIndex}件 · 第{progress.detection.attempt}次识别"
                        src = "data:image/jpeg;base64," + progress.image.data
                        manager.remote_visual.update(task_id=active.id, src=src, caption=caption)
                        manager.bus.emit({"type":"camera", "src":src})
                        manager.bus.emit({"type":"vision", "detections":[], "caption":caption, "scanning":False})
                    return answer
                if not manager.busy and active.recovery_required and kind in ("finished","error"):
                    if kind == "finished":
                        if settings.robot_protocol == "vlm":
                            completion(active)
                        else:
                            active.status, active.error, active.recovery_required = "completed", None, False
                        manager.store.set_recovery(active.recovery_required)
                        manager.store.settle_stock(active.id)
                    else:
                        active.error = {"code":"robot_error", "message":body["message"]}
                    manager.store.save(active)
                    manager.bus.emit({"type":"task", "task":active.model_dump()})
                else:
                    manager.remote_inbox.put_nowait((kind, body))
                return answer

            async def logged_callback(request: Request):
                try:
                    result = await callback(request)
                except Exception as exc:
                    app.state.manager.protocol.add("in", request.url.path, getattr(request.state, "protocol_body", {}),
                                         {"http_status": 500, "error": type(exc).__name__})
                    raise
                response = result if isinstance(result, JSONResponse) else JSONResponse(result)
                import json
                app.state.manager.protocol.add("in", request.url.path, getattr(request.state, "protocol_body", {}),
                                               {**json.loads(response.body), "http_status": response.status_code})
                return result

            app.add_api_route(f"/api/task/{kind}", logged_callback, methods=["POST"])

        @app.get("/api/robot/protocol", dependencies=[Depends(authorize), Depends(operator)])
        async def protocol_log():
            return list(app.state.manager.protocol.entries)
    else:
        # 机器人侧：接收任务下发（用于把本进程当作“兰剑机器人”）
        mount_robot_api(app, settings)

    @app.get("/api/operator/inventory", dependencies=[Depends(authorize), Depends(operator)])
    async def operator_inventory():
        manager = app.state.manager
        return [{"id": item.id, "name": item.name, "category": item.category,
                 "count": manager.stock[item.id], "initial": item.stock} for item in manager.items.values()]

    @app.get("/api/operator/protocol", dependencies=[Depends(authorize), Depends(operator)])
    async def operator_protocol(since: float = Query(default=0, ge=0), until: float = Query(default=1e20, ge=0),
                                task_id: str = "", before: int | None = None, limit: int = Query(default=100, ge=1, le=500)):
        store = app.state.manager.store
        store.prune_protocol(settings.protocol_retention_days)
        rows = list(store.protocol_rows(since=since, until=until, task_id=task_id, before=before, limit=limit + 1))
        return {"entries": rows[:limit], "next": rows[limit - 1]["seq"] if len(rows) > limit else None}

    @app.get("/api/operator/protocol/download", dependencies=[Depends(authorize), Depends(operator)])
    async def download_protocol(since: float = Query(default=0, ge=0), until: float = Query(default=1e20, ge=0), task_id: str = ""):
        import csv
        import io
        import json
        import tempfile
        import zipfile
        from datetime import datetime, timezone
        store = app.state.manager.store
        store.prune_protocol(settings.protocol_retention_days)
        archive = tempfile.SpooledTemporaryFile(max_size=2 * 1024 * 1024)
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            with bundle.open("records.jsonl", "w") as output:
                for row in store.protocol_rows(since=since, until=until, task_id=task_id, limit=None):
                    output.write((json.dumps(row, ensure_ascii=False) + "\n").encode())
            with bundle.open("records.csv", "w") as raw:
                output = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
                writer = csv.writer(output)
                writer.writerow(["时间（UTC）", "方向", "接口", "任务编号", "请求内容", "响应"])
                for row in store.protocol_rows(since=since, until=until, task_id=task_id, limit=None):
                    values = [datetime.fromtimestamp(row["at"], timezone.utc).isoformat(), row["direction"], row["path"],
                              str(row["body"].get("taskId", "")), json.dumps(row["body"], ensure_ascii=False), json.dumps(row["reply"], ensure_ascii=False)]
                    writer.writerow(["'" + v if v.startswith(("=", "+", "-", "@", "\t", "\r")) else v for v in values])
                output.flush()
                output.detach()
        archive.seek(0)
        def chunks():
            try:
                while chunk := archive.read(65536):
                    yield chunk
            finally:
                archive.close()
        return StreamingResponse(chunks(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="robot-communication.zip"'})

    # Build frontend once, then serve UI and /ws from a single process/port.
    frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if frontend.exists() and settings.serve_ui:
        @app.get("/operator", include_in_schema=False)
        async def operator_page():
            return FileResponse(frontend / "index.html")

        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


app = create_app()
