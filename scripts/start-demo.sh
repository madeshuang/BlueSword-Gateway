#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if lsof -iTCP:8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "端口 8000 已被占用（可能是之前启动的旧后端还在运行），新版本不会生效。" >&2
  echo "先停止它：kill \$(lsof -tiTCP:8000 -sTCP:LISTEN)，再重新运行本脚本。" >&2
  exit 1
fi
cd "$task_root/frontend"
if [ ! -d node_modules ]; then npm ci; fi
npm run build
cd "$task_root/backend"
uv sync --locked --python 3.12 --extra dev
exec uv run --locked uvicorn bluesword.app:app --host 127.0.0.1 --port 8000 --workers 1
