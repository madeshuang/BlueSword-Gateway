import asyncio
import json
import queue
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bluesword import local_voice, speech
from bluesword.app import create_app
from bluesword.config import Settings
from bluesword.local_voice import LocalVoice
from bluesword.wake import AudioGate, command_text


class Detector:
    def __init__(self, *args):
        self.calls = 0

    def reset(self):
        pass

    def feed(self, samples):
        self.calls += 1
        return float(np.max(samples)) > 0.45


def frame(value=0):
    return np.full(1600, value, dtype=np.float32)


class Audio:
    def __init__(self, *args):
        self.frames = queue.Queue()
        self.opens = self.closes = 0

    def open(self):
        self.opens += 1

    def read(self):
        return self.frames.get(), False

    def close(self):
        self.closes += 1
        self.frames.put(frame())

    async def play(self, data):
        pass


def make_voice(settings=None):
    return LocalVoice(settings or Settings(speech_api_key="test"), detector_factory=Detector, audio_factory=Audio)


def test_standby_keeps_only_bounded_audio_and_never_submits():
    gate = AudioGate(Detector())
    for _ in range(1000):
        assert gate.feed(frame(0.1)) == (False, None)
    assert gate.detector.calls == 1000
    assert len(gate.lead) == 30 and not gate.chunks


def test_wake_retains_same_breath_command_and_active_followup():
    gate = AudioGate(Detector(), idle=3)
    for _ in range(8):
        gate.feed(frame(0.1))
    assert gate.feed(frame(0.5))[0]
    for _ in range(8):
        gate.feed(frame(0.2))
    clips = [gate.feed(frame())[1] for _ in range(10)]
    pcm = next(clip for clip in clips if clip)
    values = np.frombuffer(pcm, dtype="<i2") / 32767
    assert values.max() == pytest.approx(0.5, abs=0.001)
    assert np.count_nonzero(np.isclose(values, 0.2, atol=0.001)) == 8 * 1600
    calls = gate.detector.calls
    gate.feed(frame(0.1))
    assert any(gate.feed(frame())[1] for _ in range(10))
    assert gate.detector.calls == calls  # Follow-up speech does not require another wake.
    for _ in range(40):
        gate.feed(frame())
    assert not gate.active
    for _ in range(15):
        assert gate.feed(frame(0.1))[1] is None


def test_playback_and_busy_audio_cannot_wake_or_enter_next_clip():
    gate = AudioGate(Detector())
    for _ in range(50):
        assert gate.feed(frame(0.7), blocked=True) == (False, None)
    assert gate.detector.calls == 0 and not gate.lead and not gate.chunks
    assert gate.feed(frame()) == (False, None)
    assert gate.feed(frame(0.5))[0]
    for _ in range(10):
        _, pcm = gate.feed(frame())
        if pcm:
            assert np.max(np.frombuffer(pcm, dtype="<i2")) < 20000


def test_long_utterance_is_capped():
    gate = AudioGate(Detector())
    gate.feed(frame(0.5))
    clips = [gate.feed(frame(0.1))[1] for _ in range(300)]
    assert any(clips)
    assert all(len(clip) <= 25 * 32000 for clip in clips if clip)


@pytest.mark.parametrize("text,expected", [("你好，布鲁，拿两瓶水。", "拿两瓶水。"),
                                           ("你好布噜！", ""), ("可以", "可以")])
def test_wake_prefix_is_removed_only_after_local_detection(text, expected):
    assert command_text(text) == expected


async def test_pause_cancels_pending_cloud_result_and_releases_microphone(monkeypatch):
    entered = asyncio.Event()
    async def recognize(*args):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(speech, "recognize", recognize)
    voice = make_voice()
    await voice.start()
    await voice.start()
    assert voice.audio.opens == 1
    voice.asr = asyncio.create_task(voice._recognize(b"00"))
    await entered.wait()
    await voice.stop()
    assert voice.input.empty() and not voice.enabled
    assert voice.audio.closes == 1 and voice.capture is None
    assert voice.status()["phase"] == "stopped"


async def test_missing_model_leaves_text_chat_available_and_exposes_no_exception(caplog):
    def missing(*args):
        raise FileNotFoundError("secret-provider-key")
    voice = LocalVoice(Settings(speech_api_key="test"), detector_factory=missing)
    await voice.start()
    assert voice.status()["phase"] == "error" and not voice.enabled
    assert "setup-voice.py" in voice.status()["status"]
    assert "secret-provider-key" not in caplog.text


async def test_tts_toggle_does_not_cancel_recognition_and_slow_turn_reopens_followup(monkeypatch):
    voice = make_voice()
    await voice.start()
    try:
        assert not voice.status()["tts"]
        await voice.send_json({"type": "assistant_delta", "id": "silent", "text": "库存已更新"})
        await voice.send_json({"type": "assistant_end", "id": "silent"})
        assert voice.player is None and voice.speech_queue.empty()
        entered, release = asyncio.Event(), asyncio.Event()
        async def recognize(*args):
            entered.set()
            await release.wait()
            return "查询库存"
        monkeypatch.setattr(speech, "recognize", recognize)
        voice.asr = asyncio.create_task(voice._recognize(b"00"))
        await entered.wait()
        await voice.control("tts_off")
        assert not voice.asr.done()
        release.set()
        await voice.asr
        assert json.loads(await voice.receive_text())["text"] == "查询库存"
        await voice.send_json({"type": "phase", "phase": "thinking"})
        for _ in range(300):
            voice.gate.feed(frame(), blocked=voice.busy)
        assert not voice.gate.active
        await voice.send_json({"type": "phase", "phase": "listening"})
        assert voice.gate.active and not voice.busy
    finally:
        await voice.stop()


async def test_reply_synthesized_once_and_cancelling_playback_guards_echo(monkeypatch):
    calls, playing = [], asyncio.Event()
    async def synthesize(text, _settings):
        calls.append(text)
        return b"audio"
    monkeypatch.setattr(speech, "synthesize", synthesize)
    voice = make_voice()
    await voice.start()
    async def play(_data):
        playing.set()
        await asyncio.Event().wait()
    voice.audio.play = play
    try:
        await voice.control("tts_on")
        for event in [{"type": "assistant_start", "id": "1"},
                      {"type": "assistant_delta", "id": "1", "text": "拿一瓶水吗？"},
                      {"type": "confirm_request", "id": "c", "timeout_s": 60},
                      {"type": "assistant_end", "id": "1"}]:
            await voice.send_json(event)
        await asyncio.wait_for(playing.wait(), 1)
        assert voice.playing and calls == ["拿一瓶水吗？"]
        await voice.control("tts_off")
        import time
        assert not voice.playing and voice.mute_until > time.monotonic()
    finally:
        await voice.stop()


async def test_sleep_stops_playback_and_latches_until_manual_wake(monkeypatch):
    entered = asyncio.Event()
    async def synthesize(*args):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(speech, "synthesize", synthesize)
    voice = make_voice()
    await voice.start()
    try:
        await voice.control("tts_on")
        await voice.send_json({"type": "assistant_delta", "id": "1", "text": "你好"})
        await voice.send_json({"type": "assistant_end", "id": "1"})
        await asyncio.wait_for(entered.wait(), 1)
        status = await voice.control("toggle")
        assert status["enabled"] and not status["active"] and status["phase"] == "standby"
        assert voice.player is None and not voice.gate.active and voice.audio.closes == 0
        # Late agent/confirmation events and toggling TTS must not undo deliberate sleep.
        await voice.send_json({"type": "phase", "phase": "listening"})
        await voice.send_json({"type": "assistant_delta", "id": "2", "text": "要拿水吗？"})
        await voice.send_json({"type": "confirm_request", "id": "c", "timeout_s": 60})
        await voice.send_json({"type": "assistant_end", "id": "2"})
        await voice.control("tts_on")
        assert not voice.gate.active and voice.player is None and voice.speech_queue.empty()
        assert (await voice.control("toggle"))["active"]
        assert voice.gate.active and not voice.sleeping and voice.audio.opens == 1
    finally:
        await voice.stop()


def until(ws, predicate):
    for _ in range(250):
        event = ws.receive_json()
        if predicate(event):
            return event
    raise AssertionError("expected event missing")


def test_native_voice_uses_fresh_page_sessions_and_one_microphone(monkeypatch):
    voices = []
    def factory(settings):
        voice = make_voice(settings)
        voices.append(voice)
        return voice
    monkeypatch.setattr(local_voice, "LocalVoice", factory)
    answers = iter(["你好，布鲁，拿一瓶矿泉水", "Hello Blue, bring me water", "Yes, please"])
    async def recognize(*args):
        return next(answers)
    monkeypatch.setattr(speech, "recognize", recognize)
    settings = Settings(catalog_path=str(Path(__file__).parent / "fixtures/geometry-catalog.json"),
                        db_path=":memory:", speech_mode="local", speech_api_key="test", llm_fallback_enabled=False,
                        mock_delay=0, api_token="private-token")
    headers = {"Authorization": "Bearer private-token"}
    with TestClient(create_app(settings)) as client:
        voice = voices[0]
        assert client.post("/api/speech/control", json={"action": "pause"}).status_code == 401
        assert client.post("/api/speech/control", json={"action": "pause"},
                           headers=headers | {"Origin": "https://wrong.test"}).status_code == 403
        with client.websocket_connect("/ws?token=private-token") as first:
            first_id = until(first, lambda e: e["type"] == "voice_status")["session_id"]
            client.portal.call(voice._recognize, b"00")
            old = until(first, lambda e: e["type"] == "confirm_request")
        assert voice.owner is None and voice.enabled
        assert client.get("/api/tasks", headers=headers).json() == []
        with client.websocket_connect("/ws?token=private-token") as second:
            second_id = until(second, lambda e: e["type"] == "voice_status")["session_id"]
            assert second_id != first_id
            until(second, lambda e: e["type"] == "phase" and e["phase"] == "idle")
            second.send_json({"type": "confirm_response", "id": old["id"], "approved": True})
            client.portal.call(voice._recognize, b"00")
            fresh = until(second, lambda e: e["type"] == "confirm_request")
            assert fresh["id"] != old["id"] and fresh["language"] == "en"
            with client.websocket_connect("/ws?token=private-token") as third:
                third_id = until(third, lambda e: e["type"] == "voice_status")["session_id"]
                assert third_id != second_id and voice.owner.id == third_id
                until(third, lambda e: e["type"] == "phase" and e["phase"] == "idle")
                status = client.post("/api/speech/control", json={"action": "toggle", "session_id": second_id}, headers=headers).json()
                assert status["active"] and voice.owner.id == second_id
            client.portal.call(voice._recognize, b"00")
            until(second, lambda e: e["type"] == "task" and e.get("task", {}).get("status") == "completed")
            assert len(client.get("/api/tasks", headers=headers).json()) == 1
        assert voice.enabled and voice.audio.opens == 1
        assert client.post("/api/speech/control", json={"action": "toggle", "session_id": first_id}, headers=headers).status_code == 409


async def test_native_capture_only_calls_asr_after_wake(monkeypatch):
    clips = []
    done = asyncio.Event()
    async def recognize(pcm, _settings):
        clips.append(pcm)
        done.set()
        return "你好，布鲁，查询库存"
    monkeypatch.setattr(speech, "recognize", recognize)
    voice = make_voice()
    voice.owner = SimpleNamespace(id="capture-test")
    await voice.start()
    try:
        assert (await voice.control("toggle"))["active"]
        assert not (await voice.control("toggle"))["active"]
        for _ in range(20):
            voice.audio.frames.put(frame(0.1))
        voice.audio.frames.put(frame(0.5))
        for _ in range(10):
            voice.audio.frames.put(frame())
        await asyncio.wait_for(done.wait(), 3)
        event = json.loads(await voice.receive_text())
        assert event["type"] == "text_input" and event["text"] == "查询库存"
        assert len(clips) == 1
        assert not voice.sleeping and voice.status()["active"]
    finally:
        await voice.stop()


async def test_aborted_model_attempt_never_enters_native_speech_queue():
    voice = make_voice()
    voice.enabled, voice.sleeping, voice.tts = True, False, True
    # Keep the queue observable without starting audio playback.
    voice.player = asyncio.create_task(asyncio.sleep(30))
    try:
        for event in [
            {"type": "assistant_start", "id": "broken"},
            {"type": "assistant_delta", "id": "broken", "text": "半句"},
            {"type": "assistant_abort", "id": "broken"},
            {"type": "assistant_delta", "id": "broken", "text": "迟到"},
            {"type": "assistant_end", "id": "broken"},
            {"type": "assistant_start", "id": "backup"},
            {"type": "assistant_delta", "id": "backup", "text": "完整回复"},
            {"type": "assistant_end", "id": "backup"},
        ]:
            await voice.send_json(event)
        assert voice.speech_queue.qsize() == 1
        assert voice.speech_queue.get_nowait() == "完整回复"
    finally:
        voice.player.cancel()
        with pytest.raises(asyncio.CancelledError):
            await voice.player
