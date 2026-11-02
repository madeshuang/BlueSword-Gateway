from __future__ import annotations

import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .agent import create_agent, glossary
from .config import Settings
from .conversation import serve_conversation
from .domain import RobotError, TaskRequest
from .drivers import create_bundle
from .mock import MockRobot
from .protocol import reply
from .robot_api import mount_robot_api
from .service import EventBus, TaskManager
from .speech import mount_speech
from .storage import TaskStore
from .vlm import Progress, apply_progress, completion, log_body

logger = logging.getLogger(__name__)


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
        app.state.local_voice = None
        try:
            bundle = await create_bundle(settings)
            bus = EventBus()
            manager = TaskManager(bundle, settings, store, bus)
            await manager.initialize()
            agent = create_agent(settings, manager)
            app.state.manager, app.state.bus, app.state.agent = manager, bus, agent
            if settings.speech_mode == "local":
                from .local_voice import LocalVoice

                voice = app.state.local_voice = LocalVoice(settings)
                await voice.start()
            yield
        finally:
            if app.state.local_voice:
                await app.state.local_voice.close()
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

    @app.post("/api/operator/refund", dependencies=[Depends(authorize), Depends(operator)])
    async def refund_stock(request: Request):
        body = await request.json()
        if not isinstance(body, dict) or body.get("confirmation") != "确认本单全部物品仍在货架":
            raise HTTPException(400, "请确认本单全部物品仍在货架；部分取走或状态不明时不能整单退回。")
        returned = await app.state.manager.refund_reserved_stock(body.get("task_id"))
        return {"returned": returned, "message": f"已退回预留库存，共 {sum(returned.values())} 件。" if returned
                else "没有可退回的预留库存，可能已退回或已补满库存。"}

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
        manager = app.state.manager
        if app.state.local_voice is not None:
            await app.state.local_voice.serve(ws, lambda transport: serve_conversation(
                transport, settings, manager, app.state.agent, mock_take, mock_recover, boot_id=app.state.boot_id,
            ))
        else:
            await serve_conversation(ws, settings, manager, app.state.agent, mock_take, mock_recover, boot_id=app.state.boot_id)

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
                        manager.bus.emit({"type":"camera", "task_id":active.id, "src":src})
                        manager.bus.emit({"type":"vision", "task_id":active.id, "detections":[], "caption":caption, "scanning":False})
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
