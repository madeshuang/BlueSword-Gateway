# 开发速查

本文件提供代码结构、接口边界和验证要点的快速参考。完整需求背景见 [项目背景与需求说明](项目背景与需求说明.md)，待办任务见 [开发计划](development-plan.md)。

## 代码结构

| 目录/文件 | 职责 |
|-----------|------|
| `apps/api/src/booth/` | 正式 HTTP 入口、配置、业务逻辑和 AI 建议 |
| `apps/api/src/storage.ts` | 通用 SQLite KV 持久化 |
| `apps/web/` | 展会前端体验 |
| `packages/contracts/` | 外部下发与内部 UI/业务类型定义 |
| `scripts/` | 独立机器人对端、人工接口工具、交付打包和验证入口 |

## 外部接口与内部实现边界

### 与机器人的接口（按 docs/接口文档.md）

| 接口 | 我方职责 | 不属于我方 |
|------|---------|-----------|
| **POST /api/task/dispatch**<br/>（我方 → 机器人） | 发送 `location`、`item`、`count`；以 `success` 判断受理，不依赖 `code:1` | 机器人侧路径规划、导航、抓取实现 |
| **POST /api/task/finished**<br/>（机器人 → 我方） | 接收完成通知 `{“result”:”success”}`，返回接收回执；兼容空体/空 JSON | 机器人执行进度管理与中间步骤 |
| **POST /api/task/error**<br/>（机器人 → 我方） | 接收不可恢复故障 `message`，展示并返回回执 | 机器人可自行恢复的故障处理 |

**关键边界：**
- 受理成功 ≠ 任务完成，完成依赖机器人主动通知
- 不轮询机器人状态
- 不把展示脚本当作真实执行步骤，也不按模拟耗时宣告完成。用户已明确要求在对话中增加固定、逐字显示的模拟取物过程，具体展示与验证边界见[思考过程说明](booth-thinking-display.md)
- 受理结果不明、故障、提交中状态均阻止新任务
- 重启时提交中任务转为受理不明

### 我方内部接口

| 接口 | 用途 | 实现选择 |
|------|------|---------|
| `GET /api/booth` | 网页快照 | 单任务占用、SQLite 存储 |
| `GET /api/booth/events` | SSE 状态推送 | 单进程、本地 SSE |
| `POST /api/booth/requests` | 用户确认提交 | 内部 `requestId` 不传入机器人报文 |
| `POST /api/booth/chat` | AI 建议 | 后端配置选择 GPT/DeepSeek |
| `POST /api/booth/experiences` | 建立独立体验关联 | 刷新保留标签页凭据，后端核实关联任务；详见[实现与验证记录](ai-task-progress-validation-2026-10-14.md) |
| `POST /api/booth/operator/resolve` | 工作人员解除本地占用 | 不停止/取消机器人任务 |
| `POST /api/booth/operator/stock/reset` | 核对补货后重置单个物品数量 | 需要工作人员凭据和补货确认；有任务或告警时拒绝，详见[库存说明](booth-inventory.md) |
| `POST /api/booth/operator/stock/reset-all` | 核对全部补货后重置当前目录全部数量 | 需要同一工作人员凭据及独立全量确认；有任务或告警时拒绝，全部更新在一个事务中完成 |

**技术约束：**
- 单进程 + 本地 SQLite（多实例需重新评估 SSE/任务控制）
- 内部 HTTP 错误码与输入上限是我方实现选择
- 单任务占用不能识别跨单迟到回调（待确认任务关联标识）

## 交付运行入口

`pnpm serve` 在后端同一端口提供 `apps/web/dist` 中的构建入口和 `/assets/`、`/products/` 素材，不公开项目目录。未构建网页时启动失败；源码变更先运行 `pnpm build`。它沿用正式 API 和 SQLite，不额外引入代理服务。

`pnpm manual:gateway` 使用独立练习数据库和回环4201人工对端，强制覆盖正式发单配置；`pnpm manual:robot` 只监听回环地址，按钮显式决定受理和回调。它与原有自动模拟器分开，不能证明真实机器人能力。包的自动检查、人的操作记录和真实对端联调分别记录，见[人工测试指南](manual-interface-test.md)。

`pnpm delivery` 使用明确文件清单生成 ZIP 及 SHA-256 清单；构建文件只进入忽略区中的交付包，不纳入 Git。Vitest 排除 `.tmp/`、`.scratch/` 和 `.pnpm-store/`，避免解压副本、历史快照或安装缓存被再次当作当前源码测试。`scripts/package.json` 仅指定 TypeScript 工具使用 ESM，不是新增 workspace 包。

## 验证要点

功能验证报告须包含：

1. **环境标识**：提交哈希或”工作区 + 日期时间”
2. **对端类型**：模拟器 / HTTP 替身 / 真实机器人 / 真实 AI 供应商
3. **验证场景**：受理成功、受理拒绝、完成通知、故障通知、迟到回调、重启恢复等
4. **实际命令与结果**：执行的命令、观察到的行为、日志摘要
5. **未验证范围**：明确列出未覆盖的场景或约束条件

**不可替代原则：**
- 测试替身结果不能当作真实供应商验证
- 受理成功不能当作任务完成
- 历史验证报告不能作为当前实现的验收结论
