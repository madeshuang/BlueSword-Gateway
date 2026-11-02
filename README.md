# 兰剑智能 · 展会取物 Agent

已有 React 前端接入 Python/FastAPI 后端。默认使用**后端机器人模拟器**：任务状态、深度反投影、TF 坐标变换、横移后的重新观测、动作顺序与异常处理都在后端执行，前端显示实际事件。

已依据提供的 **Genie 02 GDK v2.2.3 手册**补上具体 SDK 适配代码和 SDK 层模拟器；完整任务通过同一适配器执行。**尚未使用厂商二进制包和真实机器人验证。** `gdk` 模式要求现场标定、视觉模型与接物传感器插件，缺少配置直接启动失败。自然语言入口由 **DeepSeek（deepseek-flash / V4.1）** 驱动：前端实时显示思考链，取货、卸货作为技能由大模型调用；未配置 key 或大模型不可用时自动退回规则路由。ASR/TTS 尚未接入。

## 启动

已有 **Blender 3D 联动演示**：运行 `bash scripts/start-blender-demo.sh`，打开 <http://127.0.0.1:8001> 发起取物，Blender 同步显示官方 Genie G2 模型与 GDK 模拟指令。详见 [Blender 演示说明](docs/blender-demo.md)。原有二维前端和轻量 mock 仍使用下面的启动方式。

需要 Node.js/npm、uv 和 Python 3.11+。在项目根目录执行：

```bash
bash scripts/start-demo.sh
```

打开 <http://127.0.0.1:8000>，输入“帮我拿一瓶矿泉水”或“我想吃点甜的”。默认约十几秒执行完整流程。左下角明确标识“机器人模拟器 · Mock”。API 文档在 <http://127.0.0.1:8000/docs>。

分开开发：

```bash
# 终端一
cd backend
uv sync --python 3.12 --extra dev
uv run uvicorn bluesword.app:app --host 127.0.0.1 --port 8000

# 终端二
cd frontend
npm install
npm run dev
```

Vite 将 `/ws`、`/api` 和 `/health` 转发到后端。保留原来的纯前端动画演示：`VITE_AGENT_MODE=demo npm run dev`。原有的 `VITE_AGENT_WS` 自定义地址仍然有效。

## 兰剑协议联调演示（网关 ⇄ 模拟兰剑机器人）

```bash
bash scripts/start-protocol-demo.sh          # 两个后端 + Blender
bash scripts/start-protocol-demo.sh --stop   # 停止两个后端
```

- **:8000 布鲁网关**（`BLUESWORD_ROBOT_MODE=lanjian_http`）：大模型 Agent，取货 / 卸货技能通过 HTTP 下发。
- **:8001 模拟兰剑机器人**（`gdk_mock`）：现有 GDK 流程 + FakeSdk 驱动 Blender，外挂 `robot_api.Reporter` 按提案等级二回报阶段进度。
- 协议见 `backend/bluesword/protocol.py`、提案见 `docs/布鲁Agent升级提案.md`；网关页面右侧“机器人通信”显示每条报文，`GET /api/robot/protocol` 可导出。
- 技能结果返回后的复盘轮使用 `BLUESWORD_LLM_REVIEW_EFFORT`（默认 max），让思考链引用机器人回报的细节；决策轮使用 `DEEPSEEK_REASONING_EFFORT`（默认 high）。

## 大模型与技能

- Key 放在 `backend/.env`（已加入 `.gitignore`，权限 600）：`DEEPSEEK_API_KEY=...`，可选 `DEEPSEEK_MODEL=deepseek-flash`。真实环境变量优先。
- 系统提示词：`backend/bluesword/prompts/system.md`（人设、话术长度、物品规则、失败时如何表述）。物品清单由 `scene.json` 自动注入。
- 技能目录：`backend/bluesword/skills.py`。技能 = 步骤的有序组合，步骤 = GDK 原语的组合：
  - **取货 `pick_item`**：导航 → 精确停靠 → 扫描 → 三维定位 → 横移对齐 → 抓取验证 → 抬起收臂（结束时持物）
  - **卸货 `unload_item`**：回递物点 → 递出等待接物 → 松爪收臂（要求手里有物品）
  - 另有 `look_shelf`（看一眼货架）、`get_robot_status`（查询状态）和 `check_inventory`（查询库存）。每次取物前，大模型会先查状态和库存再决定。
- 库存由网关本地维护：`scene.json` 里每件物品的 `stock` 为初始数量（默认 3），递出成功后减一，没货时拒绝取货。`GET /api/inventory` 查看，`POST /api/inventory/reset`（可带 `item_id`）补货重置。
- 大模型只能选技能和清单内的物品，不输出任何运动参数；技能结果如实回传，失败时不得声称完成。
- 事件协议新增：`reasoning_delta` / `reasoning_end`（思考链）、`skill`（技能调用及其 GDK 组合）、`task_step.gdk`。
- “停止”类指令不经过大模型，直接取消任务。

## 流程

1. 解析目标物品，获得机器人独占任务锁。
2. 导航到货架地图引导点，再执行 `high_precision_navi` 并检查停靠误差。
3. 头部 RGB-D 扫描；目标未发现时，有限次转头、调整腰部层高。
4. 检测框内有效深度取中值，通过内参计算相机坐标，再用采集时刻的 `T_base_camera` 转到 `base_link`。
5. 检查工作空间；只允许有界横移 `relative_move`。移动后重新采图、检测和计算坐标。
6. 打开空夹爪 → 预抓取 → 接近 → 闭爪 → 验证持物。
7. 抬起 → 后撤 → 收至持物导航姿态。
8. 导航回递物点并精确停靠。
9. 检查仍在持物 → 递出 → 等待本次接物支撑反馈。
10. 松爪 → 验证离手 → 收臂，最后才报告任务完成。

每个动作都有完成反馈和超时。失败、取消、控制连接断开会请求停止运动并保持夹爪；不会盲目返回或松爪。异常后需要复位，mock 复位按钮只对模拟器开放。任务及事件保存在 `backend/data/tasks.sqlite3`。服务重启会把未完成任务标记为 `interrupted`，不会重新播放运动命令。

## 不需要机器人即可运行整套程序

```bash
cd backend

# 实际执行同一套任务编排，打印每个机器人接口调用，保存 JSONL 轨迹
uv run bluesword-demo --item oreo --output ../output/mock-success.jsonl

# 用 GDK 2.2.3 请求对象、反馈轮询、RGB-D 解码跑完整适配器（仍无硬件）
uv run bluesword-gdk-demo --item oreo --output ../output/gdk-api-success.jsonl
uv run bluesword-gdk-demo --scenario handover_timeout --expect failed \
  --output ../output/gdk-api-handover-timeout.jsonl

# 验证转头和腰部搜索
uv run bluesword-demo --item poker --scenario search

# 无人接物：应该失败且继续持物，退出码仍为 0（符合 --expect）
uv run bluesword-demo --scenario handover_timeout --expect failed \
  --output ../output/mock-handover-timeout.jsonl

# 自动化测试和静态检查
uv run --extra dev pytest -q
uv run --extra dev ruff check bluesword tests

# 已启动服务时，再检查真实 HTTP/WS 链路、静态资源和完整任务
uv run --extra dev python scripts/smoke_server.py --output ../output/server-smoke.json
```

`--scenario` 支持：`success`、`search`、`not_found`、`bad_depth`、`stale_frame`、`tf_error`、`nav_failure`、`nav_timeout`、`precision_unavailable`、`grasp_failure`、`handover_timeout`。

mock 验证接口、状态和几何计算；不模拟刚体动力学、碰撞、实际抓取成功率或真人接物力反馈。

## 手动体验接物、失败和取消

默认 mock 自动产生接物信号。需要人工点击“模拟接稳物品”时：

```bash
cd backend
BLUESWORD_AUTO_TAKE=false uv run uvicorn bluesword.app:app --host 127.0.0.1 --port 8000
```

注入故障示例：

```bash
BLUESWORD_SCENARIO=grasp_failure uv run uvicorn bluesword.app:app --host 127.0.0.1 --port 8000
```

“停止任务”会中断当前任务；“新对话”或关闭发起任务的 WebSocket 也会取消该连接的任务。观察者断线不会取消别人的任务。断线期间的前端请求不会排队在重连后执行。

## API

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 模式、连接状态、是否忙碌、是否需要复位 |
| `GET /api/items` | 展会物品目录 |
| `POST /api/tasks` | `{ "item_id": "oreo", "request_id": "unique-001" }` |
| `GET /api/tasks` | 最近任务 |
| `GET /api/tasks/{id}` | 状态、步骤、错误、持物状态 |
| `GET /api/tasks/{id}/events` | 有序事件和机器人接口请求记录 |
| `POST /api/tasks/{id}/cancel` | 取消任务并等待停止处理完成 |
| `POST /api/mock/take` | mock 接物信号 |
| `POST /api/mock/recover` | 重置模拟器并解除异常锁定 |
| `WS /ws` | 兼容现有前端事件协议 |

`request_id` 持久化去重；重复提交返回原任务，同一个 ID 换物品会返回冲突。一次只执行一个任务，忙碌时返回 409，不隐式排队。服务只支持**单 worker、单机器人控制实例**，不要启动多个进程控制同一机器人。

## 配置与代码入口

- `backend/bluesword/scene.json`：示例地图点、物品、别名；坐标单位米，角度弧度。文件中的点位和范围仅用于 mock。
- `backend/bluesword/workflow.py`：确定性的任务状态机。
- `backend/bluesword/ports.py`：应用自己的机器人/检测器接口，**不是官方 GDK API 签名**。
- `backend/bluesword/mock.py`：有状态的机器人替身及合成 RGB-D 数据。
- `backend/bluesword/gdk_v223/robot.py`：按 2.2.3 手册实现的版本适配器。
- `backend/bluesword/gdk_v223/rgbd.py`：原始 RGB-D 去畸变、深度配准与遮挡处理。
- `backend/bluesword/gdk_v223/fake.py`：模拟厂商 SDK，检验同一个适配器。
- `backend/bluesword/perception.py`：深度、内参与 TF 坐标计算。
- `backend/bluesword/intents.py`：展会规则意图路由。
- `backend/bluesword/app.py`：HTTP、WebSocket、前端静态文件服务。
- `backend/bluesword/cli.py`：执行完整任务的独立程序。
- [GDK 接入说明](docs/gdk-integration.md)：官方接口映射、手册差异、插件和实机配置要求。

主要环境变量：

| 变量 | 默认值 / 说明 |
| --- | --- |
| `BLUESWORD_ROBOT_MODE` | `mock`；Blender 联动为 `gdk_mock`；真实模式为 `gdk` |
| `BLUESWORD_SIMULATION_SPEED` | `1`；仅控制 GDK 模拟联动的动作播放速度 |
| `BLUESWORD_DRIVER_FACTORY` | 可选；真实模式默认 `bluesword.gdk_v223:create_driver` |
| `BLUESWORD_GDK_CONFIG` | 真实模式必填；现场标定 Profile JSON 路径 |
| `BLUESWORD_SCENE` | 自定义场景 JSON 路径 |
| `BLUESWORD_DB_PATH` | `data/tasks.sqlite3`，相对后端启动目录 |
| `BLUESWORD_SCENARIO` | `success`，mock 故障注入 |
| `BLUESWORD_MOCK_DELAY` | `0.35` 秒 / 接口调用 |
| `BLUESWORD_AUTO_TAKE` | `true` |
| `BLUESWORD_MOTION_TIMEOUT` | `20` 秒 |
| `BLUESWORD_HANDOVER_TIMEOUT` | `30` 秒 |
| `BLUESWORD_API_TOKEN` | 可选；HTTP Bearer token；WS 用 `?token=...` |
| `BLUESWORD_ALLOWED_ORIGINS` | JSON 数组，默认两个本地 Vite 地址；同源 WS 也允许 |

默认只监听本机。展台内网部署时按实际终端设置监听地址、允许来源和访问 token。
