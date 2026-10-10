# 开发说明与实现边界

## 当前依据与结构

当前主要依据为 `docs/接口文档.md`。原文虽保留“对接草案”说明，用户已指定它作为本阶段正式实现依据；其中地址、目录、回调字段和任务关联等待确认事项继续有效。旧会议、审计及设计只能解释背景，不能覆盖这份文档。

`apps/api/src/booth` 负责正式 HTTP 入口、配置、业务和 AI 建议；`apps/api/src/storage.ts` 提供通用 SQLite KV 持久化。`apps/web` 保留现有展会体验；`packages/contracts` 只导出 booth 所需的外部下发与内部 UI/业务类型。独立机器人模拟器在 `scripts`，不属于正式业务依赖。

## 外部接口与我方内部选择

| 路径或行为 | 依据与边界 |
| --- | --- |
| 后端向机器人 `POST /api/task/dispatch` | 只发送 `location`、`item`、`count`；以 `success` 判断受理，不能凭 `code:1` 判断成功。 |
| 接收 `POST /api/task/finished` | 按现稿接收 `{"result":"success"}` 并返回 `{code:1,data:"OK",success:true}`。兼容空体/空 JSON 是已有容错选择，不是新增双方约定。 |
| 接收 `POST /api/task/error` | 展示机器人 `message` 并回复同样的接收回执。 |
| `GET /api/booth`、`GET /api/booth/events` | 我方网页快照与 SSE；不向机器人查询状态。 |
| `POST /api/booth/requests`、`POST /api/booth/chat` | 内部确认提交与 AI 建议 API；内部 `requestId` 不传入机器人报文。 |
| `POST /api/booth/operator/resolve` | 凭据和现场确认后解除本地异常占用；不停止、不取消机器人任务。 |
| 单任务占用、SQLite、输入上限、内部 HTTP 错误码 | 我方实现选择，不是机器人文档的新要求。单任务占用不能识别跨单迟到回调。 |

受理结果不明、故障和提交中状态继续阻止新任务。重启时提交中任务转为受理不明。业务不自动重发机器人请求、不轮询机器人、不虚构执行步骤。完成只依赖主动通知，不依赖模拟耗时。

## 项目资料与验证

正式规则、当前技术方案和可核对的测试记录放在 `docs`。`.tmp` 仅存本次安装/验收产物和临时资料，`.scratch` 仅存待确认草案；两者不提交 Git。历史审计没有被复制为新项目的自测结论。验证报告须说明使用的提交、对端类型、实际命令和未验证范围。

按单进程、本地 SQLite 的已有实现继续开发。若后续要求多实例或网络盘数据库，需连同 SSE、AI 忙碌状态和任务控制一起评估，不能仅更换数据库就宣布问题解决。

关键行为开发采用公开接口测试，先确认测试边界，再按一个失败测试、最小实现、复验的顺序推进。内部函数不逐个镜像测试。重要变更由 code-review 的规则与需求两个轴检查；迁移阶段只保留已有测试，不混入大规模重构。

## 技能的选择性配置

已读取 setup-matt-pocock-skills、create-plan、tdd、code-review 和 clear-chinese-docs 的实际说明。沿用用户已经确认的 Linear 归属及单领域上下文，建立 AGENTS.md、issue-tracker.md 和 domain.md；不新增标签、不建立空词汇表或 ADR、不把 pnpm 多包误认为多个领域。

用户已明确授权本次本地工程建立、规则适配及计划文档，不再重复一轮配置选择。create-plan 的只读规划流程用于分析下一阶段；保存计划及其他交付文档遵循本次用户要求。TDD 留待关键功能正式开发，本次没有新增测试；code-review 用初始化提交作为新仓库审查固定点。
