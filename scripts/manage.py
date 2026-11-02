"""Shared Ubuntu/Windows installation and foreground gateway startup."""
from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class SetupError(Exception):
    pass


def executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise SetupError(f"找不到 {name}，请先按 README 安装基础软件，并重新打开终端。")
    return path


def create_env(backend: Path) -> None:
    """Create a private template only if no local configuration exists."""
    template = (backend / ".env.example").read_bytes()
    try:
        fd = os.open(backend / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print("已保留 backend/.env。", flush=True)
        return
    with os.fdopen(fd, "wb") as target:
        target.write(template)
    print("已生成 backend/.env，请填写 Key 和现场配置。", flush=True)


def setup(root: Path, voice: bool = False) -> None:
    executable("node")
    npm = executable("npm.cmd" if os.name == "nt" else "npm")
    uv = executable("uv")
    steps = [
        ("安装前端锁文件依赖", [npm, "ci"], root / "frontend"),
        ("构建网页", [npm, "run", "build"], root / "frontend"),
        ("安装后端锁文件依赖", [uv, "sync", "--locked", "--python", "3.12", "--extra", "dev"],
         root / "backend"),
    ]
    if voice:
        steps[-1][1].extend(["--extra", "voice"])
    for title, command, directory in steps:
        print(f"\n{title}…", flush=True)
        subprocess.run(command, cwd=directory, check=True)
    create_env(root / "backend")
    if voice:
        subprocess.run([sys.executable, str(root / "scripts/setup-voice.py")], check=True)
    print("\n安装／更新完成。确认配置后运行启动脚本。", flush=True)


def check_files(root: Path) -> None:
    if not (root / "backend/.env").is_file():
        raise SetupError("缺少 backend/.env，请先运行安装／更新脚本并填写配置。")
    if not (root / "frontend/dist/index.html").is_file():
        raise SetupError("缺少构建后的网页，请先运行安装／更新脚本。")


def check_port(host: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
        except OSError:
            raise SetupError(f"无法监听 {host}:{port}，请核对端口占用和系统权限后再启动。") from None


def start(root: Path, host: str, port: int) -> None:
    check_files(root)
    # Database and user-supplied relative paths retain the README's backend cwd.
    os.chdir(root / "backend")
    sys.path.insert(0, str(root / "backend"))
    try:
        import uvicorn
        from bluesword.config import Settings
        from pydantic import ValidationError
    except ImportError:
        raise SetupError("后端依赖不完整，请重新运行安装／更新脚本。") from None
    try:
        settings = Settings.from_env()
    except (ValidationError, ValueError, OSError):
        raise SetupError("配置读取失败，请核对 backend/.env 和进程环境变量；字段说明见 README。") from None
    if settings.robot_mode == "lanjian_http":
        try:
            url = urlsplit(settings.robot_dispatch_url)
            valid = url.scheme in ("http", "https") and url.hostname and url.port != 0
        except ValueError:
            valid = False
        if not valid:
            raise SetupError("HTTP 机器人模式需填写有效的 BLUESWORD_ROBOT_DISPATCH_URL。")
    check_port(host, port)
    print(f"机器人模式：{settings.robot_mode}；协议：{settings.robot_protocol}", flush=True)
    print(f"服务就绪后打开：http://127.0.0.1:{port}；按 Ctrl+C 停止。", flush=True)
    if host == "0.0.0.0":
        print(f"局域网监听已开启；机器人回调请填写本机实际局域网 IP:{port}，并核对防火墙。", flush=True)
    elif settings.robot_mode == "lanjian_http":
        print("当前仅监听本机；跨电脑联调请停止后加 --host 0.0.0.0 重新启动。", flush=True)
    uvicorn.run("bluesword.app:app", host=host, port=port, workers=1)


def main() -> int:
    # Keep redirected logs readable across Windows code pages and Ubuntu terminals.
    for stream in (sys.stdout, sys.stderr):
        if not stream.isatty() and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="安装／更新或启动布鲁网关（Windows / Ubuntu 共用）")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("setup", help="安装锁文件依赖、构建网页并准备配置")
    install.add_argument("--voice", action="store_true", help="同时安装本地持续唤醒依赖与模型")
    launch = commands.add_parser("start", help="使用现有配置前台启动，不安装依赖或构建")
    launch.add_argument("--host", choices=["127.0.0.1", "0.0.0.0"], help="覆盖配置向导保存的监听地址")
    launch.add_argument("--port", type=int, help="覆盖配置向导保存的端口")
    args = parser.parse_args()
    if args.command == "start" and args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    try:
        if args.command == "setup":
            setup(ROOT, voice=args.voice)
        else:
            from configure import start_defaults

            try:
                host, port = start_defaults(ROOT)
            except (OSError, ValueError, TypeError):
                raise SetupError("现场启动配置无效，请重新运行 scripts/configure.py。") from None
            start(ROOT, args.host or host, args.port if args.port is not None else port)
    except SetupError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"安装步骤失败（退出码 {exc.returncode}），请处理上方错误后重新运行。", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
