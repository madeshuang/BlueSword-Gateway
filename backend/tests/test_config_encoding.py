"""Scene loading must not depend on the operating system's default encoding."""
import io
from pathlib import Path

import pytest

from bluesword.config import load_scene


@pytest.mark.parametrize("default_encoding", ["utf-8", "gbk"])
@pytest.mark.parametrize("custom_scene", [False, True])
def test_scene_preserves_chinese_text(monkeypatch, tmp_path, default_encoding, custom_scene):
    monkeypatch.delenv("BLUESWORD_SCENE", raising=False)
    if custom_scene:
        source = Path(__file__).resolve().parents[1] / "bluesword/scene.json"
        target = tmp_path / "自定义场景.json"
        target.write_bytes(source.read_bytes())
        monkeypatch.setenv("BLUESWORD_SCENE", str(target))

    original_open = io.open

    def open_with_locale(file, mode="r", buffering=-1, encoding=None, *args, **kwargs):
        if "b" not in mode and encoding in (None, "locale"):
            encoding = default_encoding
        return original_open(file, mode, buffering, encoding, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(io, "text_encoding", lambda encoding, stacklevel=2: encoding or "locale")
        patch.setattr(io, "open", open_with_locale)
        waypoints, items = load_scene()

    assert waypoints["shelf"].name == "货架固定点"
    assert items["water"].name == "矿泉水"
    assert "饼干" in items["oreo"].aliases
