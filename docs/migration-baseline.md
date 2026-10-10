# BlueSword-Gateway 选择性迁移基线

记录日期：2026-10-10。新工程位于 `E:/Sevenova/BlueSword-Gateway`，是独立 Git 仓库；旧工程 `E:/Sevenova/BlueSword-Agent` 全程只读。此记录只证明本次本地迁移和自测，不是整个系统验收或机器人联调结论。

## 来源与审查范围

创建前确认目标路径不存在，没有覆盖其他内容。旧仓库状态为干净的 `codex/archive-bluesword-agent-2026-10-10`，分支与 HEAD 均指向 `86e8b6d7ac79672be13dc8f4a4aed028ad0c91d5`。实际提交时间为 2026-10-10 13:54:11 +0800，提交说明是冻结历史原型，不代表最终验收。

新仓库初始化提交为 `5ce21f5`（仅包含 .gitignore）；迁移审查固定点为该提交，代码审查通过 `git diff 5ce21f5...HEAD` 核对新基线。没有复制旧 .git，没有 remote，没有远程 Git 操作。逐文件来源 blob、SHA-256、本次修改状态见 `docs/migration-source.json`。

已参考固定提交中的 `docs/第一版实施与审计.md` 和 `docs/当前开发进度.md`，并读取“开发兰剑展会首版系统”聊天中上一轮迁移审计及清单；没有重新审计全部历史资料。旧 `.scratch/booth/linear-write-draft.md` 在工作区存在，但不在固定提交中，只按用户要求只读作为 Linear 草案参考，没有迁为代码来源。

## 实际迁移与适配

共选择 31 个来源文件；其中 .gitignore 在初始化时纳入。正式业务、前端和测试优先原样保留。

| 模块 | 实际文件 | 处理与依据 |
| --- | --- | --- |
| booth 后端 | `apps/api/src/booth/{config,index,openai,server,service,booth.test}.ts` | 复用路由、任务处理、配置和 GPT 请求/校验；index 只更新日志项目名。复验正式接口与可控异常。 |
| SQLite 基础 | `apps/api/src/storage.ts` | 保留 ApplicationStorage 通用 KV、WAL、FULL、busy_timeout；移除旧 TaskRepository、旧类型导入与未使用 events 表。没有更换数据库或重写任务逻辑。 |
| 共享契约 | `packages/contracts/package.json`、`src/booth.ts` | 仅迁 booth 类型；新 `src/index.ts` 只导出 booth，未迁旧契约全集。当前 ai.provider 仍是 OpenAI，下一阶段双供应商实现时适配。 |
| 视觉与交互 | `apps/web/src/{BoothApp.tsx,ProductArt.tsx,booth.css,main.tsx,vite-env.d.ts}`、`index.html`、`vite.config.ts` | 保留 SVG 产品插画、CSS 机器人造型、颜色、排版和有效界面。代码/素材原样复用；没有重做对话布局。 |
| 自测与模拟器 | `scripts/booth-acceptance.cjs`、`scripts/robot-simulator.ts` | 保留正式浏览器验收和独立回环机器人对端；无旧 Mock 包依赖。 |
| 示例目录 | `config/booth-catalog.example.json` | 保持示例性质，HTTP 模式目录未确认禁止发单。 |
| 工程配置 | 根/API/Web package.json、workspace、锁文件、tsconfig、.gitattributes、.gitignore、.env.example | 根名称改为 bluesword-gateway，移除 legacy 脚本；API 只依赖 contracts，指向 booth 入口。保留严格 TS 与原 Vite 配置；示例环境移除旧 Mock 变量，真实密钥为空。 |
| 必要规则 | `docs/接口文档.md`、`docs/agents/{issue-tracker,domain}.md` | 接口文档逐字节保持不变；Linear 规则保留写入确认和外部权威规范，更新项目名/托管边界；domain 链接改为精简开发说明。 |

新建 README、AGENTS、开发说明、后续计划、本记录、来源清单和精简契约导出入口。Linear 完整操作方案存于忽略的 `.scratch/booth/linear-write-draft.md`，未提交在线系统。

## 排除内容

- 旧 .git、node_modules、构建输出、缓存、本地 .env、真实凭据、SQLite 数据和临时截图：保护独立仓库和真实配置，不整体复制。
- application、domain、robot-mock、runtime-mock、runtime-nanoclaw、mcp-server、booth-delivery skill：与现行三接口不兼容或没有现行用途，不作为正式依赖。
- 旧 API index/server/adapter/tool-facade/event-store、旧 App/styles/legacy.html/legacy.tsx、旧 contracts index 全集：依赖历史八接口、轮询或旧 Mock 流程。
- 旧 37 项 Mock 测试及 scripts/browser-acceptance.cjs：验证历史协议；本阶段只迁正式 booth 测试和 booth 浏览器脚本。
- .tmp 历史设计、大量历史资料、旧自测报告和交流提纲：只参考必要内容，没有复制成当前验收证据；不创建空运行时、抽象层或领域目录。

## 版本与安装结果

保留 Node 24.13.1 / pnpm 11.25.0 的可用环境。直接依赖按原锁文件已解析版本固定：TypeScript 5.9.3、Vitest 4.1.11、tsx 4.23.15、React/React DOM 19.3.0、Vite 7.3.6、plugin-react 5.2.0、lucide-react 0.544.0、Playwright 1.62.1、concurrently 9.2.4、Node types 24.13.6、React/React DOM types 19.3.0。

从原锁文件保留所需 importer 和 resolutions/snapshots，再由 pnpm 裁剪；包条目从 288 降到 203，移除 85 个，未引入任何原锁文件以外的包版本。精简 workspace 为根工程、api、web、contracts 四项。原 workspace 的 esbuild 构建许可与 minimumReleaseAge=4320 分钟均保留。

实际测试对象是初始化提交 `5ce21f5` 之后、尚未提交的迁移工作树，随后纳入 `c0a143bd91a244e04878b50ce0cfddd546a2d682`。测试涉及的应用源码、测试脚本、契约、目录、package.json、workspace、锁文件及 TypeScript/Vite 配置与该提交一致；中文说明和 Linear 草案在测试后补充。后续 `3a49295` 只清除了 storage.ts 文件末尾多余空行并更新对应哈希，没有业务变化。本记录不宣称曾对提交后的最终 HEAD 重跑全部测试；文件来源及最终字节哈希见来源清单。

| 实际命令或检查 | 真实结果 |
| --- | --- |
| `pnpm install --lockfile-only --offline` | 初次失败：本机缺少 registry.npmmirror.com 的离线元数据。未升级依赖。 |
| `pnpm install --lockfile-only` | 成功；联网核验已有锁定版本并裁剪旧图。 |
| 首次 `pnpm install --frozen-lockfile` | 依赖已链接，但退出码1：esbuild 构建脚本被拦截。原 workspace 的构建许可随后恢复。 |
| 恢复原 workspace 后 `pnpm install --frozen-lockfile` | 退出码0；4 个 workspace 解析正确，esbuild postinstall 成功。没有升级 pnpm。 |
| `pnpm build` | 退出码0；含 `pnpm typecheck`，strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes 均保留。Vite 转换1672模块，前端产物正常。 |
| `pnpm test --reporter=verbose` | 退出码0；1文件16项通过：10项正式接口/任务事实、5项可控 OpenAI、1项目录校验。旧 Mock 测试为0项。 |
| `pnpm test:browser` | 退出码0；10类流程、5种尺寸通过，4次本地机器人请求，网页无 pageerror。AI是浏览器替身，realOpenAICall=false。 |
| 独立 simulator + API 冒烟 | 独立进程启动后下发仅三字段，从 executing 经主动回调变为 succeeded，active 释放；realRobot=false。结束后已停止本次进程。 |
| 桌面/手机截图人工检查 | 1440宽桌面初始图与390宽手机全页图已实际打开检查；插画、配色和排版保留，无明显裁切。手机对话入口较深的既有布局问题留作 P7。 |
| 依赖/环境/来源核对 | 无旧 Mock/MCP/NanoClaw importer；无真实密钥；接口文档和前端源码与固定提交字节一致。旧仓库状态和 index 哈希最终再次核对。 |

本次浏览器结果保存在 `.tmp/booth-acceptance-IFrhx7/report.json` 及同目录截图；独立模拟器结果在 `.tmp/simulator-smoke/report.json`。这些是本次新生成的临时证据，未纳入 Git。详细流程序列为受理等待、完成、拒绝、故障核对释放、反馈丢失零重发、跨浏览器占用、独立进程重启、AI建议界面、AI错误保留输入、分类。五种尺寸为1440×1000、1024×768、768×1024、390×844、320×568。

## 未解决问题与下一阶段

当前没有阻塞本地安装、类型检查、构建或迁移测试的已知问题。继承风险仍存在：跨任务迟到回调、迟到 AI 改选、回调审计与状态分离写入、长时间等待缺少提醒。真实 OpenAI 未验证，DeepSeek 未接入；统一双供应商与对话布局留待下一阶段。接口中的真实目录、地址、关联和异常收尾尚未确认。SQLite 实验性警告是当前 Node 行为，未因此更换存储。

具体工作、优先级、验收条件与实施顺序见 `docs/development-plan.md`（P1–P9）。优先确认并复现跨单回调，隔离影响后处理 AI 迟到与事务一致性，再尽早接入并真实验证两供应商，补提醒、改对话布局，最后完整自测收口。自动故障切换单独确认，不默认实施。

Linear 在线 VLM-8/9/10 内容正确且均 Done，建议保持不动。临时操作草案包含主开发 Issue 及其进度/验收评论、跨单回调高优先级 Issue 及其复现/验收评论，共4项，全部待确认。没有创建 Project、Issue、评论或修改任何在线字段。

本阶段在迁移基线完成后停止，不继续上述新功能、不执行 Linear 写入、不配置远程仓库或推送。

## 双轴审查结果

审查固定点为初始化提交5ce21f5，代码范围到3a49295，最终文档修正也已复核。Standards轴发现的实测版本标注问题已解决，剩余2项非阻塞的前端维护建议；Spec轴0项发现。完整结果见 `docs/code-review.md`。审查没有扩大本阶段业务功能范围。
