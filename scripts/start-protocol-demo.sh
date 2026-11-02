#!/usr/bin/env bash
# 兰剑协议联调演示：布鲁网关（:8000）⇄ 模拟兰剑机器人（:8001，GDK 模拟 + Blender）
#   bash scripts/start-protocol-demo.sh             启动两个后端并打开 Blender
#   bash scripts/start-protocol-demo.sh --no-blender 只启动后端
#   bash scripts/start-protocol-demo.sh --stop      停止两个后端
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
logs="$root/output/protocol-demo"
mkdir -p "$logs"
gateway_port="${GATEWAY_PORT:-8000}"
robot_port="${ROBOT_PORT:-8001}"

stop() {
  for name in gateway robot; do
    if [ -f "$logs/$name.pid" ]; then kill "$(cat "$logs/$name.pid")" 2>/dev/null || true; rm -f "$logs/$name.pid"; fi
  done
}
if [ "${1:-}" = "--stop" ]; then stop; echo "已停止"; exit 0; fi

for port in "$gateway_port" "$robot_port"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "端口 $port 已被占用。先停止占用它的旧服务：kill \$(lsof -tiTCP:$port -sTCP:LISTEN)" >&2
    exit 1
  fi
done

(cd "$root/frontend" && { [ -d node_modules ] || npm ci; } && npm run build >/dev/null)

cd "$root/backend"
# 模拟兰剑机器人：现有 GDK 流程 + FakeSdk，只外挂了阶段回报器
nohup env BLUESWORD_ROBOT_MODE=gdk_mock BLUESWORD_DB_PATH=data/protocol-robot.sqlite3 \
  BLUESWORD_AUTO_TAKE=true BLUESWORD_GATEWAY_URL="http://127.0.0.1:$gateway_port" BLUESWORD_SERVE_UI=false \
  BLUESWORD_SIMULATION_SPEED="${SPEED:-1}" \
  uv run uvicorn bluesword.app:app --host 127.0.0.1 --port "$robot_port" --workers 1 > "$logs/robot.log" 2>&1 &
echo $! > "$logs/robot.pid"
# 布鲁网关：大模型 Agent，技能通过兰剑协议下发到机器人
nohup env BLUESWORD_ROBOT_MODE=lanjian_http BLUESWORD_DB_PATH=data/protocol-gateway.sqlite3 \
  BLUESWORD_ROBOT_DISPATCH_URL="http://127.0.0.1:$robot_port/api/task/dispatch" \
  uv run uvicorn bluesword.app:app --host 127.0.0.1 --port "$gateway_port" --workers 1 > "$logs/gateway.log" 2>&1 &
echo $! > "$logs/gateway.pid"

for _ in $(seq 1 60); do
  if curl --noproxy '*' -fsS "http://127.0.0.1:$gateway_port/health" >/dev/null 2>&1 \
     && curl --noproxy '*' -fsS "http://127.0.0.1:$robot_port/api/simulation" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
echo "布鲁网关：      http://127.0.0.1:$gateway_port"
echo "模拟兰剑机器人：http://127.0.0.1:$robot_port （只有接口，没有网页；日志 output/protocol-demo/）"
echo "停止：bash scripts/start-protocol-demo.sh --stop"

if [ "${1:-}" != "--no-blender" ]; then
  blender="${BLENDER_BIN:-$HOME/Applications/Blender-4.5.app/Contents/MacOS/Blender}"
  cd "$root"
  exec "$blender" output/blender/lanjian_gdk.blend --python simulation/live_bridge.py -- --url "http://127.0.0.1:$robot_port"
fi
