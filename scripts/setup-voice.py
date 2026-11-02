"""Download the pinned sherpa KWS model and write the Blue wake phrase. No credentials needed."""
from __future__ import annotations

import hashlib
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

MODEL = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL}.tar.bz2"
SHA256 = "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"
SUFFIX = "epoch-13-avg-2-chunk-8-left-64"
FILES = [f"encoder-{SUFFIX}.int8.onnx", f"decoder-{SUFFIX}.onnx",
         f"joiner-{SUFFIX}.int8.onnx", "tokens.txt"]
# Official phone+ppinyin encoding, matching this model's tokens.txt.
KEYWORDS = "n ǐ h ǎo b ù l ǔ @你好布鲁\n"


def setup(root: Path):
    destination = root / "backend" / "models" / MODEL
    destination.mkdir(parents=True, exist_ok=True)
    if not all((destination / name).is_file() for name in FILES):
        print("下载官方 sherpa-onnx 唤醒模型（约 38 MB）…", flush=True)
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "model.tar.bz2"
            with urllib.request.urlopen(URL, timeout=90) as response, archive.open("wb") as target:
                shutil.copyfileobj(response, target)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
                raise ValueError("模型校验失败，未安装")
            with tarfile.open(archive) as source:
                # Copy only named regular files; never extract archive paths or links.
                for name in FILES:
                    member = source.getmember(f"{MODEL}/{name}")
                    if not member.isfile():
                        raise ValueError("模型文件类型无效")
                    with source.extractfile(member) as content, (destination / name).open("wb") as target:
                        shutil.copyfileobj(content, target)
    (destination / "bluesword-keywords.txt").write_text(KEYWORDS, encoding="utf-8")
    print(f"唤醒模型就绪：{destination}\n唤醒词：你好，布鲁", flush=True)


if __name__ == "__main__":
    setup(Path(__file__).resolve().parents[1])
