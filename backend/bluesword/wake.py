"""Offline KWS and bounded utterance buffering. No network or microphone side effects."""
from __future__ import annotations

import re
from collections import deque
from pathlib import Path

import numpy as np

RATE = 16000


class SherpaWake:
    def __init__(self, directory: str, threshold: float):
        import sherpa_onnx

        root = Path(directory)
        suffix = "epoch-13-avg-2-chunk-8-left-64"
        files = {
            "encoder": root / f"encoder-{suffix}.int8.onnx",
            "decoder": root / f"decoder-{suffix}.onnx",
            "joiner": root / f"joiner-{suffix}.int8.onnx",
            "tokens": root / "tokens.txt",
            "keywords_file": root / "bluesword-keywords.txt",
        }
        if not all(path.is_file() for path in files.values()):
            raise FileNotFoundError("请先运行 scripts/setup-voice.py 安装唤醒模型")
        self.model = sherpa_onnx.KeywordSpotter(
            **{key: str(path) for key, path in files.items()},
            num_threads=1, provider="cpu", keywords_threshold=threshold,
        )
        self.reset()

    def reset(self):
        # A new stream also discards acoustic history from before playback/reset.
        self.stream = self.model.create_stream()

    def feed(self, samples: np.ndarray) -> bool:
        self.stream.accept_waveform(RATE, samples)
        found = False
        while self.model.is_ready(self.stream):
            self.model.decode_stream(self.stream)
            if self.model.get_result(self.stream):
                found = True
                self.model.reset_stream(self.stream)
        return found


def command_text(text: str) -> str:
    """KWS has already accepted the wake phrase; strip an ASR spelling variant."""
    return re.sub(r"^\s*(?:你好[，,、\s]*(?:布鲁|布噜|布路|布卢|blue)|hello[，,\s]+blue\b)[，,。！!？?.:\s]*", "", text,
                  flags=re.IGNORECASE).strip()


class AudioGate:
    """100 ms frames at 16 kHz. Standby frames never produce an ASR request.

    A three-second pre-roll retains a wake phrase immediately followed by a command.
    Only that bounded context and post-wake speech leave this class, after a hit.
    """

    def __init__(self, detector, rms=0.012, silence=0.85, idle=20):
        self.detector, self.rms, self.silence, self.idle = detector, rms, silence, idle
        self.now = 0.0
        self.active_until = 0.0
        self.blocked = False
        self.reset()

    @property
    def active(self):
        return self.now < self.active_until

    def clear(self):
        self.lead = deque(maxlen=30)
        self.chunks = []
        self.length = 0
        self.last_sound = None

    def reset(self):
        self.active_until = 0.0
        self.clear()
        self.detector.reset()

    def activate(self, duration=None):
        self.active_until = self.now + (duration or self.idle)

    def feed(self, samples, blocked=False):
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        self.now += len(samples) / RATE
        if blocked:
            if not self.blocked:
                self.clear()
                self.detector.reset()
            self.blocked = True
            return False, None
        self.blocked = False
        woke = False
        sound = float(np.sqrt(np.mean(samples * samples))) >= self.rms
        if not self.active and not self.chunks:
            self.lead.append(samples.copy())
            if not self.detector.feed(samples):
                return False, None
            woke = True
            self.activate()
            self.chunks = list(self.lead)
            self.length = sum(len(part) for part in self.chunks)
            self.lead.clear()
            self.last_sound = self.now
        else:
            if sound and not self.chunks:
                self.chunks = list(self.lead)
                self.length = sum(len(part) for part in self.chunks)
                self.lead.clear()
            if self.chunks or sound:
                self.chunks.append(samples.copy())
                self.length += len(samples)
                if sound:
                    self.last_sound = self.now
            else:
                self.lead.append(samples.copy())
                # Only 200 ms context is needed between turns.
                while len(self.lead) > 2:
                    self.lead.popleft()
        if self.chunks and ((self.last_sound is not None and self.now - self.last_sound >= self.silence)
                            or self.length >= RATE * 25):
            pcm = (np.clip(np.concatenate(self.chunks), -1, 1) * 32767).astype("<i2").tobytes()
            self.clear()
            return woke, pcm
        return woke, None
