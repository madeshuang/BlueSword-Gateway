"""Opt-in real-provider smoke test. Synthesizes its own fixture; never opens a microphone.

Run in backend/: .venv/bin/python scripts/smoke_voice.py
Uses configured Alibaba/DeepSeek APIs (small usage); robot and database are isolated mocks.
"""
from __future__ import annotations

import asyncio
import io

import numpy as np
import soundfile as sf

from bluesword.agent import create_agent
from bluesword.config import Settings
from bluesword.drivers import create_bundle
from bluesword.service import EventBus, TaskManager
from bluesword.speech import recognize, synthesize
from bluesword.storage import TaskStore
from bluesword.wake import RATE, AudioGate, SherpaWake, command_text


async def main():
    settings = Settings.from_env().model_copy(update={
        "robot_mode": "mock", "db_path": ":memory:", "mock_delay": 0,
    })
    if not settings.speech_api_key or not settings.llm_api_key:
        raise RuntimeError("请先在 backend/.env 配置阿里语音与 DeepSeek Key")
    data = await synthesize("你好，布鲁，查询库存。", settings)
    samples, rate = sf.read(io.BytesIO(data), dtype="float32")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    samples = np.interp(np.arange(0, len(samples), rate / RATE), np.arange(len(samples)), samples)
    samples = np.concatenate([np.zeros(RATE), samples, np.zeros(2 * RATE)]).astype("float32")
    gate = AudioGate(SherpaWake(settings.wake_model_dir, settings.wake_threshold),
                     settings.voice_rms, settings.voice_silence, settings.voice_idle)
    clips, wakes = [], 0
    for offset in range(0, len(samples), 1600):
        woke, pcm = gate.feed(samples[offset:offset + 1600])
        wakes += int(woke)
        if pcm:
            clips.append(pcm)
    assert wakes == 1 and len(clips) == 1, "本地唤醒未命中或重复命中"
    text = command_text(await recognize(clips[0], settings))
    assert "库存" in text, "测试语音未正确识别"
    print(f"KWS → 千问 ASR 通过：{text}", flush=True)
    store = TaskStore(":memory:")
    manager = TaskManager(await create_bundle(settings), settings, store, EventBus())
    agent = None
    try:
        await manager.initialize()
        agent = create_agent(settings, manager)
        events = []

        async def decline(_plan):
            return False  # A smoke test must never approve robot motion.

        await agent.session("voice-smoke").turn(text, events.append, decline)
        reply = "".join(e["text"] for e in events if e["type"] == "assistant_delta")
        assert reply and any(e["type"] == "skill" and e["name"] == "check_inventory" for e in events)
        assert store.recent() == [], "查询库存不应创建取物任务"
        spoken = await synthesize(reply[:1000], settings)
        assert len(spoken) > 1000
        print(f"DeepSeek 库存工具 → 千问 TTS 通过：{reply}", flush=True)
    finally:
        if agent:
            await agent.close()
        await manager.shutdown()
        store.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        # Provider exceptions may contain request metadata; keep diagnostic output categorical.
        print(f"语音冒烟测试失败：{type(exc).__name__}")
        raise SystemExit(1) from None
