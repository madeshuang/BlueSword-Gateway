"""Local VLM v1.2 HTTP robot substitute; no GDK, hardware or real camera access."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI
from PIL import Image, ImageDraw
from pydantic import AliasChoices, BaseModel, Field, model_validator

from .protocol import reply

logger = logging.getLogger(__name__)
DEFAULT_CATALOG = Path(__file__).resolve().parents[2] / "config/booth-catalog.example.json"


class DispatchItem(BaseModel):
    item: str = Field(min_length=1)
    count: int = Field(default=1, ge=1, le=2, strict=True)
    location: str = ""


class Dispatch(BaseModel):
    taskId: str | int | None = Field(default=None, validation_alias=AliasChoices("taskId", "task_id"))
    items: list[DispatchItem] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def whole_order(self):
        if sum(item.count for item in self.items) > 2:
            raise ValueError("每单最多两件")
        if len({item.item for item in self.items}) != len(self.items):
            raise ValueError("同种物品请合并数量")
        return self


def simulated_image(code: str, attempt: int) -> dict:
    image = Image.new("RGB", (640, 400), "#1e2834")
    draw = ImageDraw.Draw(image)
    draw.text((20, 20), "SIMULATED IMAGE - NO REAL CAMERA", fill="white")
    draw.rectangle((180, 95, 440, 320), outline="#53c7c2", width=3)
    # Avoid requiring an extra font package for non-ASCII catalog codes.
    label = code.encode("ascii", errors="replace").decode()
    draw.text((180, 75), f"{label} / attempt {attempt}", fill="white")
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=65)
    return {"mime": "image/jpeg", "width": 640, "height": 400,
            "data": base64.b64encode(output.getvalue()).decode()}


def create_simulator(
    gateway_url: str, catalog_path: str | Path = DEFAULT_CATALOG, *, delay: float = 0.6,
    scenario: Literal["success", "partial", "error"] = "success",
) -> FastAPI:
    if scenario not in ("success", "partial", "error") or delay < 0:
        raise ValueError("模拟场景或间隔不正确")
    rows = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    catalog: dict[str, dict] = {}
    for row in rows:
        product = {"code": row.get("robotItem") or row["name"], "label": row["name"]}
        for name in (product["code"], product["label"]):
            if name in catalog and catalog[name] != product:
                raise ValueError(f"模拟目录名称或编码有歧义：{name}")
            catalog[name] = product
    job: asyncio.Task | None = None
    client: httpx.AsyncClient

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal client
        async with httpx.AsyncClient(trust_env=False) as client:
            yield
            if job:
                job.cancel()
                with suppress(asyncio.CancelledError):
                    await job

    app = FastAPI(title="VLM v1.2 模拟机器人（无硬件）", lifespan=lifespan)

    async def report(kind: str, body: dict):
        # Initial attempt plus three retries; sequential, matching the robot document.
        for attempt in range(4):
            try:
                response = await client.post(gateway_url.rstrip("/") + "/api/task/" + kind,
                                             json=body, timeout=5)
                response.raise_for_status()
                return
            except httpx.HTTPError as exc:
                logger.warning("模拟回报 %s 第 %s 次失败：%s", kind, attempt + 1, type(exc).__name__)
                if attempt < 3:
                    await asyncio.sleep(1)

    async def run(order: Dispatch, units: list[dict]):
        base = {"taskId": order.taskId} if order.taskId is not None else {}
        total = 3 * len(units) + 2

        async def progress(stage: str, index: int, pick: int, message: str, **extra):
            await asyncio.sleep(delay)
            if base:
                await report("progress", {**base, "stage": stage, "stageIndex": index,
                                          "stageTotal": total, "pickIndex": pick,
                                          "message": "模拟 · " + message, **extra})

        # Deliberately reorder products so callers cannot equate pickIndex with request order.
        for pick, product in enumerate(sorted(units, key=lambda item: item["code"]), 1):
            offset = (pick - 1) * 3
            await progress("arrived_shelf", offset + 1, pick, "已到达货架")
            # Two recognition attempts exercise replacement of the same row and image.
            for attempt in (1, 2):
                await progress("target_located", offset + 2, pick, f"已识别到{product['label']}",
                               detection={"item": product["code"], "label": "模拟 · " + product["label"], "attempt": attempt},
                               image=simulated_image(product["code"], attempt))
            if scenario == "error":
                await report("error", {**base, "message": "模拟：抓取失败"})
                return
            if scenario == "partial" and pick == 2:
                continue  # Skip grasped(6); still finish after delivery, as documented.
            await progress("grasped", offset + 3, pick, "已抓稳物品")
        await progress("at_delivery", total - 1, 0, "已到达交付处")
        await progress("placed", total, 0, "已放下本次搬运的物品")
        await asyncio.sleep(delay)
        await report("finished", {**base, "result": "success"})

    @app.get("/api/health")
    async def health():
        return {**reply(True, "ok"), "busy": job is not None and not job.done()}

    @app.post("/api/task/dispatch")
    async def dispatch(order: Dispatch):
        nonlocal job
        if job is not None and not job.done():
            return reply(False, "模拟机器人正在执行任务")
        if any(line.item not in catalog for line in order.items):
            return reply(False, "物品不在模拟目录中")
        products = [catalog[line.item] for line in order.items]
        if len({product["code"] for product in products}) != len(products):
            return reply(False, "同种物品请合并数量")
        units = [catalog[line.item] for line in order.items for _ in range(line.count)]
        job = asyncio.create_task(run(order, units), name="vlm-simulated-order")
        return reply(True, "received")

    return app


def create_app() -> FastAPI:
    """Uvicorn factory; this simulator reads no provider credentials or real robot URL."""
    return create_simulator(
        os.getenv("BLUESWORD_GATEWAY_URL", "http://127.0.0.1:8000"),
        os.getenv("BLUESWORD_CATALOG_PATH") or DEFAULT_CATALOG,
        delay=float(os.getenv("VLM_DEMO_DELAY", "0.6")),
        scenario=os.getenv("VLM_DEMO_SCENARIO", "success"),
    )
