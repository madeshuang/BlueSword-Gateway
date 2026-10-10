# BlueSword-Gateway

展会机器人系统的用户侧网关。用户选择物品并确认数量，后端向机器人发送抓取指令；机器人主动通知完成或不可恢复故障。当前工程是从冻结原型选择性迁移并重新验证的本地基线，真实模型调用、现场配置和机器人联调仍未验证。

## 环境与安装

需要 Node.js >=24.13.0、pnpm 11.25.0。本次验证使用 Node.js 24.13.1。SQLite 使用 Node 内置 `node:sqlite`，该版本运行时会提示实验性功能警告。

在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
```

workspace 只有根工程、`apps/api`、`apps/web`、`packages/contracts`。包名仍使用 `@bluesword/*`，以减少无意义的导入变更。依赖沿用归档锁文件已解析的版本，并在 package.json 中固定直接依赖版本。

## 本地演示

```powershell
pnpm dev:demo
```

打开 http://127.0.0.1:5173 。API 默认使用 4100 端口，独立机器人模拟对端使用 4200 端口。演示采用 `.data/booth-demo.sqlite` 和示例目录；不连接现场机器人。三个进程由 concurrently 启动，结束时按 Ctrl+C。

模拟器默认受理后约 2.5 秒主动发完成通知。可向本地模拟器的 `POST /simulation/scenario` 发送 `{"scenario":"error"}`、`rejected`、`silent` 或 `success`，切换后续任务场景。`silent` 会一直保留模拟器占用，需要结束并重启模拟器；这不代表正式机器人支持场景切换。模拟器只监听回环地址。回调地址、监听端口可分别用 `SIMULATOR_CALLBACK_URL`、`SIMULATOR_PORT` 调整；配套 `dev:demo` 入口固定连接 4200，默认回调 API 4100，演示应使用默认端口。

AI 没有配置密钥时不能对话，但仍可手动选择物品。界面保留现有配色、排版、产品 SVG 插画和 CSS 机器人造型；对话式布局留待下一阶段。

## HTTP 开发模式与必要配置

```powershell
Copy-Item .env.example .env
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
| `OPENAI_API_KEY`、`OPENAI_MODEL` | 服务端 GPT 配置，默认模型 `gpt-4.1-mini`；这是复用原配置，尚未完成真实调用验证。 |
| `OPENAI_TIMEOUT_MS` | AI 调用超时，默认 20000 毫秒。 |
| `BOOTH_OPERATOR_TOKEN` | 工作人员解除本地异常占用所需凭据；示例留空。 |
| `VITE_API_TARGET` | Vite 开发服务器代理地址，默认 `http://127.0.0.1:4100`；自定义 API 端口时需在 Vite 进程环境中设置。 |

现场目录沿用示例文件的字段结构，要求物品 ID 唯一，`maxCount` 为 1–100 的整数，色值为六位十六进制。`art` 使用现有四种插画类别；可选 `imageUrl` 只引用 `/products/` 下的本地文件，将实际照片放入 `apps/web/public/products/` 后使用。当前没有现场照片或已核对的真实目录。

工作人员入口位于页面底部，或访问 `/#operations`。故障和受理不明时，必须现场核对机器人停止及物品情况，再输入凭据并勾选确认，才能解除我方占用。这不会向机器人发送停止或取消指令。执行中任务不会按时间自动结束。缺少跨任务关联标识时，迟到回调仍可能误关联下一单；本基线没有解决该风险，见后续计划。

## 验证命令

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm test:interfaces
pnpm test:ai
pnpm test:browser
```

`build` 包含严格类型检查及前端生产构建，输出位于 `apps/web/dist`；它不生成后端编译包。`pnpm --filter @bluesword/web preview` 仅供查看前端构建，生产部署与 API 路由安排留待后续处理。

迁移测试共有 16 项：10 项正式接口与任务事实，5 项可控 OpenAI 行为，1 项目录校验。没有迁移旧 Mock 的 37 项测试。浏览器脚本使用本地机器人对端和 AI 替身，不调用真实模型；Windows 默认使用已安装的 Microsoft Edge，可通过 `PLAYWRIGHT_CHANNEL` 改为其他 Playwright 支持的已安装浏览器。其他系统需准备 Playwright Chromium。

## 文档入口

- `docs/接口文档.md`：原样保留的主要实现依据。原文的待确认项没有被本次迁移消除。
- `docs/development-guide.md`：内部实现边界与开发实践。
- `docs/migration-baseline.md`：本次实际迁移、测试结果和限制。
- `docs/migration-source.json`：来源提交、逐文件 Git blob 与 SHA-256。
- `docs/development-plan.md`：下一阶段任务、风险和实施顺序。
- `.scratch/booth/linear-write-draft.md`：待确认、未提交的临时 Linear 操作草案；不属于正式 Issue 系统。
