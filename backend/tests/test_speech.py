import json

import httpx
import pytest
from fastapi.testclient import TestClient

from bluesword import speech
from bluesword.app import create_app
from bluesword.config import Settings


async def test_asr_protocol_returns_final_sentences(monkeypatch):
    sent = []
    packets = iter(
        [
            {"header": {"event": "task-started"}},
            {
                "payload": {
                    "output": {"sentence": {"sentence_id": 0, "text": "不要保留", "sentence_end": False}}
                }
            },
            {
                "payload": {
                    "output": {"sentence": {"sentence_id": 1, "text": "拿两瓶水。", "sentence_end": True}}
                }
            },
            {
                "payload": {
                    "output": {"sentence": {"sentence_id": 0, "text": "你好，布鲁。", "sentence_end": True}}
                }
            },
            {"header": {"event": "task-finished"}},
        ]
    )

    class Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send(self, data):
            sent.append(data)

        async def recv(self):
            return json.dumps(next(packets))

    monkeypatch.setattr(speech, "connect", lambda *a, **kw: Socket())
    assert await speech.recognize(bytes(6400), Settings(speech_api_key="test")) == "你好，布鲁。拿两瓶水。"
    assert json.loads(sent[0])["payload"]["model"] == Settings().speech_model
    assert b"".join(x for x in sent if isinstance(x, bytes)) == bytes(6400)
    assert json.loads(sent[-1])["header"]["action"] == "finish-task"


def test_speech_http_validation_and_no_dispatch(monkeypatch):
    async def recognize(pcm, settings):
        return "拿两瓶水"

    async def synthesize(text, settings):
        return b"RIFFtest"

    monkeypatch.setattr(speech, "recognize", recognize)
    monkeypatch.setattr(speech, "synthesize", synthesize)
    settings = Settings(db_path=":memory:", speech_api_key="test", api_token="test", mock_delay=0)
    headers = {"Authorization": "Bearer test"}
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/speech/recognize", content=b"00").status_code == 401
        assert client.post("/api/speech/recognize", content=b"0", headers=headers).status_code == 400
        assert (
            client.post(
                "/api/speech/recognize", content=b"00", headers=headers | {"Origin": "https://wrong.test"}
            ).status_code
            == 403
        )
        assert client.post("/api/speech/recognize", content=b"00", headers=headers).json() == {
            "text": "拿两瓶水"
        }
        assert client.get("/api/tasks", headers=headers).json() == []
        assert client.post("/api/speech/synthesize", json={"text": ""}, headers=headers).status_code == 400
        result = client.post("/api/speech/synthesize", json={"text": "你好"}, headers=headers)
        assert result.content == b"RIFFtest" and result.headers["cache-control"] == "no-store"


def test_asr_failure_logs_category_without_sensitive_error(monkeypatch, caplog):
    async def unavailable(pcm, settings):
        raise TimeoutError("private-provider-details")

    monkeypatch.setattr(speech, "recognize", unavailable)
    with TestClient(create_app(Settings(db_path=":memory:", speech_api_key="private-key"))) as client:
        response = client.post("/api/speech/recognize", content=b"00")
        assert response.status_code == 502
        assert "speech_asr_failed type=TimeoutError" in caplog.text
        assert "private-provider-details" not in caplog.text and "private-key" not in caplog.text


async def test_tts_download_without_leaking_credentials(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        if request.method == "POST":
            assert request.url.path.endswith("/multimodal-generation/generation")
            assert json.loads(request.content)["input"]["voice"] == "Cherry"
            return httpx.Response(
                200, json={"output": {"audio": {"url": "https://test.oss-cn-beijing.aliyuncs.com/audio.wav"}}}
            )
        assert "Authorization" not in request.headers
        return httpx.Response(200, content=b"RIFFtest")

    original = httpx.AsyncClient
    monkeypatch.setattr(
        speech.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond))
    )
    assert await speech.synthesize("你好", Settings(speech_api_key="private-test")) == b"RIFFtest"
    assert len(requests) == 2


@pytest.mark.parametrize("text", ["拿三瓶矿泉水", "矿泉水和薯片各两件", "拿零瓶水"])
def test_over_quantity_is_not_silently_reduced(text):
    from bluesword.config import load_scene
    from bluesword.intents import resolve

    _, items = load_scene()
    assert resolve(text, items).kind == "chat"
