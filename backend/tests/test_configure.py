import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


@pytest.fixture
def site(tmp_path):
    (tmp_path / "backend").mkdir()
    (tmp_path / "config").mkdir()
    for relative in ("backend/.env.example", "config/booth-catalog.example.json"):
        shutil.copyfile(ROOT / relative, tmp_path / relative)
    return tmp_path


def run_wizard(configure, monkeypatch, site, answers, passwords):
    responses, secrets = iter(answers), iter(passwords)
    monkeypatch.setattr("builtins.input", lambda _: next(responses))
    monkeypatch.setattr(configure.getpass, "getpass", lambda _: next(secrets))
    configure.configure(site)


def test_wizard_preserves_existing_config_and_catalog_and_never_prints_keys(site, monkeypatch, capsys):
    configure = module("configure")
    original = "# existing\nBLUESWORD_VOICE_INPUT_DEVICE=2\nBLUESWORD_LLM_TIMEOUT=45\n"
    (site / "backend/.env").write_text(original)
    run_wizard(configure, monkeypatch, site,
               ["1", "http://192.168.1.20:8080/api/task/dispatch", "192.168.1.10", "8015", "", "-", ""],
               ["private-deepseek", "private-dashscope", "private-operator"])
    values = configure.read_env(site / "backend/.env")
    assert values["BLUESWORD_LLM_TIMEOUT"] == "45"
    assert values["BLUESWORD_SPEECH_MODE"] == "local" and values["BLUESWORD_ROBOT_PROTOCOL"] == "vlm"
    assert "BLUESWORD_VOICE_INPUT_DEVICE" not in values
    assert configure.start_defaults(site) == ("0.0.0.0", 8015)
    assert next((site / "backend").glob(".env.backup-*")).read_text() == original
    if os.name != "nt":
        assert (site / "backend/.env").stat().st_mode & 0o777 == 0o600
    report = (site / "output/site-setup.txt").read_text()
    assert "vlm.url = 192.168.1.10:8015" in report
    printed = capsys.readouterr().out
    for secret in ("private-deepseek", "private-dashscope", "private-operator"):
        assert secret not in report and secret not in printed
    path = site / configure.CATALOG_FILE
    rows = json.loads(path.read_text())
    rows[0]["robotItem"] = "verified-robot-code"
    path.write_text(json.dumps(rows))
    expected = path.read_bytes()
    run_wizard(configure, monkeypatch, site, ["1", "", "", "", "", "-", ""], ["", "", ""])
    assert path.read_bytes() == expected
    assert configure.read_env(site / "backend/.env")["BLUESWORD_LLM_API_KEY"] == "private-deepseek"


def test_start_uses_site_port_and_explicit_arguments_override_it(site, monkeypatch):
    configure, manage = module("configure"), module("manage")
    monkeypatch.setitem(sys.modules, "configure", configure)
    monkeypatch.setattr(manage, "ROOT", site)
    (site / configure.SITE_FILE).write_text(json.dumps({"bind_host": "0.0.0.0", "port": 8015}))
    calls = []
    monkeypatch.setattr(manage, "start", lambda *args: calls.append(args))
    monkeypatch.setattr(sys, "argv", ["manage.py", "start"])
    assert manage.main() == 0 and calls[-1] == (site, "0.0.0.0", 8015)
    monkeypatch.setattr(sys, "argv", ["manage.py", "start", "--host", "127.0.0.1", "--port", "8013"])
    assert manage.main() == 0 and calls[-1] == (site, "127.0.0.1", 8013)


def test_invalid_inputs_and_incomplete_setup_are_reported_without_secrets(site, capsys):
    configure = module("configure")
    for value in ("127.0.0.1", "0.0.0.0", "localhost"):
        with pytest.raises(ValueError):
            configure.gateway_ip(value)
    with pytest.raises(ValueError):
        configure.dispatch_url("http://private-key@192.168.1.20:8080/api/task/dispatch")
    with pytest.raises(ValueError):
        configure.render_env("", {"KEY": "secret\nINJECT=true"})
    (site / "backend/.env").write_text("BLUESWORD_LLM_API_KEY=private-key\nBLUESWORD_SPEECH_MODE=local\n")
    assert configure.check(site) == 1
    output = capsys.readouterr().out
    assert "private-key" not in output
    assert "唤醒模型" in output and "后端环境" in output
