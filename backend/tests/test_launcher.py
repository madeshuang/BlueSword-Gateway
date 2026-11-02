"""Cross-platform deployment behavior without installing packages in tests."""
import importlib.util
import os
import socket
import subprocess
from pathlib import Path

import pytest

from bluesword.config import Settings

spec = importlib.util.spec_from_file_location(
    "gateway_manage", Path(__file__).resolve().parents[2] / "scripts/manage.py",
)
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


@pytest.fixture
def checkout(tmp_path):
    root = tmp_path / "网关 project"
    (root / "backend").mkdir(parents=True)
    (root / "frontend/dist").mkdir(parents=True)
    (root / "backend/.env.example").write_text("BLUESWORD_ROBOT_MODE=mock\n", encoding="utf-8")
    (root / "frontend/dist/index.html").write_text("<html></html>", encoding="utf-8")
    return root


def test_setup_preserves_configuration_and_uses_locks(checkout, monkeypatch):
    local = checkout / "backend/.env"
    original = "# 现场配置\nBLUESWORD_ROBOT_MODE=lanjian_http\n".encode()
    local.write_bytes(original)
    calls = []
    monkeypatch.setattr(manage, "executable", lambda name: name)
    monkeypatch.setattr(manage.subprocess, "run", lambda args, **kw: calls.append((args, kw)))
    manage.setup(checkout)
    assert local.read_bytes() == original
    assert calls[0][0][1:] == ["ci"]
    assert calls[1][0][1:] == ["run", "build"]
    assert "--locked" in calls[2][0]
    assert all(call[1]["check"] for call in calls)
    assert [call[1]["cwd"] for call in calls] == [
        checkout / "frontend", checkout / "frontend", checkout / "backend",
    ]


def test_failed_install_does_not_continue_or_create_config(checkout, monkeypatch):
    calls = []
    monkeypatch.setattr(manage, "executable", lambda name: name)

    def fail(args, **kwargs):
        calls.append(args)
        raise subprocess.CalledProcessError(17, args)

    monkeypatch.setattr(manage.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        manage.setup(checkout)
    assert len(calls) == 1
    assert not (checkout / "backend/.env").exists()


def test_new_configuration_is_exact_template(checkout):
    manage.create_env(checkout / "backend")
    local = checkout / "backend/.env"
    assert local.read_bytes() == (checkout / "backend/.env.example").read_bytes()
    if os.name != "nt":
        assert local.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("missing", ["backend/.env", "frontend/dist/index.html"])
def test_incomplete_install_is_rejected(checkout, missing):
    manage.create_env(checkout / "backend")
    (checkout / missing).unlink()
    with pytest.raises(manage.SetupError):
        manage.check_files(checkout)


def test_occupied_port_is_rejected_without_stopping_listener():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        with pytest.raises(manage.SetupError):
            manage.check_port("127.0.0.1", port)
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass


@pytest.mark.parametrize("mode", ["mock", "lanjian_http"])
def test_start_preserves_mode_and_backend_working_directory(checkout, monkeypatch, mode):
    import uvicorn

    manage.create_env(checkout / "backend")
    monkeypatch.chdir(checkout)
    monkeypatch.syspath_prepend(str(checkout))  # Restore sys.path after start inserts backend.
    settings = Settings(robot_mode=mode, robot_dispatch_url="http://robot.test:8080/api/task/dispatch")
    monkeypatch.setattr(Settings, "from_env", lambda: settings)
    monkeypatch.setattr(manage, "check_port", lambda host, port: None)
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.append((app, kw, Path.cwd())))
    manage.start(checkout, "0.0.0.0", 8100)
    assert settings.robot_mode == mode
    assert calls == [("bluesword.app:app", {"host": "0.0.0.0", "port": 8100, "workers": 1},
                      checkout / "backend")]


def test_remote_mode_requires_dispatch_address(checkout, monkeypatch):
    manage.create_env(checkout / "backend")
    monkeypatch.chdir(checkout)
    monkeypatch.syspath_prepend(str(checkout))
    monkeypatch.setattr(Settings, "from_env", lambda: Settings(robot_mode="lanjian_http"))
    with pytest.raises(manage.SetupError, match="BLUESWORD_ROBOT_DISPATCH_URL"):
        manage.start(checkout, "0.0.0.0", 8100)
