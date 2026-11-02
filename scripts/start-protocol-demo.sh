#!/usr/bin/env bash
# 默认：网关 :8000 ⇄ VLM v1.2 HTTP 模拟机器人 :8001；无需 Blender / GDK。
# --no-blender 与默认相同；--blender 保留旧 progress 协议的三维演示。
# --stop 停止本脚本启动的两个服务。
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
logs="$root/output/protocol-demo"
mkdir -p "$logs"
gateway_port="${GATEWAY_PORT:-8000}"
robot_port="${ROBOT_PORT:-8001}"
mode="${1:---no-blender}"
case "$mode" in --no-blender|--blender|--stop) ;; *) echo "用法：$0 [--no-blender|--blender|--stop]" >&2; exit 1 ;; esac

stop() {
  local name pid args
  for name in gateway robot; do
    if [ -f "$logs/$name.pid" ]; then
      pid="$(cat "$logs/$name.pid")"
      args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
      # 不停止被复用 PID 对应的无关进程，也不按端口批量杀进程。
      if [[ "$args" == *"$root/backend/.venv/bin/python -m uvicorn bluesword."* ]]; then
        kill "$pid" 2>/dev/null || true
      elif [ -n "$args" ]; then
        echo "PID $pid 不是本脚本启动的服务，请核对后手动处理。" >&2
        return 1
      fi
      rm -f "$logs/$name.pid"
    fi
  done
}
if [ "$mode" = "--stop" ]; then stop; echo "已发送停止请求"; exit 0; fi

for port in "$gateway_port" "$robot_port"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "端口 $port 已被占用，请先核对并停止旧服务；不会自动停止其他服务。" >&2
    exit 1
  fi
done

(cd "$root/frontend" && { [ -d node_modules ] || npm ci; } && npm run build)
(cd "$root/backend" && uv sync --locked --python 3.12 --extra dev)
python="$root/backend/.venv/bin/python"
cd "$root/backend"

protocol=vlm
catalog="${BLUESWORD_CATALOG_PATH:-$root/config/booth-catalog.example.json}"
if [[ "$catalog" != /* ]]; then
  echo "BLUESWORD_CATALOG_PATH 请使用绝对路径。" >&2
  exit 1
fi
if [ "$mode" = "--blender" ]; then
  : "${BLENDER_BIN:?三维演示请设置 BLENDER_BIN，并提前生成 output/blender/lanjian_gdk.blend}"
  protocol=progress
  catalog="$logs/demo-catalog.json"
  "$python" - "$catalog" <<'PYCODE'
import json, sys
from bluesword.config import load_scene
_, items = load_scene()
with open(sys.argv[1], 'w') as f:
    json.dump([dict(id=i.id, name=i.name, aliases=i.aliases, category=i.category,
                    location="模拟货架", initialStock=i.stock) for i in items.values()], f, ensure_ascii=False)
PYCODE
fi

# 启动失败时回收本次创建的进程；只在两个服务均就绪后保留后台进程。
trap 'stop' EXIT
if [ "$protocol" = "vlm" ]; then
  nohup env BLUESWORD_GATEWAY_URL="http://127.0.0.1:$gateway_port" BLUESWORD_CATALOG_PATH="$catalog" \
    "$python" -m uvicorn bluesword.vlm_simulator:create_app --factory --host 127.0.0.1 --port "$robot_port" --workers 1 \
    > "$logs/robot.log" 2>&1 &
  robot_health=/api/health
  gateway_db=:memory:
else
  nohup env BLUESWORD_ROBOT_MODE=gdk_mock BLUESWORD_ROBOT_PROTOCOL=progress BLUESWORD_CATALOG_PATH= BLUESWORD_API_TOKEN= \
    BLUESWORD_DB_PATH=data/protocol-robot.sqlite3 BLUESWORD_AUTO_TAKE=true \
    BLUESWORD_GATEWAY_URL="http://127.0.0.1:$gateway_port" BLUESWORD_SERVE_UI=false \
    BLUESWORD_SIMULATION_SPEED="${SPEED:-1}" \
    "$python" -m uvicorn bluesword.app:app --host 127.0.0.1 --port "$robot_port" --workers 1 > "$logs/robot.log" 2>&1 &
  robot_health=/api/simulation
  gateway_db=data/protocol-gateway.sqlite3
fi
echo $! > "$logs/robot.pid"
nohup env BLUESWORD_ROBOT_MODE=lanjian_http BLUESWORD_DB_PATH="$gateway_db" BLUESWORD_API_TOKEN= BLUESWORD_SERVE_UI=true \
  BLUESWORD_CATALOG_PATH="$catalog" BLUESWORD_ROBOT_PROTOCOL="$protocol" BLUESWORD_SPLIT_SKILLS=false \
  BLUESWORD_ROBOT_DISPATCH_URL="http://127.0.0.1:$robot_port/api/task/dispatch" \
  "$python" -m uvicorn bluesword.app:app --host 127.0.0.1 --port "$gateway_port" --workers 1 > "$logs/gateway.log" 2>&1 &
echo $! > "$logs/gateway.pid"

ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$(cat "$logs/gateway.pid")" 2>/dev/null || ! kill -0 "$(cat "$logs/robot.pid")" 2>/dev/null; then break; fi
  if curl --noproxy '*' --max-time 2 -fsS "http://127.0.0.1:$robot_port$robot_health" >/dev/null 2>&1 \
     && curl --noproxy '*' --max-time 2 -fsS "http://127.0.0.1:$gateway_port/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.5
done
if [ "$ready" != true ]; then
  echo "启动未成功，请查看 $logs/gateway.log 和 $logs/robot.log。" >&2
  exit 1
fi
trap - EXIT
echo "协议：$protocol（本机模拟，不连接真实机器人）"
echo "布鲁网关：http://127.0.0.1:$gateway_port"
echo "模拟机器人：http://127.0.0.1:$robot_port（仅接口）"
echo "日志：$logs；停止：bash scripts/start-protocol-demo.sh --stop"
if [ "$protocol" = "vlm" ]; then
  echo "场景：${VLM_DEMO_SCENARIO:-success}；照片是合成模拟图；重启后清空本次模拟任务和库存。"
else
  cd "$root"
  exec "$BLENDER_BIN" output/blender/lanjian_gdk.blend --python simulation/live_bridge.py -- --url "http://127.0.0.1:$robot_port"
fi
