# 兰剑智能 · 展会取物 Agent

React 前端 + Python/FastAPI 后端，负责语音对话、整单确认、任务下发和结果展示。每单最多两件，同种两件或两种各一件；支持 DeepSeek 主、千问备用对话、阿里云识别和播报，以及“你好，布鲁”唤醒。

现场使用机器人团队的 **VLM HTTP v1.2**。本地可以启动同协议的 HTTP 模拟机器人，验证发单、进度、识别照片和最终结果。**模拟测试已覆盖接口链路，真实机器人仍需现场联调。** GDK 和 Blender 保留为独立演示，不是现场 HTTP 对接的前置条件。

## 安装与启动

当前版本使用 **npm + uv**，分别按 `frontend/package-lock.json` 和 `backend/uv.lock` 安装。首次准备 Git、Node.js 24（当前前端要求 `^20.19.0` 或 `>=22.12.0`）、npm 和 uv，Python 3.12 由 uv 管理。SQLite 无需单独部署；模拟模式无需真实机器人或厂商 SDK。Ubuntu 下的 VLM 双服务和 Blender 演示脚本另外需要 Bash、curl、lsof。

Ubuntu 和 Windows 均支持原生安装、内部模拟和真实机器人联调。Windows 使用 PowerShell，见下方“Windows 原生安装与启动”；标为 `bash` 的命令用于 Ubuntu，标为 `powershell` 的命令用于 Windows。

### 交给现场负责人：配置向导

在**连接麦克风、运行网页和 Agent 的网关电脑**上，从 main 仓库根目录执行。机器人控制器只需运行机器人团队自己的 VLM v1.2 服务，填写后面的 `vlm.url` 和机器人内部格位，不需要在控制器重复安装网页或填写模型 Key。

先准备 Git、Node.js/npm 和 uv，再按系统依次执行：

```bash
# Ubuntu / macOS
bash scripts/setup.sh --voice
bash scripts/configure.sh
bash scripts/configure.sh --check
bash scripts/start.sh
```

```powershell
# Windows PowerShell
.\scripts\setup.cmd --voice
.\scripts\configure.cmd
.\scripts\configure.cmd --check
.\scripts\start.cmd
```

也可直接用 Python 3.12 运行 `python scripts/configure.py`。配置向导不启动服务、不连接机器人、不下发取物任务；`--check` 只读检查本机文件、配置和依赖。

| 需要准备 | 谁提供 / 如何填写 |
| --- | --- |
| 机器人发单地址 | 机器人负责人提供完整地址，例如 `http://192.168.1.20:8080/api/task/dispatch`，须支持 VLM HTTP v1.2 |
| 网关 IP 和端口 | 运行本仓库的电脑实际局域网 IPv4；端口默认 8000。不能把机器人 IP 填到网关这一栏 |
| DeepSeek API Key | 主聊天模型；输入不回显。缺 Key 时使用已配置的千问备用；两家均未配置时使用规则回复 |
| 阿里百炼 API Key | 北京地域、可调用当前 ASR 模型的 Key；专属工作空间 ID 按账号填写，无则留空。缺 Key 无法完成语音识别 |
| 工作人员口令 | 用于 `/operator` 工作台。首次留空会自动生成，保存在本机 `backend/.env`，不打印到交接单 |
| 麦克风 | 接在网关电脑上。向导显示设备列表，选输入设备编号；`-` 使用系统默认。首次启动按操作系统要求允许麦克风权限 |
| 物品 JSON | 负责人确认 `robotItem` 是机器人真实支持的名称/编码，并配置机器人内部格位；英语叫法填写 `nameEn`、`aliasesEn` |

向导默认设置**本地 sherpa 双语唤醒、VLM v1.2 整单取送**；播报沿用版本默认关闭。首次会复制一份 `config/booth-catalog.local.json`，不会修改仓库中的商品示例；已有目录不会覆盖。初始映射仍是示例编码，必须由机器人负责人核对，不代表机器人已经支持这些物品。

文件用途：

- `backend/.env`：本机 Key、机器人地址、口令、语音和目录路径。重跑向导时密钥输入留空即保留；原文件先备份到 `backend/.env.backup-*`，其他配置项保留。
- `config/site.local.json`：启动地址、端口和网关 IP。现场模式下启动脚本自动监听 `0.0.0.0`，模拟模式监听本机；可用 `start.sh/start.cmd --host ... --port ...` 临时覆盖。
- `output/site-setup.txt`：可交给机器人负责人的配置单，包含 `vlm.url`、回调地址和物品编码映射，不含 API Key 或工作人员口令。

上述本机配置、备份和交接单均已加入忽略规则。更换电脑后重新运行向导，避免沿用旧电脑的绝对路径、IP 和声卡编号。进程环境变量仍优先于 `.env`；`--check` 会提示存在覆盖的变量名，不显示密钥。已有网页 API token 会保留，需沿用 [网页访问控制配置](#配置与代码入口) 中的前端配置。

机器人负责人拿到交接单后，将 `vlm.url` 配为其中的 **`网关IP:端口`**，不追加回调路径，并按机器人自身方式重载配置。双方先按交接单检查 `/api/health` 和 `/health` 双向连通，再在网页确认一笔单件取物，核对 `progress`、识别照片以及 `finished/error`。`--check` 不验证 Key 有效性、系统麦克风权限或机器人网络；这些需要现场确认。协议字段与完整联调顺序见 [接口文档](docs/接口文档.md)。

### Ubuntu 安装与启动

先按 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/) 安装 uv，并确认普通终端可运行 `node`、`npm` 和 `uv`。首次安装可选择分步执行或使用快捷脚本，执行其中一种即可。已有环境按后文“已有环境与版本更新”处理。

**分步安装：** 从项目根目录逐条执行，任一步报错时先处理错误。

```bash
uv python install 3.12
npm ci --prefix frontend
npm run build --prefix frontend
uv sync --locked --project backend --python 3.12 --extra dev
if [ ! -f backend/.env ]; then cp backend/.env.example backend/.env; fi
chmod 600 backend/.env
```

以上依次准备 Python、安装前端依赖、构建网页、同步后端依赖（含开发测试依赖），最后在缺少配置文件时复制示例。已有 `backend/.env` 的内容会保留。

**快捷安装：** 如需一次完成上述步骤，在项目根目录执行：

```bash
bash scripts/setup.sh
```

脚本自动准备可用的 Python 3.12 并执行安装流程，任一步失败都会停止；不会拉取 Git 更新或覆盖已有配置。完整更新或环境修复时也可以使用，重复执行的行为见后文。

按下方“首次配置”填写并保存后，日常启动只需：

```bash
bash scripts/start.sh
```

访客网页：<http://127.0.0.1:8000>；工作人员工作台：<http://127.0.0.1:8000/operator>。按 `Ctrl+C` 停止。启动入口检查配置文件、前端构建产物和端口，固定在 `backend` 目录运行单 worker 服务；启动时不安装依赖、不构建网页。Ubuntu 和 Windows 的入口共用 `scripts/manage.py`，机器人模式由配置决定。

### 首次配置

编辑上述步骤生成的 `backend/.env`。Ubuntu 快捷脚本新建文件的权限为 `600`；已有文件按需执行 `chmod 600 backend/.env`。Windows 可用记事本编辑。配置文件请保存为 UTF-8。

编辑 `backend/.env`：文字 AI 填 `DEEPSEEK_API_KEY`；语音识别和播报填 `DASHSCOPE_API_KEY`；本地演示保留 `BLUESWORD_ROBOT_MODE=mock`。工作人员口令在同一文件中设置 `BLUESWORD_OPERATOR_TOKEN`，用于工作台登录、补货和人工核对。连接真机时再按下文填写模式、协议和发单地址。

旧版配置请按新示例逐项核对：旧 `BOOTH_*`、`OPENAI_*`、`TENCENT_*` 配置多数不再读取（工作人员口令 `BOOTH_OPERATOR_TOKEN` 仍兼容），不要直接沿用旧文件作为完整配置。

配置统一填写在 `backend/.env`，已有进程环境变量优先；修改后需重启服务。主模型默认 `deepseek-flash`，可用 `DEEPSEEK_MODEL` 调整；两家均无聊天 Key 时使用规则路由。配置项见 [backend/.env.example](backend/.env.example)，不要提交真实 `.env`。

### 聊天主备与现场等待

默认 `BLUESWORD_LLM_ROUTING=auto`：主服务超时、断流或返回错误时，后端接续当前模型步骤，改用 `qwen3.8-max`，保留思考展示。千问默认复用百炼语音 Key 及北京地域/工作空间；也可单独填写 `BLUESWORD_QWEN_API_KEY`、`BLUESWORD_QWEN_BASE_URL`。语音可用不代表旗舰聊天权限、额度已经开通，需检查百炼的“仅使用免费额度”设置。

配置后可运行 `bash scripts/configure.sh --check-ai`（Windows：`.\scripts\configure.cmd --check-ai`）。此命令实际调用两家已配置供应商，使用合成文字验证思考、工具和 JSON，不启动机器人或数据库，不上传聊天记录，会产生少量模型调用用量。原 `--check` 仍为离线检查。

默认接待上限 `BLUESWORD_LLM_RESPONSE_TIMEOUT=20` 秒，从开始处理文字请求，到显示可确认清单或明确失败提示；其中预留 3 秒页面呈现，主模型累计最多 `BLUESWORD_LLM_PRIMARY_BUDGET=6` 秒，备用使用剩余预算。`BLUESWORD_LLM_IDLE_TIMEOUT=4` 秒没有有效思考、正文或工具参数进展时提前切换，空保活不算进展。只读机器人状态查询占用这一预算；用户确认、语音收播和机器人实际执行另计。截止时可能给出失败提示，不保证一定生成清单；浏览器后台节流或网络中断也可能延后页面显示。

模型失败不重跑整轮、不重复下单；已经发出的机器人任务继续依据原编号和真实回调展示结果。流式失败尝试从页面移除，其未完成正文不进入播报队列。两家均失败时给出提示，不会自动用规则再次执行原请求。请求因 HTTP 400/422 被拒绝且接续仍失败时，清理被拒绝的对话上下文，保留最近已处理动作的结构化结果及任务去重状态，让后续正常请求可重新开始；待确认清单保持不变。其他故障仍保留已完成的工具事实。机器人通信遵守本文与接口文档中的超时及不确定接单规则。

主服务故障后默认冷却 `BLUESWORD_LLM_COOLDOWN=60` 秒，进行小型文字探测；连续两次成功后，新响应恢复主服务，当前响应不会被中途切回。探测失败逐步延长间隔，最多五倍冷却时间。仅用完主模型累计预算时，当前响应接续备用，后续新响应仍优先使用 DeepSeek；主模型预算或整段接待预算耗尽都不改变供应商共享健康状态，也不启动恢复探测。无有效输出、网络错误和供应商请求超时仍按故障处理。HTTP 400/422 可能由当前消息格式、参数或上下文引起，只影响当前响应，不改变其他会话的路由或禁用供应商；探测遇到这类错误也不会永久禁用。HTTP 401/403/404 按鉴权、权限或模型/端点配置错误处理，停止自动探测，处理后重启服务。工作人员登录 `/operator` 可查看当前路由、原因和恢复状态。必要时以 `BLUESWORD_LLM_ROUTING=deepseek` 或 `qwen` 锁定单一供应商排障；`BLUESWORD_LLM_FALLBACK_ENABLED=false` 禁用自动备用。

千问未配置、关闭或被禁用时，DeepSeek 的临时故障不会阻断之后的新请求；后续请求仍可尝试 DeepSeek。DeepSeek 自身被鉴权或配置错误禁用时仍需处理配置，不能绕过禁用状态调用。

千问保留思考后可能比主模型慢；供应商切换不保证话术和耗时完全一致，也不能解决展馆断网或语音服务故障。现场仍应验证普通对话、中英文、改单、故障切换与确认展示。

### Windows 原生安装与启动

安装 Windows 版 Git、Node.js 24 和 uv 后，重新打开 PowerShell，确认 `node`、`npm.cmd` 和 `uv` 可用。首次安装可选择分步执行或使用快捷脚本，执行其中一种即可。

**分步安装：** 从项目根目录逐条执行，任一步报错时先处理错误。

```powershell
uv python install 3.12
npm.cmd ci --prefix frontend
npm.cmd run build --prefix frontend
uv sync --locked --project backend --python 3.12 --extra dev
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
```

以上依次准备 Python、安装前端依赖、构建网页、同步后端依赖，最后在缺少配置文件时复制示例。已有配置会保留。

**快捷安装：** 如需一次完成上述步骤，在项目根目录执行：

```powershell
.\scripts\setup.cmd
```

分步安装全部成功，或快捷脚本显示“安装／更新完成”后，打开配置文件：

```powershell
notepad.exe backend/.env
```

按“首次配置”填写并保存。内部模拟体验时保留 `BLUESWORD_ROBOT_MODE=mock`；从项目根目录启动：

```powershell
.\scripts\start.cmd
```

访客网页：<http://127.0.0.1:8000>；工作人员工作台：<http://127.0.0.1:8000/operator>。按 `Ctrl+C` 停止。连接真实机器人时，先停止模拟服务，按下方“连接真实机器人”填写 `backend/.env`，仍在项目根目录运行：

```powershell
.\scripts\start.cmd --host 0.0.0.0
```

已安装好的环境日常只需运行 `start.cmd`；取得新版本后按下方“已有环境与版本更新”选择需要的步骤。这些 `.cmd` 入口可直接从 PowerShell 调用，无需修改 PowerShell 脚本执行策略。

现场需允许机器人通过 Windows 防火墙访问网关 8000 端口，并使用网关电脑实际局域网地址配置回调。自定义端口可加 `--port 4100`，机器人回调端口需同步修改。PowerShell 临时环境变量语法为 `$env:变量名="值"`，会优先于 `.env`；切换场景前用 `Remove-Item Env:变量名` 清除先前的临时覆盖。服务和日志在当前终端运行，关闭终端前先按 `Ctrl+C`；端口占用时脚本报错，不会自动结束其他进程。

停止后如果终端询问 `Terminate batch job (Y/N)?`，输入 `Y` 并回车结束脚本。

### 已有环境与版本更新

已经安装好且代码未变化时，直接使用 `start` 入口，无需再次执行 `setup`。更新部署版本前先停止服务，再取得目标代码版本，按实际变化处理：

| 更新内容 | 需要执行的步骤 |
| --- | --- |
| 只改文档 | 无需安装依赖或构建 |
| 只改前端代码，依赖未变 | 构建网页后启动服务，刷新浏览器 |
| 只改后端业务代码，依赖未变 | 重新启动服务 |
| `frontend/package.json` 或 `frontend/package-lock.json` 变化 | 安装前端依赖、构建网页，再启动服务 |
| `backend/pyproject.toml` 或 `backend/uv.lock` 变化 | 同步后端依赖，再启动服务 |
| 多部分同时变化 | 合并执行对应步骤 |
| 不确定变化范围，或需要完整更新、修复环境 | 运行 `setup`，成功后启动服务 |

对应的操作如下，均从项目根目录执行：

| 操作 | Ubuntu | Windows PowerShell |
| --- | --- | --- |
| 安装前端依赖 | `npm ci --prefix frontend` | `npm.cmd ci --prefix frontend` |
| 构建网页 | `npm run build --prefix frontend` | `npm.cmd run build --prefix frontend` |
| 同步后端依赖 | `uv sync --locked --project backend --python 3.12 --extra dev` | 同左 |
| 完整安装／更新 | `bash scripts/setup.sh` | `.\scripts\setup.cmd` |

`setup` 每次都会执行 `npm ci`，清理现有 `frontend/node_modules` 后按锁文件重新安装，并重新构建网页；它不只是检查是否已安装。npm 会利用缓存，但缓存不足时仍需下载。后端的 `uv sync --locked` 会检查并同步依赖，通常保留已满足要求的包，也会利用缓存。已有可用的 Python 3.12 通常会复用；Git、Node.js 和 uv 不会由脚本重新安装。因此，仅修改业务代码时可按上表执行，避免不必要的完整安装。

已有 `.env` 不会被覆盖，新配置项请对照 `.env.example` 补充；修改后重启服务。前端 `VITE_*` 配置变化时需重新构建网页。日常 `start` 入口不执行依赖安装或网页构建。

### 选择启动方式

以下命令从项目根目录执行。先按需要选一种，不要同时启动：

| 用途 | Ubuntu 命令 | Windows PowerShell 命令 | 配置与机器人 |
| --- | --- | --- | --- |
| 只体验页面、语音和确认流程 | `bash scripts/start.sh` | `.\scripts\start.cmd` | `.env` 设置 `BLUESWORD_ROBOT_MODE=mock` |
| 本地验证现场接口（Ubuntu 模拟联调） | `bash scripts/start-protocol-demo.sh --no-blender` | 暂无原生双服务启动脚本 | VLM v1.2，两个本地 HTTP 服务 |
| 连接真实机器人 | `bash scripts/start.sh --host 0.0.0.0` | `.\scripts\start.cmd --host 0.0.0.0` | 按下文配置 VLM v1.2 和真实机器人地址 |

前两种默认打开 <http://127.0.0.1:8000>。它们都不需要 Blender。`source "$HOME/.local/bin/env"` 只用于让终端找到 uv；已经可以运行 `uv --version` 时无需重复。

### 1. 本地页面和语音体验

在项目根目录执行：

```bash
BLUESWORD_ROBOT_MODE=mock bash scripts/start.sh
```

打开 <http://127.0.0.1:8000>，输入“帮我拿一包奥利奥”，按页面提示确认执行；默认自动模拟接物。API 文档在 <http://127.0.0.1:8000/docs>，健康检查为 `GET /health`。保持终端打开，按 `Ctrl+C` 停止。

### 2. VLM HTTP 模拟联调（Ubuntu，无需 Blender）

本节的一键双服务脚本用于 Ubuntu。确保 8000、8001 空闲，在项目根目录执行：

```bash
bash scripts/start-protocol-demo.sh --no-blender
# 不带参数也是相同的 VLM 模式：bash scripts/start-protocol-demo.sh
```

脚本按锁文件准备依赖、构建前端，并启动两个仅监听本机的服务：

- **8000 网关**：`lanjian_http` + `vlm`，打开 <http://127.0.0.1:8000> 使用完整前端。
- **8001 VLM 模拟机器人**：接收 `/api/task/dispatch`，提供 `/api/health`，按 v1.2 串行回调进度、识别图片、完成或故障；只有接口，没有网页。它不调用 GDK 或真实机器人。

两端使用同一份 `config/booth-catalog.example.json`。打开网页说“帮我拿两包乐事薯片”，确认后可看到八个进度节点和识别图片。每件会模拟两次识别，同一行及照片会更新。两种商品会按模拟器编码排序，以检查实际执行顺序变化。图片带有 **SIMULATED IMAGE** 标记，中文说明带“模拟”，不是现场照片。

也可指定另一份 JSON（绝对路径），两端会同步加载：

```bash
BLUESWORD_CATALOG_PATH=/absolute/path/catalog.json bash scripts/start-protocol-demo.sh --no-blender
```

停止时执行：

```bash
bash scripts/start-protocol-demo.sh --stop
```

服务在后台运行，关闭终端不会停止它们。日志在 `output/protocol-demo/gateway.log`、`robot.log`；启动失败会报错并回收本次进程。默认 VLM 演示使用内存数据库，**停止并重新启动后，模拟任务、库存和异常限制都会清空**，不会动现场数据库。脚本仅为本机演示关闭网页 API token；模型和语音仍按本地 Key 配置使用真实供应商。

需要检查异常时，先停止上一轮，再选一个场景启动：

```bash
VLM_DEMO_SCENARIO=partial bash scripts/start-protocol-demo.sh --no-blender
# 双件订单跳过第二件抓稳，完成后提示数量待核对；单件仍正常完成。
VLM_DEMO_SCENARIO=error bash scripts/start-protocol-demo.sh --no-blender
# 模拟抓取失败，回调 /api/task/error。
```

默认 `VLM_DEMO_SCENARIO=success`；`VLM_DEMO_DELAY` 可设置阶段间隔秒数，默认 `0.6`。模拟器验证的是网关与 VLM 的 HTTP 合同，不验证物理运动或真实机器人是否支持目录中的编码。

### 3. 连接真实机器人（VLM v1.2）

先停止本地模拟服务。在 `backend/.env` 设置（IP 替换成现场值）：

```dotenv
BLUESWORD_ROBOT_MODE=lanjian_http
BLUESWORD_ROBOT_PROTOCOL=vlm
BLUESWORD_ROBOT_DISPATCH_URL=http://<机器人IP>:8080/api/task/dispatch
# 留空使用 config/booth-catalog.example.json，也可指定绝对路径
BLUESWORD_CATALOG_PATH=
```

在项目根目录执行；Ubuntu 使用：

```bash
bash scripts/start.sh --host 0.0.0.0
```

Windows PowerShell 使用：

```powershell
.\scripts\start.cmd --host 0.0.0.0
```

机器人团队将 `vlm.url` 配为 **网关电脑的局域网IP:8000**，确保双向网络可达。网关电脑可打开 <http://127.0.0.1:8000>，按 `Ctrl+C` 停止服务。不要用 `mock` 或上述模拟联调脚本连接真机；模拟脚本会固定指向本机模拟机器人。现场口令、编码映射和回调说明见 [接口文档](docs/接口文档.md)。在其他电脑通过浏览器使用麦克风时还需 HTTPS。

#### 机器人团队需要填写与确认的内容

双方先交换以下信息，不要把示例值当成现场值：

| 由谁提供 / 设置 | 内容 | 填在哪里 |
| --- | --- | --- |
| 机器人团队提供 | 机器人局域网 IP、HTTP 端口（文档为 8080） | 网关 `.env` 的 `BLUESWORD_ROBOT_DISPATCH_URL=http://<机器人IP>:8080/api/task/dispatch` |
| 网关人员提供，机器人团队填写 | 网关电脑局域网 IP、监听端口（以上命令为 8000） | 机器人配置中的 `vlm.url`，填写 `<网关IP>:8000`，不追加 `/api/task/...` |
| 机器人团队确认 | 实际支持的物品名称 / 编码、对应唯一格位 | 网关 JSON 的 `robotItem`；`location` 仅记录日志，不替代机器人自己的格位配置 |
| 机器人团队确认 | 正在运行支持 VLM v1.2 的机器人服务，并已加载修改后的配置 | 机器人自身的启动 / 重载方式由机器人团队确认，网关仓库不提供其启动命令 |

`vlm.url` 指向网关，不是机器人自身；不要填 `127.0.0.1`、`localhost`、`0.0.0.0`。如果网关端口改成 4100，启动命令的 `--port` 与 `vlm.url` 同时改成 4100。机器人无需填写 DeepSeek 或阿里云 Key，也无需安装这套网页前端。

#### 双方按这个顺序联调

1. **先验证双向网络，不发单。** 网关电脑运行 `curl --noproxy '*' http://<机器人IP>:8080/api/health`，应收到 `success:true` 与布尔值 `busy`。机器人电脑运行 `curl --noproxy '*' http://<网关IP>:8000/health`，应能连接网关；若网关启用了 `BLUESWORD_API_TOKEN`，此健康查询需携带已配置的 Bearer token。双方按实际端口检查防火墙和网络。
2. **核对目录和现场状态。** 机器人团队确认 JSON 中本次试取商品的 `robotItem` 可识别、物品已摆好且机器人可执行；现场人员同意后，从网页确认一笔单件订单。不要先绕过网关向机器人另发测试单。
3. **检查编号与回报。** 网关下发时携带 `taskId`；机器人按该编号原样回报 `POST /api/task/progress`，识别阶段带检测信息与 JPEG，然后发送 `/api/task/finished` 或 `/api/task/error`。三个回调共用 `vlm.url` 的主机和端口，网关已提供路径，无需机器人另建页面。
4. **双方对照屏幕与实物。** 确认识别照片、五个单件节点及最终结果，再测试同种两件和两种各一件。双件正常为八个节点；机器人可重新排序或跳过失败步骤，缺少数量依据时网页会提示现场核对。
5. **排查缺失回报。** 机器人团队查看自己的 `vlm.access_log`（文档默认 `shelf_single_output/vlm_http.log`）及回报日志；网关人员查看启动终端和工作人员工作台的“机器人通信”。检查任务是否经 HTTP dispatch 下发、是否带 `taskId`、`vlm.url` 是否可达。进度返回 HTTP 2xx 即为接收成功，回调不要求额外 Bearer token；机器人主动回报失败时会重试，但仍可能继续运动。

接单、进度 `placed` 与最终 `finished` 是不同阶段。失败、超时或数量不明时先核对机器人和物品，不重复发单，也不把网页解除限制当成停止机器人。完整字段与数量处理见 [接口文档](docs/接口文档.md)。

### Blender 三维联动（Ubuntu）

本节的一键演示脚本用于 Ubuntu，需要图形桌面和中文字体（可安装 `fonts-noto-cjk`）。额外安装 Blender 4.5 LTS，并将 `BLENDER_BIN` 设置为实际可执行文件的绝对路径。完成上述前后端安装后，在项目根目录执行：

```bash
# 先设置 BLENDER_BIN；该文件应可以直接执行
"$BLENDER_BIN" --version
bash scripts/start-blender-demo.sh
```

首次运行会下载固定版本机器人资产并生成场景，需要访问 GitHub。打开 <http://127.0.0.1:8001>；递物时点击网页的 **我已接稳物品**。这是模拟指令和运动学可视化。

关闭 Blender 不会停止后台服务。默认端口的 PID 保存在 `output/blender/server-8001.pid`；先用 `ps -p "$(cat output/blender/server-8001.pid)" -o pid,args` 核对进程，确认属于本次演示后再用 `kill` 停止。自定义端口时替换文件名中的端口号；没有 PID 文件时，用 `lsof` 查明监听进程。更多操作见 [Blender 演示说明](docs/blender-demo.md)。

需要保留原先“两个 HTTP 服务 + Blender”的旧演示时，先按 [Blender 演示说明](docs/blender-demo.md) 准备模型和场景，并设置 `BLENDER_BIN`，再显式执行：

```bash
bash scripts/start-protocol-demo.sh --blender
# 关闭 Blender 后仍需停止后台服务：
bash scripts/start-protocol-demo.sh --stop
```

此选项仍使用圣涵原 `progress` 协议和 GDK 模拟目录，用于三维演示，不作为 VLM v1.2 的验收入口。原来不带参数会打开 Blender 的行为已改为默认启动 VLM 模拟联调。

### 分开开发

在项目根目录打开两个终端：

```bash
# 终端一
cd backend
BLUESWORD_ROBOT_MODE=mock uv run --locked uvicorn bluesword.app:app --host 127.0.0.1 --port 8000 --workers 1
```

```bash
# 终端二
cd frontend
npm run dev
```

打开 <http://localhost:5173>。Vite 将 `/ws`、`/api` 和 `/health` 转发到 8000 后端；两个终端分别按 `Ctrl+C` 停止。前端统一连接后端；本地使用后端 `mock` 模式。`VITE_AGENT_WS` 可指定 WebSocket 地址。

若端口被占用，用 `lsof -iTCP:8000 -sTCP:LISTEN`（替换对应端口）核对旧服务后再停止。若 `/health` 正常而首页 404，重新构建前端并重启后端。Blender 脚本复用已有后端时不会更新其配置。

## 大模型与技能

- Key 放在 `backend/.env`（已加入 `.gitignore`，权限 600）：`DEEPSEEK_API_KEY=...`，可选 `DEEPSEEK_MODEL=deepseek-flash`。真实环境变量优先。
- 系统提示词：`backend/bluesword/prompts/system.md`（人设、话术长度、物品规则、失败时如何表述）。物品清单由当前加载的目录自动注入（普通 mock 与现场 VLM 都默认使用 `config/booth-catalog.example.json`；GDK/Blender 的几何演示另用场景夹具）。
- 默认动作是 **整单取物 `fetch_items`**：最多两件，同种两件或两种各一件；一次确认、一次任务，不按用户或会话限次。
- 等待确认时可以继续说话或打字修改整单。模型结合当前清单和前后对话理解修改，统一校验后才更新；询问口味等问题保留原单，明确说明新增、移除及保留的物品。例如：先说“来一个饼干”，再说“再来一个薯片”，原确认卡片会更新为各一件，无需先取消。原单只有一种物品时，“再来一个”追加同种；原单有两种时会先询问想加哪种。“改成两包薯片”替换整单，“饼干不要了”从多种物品中去掉饼干；只剩一种时说“取消”取消整单。超量或含糊的修改会保留原清单并提示。修改后需重新确认，旧卡片的确认不再有效；已经确认下发的任务不能追加。
- 以下取货／卸货分拆技能仅在 `BLUESWORD_SPLIT_SKILLS=true` 时启用；现场接口未约定拆分，请保持关闭。技能目录：`backend/bluesword/skills.py`。技能 = 步骤的有序组合，步骤 = GDK 原语的组合：
  - **取货 `pick_item`**：导航 → 精确停靠 → 扫描 → 三维定位 → 横移对齐 → 抓取验证 → 抬起收臂（结束时持物）
  - **卸货 `unload_item`**：回递物点 → 递出等待接物 → 松爪收臂（要求手里有物品）
  - 另有 `look_shelf`（看一眼货架）、`get_robot_status`（查询状态）和 `check_inventory`（查询库存）。每次取物前，大模型会先查状态和库存再决定。
- 库存保存在 SQLite：发单前整单预留，明确拒单时退回；接单不等于完成，超时或故障不自动退回。重启保留库存与限制。`GET /api/inventory` 查看；工作人员核对实物补满后，带 `X-Operator-Token` 调用 `POST /api/inventory/reset?item_id=...`，恢复到初始数量（不带物品则全部补满）。补货不结束任务；旧任务拒单也不会重复增加已补满的库存。
- 大模型只能选技能和清单内的物品，不输出任何运动参数；技能结果如实回传，失败时不得声称完成。
- 事件协议新增：`reasoning_delta` / `reasoning_end`（思考链）、`skill`（技能调用及其 GDK 组合）、`task_step.gdk`。
- “停止”类指令不经过大模型。本地模拟可以取消；现场协议没有取消接口，只提示现场协助，继续等待机器人结果。

## 内部模拟 / GDK 演示的动作流程

以下动作由内部模拟或 GDK 驱动执行。现场 VLM 模式由机器人团队执行运动，网关只下发整单并接收 HTTP 回报。

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

每个动作都有完成反馈和超时。本地动作失败或取消会请求停止运动并保持夹爪；不会盲目返回或松爪。异常后需要复位，mock 复位按钮只对模拟器开放。任务及事件保存在 SQLite。普通 mock 自动使用带 `.mock` 后缀的数据库，例如 `backend/data/tasks.mock.sqlite3`；GDK 模拟使用 `.gdk_mock`，现场使用配置的原路径，防止模拟取物扣减现场库存。服务重启会把未完成任务标记为 `interrupted`，不会重新播放运动命令。

## 不需要机器人即可运行整套程序

```bash
cd backend

# 实际执行同一套任务编排，打印每个机器人接口调用，保存 JSONL 轨迹
uv run bluesword-demo --item aoliao --output ../output/mock-success.jsonl

# 用 GDK 2.2.3 请求对象、反馈轮询、RGB-D 解码跑完整适配器（仍无硬件）
uv run bluesword-gdk-demo --item oreo --output ../output/gdk-api-success.jsonl
uv run bluesword-gdk-demo --scenario handover_timeout --expect failed \
  --output ../output/gdk-api-handover-timeout.jsonl

# 验证转头和腰部搜索
uv run bluesword-demo --item playing_card_box --scenario search

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

本地模拟中，“停止任务”会中断当前任务；“新对话”、刷新或 WebSocket 断线只清理对话及未确认请求，不取消已经确认的任务，不退库存。重连恢复正在执行或需要核对的任务。断线期间的请求不会排队重发。

## API

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 模式、连接状态、是否忙碌、是否需要复位 |
| `GET /api/items` | 展会物品目录 |
| `POST /api/tasks` | `{ "items": [{ "item_id": "aoliao", "count": 2 }], "request_id": "unique-001" }`（兼容单件 `item_id`） |
| `GET /api/tasks` | 最近任务 |
| `GET /api/tasks/{id}` | 状态、步骤、错误、持物状态 |
| `GET /api/tasks/{id}/events` | 有序事件和机器人接口请求记录 |
| `POST /api/tasks/{id}/cancel` | 本地模拟取消；现场模式仅提示现场协助 |
| `POST /api/mock/take` | mock 接物信号 |
| `POST /api/mock/recover` | 重置模拟器并解除异常锁定 |
| `WS /ws` | 兼容现有前端事件协议 |

`request_id` 持久化去重；重复提交返回原任务，同一个 ID 更换物品、数量或技能会返回冲突。一次只执行一个任务，忙碌时返回 409，不隐式排队。服务只支持**单 worker、单机器人控制实例**，不要启动多个进程控制同一机器人。

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
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | Key 留空时使用规则路由；模型默认 `deepseek-flash` |
| `BLUESWORD_LLM_BASE_URL` | `https://api.deepseek.com`；自定义服务须兼容当前 Chat Completions、工具调用和 `reasoning_effort` 请求，不直接沿用旧 Responses 中转配置 |
| `BLUESWORD_LLM_TIMEOUT` | `90` 秒，模型请求超时；不是整轮多次模型调用的总时限 |
| `BLUESWORD_LLM_REASONING_EFFORT` / `BLUESWORD_LLM_REVIEW_EFFORT` | 常规思考 `high`，技能结果复盘 `max`；均可选 `low` / `high` / `max` |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_WORKSPACE_ID` | 阿里百炼北京地域 Key；工作空间可选，用于识别；需开通识别及播报模型，Key 留空仍可打字 |
| `BLUESWORD_SPEECH_MODEL` | `qwen-audio-3.1-asr-flash-message`，语音识别模型 |
| `BLUESWORD_TTS_MODEL` / `BLUESWORD_TTS_VOICE` | `qwen3-tts-flash` / `Cherry`，播报模型与音色 |
| `BLUESWORD_CONFIRM_TIMEOUT` | `180` 秒，等待用户确认；讨论、调整时重新计时；超时只取消尚未下发的请求 |
| `BLUESWORD_ROBOT_TIMEOUT` | `8` 秒，机器人健康查询及接单请求超时 |
| `BLUESWORD_REMOTE_TASK_TIMEOUT` | `0`，默认不限制机器人执行总时长，等待最终通知；可配置正数秒数，超时只要求核对，不停止机器人或退库存 |
| `BLUESWORD_ROBOT_PROTOCOL` | 代码默认 `v1`，示例显式设为 `vlm`；现场使用 `vlm` |
| `BLUESWORD_ROBOT_DISPATCH_URL` | 现场必填，完整发单地址，例如 `http://<机器人IP>:8080/api/task/dispatch` |
| `BLUESWORD_CATALOG_PATH` | 普通 mock 和 VLM 共用目录，留空使用项目内示例目录；自定义建议绝对路径，重启生效 |
| `BLUESWORD_SPLIT_SKILLS` | `false`；现场保持完整取送任务，拆分仅用于已确认支持的演示 |
| `BLUESWORD_OPERATOR_TOKEN` | 工作人员恢复接单和补货的口令；留空不开放操作，与网页访问 token 分开 |
| `BLUESWORD_ROBOT_MODE` | `mock`；Blender 联动为 `gdk_mock`；现场 HTTP 对接为 `lanjian_http`；直接 GDK 为 `gdk` |
| `BLUESWORD_SIMULATION_SPEED` | `1`；仅控制 GDK 模拟联动的动作播放速度 |
| `BLUESWORD_DRIVER_FACTORY` | 可选；真实模式默认 `bluesword.gdk_v223:create_driver` |
| `BLUESWORD_GDK_CONFIG` | 真实模式必填；现场标定 Profile JSON 路径 |
| `BLUESWORD_SCENE` | 自定义场景 JSON 路径 |
| `BLUESWORD_DB_PATH` | `data/tasks.sqlite3`，相对后端启动目录；模拟模式自动加 `.mock` / `.gdk_mock` 后缀，`:memory:` 不变 |
| `BLUESWORD_SHOW_CAMERA` | `true`；设为 `false` 隐藏网页相机画面、识别框及相机说明，保留任务进度与现场协助；重启后端、刷新网页生效 |
| `BLUESWORD_PROTOCOL_RETENTION_DAYS` | `30`；通信记录保留天数，可增加，重启生效 |
| `BLUESWORD_SCENARIO` | `success`，mock 故障注入 |
| `BLUESWORD_MOCK_DELAY` | `1` 秒 / 内部模拟接口调用 |
| `BLUESWORD_AUTO_TAKE` | `true` |
| `BLUESWORD_MOTION_TIMEOUT` | `20` 秒 |
| `BLUESWORD_HANDOVER_TIMEOUT` | `30` 秒 |
| `BLUESWORD_API_TOKEN` | 可选；HTTP Bearer token；WS 用 `?token=...` |
| `BLUESWORD_ALLOWED_ORIGINS` | JSON 数组，默认两个本地 Vite 地址；同源 WS 也允许 |

默认只监听本机。展台内网部署时按实际终端设置监听地址、允许来源和访问 token。

所有上述超时单位均为**秒**。进程环境中的同名变量优先于 `backend/.env`；`BLUESWORD_LLM_API_KEY`、`BLUESWORD_LLM_MODEL`、`BLUESWORD_SPEECH_API_KEY`、`BLUESWORD_SPEECH_WORKSPACE` 如有设置，优先于对应的 `DEEPSEEK_*` / `DASHSCOPE_*` 别名。避免同时配置两套同用途变量。

### 可选：网页访问 token

默认留空。启用时在 `backend/.env` 设置 `BLUESWORD_API_TOKEN`，并在本机 `frontend/.env.local` 设置同一 token 的 WebSocket 地址，例如：

```dotenv
VITE_AGENT_WS=ws://127.0.0.1:8000/ws?token=<经过URL编码的网页访问token>
```

地址必须能从使用网页的电脑访问；跨电脑访问请改为网关实际地址，HTTPS 页面使用 `wss://`。然后在项目根目录运行 `npm run build --prefix frontend`、重启后端并刷新页面；开发模式则重启 Vite。`VITE_*` 在构建时写入网页，之后只改后端配置不会更新它。网页从该地址读取 token，用于 WebSocket 和 HTTP API；仅设置后端 token 会导致默认网页无法连接。

此 token 会出现在浏览器及构建产物中，只用于受控部署的网页访问，不要复用供应商 Key 或工作人员口令；不要提交 `frontend/.env.local`。跨源访问时，将页面来源加入 `BLUESWORD_ALLOWED_ORIGINS` 的 JSON 数组。机器人 VLM 回调不使用此 token；本机协议模拟脚本会将网页 token 置空，测试时也应使用不含 token 的本机前端地址。

## 现场 HTTP 对接与人工核对

现场以机器人团队提供的 **VLM HTTP v1.2** 对接，设置 `BLUESWORD_ROBOT_PROTOCOL=vlm`，详见 [接口文档](docs/接口文档.md)。同时配置 `BLUESWORD_ROBOT_MODE=lanjian_http` 和 `BLUESWORD_ROBOT_DISPATCH_URL`。VLM 模式默认读取项目内的 `config/booth-catalog.example.json`，也可以用 `BLUESWORD_CATALOG_PATH` 指定另一份目录。

目录格式参考 [物品目录示例](config/booth-catalog.example.json)：`id` 为网关标识，`name` 为显示名称，`initialStock` 为初始及补满数量；可选 `robotItem` 填机器人实际支持的中文名或内部编码，未填则使用 `name`；`aliases` 填日常说法，如 `["奥利奥", "饼干"]`，供规则识别及确认期间的修改使用。当前示例沿用原目录的十种物品，`robotItem` 暂用原 `id`（如 `shupian`），现场仍需核对机器人是否支持这些编码。替换这份 JSON 后，等当前任务结束并完成必要的现场核对，再重启后端、刷新页面即可生效，不需要改代码或重新构建前端。它不是运行中热加载。同一商品保持 `id` 不变，库存会保留；新商品使用新 `id`。修改 `initialStock` 只改变新商品的初始库存和之后的补满数量，不自动给已有商品补货。旧目录的 `maxCount` 不改变每单最多两件的规则。VLM 的 `location` 只用于日志，可以不填；旧 v1 模式要求现场确认的位置。路径相对启动目录，建议用绝对路径。

VLM 发单携带任务编号，先查 `/api/health`，接收真实进度和带框的 JPEG 识别照片，复用现有“执行过程”和“布鲁的视野”。两件任务按实际回报顺序显示；重复进度不加行，新的识别尝试更新照片，跳号不补造动作。照片不是实时视频。只有最终完成通知才结束任务；双件任务如果缺少足够的数量依据，会请现场核对，避免把只送回一件说成两件全部送达。

兼容设置仍保留：`v1` 为旧完整任务接口（默认值，不携带编号），`progress` 为圣涵原提案模拟协议。两者均不是 VLM v1.2；现场需显式选择 `vlm`。本次只接收机器人团队已经提供的进度和照片，不修改机器人运动或增加机器人侧埋点。

没有完成通知时，不会把接单或展示动画当成完成；超时、回执不明确、故障或进程重启都保留限制。现场模式无远程停止接口，只有接口约定的进度和识别照片，没有连续持物或位置遥测。页面的“需要停下”只提示现场协助，不撤销机器人任务。

设置 `BLUESWORD_OPERATOR_TOKEN`（也兼容 `BOOTH_OPERATOR_TOKEN`）后，工作人员可展开现有任务区域中的“现场协助”，核对机器人和物品、填写口令，再恢复接单。它只解除网关限制，不会停止机器人，也不自动恢复库存。API 为 `POST /api/operator/resolve`，携带 `X-Operator-Token` 和 `{task_id,confirmation:"已核对机器人和物品"}`；未配置口令时不开放此操作。

## 最近对话与工作人员工作台

页面不会因闲置自动返回首页或清空对话。浏览器本地保存最多 20 段近期对话（含当前对话），回复生成中也持续保存已显示内容。服务重启后重新打开网页会回到首页，之前的对话保留在历史中；刷新网页仍恢复当前对话，已打开的页面断线重连也不会自动回首页。刷新后可查看已保存的文字；未说完的回复标注“这条回复还没说完。”。回看历史只读，不恢复旧确认按钮，也不影响当前机器人任务。记录仅保存在当前浏览器，不跨设备同步；刷新或断线重连后，模型重新开始理解需求，继续取物时请重新说完整需求。

工作人员直接访问 <http://127.0.0.1:8000/operator>（从其他电脑访问时替换为网关实际地址），输入在 `backend/.env` 配置的 `BLUESWORD_OPERATOR_TOKEN`，入口不放在访客页面。库存页显示目录全部物品及当前可用数量，可单项或全部恢复到目录的 `initialStock`，执行任务期间也可操作。库存恢复与机器人任务、异常解除独立；它不会取消任务或自动解除接单限制。

“机器人通信”页按日期、任务编号查询网关发出的健康查询、取物请求，以及机器人回传的进度、完成和错误通知，包含响应结果；重复、过期和无效回报也记录。记录存入 SQLite，默认保留 30 天，每页 100 条，可继续加载。下载 ZIP 包含所选范围的全部 CSV 表格和 JSONL 报文，不受网页页数限制；照片只留尺寸等元信息，密钥字段脱敏。普通内部 mock 没有 HTTP 机器人报文；需要验证通信时使用 VLM HTTP 模拟器。该记录反映网关与机器人的接口通信，不包含机器人内部运动日志。

普通 mock 与现场 VLM 使用同一份商品目录、别名、分类及初始库存，运行后的剩余数量各自存储。访客查询某类库存时只展示该类别，查询全部时覆盖整个目录，零库存仍显示为 0；工作人员库存页始终列出全部商品。在 `backend/.env` 中设置 `BLUESWORD_SHOW_CAMERA=false`，重启后端并刷新网页即可隐藏相机；改回 `true` 可恢复。此配置只隐藏网页视觉区域，不改变机器人识别、任务协议或日志收集，不需要维护第二个分支。

## 语音与验收

配置 `DASHSCOPE_API_KEY`，可选 `DASHSCOPE_WORKSPACE_ID`；识别默认沿用原 main 的 `qwen-audio-3.1-asr-flash-message`，播报默认 `qwen3-tts-flash` / `Cherry`。可通过 `BLUESWORD_SPEECH_MODEL`、`BLUESWORD_TTS_MODEL`、`BLUESWORD_TTS_VOICE` 调整。

### 本地常驻唤醒（展台推荐）

```bash
# 项目根目录，macOS / Ubuntu（Windows: python scripts/manage.py setup --voice）
bash scripts/setup.sh --voice
# 在 backend/.env 中填写阿里语音 Key 和 DeepSeek Key，然后设置：
# BLUESWORD_SPEECH_MODE=local
bash scripts/start.sh --port 8013
```

服务启动后，由**运行后端的电脑**自动打开麦克风，用 sherpa-onnx 在本地检测“你好，布鲁”或“Hello Blue”。网页打开即可看到“布鲁休眠中”，不用点击网页麦克风；首次运行仍需允许操作系统的麦克风权限。说“你好，布鲁，查询库存”或“Hello Blue, check the inventory”可连贯下达指令；唤醒后 20 秒内可继续对话，空闲后自动回到本地唤醒。启动脚本运行期间保持监听；关机、休眠或停止进程后不会监听，这次不安装系统登录启动项。

```text
本机麦克风 → sherpa-onnx 唤醒 → 语音分段 → 千问 ASR
  → 同一 Agent 会话 / DeepSeek → 取物确认 → 原有机器人任务接口
  → 千问 TTS → 本机音箱
网页独立会话 ← WebSocket：唤醒、识别文字、回复、确认单、语音状态
```

- 待机音频只在内存中做本地检测，不上传。命中唤醒后上传该段语音（含最多 3 秒前置缓存，避免丢失连说指令）；单段上限 25 秒，静音约 0.85 秒结束。采用可调 RMS 分段，展会嘈杂环境仍需调参和现场验证。
- 后端只保留一个本地麦克风；Agent 会话与 main 保持一致，每个网页连接独立创建。刷新或断开会取消该页尚未确认的请求，新连接不恢复旧 Agent 上下文和确认单；已下发机器人任务继续执行。页面历史文字仍可恢复。多开时语音跟随最近连接的页面，点击另一页面的布鲁或麦克风可切换；同一句语音只进入一个会话。没有网页连接时保留音频设备，不向云端提交音频。
- 点击左下角布鲁、输入框麦克风或上方“关闭语音”可切换到休眠：停止当前识别和播报，布鲁闭眼，只在本地检测唤醒词；刷新后从待唤醒开始新会话。再点一次或说“你好，布鲁 / Hello Blue”即可唤醒。聊天记录和待确认清单保留，已提交的 Agent 对话及机器人任务继续执行；休眠期间的回复只显示文字。
- 网页通过语音状态中的 `session_id` 控制所属会话。`POST /api/speech/control` 的 `toggle`、`sleep`、`listen` 分别切换、休眠和唤醒。`pause` 仍可完全关闭本机麦克风，此时唤醒词无效；`resume` 重新打开麦克风等待唤醒。后端重启按配置自动监听。
- 默认关闭语音播报，回复只显示文字，中英文唤醒和语音输入保留；无需等待朗读结束即可继续对话。网页刷新或后端重启均不会自动开启播报。如有需要可手动点击“播报关”开启，它只控制朗读，不关闭收音。启用播报后，合成、播放及回声消退期间暂停检测音频；Agent 思考／执行期间仍保持原有收音限制。点击布鲁或麦克风可休眠，但不会中断正在执行的任务。
- 语音文字复用网页输入的订单修改、确认、取消逻辑，不直接下发机器人动作。模型文件、系统权限或音频设备异常会显示在语音状态栏，文字聊天仍可用；检查后点击布鲁或麦克风。
- 远程访问网页不会使用远程电脑的麦克风／音箱。本地模式仍需联网调用 ASR、DeepSeek、TTS；只有唤醒离线。采用单进程运行，勿使用多个 Uvicorn worker 同时打开麦克风。

音频设备使用系统默认值，可在后端目录运行 `.venv/bin/python -m sounddevice` 查看设备，再设置 `BLUESWORD_VOICE_INPUT_DEVICE` 和 `BLUESWORD_VOICE_OUTPUT_DEVICE`（Windows 用 `.venv\Scripts\python.exe`）。Ubuntu 需有可用的 PortAudio，例如 `sudo apt install libportaudio2`。系统权限由启动后端的应用持有，在 macOS 的“隐私与安全性 → 麦克风”中允许对应终端／应用。

`BLUESWORD_WAKE_THRESHOLD` 控制命中阈值（默认 0.25，越大越难唤醒）；`BLUESWORD_VOICE_RMS`、`BLUESWORD_VOICE_SILENCE`、`BLUESWORD_VOICE_IDLE` 调节音量门限、句尾静音和续聊窗口。模型默认位于 `backend/models/`（不提交），下载脚本校验 SHA-256；使用官方 [中英双语 KWS 模型](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)，关键词使用对应的 `phone+ppinyin` 编码。Python 包与原生 core 同版本锁定，避免平台依赖遗漏。

### 中英双语接待

中文和英语共用同一个会话、库存和机器人接口。说“你好，布鲁”或“Hello Blue”唤醒，也可连着说请求，例如 `Hello Blue, could you bring me a bottle of water?`。英语请求会得到英语文字回复和英语确认卡；中文请求继续使用中文。播报默认关闭，手动开启后按回复语言朗读。纯唤醒后会简短回应“我在，请说”或 “I'm listening. How can I help?”。ASR 使用同一个多语言模型，TTS 根据回复选择 Chinese / English，混合文本使用 Auto。

等待确认时可以说 `Yes, please` / `Confirm` / `Go ahead`，或 `No, thanks` / `Cancel`；也可以先说 `Add one pack of chips`、`Change it to two bottles of water`、`Remove chips`、`Make it two`。改单后须重新确认，旧确认按钮不生效。`Yes, add chips` 只修改清单，不会直接批准；超过两件或含未知物品时保留原清单并提示。语音确认／取消仅在收音窗口有效，播报和执行中仍需使用页面或请现场工作人员协助。

示例物品清单已增加 `nameEn`（英文展示名）和 `aliasesEn`（英语别称）。使用自己的 `BLUESWORD_CATALOG_PATH` 时也请补充这两个可选字段，例如 `"nameEn":"bottled water", "aliasesEn":["water","mineral water","bottled water"]`。它们不改变原有 `id`、`robotItem`、位置或机器人报文；缺少英文展示名时确认卡会保留原物品名。场景 JSON 对应字段为 `name_en` / `aliases_en`。

从仅中文唤醒版本升级后，在项目根目录运行 `python3 scripts/setup-voice.py` 更新关键词文件，然后构建前端并重启后端。双语接待覆盖语音对话、确认卡和唤醒提示；任务详情及工作人员界面仍以中文展示。

### 原网页语音模式

默认 `BLUESWORD_SPEECH_MODE=browser` 使用网页麦克风。允许权限后尝试自动开启；浏览器限制自动开启时点一下麦克风。先将语音送千问识别，再判断文字是否以“你好，布鲁 / 布鲁 / Hello Blue”开头，**不是离线唤醒**。空闲 60 秒后回到待唤醒，思考或等待确认时保持对话。点击停止会关闭网页麦克风，最后一句仍继续处理，需点击重新开启。此模式也默认关闭播报；如手动开启播报，停止收音不会停止播报，说话可打断输出。其他电脑访问需要 HTTPS，localhost 可直接测试。

两种模式都不把音频写入数据库，也不把 Key 发给前端。识别／播报故障日志只记录异常类别，不记录音频、识别内容或 Key。配置保存在已忽略的 `backend/.env`，不要提交真实凭据。

```bash
npm run build --prefix frontend
node --test frontend/tests/*.test.mjs
(cd backend && uv run --locked --extra dev --extra voice pytest -q && uv run --locked --extra dev --extra voice ruff check bluesword tests)
```

浏览器模式手动验收按耳机场景进行（播报相关检查须先手动开启播报）：允许麦克风、叫“布鲁”并连着说需求、播报时插话、说完立即点停止、停止后确认尾句仍提交且播报继续、再次开启收音。受控音源测试验证的是程序流程，不代替真人耳机效果。机器人现场联调另需核对物品编码、机器人地址及网关回调地址。

安装 voice 扩展并配置 Key 后，可在后端目录运行 `.venv/bin/python scripts/smoke_voice.py`：自动生成“你好，布鲁，查询库存”语音，实际经过 sherpa 唤醒、千问 ASR、DeepSeek 库存工具、千问 TTS。这项测试会产生少量模型调用费用；不开麦克风、不播放音频，使用独立内存数据库与 mock 机器人，不会影响正在演示的会话。可加 `--language en --fetch` 验证英语唤醒、取物请求、语音确认、隔离 mock 取物及英文播报；不加 `--fetch` 时只查库存。合成语音测试通过不代表真人、远场或展馆噪声下的唤醒率已验收。

浏览器回归使用 `frontend/tests/restart.browser.cjs`、`frontend/tests/progress.browser.cjs`、`frontend/tests/reception.browser.cjs`、`frontend/tests/order.browser.cjs`、`frontend/tests/speech.browser.cjs`、`frontend/tests/speech-home.browser.cjs` 和 `frontend/tests/order-revision.browser.cjs`。先构建前端，在单独终端启动隔离模拟服务，再使用已安装的 `playwright-cli`：

```bash
BLUESWORD_ROBOT_MODE=mock BLUESWORD_DB_PATH=:memory: BLUESWORD_LLM_API_KEY= BLUESWORD_SPEECH_API_KEY= BLUESWORD_API_TOKEN= BLUESWORD_OPERATOR_TOKEN=acceptance-only BLUESWORD_CONFIRM_TIMEOUT=180 BLUESWORD_REMOTE_TASK_TIMEOUT=0 BLUESWORD_MOCK_DELAY=0.02 uv run --locked --project backend uvicorn bluesword.app:app --host 127.0.0.1 --port 8012
# 另一终端
playwright-cli -s=acceptance open http://127.0.0.1:8012
playwright-cli -s=acceptance run-code --filename=frontend/tests/restart.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/progress.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/reception.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/order.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/speech.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/speech-home.browser.cjs
playwright-cli -s=acceptance run-code --filename=frontend/tests/order-revision.browser.cjs
playwright-cli -s=acceptance close
```

这些浏览器检查使用受控音源与模拟语音响应；语音供应商的实际识别和播报需单独验证，真人耳机效果由用户手动验收。
