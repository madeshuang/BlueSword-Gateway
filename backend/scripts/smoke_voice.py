"""Opt-in real-provider smoke test. Synthesizes its own fixture; never opens a microphone.

Run in backend/: .venv/bin/python scripts/smoke_voice.py
Uses configured Alibaba/DeepSeek APIs (small usage); robot and database are isolated mocks.
"""
from __future__ import annotations

import argparse
import asyncio
import io
from pathlib import Path

import numpy as np
import soundfile as sf

from bluesword.agent import create_agent
from bluesword.config import Settings
from bluesword.drivers import create_bundle
from bluesword.intents import confirmation_reply
from bluesword.language import CJK
from bluesword.service import EventBus, TaskManager
from bluesword.speech import recognize, synthesize
from bluesword.storage import TaskStore
from bluesword.wake import RATE, AudioGate, SherpaWake, command_text


async def fixture(utterance, settings, *, wake=True):
    data = await synthesize(utterance, settings)
    samples, rate = sf.read(io.BytesIO(data), dtype="float32")
    if samples.ndim == 2:
        samples = samples.mean(axis=1)
    samples = np.interp(np.arange(0, len(samples), rate / RATE), np.arange(len(samples)), samples)
    samples = np.concatenate([np.zeros(RATE), samples, np.zeros(2 * RATE)]).astype("float32")
    gate = AudioGate(SherpaWake(settings.wake_model_dir, settings.wake_threshold),
                     settings.voice_rms, settings.voice_silence, settings.voice_idle)
    if not wake:
        gate.activate()
    clips, wakes = [], 0
    for offset in range(0, len(samples), 1600):
        woke, pcm = gate.feed(samples[offset:offset + 1600])
        wakes += int(woke)
        if pcm:
            clips.append(pcm)
    assert wakes == int(wake) and len(clips) == 1, "本地唤醒或续聊分段未通过"
    return command_text(await recognize(clips[0], settings))


async def main(language="zh", fetch=False):
    settings = Settings.from_env().model_copy(update={
        "robot_mode": "mock", "db_path": ":memory:", "mock_delay": 0, "catalog_path": str(Path(__file__).resolve().parents[1] / "tests/fixtures/geometry-catalog.json"),
        "scenario": "success", "auto_take": True, "split_skills": False,
    })
    if not settings.speech_api_key or not settings.llm_api_key:
        raise RuntimeError("请先在 backend/.env 配置阿里语音与 DeepSeek Key")
    utterance = (("Hello Blue, could you bring me a bottle of water?" if fetch else "Hello Blue, check the inventory.")
                 if language == "en" else ("你好，布鲁，拿一瓶矿泉水。" if fetch else "你好，布鲁，查询库存。"))
    text = await fixture(utterance, settings)
    assert ("water" if fetch else "inventory") in text.lower() if language == "en" else ("水" if fetch else "库存") in text
    print(f"KWS → 千问 ASR 通过：{text}", flush=True)
    store = TaskStore(":memory:")
    manager = TaskManager(await create_bundle(settings), settings, store, EventBus())
    agent = None
    try:
        await manager.initialize()
        agent = create_agent(settings, manager)
        events = []

        confirmations = []
        async def confirm(plan):
            confirmations.append(plan)
            assert store.recent() == [], "确认前不得执行"
            if not fetch:
                return False
            assert plan["_items"] == [{"item_id": "water", "count": 1}]
            assert plan.get("language", "zh") == language
            answer = await fixture("Yes, please." if language == "en" else "可以。", settings, wake=False)
            assert confirmation_reply(answer) is True
            print(f"语音确认通过：{answer}", flush=True)
            return True  # Isolated mock robot only; never connects to the demo or a real robot.

        await agent.session("voice-smoke").turn(text, events.append, confirm)
        reply = "".join(e["text"] for e in events if e["type"] == "assistant_delta")
        assert reply and any(e["type"] == "skill" and e["name"] == "check_inventory" for e in events)
        if language == "en":
            assert not CJK.search(reply), "英语请求不应得到中文回复"
        if fetch:
            tasks = store.recent()
            assert len(confirmations) == 1 and len(tasks) == 1 and tasks[0].status == "completed"
            assert tasks[0].items[0].item_id == "water" and tasks[0].items[0].count == 1
            answer = await fixture("No, cancel." if language == "en" else "取消。", settings, wake=False)
            assert confirmation_reply(answer) is False
            print(f"Mock 取物完成；语音取消识别通过：{answer}", flush=True)
        else:
            assert store.recent() == [], "查询库存不应创建取物任务"
        spoken = await synthesize(reply[:600], settings)
        assert len(spoken) > 1000
        print(f"DeepSeek → 千问 TTS 通过：{reply}", flush=True)
    finally:
        if agent:
            await agent.close()
        await manager.shutdown()
        store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="真实中英语音链路测试；取物仅连接隔离 mock")
    parser.add_argument("--language", choices=["zh", "en"], default="zh")
    parser.add_argument("--fetch", action="store_true", help="包含语音确认及 mock 取物，默认只查询库存")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.language, args.fetch))
    except Exception as exc:
        # Provider exceptions may contain request metadata; keep diagnostic output categorical.
        print(f"语音冒烟测试失败：{type(exc).__name__}")
        raise SystemExit(1) from None
