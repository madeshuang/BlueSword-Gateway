"""Speech transport only: audio recognition/synthesis never dispatches robot tasks."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from websockets.asyncio.client import connect

from .config import Settings

logger = logging.getLogger(__name__)


class VoiceControl(BaseModel):
    action: Literal["resume", "pause", "tts_on", "tts_off", "interrupt"]


async def recognize(pcm: bytes, settings: Settings) -> str:
    host = (
        f"{settings.speech_workspace}.cn-beijing.maas.aliyuncs.com"
        if settings.speech_workspace
        else "dashscope.aliyuncs.com"
    )
    task_id = uuid.uuid4().hex
    sentences: dict[int, str] = {}
    async with asyncio.timeout(40):
        async with connect(
            f"wss://{host}/api-ws/v1/inference",
            additional_headers={"Authorization": f"Bearer {settings.speech_api_key}"},
            open_timeout=12,
            max_size=262144,
            proxy=None,
        ) as socket:
            await socket.send(
                json.dumps(
                    {
                        "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
                        "payload": {
                            "task_group": "audio",
                            "task": "asr",
                            "function": "recognition",
                            "model": settings.speech_model,
                            "parameters": {
                                "format": "pcm",
                                "sample_rate": 16000,
                                "intermediate_result_enabled": True,
                            },
                            "input": {},
                        },
                    }
                )
            )
            while True:
                message = json.loads(await socket.recv())
                event = message.get("header", {}).get("event")
                if event == "task-failed":
                    raise RuntimeError("识别服务暂时不可用，先打字也可以。")
                if event == "task-started":
                    break
            for offset in range(0, len(pcm), 3200):
                await socket.send(pcm[offset : offset + 3200])
            await socket.send(
                json.dumps(
                    {
                        "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
                        "payload": {"input": {}},
                    }
                )
            )
            while True:
                packet = json.loads(await socket.recv())
                event = packet.get("header", {}).get("event")
                if event == "task-failed":
                    raise RuntimeError("这次没听清，稍后再试试。")
                sentence = packet.get("payload", {}).get("output", {}).get("sentence", {})
                if sentence.get("sentence_end") and isinstance(sentence.get("text"), str):
                    sentences[int(sentence.get("sentence_id", 0))] = sentence["text"]
                if event == "task-finished":
                    return "".join(sentences[k] for k in sorted(sentences))[:2000]


async def synthesize(text: str, settings: Settings) -> bytes:
    async with httpx.AsyncClient(timeout=35, trust_env=False) as client:
        response = await client.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            headers={"Authorization": f"Bearer {settings.speech_api_key}"},
            json={
                "model": settings.tts_model,
                "input": {"text": text, "voice": settings.tts_voice, "language_type": "Chinese"},
            },
        )
        response.raise_for_status()
        if response.headers.get("content-type", "").startswith("audio/"):
            return response.content
        output = response.json().get("output", {})
        audio = output.get("audio", {})
        url = audio.get("url") if isinstance(audio, dict) else output.get("audio_url")
        if not isinstance(url, str):
            raise RuntimeError("暂时无法播报，文字已经显示在屏幕上。")
        parsed = urlparse(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or not parsed.hostname.endswith((".aliyuncs.com", ".aliyun.com"))
        ):
            raise RuntimeError("语音地址无效。")
        # DashScope may return an HTTP OSS URL; fetch the same signed resource over TLS.
        audio_response = await client.get(parsed._replace(scheme="https").geturl())
        audio_response.raise_for_status()
        return audio_response.content


def mount_speech(app: FastAPI, settings: Settings) -> None:
    slots = asyncio.Semaphore(2)

    def authorized(authorization: str | None):
        if settings.api_token and not secrets.compare_digest(
            authorization or "", f"Bearer {settings.api_token}"
        ):
            raise HTTPException(401, "请先连接服务。")

    @app.get("/api/speech")
    async def status(authorization: str | None = Header(default=None)):
        authorized(authorization)
        return {
            "configured": bool(settings.speech_api_key),
            "wake_phrase": "你好，布鲁",
            "tts": bool(settings.speech_api_key),
            "mode": settings.speech_mode,
            "local": app.state.local_voice.status() if app.state.local_voice else None,
        }

    @app.post("/api/speech/control")
    async def control(body: VoiceControl, request: Request, authorization: str | None = Header(default=None)):
        authorized(authorization)
        origin = request.headers.get("origin")
        if origin and origin not in settings.allowed_origins and origin != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "请从布鲁页面控制语音。")
        if app.state.local_voice is None:
            raise HTTPException(409, "当前未启用本地语音模式。")
        return await app.state.local_voice.control(body.action)

    async def read_limited(request: Request, limit: int) -> bytes:
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > limit:
                raise HTTPException(413, "这段有点长，请分两次说。")
        return bytes(body)

    def check(request: Request, authorization: str | None):
        authorized(authorization)
        origin = request.headers.get("origin")
        if origin and origin not in settings.allowed_origins and origin != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "请从布鲁页面使用语音。")
        if not settings.speech_api_key:
            raise HTTPException(503, "语音还没准备好，先打字也可以。")

    @app.post("/api/speech/recognize")
    async def asr(request: Request, authorization: str | None = Header(default=None)):
        check(request, authorization)
        pcm = await read_limited(request, 1_920_000)
        if not pcm or len(pcm) % 2:
            raise HTTPException(400, "这次没有录好，请再试一次。")
        if slots.locked():
            raise HTTPException(429, "稍等一下，再说一次吧。")
        async with slots:
            started = time.monotonic()
            try:
                return {"text": await recognize(pcm, settings)}
            except Exception as exc:
                # Record the failure category, never credentials, audio, transcripts or exception text.
                logger.warning("speech_asr_failed type=%s elapsed_s=%.2f", type(exc).__name__, time.monotonic() - started)
                raise HTTPException(502, "这次没听清，稍后再试试。") from None

    @app.post("/api/speech/synthesize")
    async def tts(request: Request, authorization: str | None = Header(default=None)):
        check(request, authorization)
        raw = await read_limited(request, 8192)
        try:
            text = json.loads(raw)["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "播报内容不合适。") from None
        if slots.locked():
            raise HTTPException(429, "语音稍等一下。")
        async with slots:
            try:
                return Response(
                    await synthesize(text, settings),
                    media_type="audio/wav",
                    headers={"Cache-Control": "no-store"},
                )
            except Exception:
                raise HTTPException(502, "暂时无法播报，文字已经显示在屏幕上。") from None
