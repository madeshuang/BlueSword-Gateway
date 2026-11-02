"""Interactive, standard-library-only setup for the exhibition gateway."""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SITE_FILE = "config/site.local.json"
CATALOG_FILE = "config/booth-catalog.local.json"


def read_env(path: Path) -> dict[str, str]:
    values = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("'\"")
    return values


def render_env(text: str, updates: dict[str, str | None]) -> str:
    for value in updates.values():
        if value is not None and any(c in value for c in "\r\n\x00"):
            raise ValueError("配置不能包含换行或空字符")
    lines = [line for line in text.splitlines()
             if line.lstrip().startswith("#") or "=" not in line or line.split("=", 1)[0].strip() not in updates]
    lines += ["", "# 现场配置向导生成；同名进程环境变量仍优先"]
    lines += [f"{key}={value}" for key, value in updates.items() if value is not None]
    return "\n".join(lines) + "\n"


def write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".env.", delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            output.write(content)
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def port_number(value: str) -> str:
    number = int(value)
    if not 1 <= number <= 65535:
        raise ValueError("端口必须在 1～65535 之间")
    return str(number)


def one_of(value: str, choices: set[str]) -> str:
    if value not in choices:
        raise ValueError("请选择提示中的选项")
    return value


def input_device(value: str) -> str:
    if value != "-" and not value.isdecimal():
        raise ValueError("请输入非负整数设备编号，或 - 使用系统默认")
    return value


def gateway_ip(value: str) -> str:
    address = ipaddress.IPv4Address(value)
    if address.is_loopback or address.is_unspecified or address.is_multicast:
        raise ValueError("请填写网关电脑的实际局域网 IPv4，不能填 localhost 或 0.0.0.0")
    return str(address)


def dispatch_url(value: str) -> str:
    parts = urlsplit(value)
    if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.port == 0
            or parts.username or parts.password or parts.query or parts.fragment
            or parts.path.rstrip("/") != "/api/task/dispatch"):
        raise ValueError("请填写完整地址，例如 http://192.168.1.20:8080/api/task/dispatch")
    return value.rstrip("/")


def catalog_rows(path: Path) -> list[dict]:
    rows = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("物品目录必须是非空 JSON 数组")
    ids = set()
    for row in rows:
        if (not isinstance(row, dict) or any(not isinstance(row.get(k), str) or not row[k].strip()
                                            for k in ("id", "name", "category"))
                or type(row.get("initialStock")) is not int or row["initialStock"] < 0):
            raise ValueError("每件物品需填写 id、name、category 和非负整数 initialStock")
        if row["id"] in ids:
            raise ValueError("物品 id 不能重复")
        ids.add(row["id"])
        for key in ("aliases", "aliasesEn"):
            if key in row and (not isinstance(row[key], list) or any(not isinstance(v, str) for v in row[key])):
                raise ValueError(f"{key} 必须是文字数组")
        for key in ("robotItem", "nameEn", "location", "description"):
            if key in row and not isinstance(row[key], str):
                raise ValueError(f"{key} 必须是文字")
    return rows


def ask(label: str, default="", validate=None) -> str:
    while True:
        value = input(f"{label}" + (f" [{default}]" if default else "") + ": ").strip() or default
        try:
            if validate:
                value = validate(value)
            return value
        except ValueError:
            print("输入格式不正确，请按提示重新填写。")


def secret(label: str, previous="", empty_hint="回车暂不配置") -> str:
    hint = "已配置，回车保留" if previous else empty_hint
    value = getpass.getpass(f"{label}（{hint}，输入不回显）: ").strip()
    if any(c in value for c in "\r\n\x00"):
        raise ValueError("密钥或口令不能包含换行")
    return value or previous


def backend_python(root: Path) -> Path:
    return root / ("backend/.venv/Scripts/python.exe" if os.name == "nt" else "backend/.venv/bin/python")


def start_defaults(root: Path) -> tuple[str, int]:
    path = root / SITE_FILE
    if not path.exists():
        return "127.0.0.1", 8000
    site = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(site, dict) or site.get("bind_host") not in {"127.0.0.1", "0.0.0.0"}:
        raise ValueError("现场监听地址无效，请重新运行配置向导")
    if type(site.get("port")) is not int:
        raise ValueError("现场监听端口无效，请重新运行配置向导")
    return site["bind_host"], int(port_number(str(site["port"])))


def handoff(site: dict, rows: list[dict], robot_url: str) -> str:
    host, port = site["gateway_ip"], site["port"]
    lines = ["布鲁现场配置交接单（不包含密钥）", "",
             f"模式：{site['robot_mode']}；收音：本地 sherpa；播报：默认关闭",
             f"访客网页：http://{host}:{port}", f"工作人员：http://{host}:{port}/operator",
             "工作人员口令保存在 backend/.env 的 BLUESWORD_OPERATOR_TOKEN。", ""]
    if site["robot_mode"] == "lanjian_http":
        parts = urlsplit(robot_url)
        lines += [f"网关发单地址：{robot_url}", f"机器人侧填写 vlm.url = {host}:{port}",
                  "机器人侧 vlm.url 不加 /api/task/...；机器人服务的重载由机器人负责人完成。",
                  f"网关可先 GET {parts.scheme}://{parts.netloc}/api/health 检查机器人，需 success=true、busy 为布尔值。",
                  f"机器人电脑可 GET http://{host}:{port}/health 检查反向连通（若网关启用 API token 需携带）。",
                  "允许双向网络通过上述端口；以下回调需沿用下发的 taskId：",
                  *[f"  POST http://{host}:{port}/api/task/{kind}" for kind in ("progress", "finished", "error")], ""]
    lines += ["双方核对物品映射（初始库存不会覆盖数据库里已有库存）：", "id | 显示名称 | 机器人 item | initialStock"]
    lines += [f"{r['id']} | {r['name']} | {r.get('robotItem') or r['name']} | {r['initialStock']}" for r in rows]
    lines += ["", "机器人负责物品对应格位、导航和抓取标定。网关目录 location 在 VLM v1.2 中仅记录，不替代机器人格位。",
              "英语名称/叫法填写 nameEn、aliasesEn。核对物品编码后，通过网页确认一笔单件订单完成现场验收。",
              "启动：Ubuntu/macOS 使用 bash scripts/start.sh；Windows 使用 scripts\\start.cmd。",
              "诊断：运行同一配置脚本并加 --check。改配置后重启后端并刷新页面。"]
    return "\n".join(lines) + "\n"


def configure(root: Path) -> None:
    env_path = root / "backend/.env"
    current = read_env(env_path)
    site_path = root / SITE_FILE
    previous = json.loads(site_path.read_text(encoding="utf-8")) if site_path.exists() else {}
    print("布鲁现场配置：只生成配置，不启动服务、不下发机器人任务。\n1. 兰剑机器人 VLM v1.2\n2. 本地模拟")
    choice = ask("选择模式（1/2）", "1", lambda v: one_of(v, {"1", "2"}))
    onsite = choice == "1"
    robot_url = ask("机器人完整发单地址，如 http://192.168.1.20:8080/api/task/dispatch",
                    current.get("BLUESWORD_ROBOT_DISPATCH_URL", ""), dispatch_url) if onsite else ""
    host = ask("网关电脑实际局域网 IPv4（机器人要回调这台电脑）",
               previous.get("gateway_ip", "") if previous.get("gateway_ip") != "127.0.0.1" else "", gateway_ip) if onsite else "127.0.0.1"
    port = int(ask("网关监听端口", str(previous.get("port", 8000)), port_number))
    llm = secret("DeepSeek API Key", current.get("BLUESWORD_LLM_API_KEY", current.get("DEEPSEEK_API_KEY", "")))
    speech = secret("阿里百炼北京地域 API Key", current.get("BLUESWORD_SPEECH_API_KEY", current.get("DASHSCOPE_API_KEY", "")))
    workspace = ask("阿里专属工作空间 ID（无则留空；输入 - 清空）",
                    current.get("BLUESWORD_SPEECH_WORKSPACE", current.get("DASHSCOPE_WORKSPACE_ID", "")))
    operator = secret("工作人员口令",
                      current.get("BLUESWORD_OPERATOR_TOKEN", current.get("BOOTH_OPERATOR_TOKEN", "")),
                      empty_hint="回车自动生成") or secrets.token_urlsafe(18)
    python = backend_python(root)
    if python.exists():
        print("\n本机音频设备（无声卡或未装语音依赖时可稍后再选）：", flush=True)
        subprocess.run([str(python), "-m", "sounddevice"], check=False)
    device = ask("麦克风输入设备编号；- 表示系统默认", current.get("BLUESWORD_VOICE_INPUT_DEVICE", "-") or "-",
                 input_device)
    catalog_default = current.get("BLUESWORD_CATALOG_PATH")
    if catalog_default and not Path(catalog_default).is_absolute():
        catalog_default = str((root / "backend" / catalog_default).resolve())
    catalog_value = ask("物品 JSON 路径（相对路径从仓库根目录算起）", catalog_default or CATALOG_FILE)
    catalog = Path(catalog_value).expanduser()
    catalog = (root / catalog).resolve() if not catalog.is_absolute() else catalog.resolve()
    create_catalog = catalog == (root / CATALOG_FILE).resolve() and not catalog.exists()
    rows = catalog_rows(root / "config/booth-catalog.example.json" if create_catalog else catalog)
    updates = {
        "BLUESWORD_ROBOT_MODE": "lanjian_http" if onsite else "mock", "BLUESWORD_ROBOT_PROTOCOL": "vlm",
        "BLUESWORD_ROBOT_DISPATCH_URL": robot_url, "BLUESWORD_SPLIT_SKILLS": "false",
        "BLUESWORD_CATALOG_PATH": str(catalog), "BLUESWORD_SPEECH_MODE": "local",
        "BLUESWORD_LLM_API_KEY": llm, "BLUESWORD_SPEECH_API_KEY": speech,
        "BLUESWORD_SPEECH_WORKSPACE": "" if workspace == "-" else workspace,
        "BLUESWORD_OPERATOR_TOKEN": operator, "BLUESWORD_VOICE_INPUT_DEVICE": None if device == "-" else device,
    }
    original = env_path.read_text(encoding="utf-8-sig") if env_path.exists() else (root / "backend/.env.example").read_text(encoding="utf-8")
    rendered = render_env(original, updates)
    if env_path.exists():
        backup = env_path.with_name(".env.backup-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
        write_private(backup, original)
        print(f"已备份原配置：{backup.name}")
    if create_catalog:
        catalog.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / "config/booth-catalog.example.json", catalog)
    site = {"robot_mode": updates["BLUESWORD_ROBOT_MODE"], "gateway_ip": host,
            "bind_host": "0.0.0.0" if onsite else "127.0.0.1", "port": port}
    write_private(env_path, rendered)
    write_private(site_path, json.dumps(site, ensure_ascii=False, indent=2) + "\n")
    report = handoff(site, rows, robot_url)
    write_private(root / "output/site-setup.txt", report)
    print("\n已写入 backend/.env、config/site.local.json 和 output/site-setup.txt。")
    print(f"物品目录：{catalog}\n请双方核对 robotItem 编码；脚本无法确认机器人实际支持的商品。")
    if not llm or not speech:
        print("API Key 尚未填齐：缺 DeepSeek 时使用规则回复；缺阿里 Key 时无法语音识别。可重跑向导补填。")
    print("\n" + report)


def check(root: Path) -> int:
    """Offline checks; never sends a command to the robot or exposes credentials."""
    errors = []
    values = read_env(root / "backend/.env")
    for key in values:
        if key in os.environ:
            print(f"提示：{key} 被进程环境变量覆盖（不显示值）")
    values.update(os.environ)
    try:
        host, port = start_defaults(root)
        print(f"启动监听：{host}:{port}")
        if values.get("BLUESWORD_ROBOT_MODE") == "lanjian_http":
            dispatch_url(values.get("BLUESWORD_ROBOT_DISPATCH_URL", ""))
            if values.get("BLUESWORD_ROBOT_PROTOCOL") != "vlm":
                errors.append("现场协议应为 vlm")
        if values.get("BLUESWORD_SPEECH_MODE") != "local":
            errors.append("现场收音应为 local")
        for canonical, alias, label in (("BLUESWORD_LLM_API_KEY", "DEEPSEEK_API_KEY", "DeepSeek"),
                                         ("BLUESWORD_SPEECH_API_KEY", "DASHSCOPE_API_KEY", "阿里百炼")):
            if not values.get(canonical, values.get(alias, "")):
                errors.append(f"缺少 {label} API Key")
        if not values.get("BLUESWORD_OPERATOR_TOKEN", values.get("BOOTH_OPERATOR_TOKEN", "")):
            errors.append("缺少工作人员口令")
        catalog = Path(values.get("BLUESWORD_CATALOG_PATH") or root / "config/booth-catalog.example.json")
        if not catalog.is_absolute():
            catalog = root / "backend" / catalog
        rows = catalog_rows(catalog)
        print(f"物品目录格式正确：{len(rows)} 项；机器人 item 编码仍需现场核对")
        model = Path(values.get("BLUESWORD_WAKE_MODEL_DIR") or "models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20")
        if not model.is_absolute():
            model = root / "backend" / model
        suffix = "epoch-13-avg-2-chunk-8-left-64"
        files = [f"encoder-{suffix}.int8.onnx", f"decoder-{suffix}.onnx", f"joiner-{suffix}.int8.onnx", "tokens.txt", "bluesword-keywords.txt"]
        if not all((model / name).is_file() for name in files):
            errors.append("唤醒模型不完整，请运行安装脚本并加 --voice")
        if not (root / "frontend/dist/index.html").exists():
            errors.append("网页尚未构建，请运行安装脚本")
        python = backend_python(root)
        if not python.exists():
            errors.append("后端环境未安装，请运行安装脚本并加 --voice")
        else:
            result = subprocess.run([str(python), "-c", "import sherpa_onnx, sounddevice, soundfile; import bluesword.app"],
                                    cwd=root / "backend", capture_output=True, check=False)
            if result.returncode:
                errors.append("后端/语音依赖或配置未就绪，请核对 .env 并运行安装脚本加 --voice")
    except (ValueError, OSError, TypeError):
        errors.append("配置文件、地址或物品目录无效，请重新运行向导并核对 JSON")
    for message in errors:
        print("未就绪：" + message)
    print("配置检查通过；尚未验证 API Key 有效性、麦克风权限和机器人双向网络。" if not errors else "请处理以上项目后重跑 --check。")
    return int(bool(errors))


def main(root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description="配置布鲁现场网关（Windows / Ubuntu / macOS）")
    parser.add_argument("--check", action="store_true", help="只读检查本地配置和安装，不连接机器人")
    args = parser.parse_args()
    try:
        if args.check:
            return check(root)
        configure(root)
        return 0
    except (EOFError, KeyboardInterrupt):
        print("\n配置已取消。")
        return 130
    except (ValueError, OSError, TypeError):
        print("配置未完成：请检查输入、JSON 格式及文件访问权限；错误信息不显示密钥。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
