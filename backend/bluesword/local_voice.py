"""One native microphone, speaker and conversation per gateway process."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import time
import uuid

from fastapi import WebSocketDisconnect

from . import speech
from .language import language_of
from .service import EventBus
from .wake import RATE, AudioGate, SherpaWake, command_text

logger = logging.getLogger(__name__)


class NativeAudio:
    def __init__(self, settings):
        import sounddevice as sd

        self.sd, self.settings, self.stream = sd, settings, None

    def open(self):
        self.stream = self.sd.InputStream(
            samplerate=RATE, channels=1, dtype="float32", blocksize=1600,
            device=self.settings.voice_input_device,
        )
        self.stream.start()

    def read(self):
        return self.stream.read(1600)

    def close(self):
        stream, self.stream = self.stream, None
        if stream is not None:
            stream.abort()
            stream.close()

    async def play(self, data):
        import soundfile as sf

        samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        position = 0

        def callback(out, frames, _time, _status):
            nonlocal position
            count = min(frames, len(samples) - position)
            out.fill(0)
            out[:count] = samples[position:position + count]
            position += count
            if count < frames:
                raise self.sd.CallbackStop

        with self.sd.OutputStream(samplerate=rate, channels=samples.shape[1], dtype="float32",
                                  device=self.settings.voice_output_device, callback=callback) as stream:
            while stream.active:
                await asyncio.sleep(0.05)


class LocalVoice:
    def __init__(self, settings, *, detector_factory=SherpaWake, audio_factory=NativeAudio):
        self.settings = settings
        self.detector_factory, self.audio_factory = detector_factory, audio_factory
        self.output = EventBus()
        self.input = asyncio.Queue(maxsize=32)
        self.audio = self.gate = None
        self.capture = self.asr = self.player = None
        self.enabled = self.playing = self.recognizing = self.busy = False
        self.tts = False
        self.sleeping = False
        self.error = ""
        self.phase = "stopped"
        self.snapshot = {}
        self.text = {}
        self.spoken = set()
        self.speech_queue = asyncio.Queue(maxsize=8)
        self.confirm_until = 0.0
        self.mute_until = 0.0
        self.control_lock = asyncio.Lock()

    def status(self):
        labels = {
            "stopped": "本地监听已暂停 · Paused", "starting": "正在准备本地唤醒 · Starting…",
            "standby": "布鲁休眠中 · 你好，布鲁 / Hello Blue", "listening": "我在听 · Listening…",
            "recognizing": "正在识别 · Recognizing…", "thinking": "正在处理 · Please wait…",
            "speaking": "正在播报 · Speaking…", "error": self.error,
        }
        return {"mode": "local", "enabled": self.enabled, "tts": self.tts,
                "active": bool(self.enabled and not self.sleeping and
                               (self.playing or self.recognizing or self.busy or self.gate and self.gate.active)),
                "phase": self.phase,
                "status": labels[self.phase] + (f" · {self.error}" if self.error and self.phase != "error" else ""),
                "error": self.error}

    def report(self, phase=None):
        phase = phase or ("stopped" if not self.enabled else "standby" if self.sleeping
                          else "speaking" if self.playing
                          else "recognizing" if self.recognizing else "thinking" if self.busy
                          else "listening" if self.gate and self.gate.active else "standby")
        old = self.status()
        self.phase = phase
        if old != self.status() or phase == "error":
            self.output.emit({"type": "voice_status", **self.status()})

    async def start(self):
        async with self.control_lock:
            if self.enabled:
                return
            self.error = ""
            self.report("starting")
            try:
                if not self.settings.speech_api_key:
                    raise ValueError("missing speech key")
                detector = await asyncio.to_thread(
                    self.detector_factory, self.settings.wake_model_dir, self.settings.wake_threshold,
                )
                self.gate = AudioGate(detector, self.settings.voice_rms,
                                      self.settings.voice_silence, self.settings.voice_idle)
                self.audio = self.audio_factory(self.settings)
                await asyncio.to_thread(self.audio.open)
                self.enabled = True
                self.capture = asyncio.create_task(self._capture())
                self.report()
            except Exception as exc:
                if self.audio:
                    await asyncio.to_thread(self.audio.close)
                logger.warning("local_voice_start_failed type=%s", type(exc).__name__)
                self.error = ("缺少唤醒模型，请运行 scripts/setup-voice.py" if isinstance(exc, FileNotFoundError)
                              else "缺少本地语音依赖，请安装 voice 扩展" if isinstance(exc, ImportError)
                              else "请配置阿里语音 Key" if not self.settings.speech_api_key
                              else "麦克风未就绪，请检查系统权限和音频设备，再恢复监听")
                self.report("error")

    async def _cancel(self, task):
        if task and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def stop_speaking(self):
        await self._cancel(self.player)
        self.player = None
        self.playing = False
        while not self.speech_queue.empty():
            self.speech_queue.get_nowait()

    async def interrupt(self):
        await self._cancel(self.asr)
        await self.stop_speaking()
        self.asr = None
        self.recognizing = False
        if self.gate:
            self.gate.clear()
            self.gate.detector.reset()

    async def stop(self):
        async with self.control_lock:
            self.enabled = False
            await self.interrupt()
            # Abort the blocking PortAudio read before cancelling its asyncio wrapper.
            if self.audio:
                await asyncio.to_thread(self.audio.close)
            await self._cancel(self.capture)
            self.capture = None
            if self.gate:
                self.gate.reset()
            self.report("stopped")

    async def _capture(self):
        try:
            while self.enabled:
                samples, overflow = await asyncio.to_thread(self.audio.read)
                if not self.enabled:
                    break
                if overflow:
                    self.gate.reset()
                    continue
                woke, pcm = self.gate.feed(
                    samples, self.control_lock.locked() or (self.busy and not self.sleeping)
                    or self.playing or self.recognizing or time.monotonic() < self.mute_until,
                )
                if woke:
                    self.sleeping = False
                    self.output.emit({"type": "wake"})
                if pcm is not None:
                    self.recognizing = True
                    self.asr = asyncio.create_task(self._recognize(pcm))
                self.report()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.enabled:
                logger.warning("local_voice_capture_failed type=%s", type(exc).__name__)
                self.enabled = False
                await self.interrupt()
                await asyncio.to_thread(self.audio.close)
                self.error = "麦克风已断开，请检查设备后恢复监听"
                self.report("error")

    async def _recognize(self, pcm):
        try:
            recognized = await speech.recognize(pcm, self.settings)
            text = command_text(recognized)
            if not self.enabled or self.sleeping:
                return
            self.gate.activate()
            self.error = ""
            if text:
                if self.input.full():
                    self.error = "输入繁忙，请稍后再说"
                    return
                self.output.emit({"type": "asr", "text": text, "final": True})
                self.input.put_nowait(json.dumps({"type": "text_input", "text": text,
                                                 "request_id": uuid.uuid4().hex}))
            else:
                self.output.emit({"type": "wake"})
                if recognized.strip():
                    identifier = uuid.uuid4().hex
                    greeting = "I'm listening. How can I help?" if language_of(recognized) == "en" else "我在，请说。"
                    for event in ({"type": "assistant_start", "id": identifier},
                                  {"type": "assistant_delta", "id": identifier, "text": greeting},
                                  {"type": "assistant_end", "id": identifier}):
                        await self.send_json(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("local_voice_asr_failed type=%s", type(exc).__name__)
            self.error = "识别暂时没接上，继续说或打字都可以"
            self.output.emit({"type": "voice_status", **self.status(), "status": self.error})
        finally:
            self.recognizing = False

    def enqueue(self, identifier):
        text = self.text.pop(identifier, "").strip()
        if not text or identifier in self.spoken:
            return
        if len(self.spoken) >= 100:
            self.spoken.clear()
        self.spoken.add(identifier)
        if self.enabled and not self.sleeping and self.tts and not self.speech_queue.full():
            self.speech_queue.put_nowait(text[:1000])
            if not self.player or self.player.done():
                self.player = asyncio.create_task(self._speak())

    async def _speak(self):
        self.playing = True
        self.report()
        try:
            while not self.speech_queue.empty():
                text = self.speech_queue.get_nowait()
                try:
                    data = await speech.synthesize(text, self.settings)
                    await self.audio.play(data)
                    self.error = ""
                    # Let loudspeaker reverberation decay before accepting microphone frames.
                    await asyncio.sleep(0.4)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("local_voice_tts_failed type=%s", type(exc).__name__)
                    self.error = "文字已显示，播报暂时没接上"
        finally:
            self.playing = False
            self.mute_until = time.monotonic() + 0.4
            if self.gate:
                self.gate.clear()
                self.gate.detector.reset()
                if self.enabled and not self.sleeping:
                    self.gate.activate(max(self.settings.voice_idle, self.confirm_until - time.monotonic()))
            self.report()

    async def receive_text(self):
        raw = await self.input.get()
        try:
            event = json.loads(raw)
            if isinstance(event, dict) and event.get("type") in {"text_input", "reset", "cancel_task"}:
                await self.interrupt()
        except ValueError:
            pass
        return raw

    async def send_json(self, event):
        """Conversation transport: fan out once, and speak once regardless of viewer count."""
        kind = event["type"]
        if kind in {"device", "backend", "phase", "task", "camera", "vision", "confirm_request"}:
            self.snapshot[kind] = event
        if kind == "phase":
            self.busy = event["phase"] in {"thinking", "speaking", "acting"}
            if event["phase"] == "listening" and self.gate and self.enabled and not self.sleeping:
                self.gate.activate(max(self.settings.voice_idle, self.confirm_until - time.monotonic()))
        elif kind == "confirm_request":
            self.confirm_until = time.monotonic() + event["timeout_s"]
            self.busy = False
            if self.gate and self.enabled and not self.sleeping:
                self.gate.activate(event["timeout_s"])
            for identifier in list(self.text):
                self.enqueue(identifier)
        elif kind == "confirm_closed":
            self.snapshot.pop("confirm_request", None)
            self.confirm_until = 0
            self.text.clear()
            await self.interrupt()
        elif kind == "assistant_start":
            self.text[event["id"]] = ""
        elif kind == "assistant_delta" and event["id"] not in self.spoken:
            self.text[event["id"]] = (self.text.get(event["id"], "") + event["text"])[:1000]
        elif kind == "assistant_end":
            self.enqueue(event["id"])
        elif kind == "session_end":
            await self.interrupt()
            self.busy = False
            self.text.clear()
            if self.gate:
                self.gate.reset()
        self.output.emit(event)
        self.report()

    async def close(self, code=1000):
        await self.stop()

    async def control(self, action):
        if action == "resume":
            await self.start()
        elif action == "pause":
            await self.stop()
        elif action in {"sleep", "listen", "toggle"}:
            if action != "sleep":
                await self.start()
                if not self.enabled:
                    return self.status()
            async with self.control_lock:
                active = action == "listen" or (action == "toggle" and not self.status()["active"])
                # Latch sleep before cancelling TTS: its finally block must not reopen ASR.
                self.sleeping = not active
                await self.interrupt()
                self.text.clear()
                if self.gate:
                    self.gate.reset()
                    if active and self.enabled:
                        self.gate.activate()
                        self.output.emit({"type": "wake"})
                self.report()
        elif action in {"tts_on", "tts_off"}:
            self.tts = action == "tts_on"
            if not self.tts:
                await self.stop_speaking()
        elif action == "interrupt":
            await self.interrupt()
        self.output.emit({"type": "voice_status", **self.status()})
        return self.status()

    async def serve(self, ws):
        queue = self.output.subscribe()
        try:
            for event in list(self.snapshot.values()):
                if event["type"] == "confirm_request":
                    event = {**event, "timeout_s": max(0, self.confirm_until - time.monotonic())}
                await ws.send_json(event)
            await ws.send_json({"type": "voice_status", **self.status()})

            async def receive():
                while True:
                    raw = await ws.receive_text()
                    if len(raw) > 8192:
                        await ws.close(code=1009)
                        return
                    # Use the shared conversation's existing schema and confirmation routing.
                    await self.input.put(raw)

            async def send():
                while True:
                    event = await queue.get()
                    if event["type"] == "transport_overflow":
                        await ws.close(code=1013)
                        return
                    await ws.send_json(event)

            tasks = [asyncio.create_task(receive()), asyncio.create_task(send())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    await self._cancel(task)
        except WebSocketDisconnect:
            pass
        finally:
            self.output.unsubscribe(queue)
