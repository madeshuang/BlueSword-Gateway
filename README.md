# BlueSword-Gateway

机器人团队通过 Git 获取代码后，请先阅读[机器人团队联调指南](docs/机器人团队联调指南.md)，按其中的安装、构建、AI 配置和真实机器人对接步骤运行。双方报文以[接口文档](docs/接口文档.md)为准；[人工测试指南](docs/manual-interface-test.md)用于本机模拟自测。

展会机器人系统的用户侧网关。用户选择物品并确认数量，后端向机器人发送抓取指令；机器人主动通知完成或不可恢复故障。当前支持本地演示和 HTTP 开发模式；DeepSeek 已完成 3 条真实单轮样本及 7 项真实对话回归；OpenAI 中转首轮 2/3 通过，随后正向样本单次补验成功；官方 OpenAI 直连、现场配置和机器人联调仍未验证。

## 环境与安装

需要 Node.js >=24.13.0、pnpm 11.25.0。SQLite 使用 Node 内置 `node:sqlite`，该版本运行时会提示实验性功能警告。

在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
```

workspace 只有根工程、`apps/api`、`apps/web`、`packages/contracts`。包名使用 `@bluesword/*`，直接依赖版本在 package.json 中固定，安装时使用现有锁文件。

## 本地演示

日常操作以 [初版交接中的 PowerShell 快速入口](docs/initial-demo-handoff.md#windows-powershell日常启动入口) 为准，那里集中说明端口检查、DeepSeek 启动、停止、备用中转切换和工作人员凭据。

```powershell
pnpm dev:demo
```

打开 http://127.0.0.1:5173 。API 默认使用 4100 端口，独立机器人模拟对端使用 4200 端口。演示采用 `.data/booth-demo.sqlite` 和示例目录；不连接现场机器人。三个进程由 concurrently 启动，结束时按 Ctrl+C。

模拟器默认受理后约 2.5 秒主动发完成通知。可向本地模拟器的 `POST /simulation/scenario` 发送 `{"scenario":"error"}`、`rejected`、`silent` 或 `success`，切换后续任务场景。`silent` 会一直保留模拟器占用，需要结束并重启模拟器；这不代表正式机器人支持场景切换。模拟器只监听回环地址。回调地址、监听端口可分别用 `SIMULATOR_CALLBACK_URL`、`SIMULATOR_PORT` 调整；配套 `dev:demo` 入口固定连接 4200，默认回调 API 4100，演示应使用默认端口。

AI 没有配置密钥时不能对话，但仍可手动选择物品。界面保留现有配色、排版、产品 SVG 插画和 CSS 机器人造型。等待 AI 时改选、调整数量或确认发单，旧建议不会覆盖新的选择。“开始新体验”清理访客对话、选品和已结束任务的展示，但保留系统任务；提交或请求待核对时不能使用该入口。空闲新页面不会显示上一单，活动任务及告警仍按实际状态显示，访客主界面不展示历史订单。物品目录始终默认展开，仍可手动折叠；桌面任务卡位于右上方，右栏依次显示全宽目录和确认区域。对话卡保持稳定高度，消息列表独立滚动；任务受理、完成及异常按已确认状态显示固定对话通知，不额外调用 AI。

## HTTP 开发模式与必要配置

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# 编辑本地 .env 后：
pnpm dev
```

`pnpm dev:api` 只启动 API，`pnpm start` 使用同一正式入口启动后端。以上命令从项目根目录执行，自动读取根目录 `.env`。密钥只放在本地 `.env` 或服务端进程环境中，不提交 Git、不传给前端。

| 变量 | 用途与默认值 |
| --- | --- |
| `PORT`、`BOOTH_HOST` | API 监听端口与地址，默认 `4100`、`127.0.0.1`。供远端回调时需明确配置网络监听及访问条件。 |
| `BOOTH_ROBOT_MODE` | 默认 `http`；演示入口设置为 `simulator`。 |
| `ROBOT_DISPATCH_URL` | 机器人完整 HTTP(S) 下发 URL；必须无 URL 内嵌凭据。示例留空。 |
| `ROBOT_TIMEOUT_MS` | 等待受理响应的超时，默认 8000 毫秒。结果不明不自动重发。 |
| `BOOTH_CATALOG_PATH` | 目录 JSON 路径，默认 `config/booth-catalog.example.json`。相对路径从项目根目录解析。 |
| `BOOTH_CATALOG_CONFIRMED` | HTTP 模式只有为 `true` 才允许发单。真实物品、位置和数量上限核对后才能设置。 |
| `BOOTH_DB_PATH` | 默认 `.data/booth.sqlite`；演示使用独立数据库。 |
| `BOOTH_AI_PROVIDER` | 后端供应商选择：`openai`（默认）或 `deepseek`，重启生效。只使用所选供应商，不自动故障切换。 |
| `OPENAI_BASE_URL` | 默认 `https://api.openai.com/v1`；仅追加 `/responses`。使用中转时必须先核对 API 基址与协议；不影响 DeepSeek。 |
| `BOOTH_TASK_REMINDER_MS` | 等待提醒阈值，默认 120000 毫秒；时间到了仍保持占用，不自动完成、解锁或重发。 |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | OpenAI 服务端 API Key 与模型，默认 `gpt-4.1-mini`，使用 Responses 结构化输出。 |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` | DeepSeek 服务端 API Key 与模型，默认 `deepseek-flash`，使用 Chat Completions JSON 输出，并关闭思考模式。 |
| `OPENAI_TIMEOUT_MS`、`DEEPSEEK_TIMEOUT_MS` | 各自单次调用预算，默认 20000 毫秒，包含响应正文读取。 |
| `BOOTH_OPERATOR_TOKEN` | 工作人员解除本地异常占用及补货后重置库存所需凭据；示例留空。 |
| `VITE_API_TARGET` | Vite 开发服务器代理地址，默认 `http://127.0.0.1:4100`；自定义 API 端口时需在 Vite 进程环境中设置。 |

现场目录沿用示例文件的字段结构，要求物品 ID 唯一，`maxCount` 为 1–100 的整数，新增 `initialStock` 为 0–100000 的整数，色值为六位十六进制。`maxCount` 是每单上限，`initialStock` 是首次建立库存及补货重置后的数量。剩余库存保存在 SQLite，重启服务和修改配置都不会自动补满已有物品；聊天、手选与后台提交均受当前可用数量限制。`art` 使用现有四种插画类别；可选 `imageUrl` 只引用 `/products/` 下的本地文件，将实际照片放入 `apps/web/public/products/` 后使用。当前没有现场照片或已核对的真实目录。

工作人员可直接访问 `/#operations`，日常访客页面不显示固定工作人员入口。故障和受理不明时，必须现场核对机器人停止及物品情况，再输入凭据并勾选确认，才能解除我方占用。这不会向机器人发送停止或取消指令，也不会恢复库存。实际补货后，在同一入口的“补货重置”区域选择物品、核对补满目标并勾选补货确认，再重置所选物品数量；有未结束任务或告警时不能重置。完整数量规则和操作见[库存说明](docs/booth-inventory.md)。执行中任务不会按时间自动结束。超过提醒阈值时可从任务提示进入工作人员核对；执行中仍不能从该入口取消或解除，需联系机器人负责人。缺少跨任务关联标识时，迟到回调仍可能误关联下一单；当前尚未解决该风险，见 [开发计划 P1](docs/development-plan.md)。

## 验证命令

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm test:interfaces
pnpm test:ai
pnpm test:browser
pnpm test:inventory
```

`build` 包含严格类型检查及前端生产构建，输出位于 `apps/web/dist`；它不生成后端编译包。`pnpm serve` 使用 tsx 运行后端，并在同一端口提供构建网页与 API。`pnpm --filter @bluesword/web preview` 仅供查看前端构建。

## 交付与人工接口测试

`pnpm delivery` 先构建网页，再在被忽略的 `.tmp/delivery/` 下生成源码和构建网页的 ZIP。包内只保留必要运行资料、锁文件和人工工具，不携带本机密钥、数据库、依赖安装目录或临时材料。包内 README 使用[现场交付说明](docs/delivery-readme.md)，首次仍需 `pnpm install --frozen-lockfile`，然后填写 `.env`、运行 `pnpm serve`。打包命令在 Windows 作者机运行。

人工测试使用两个独立终端运行 `pnpm manual:robot` 和 `pnpm manual:gateway`，分别打开4201人工工具和4101网页。人工模式覆盖正式机器人地址及数据库，受理、拒绝、完成和故障均由人点击；工具显示原始 HTTP 请求/响应并可下载记录。具体步骤和待填写的人工记录见[人工测试指南](docs/manual-interface-test.md)。`pnpm test:delivery` 自动解压、安装及检查这些行为，不能代替人的逐项操作和真实机器人联调。

本次包的实际安装、接口结果、笔记本备选运行检查及未验证范围见[第四项验证记录](docs/delivery-validation-2026-10-15.md)。

当前后端与验证命令共 76 项检查通过，包括 12 项库存 HTTP 检查和 2 项交付/人工对端 HTTP 检查；`pnpm test:inventory` 还运行库存浏览器检查，结果与范围见[库存验证记录](docs/booth-inventory.md)。既有 HTTP 测试保留 P1 跨单迟到通知限制的复现；该检查通过不代表风险已修复。这些测试不代表真实模型或现场机器人验证。浏览器脚本使用本地机器人对端和 AI 替身，不调用真实模型；Windows 默认使用已安装的 Microsoft Edge，可通过 `PLAYWRIGHT_CHANNEL` 改为其他 Playwright 支持的已安装浏览器。其他系统需准备 Playwright Chromium。

## 真实模型小样本验证

本地配置好所需 API Key 后，显式执行：

```powershell
pnpm verify:ai --provider both
# 只准备好一家时，可指定 openai 或 deepseek
```

命令先检查所有指定供应商的凭证，再依次向每家发送 3 条固定文本：明确单物品/数量、数量待澄清和目录外物品。只调用我方聊天 HTTP 接口，不发机器人任务，使用内存数据库；真实请求会产生 API 费用。配置错误或认证失败会停止剩余样本，命令不重试。结果保存在被忽略的 `.tmp/ai-verification/`，包含配置模型、上游返回模型与用量（如提供）、日期、我方及上游 HTTP 状态、错误类别、耗时、结构校验、selection 判定和零任务核对，不保存密钥、请求头或完整对话。这是小样本检查，不能证明多轮对话或现场稳定性。DeepSeek 于 2026-10-11 的 3 条样本全部通过且任务数为零；OpenAI 中转首轮为 2/3 通过，后续正向样本补验成功，官方直连仍未执行，详见 [补验与交付记录](docs/development-progress-handoff-2026-10-11.md)。

中转验证使用独立文件 `.env.relay`，采用其中的 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和中转专用 `OPENAI_API_KEY`。本机该文件还包含 DeepSeek 字段，因此不能仅凭文件名认为供应商环境已经隔离；日常中转启动按初版交接说明加载后移除 DeepSeek 字段。确认该文件被 Git 忽略，并将本地文件权限限制为当前用户及系统账户。后续获准执行真实验证时使用：

```powershell
pnpm verify:relay
# 获准只补验正向样本时，每次只调用一次：
pnpm verify:relay --sample positive
```

样本选项为 `positive`（明确单物品和数量）、`clarify`（数量待澄清）和 `outside`（目录外物品）；不指定时仍运行三条。`verify:ai` 同样支持 `--sample`，指定 `both` 时会对两家各调用一次，使用前注意授权调用范围。

该入口清除子进程继承的供应商变量，核对文件配置实际生效后，执行原有 OpenAI 的最多 3 条固定样本，不加载 `.env`。直接运行 `node --env-file=.env.relay ...` 会受到已存在的进程变量覆盖，不能仅凭命令形式保证使用文件中的值。不要将官方 OpenAI Key 放入中转配置。本轮正向补验仅执行一次真实调用；再次运行仍会产生费用。上游返回的模型标识与用量不是模型身份或账单的独立核实结果。

界面会提前说明机器人地址缺失或现场目录尚未确认，并禁用新发单。内部 `dispatch.ready` 只表示配置满足准入条件，不证明机器人连通或任务可执行；已有待核对请求仍可核对。可控测试通过根目录 Vitest 配置禁用环境文件加载，不从本地 `.env` 读取供应商凭据。

密钥类型、本地保护方式、余额要求和已验证范围见 [P5 阶段记录](docs/development-progress-p5-2026-10-10.md)。

## 文档入口

- [接口文档](docs/接口文档.md)：当前主要实现依据；原文中列出的待确认项仍然有效。
- [项目背景与需求说明](docs/项目背景与需求说明.md)：第一版范围、重要决策、历史方案状态与原始资料索引。
- [开发说明](docs/development-guide.md)：内部实现边界与运行约束。
- [开发计划](docs/development-plan.md)：未解决风险、验收条件与下一阶段顺序。
- [P1/P2/P3 阶段记录](docs/development-progress-2026-10-10.md)：本次协议建议审查、开发结果和实际验证范围；开发前基线记录单独保留。
- [P5 阶段记录](docs/development-progress-p5-2026-10-10.md)：第二版回调建议复核、双供应商配置与本次验证范围。
- [10 月 11 日阶段记录](docs/development-progress-2026-10-11.md)：DeepSeek 真实结果、OpenAI 与中转复核、P6/P7 和本次验证范围。
- [中转与 P9 记录](docs/development-progress-relay-2026-10-11.md)：本轮中转 3 次尝试、配置隔离、诊断字段与现场配置提示。
- [初版演示交接](docs/initial-demo-handoff.md)：启动检查、供应商切换、真实联调决策清单及非阻塞语音评估。
- [补验与交付记录](docs/development-progress-handoff-2026-10-11.md)：单样本 TDD、本轮一次真实正向成功与演示启动实测。
- [AGENTS.md](AGENTS.md)：长期开发规则、文档职责与 Git 操作边界。
- [Linear 操作草案](.scratch/booth/linear-write-draft.md)：供用户手动核对和创建的临时草案；被 Git 忽略，不属于正式 Issue 系统。
