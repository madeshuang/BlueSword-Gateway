from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import create_agent, describe_plan, glossary
from .config import Settings
from .domain import RobotError, TaskLine, TaskRequest
from .drivers import create_bundle
from .intents import confirmation_reply, resolve, revise_order
from .mock import MockRobot
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
        store = TaskStore(settings.db_path)
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
        # 机器人动作前的确认：id → 等待观众答复的 future
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
                    emit({**plan["_skill"], "target": plan["target"], "status": "pending", "detail": "等待观众确认"})
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

    if settings.robot_mode == "lanjian_http":
        # 网关侧：接收机器人回调（v1.1 + 提案等级二），回复格式与 v1.1 一致
        for kind in ("progress", "finished", "error"):

            async def callback(request: Request):
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
                        manager.protocol.add("in", "/api/task/error", body, reply(True))
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
                    manager.protocol.add("in", "/api/task/progress", log_body(body), answer)
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
                manager.protocol.add("in", f"/api/task/{kind}", log_body(body), answer)
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

            app.add_api_route(f"/api/task/{kind}", callback, methods=["POST"])

        @app.get("/api/robot/protocol", dependencies=[Depends(authorize)])
        async def protocol_log():
            return list(app.state.manager.protocol.entries)
    else:
        # 机器人侧：接收任务下发（用于把本进程当作“兰剑机器人”）
        mount_robot_api(app, settings)

    # Build frontend once, then serve UI and /ws from a single process/port.
    frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if frontend.exists() and settings.serve_ui:
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


app = create_app()
