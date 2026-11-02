#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_port="${BLUESWORD_SIM_PORT:-8001}"
task_blender="${BLENDER_BIN:-$HOME/Applications/Blender-4.5.app/Contents/MacOS/Blender}"
if [ ! -x "$task_blender" ]; then
  if command -v blender >/dev/null 2>&1; then task_blender="$(command -v blender)";
  elif [ -x /Applications/Blender.app/Contents/MacOS/Blender ]; then task_blender=/Applications/Blender.app/Contents/MacOS/Blender;
  else echo 'Blender not found. Set BLENDER_BIN to a Blender 4.5 executable.'; exit 1; fi
fi
cd "$task_root"
mkdir -p output/blender
if [ ! -f simulation/assets/g2.urdf ]; then
  uv run --project backend python simulation/fetch_assets.py
  uv run --project backend --with xacro python simulation/prepare_model.py
fi
if [ ! -f output/blender/lanjian_gdk.blend ]; then
  "$task_blender" -b --factory-startup --python simulation/build_scene.py
fi
if [ "${1:-}" = '--replay' ]; then
  exec "$task_blender" output/blender/lanjian_gdk_animation.blend --python simulation/replay.py
fi
if ! curl --noproxy '*' -fsS "http://127.0.0.1:$task_port/api/simulation" >/dev/null 2>&1; then
  if curl --noproxy '*' -fsS "http://127.0.0.1:$task_port/health" >/dev/null 2>&1; then
    echo "Port $task_port has a different backend. Set BLUESWORD_SIM_PORT to an unused port."
    exit 1
  fi
  (
    cd backend
    nohup env BLUESWORD_ROBOT_MODE=gdk_mock BLUESWORD_DB_PATH="data/blender-$task_port.sqlite3" \
      BLUESWORD_AUTO_TAKE="${BLUESWORD_AUTO_TAKE:-false}" BLUESWORD_HANDOVER_TIMEOUT="${BLUESWORD_HANDOVER_TIMEOUT:-180}" \
      uv run uvicorn bluesword.app:app --host 127.0.0.1 --port "$task_port" --workers 1 \
      > "../output/blender/server-$task_port.log" 2>&1 &
    echo $! > "../output/blender/server-$task_port.pid"
  )
  for attempt in $(seq 1 60); do
    if curl --noproxy '*' -fsS "http://127.0.0.1:$task_port/api/simulation" >/dev/null 2>&1; then break; fi
    sleep .25
  done
  curl --noproxy '*' -fsS "http://127.0.0.1:$task_port/api/simulation" >/dev/null
fi
echo "Frontend: http://127.0.0.1:$task_port"
echo 'Blender: N sidebar → 兰剑联动 → 取物演示：奥利奥'
exec "$task_blender" output/blender/lanjian_gdk.blend --python simulation/live_bridge.py -- --url "http://127.0.0.1:$task_port"
