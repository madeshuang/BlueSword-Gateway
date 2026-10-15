# BlueSword-Gateway 联调指南

本文说明 Windows 下从 GitHub 获取代码到一键启动的全过程。默认用于本机人工联调：AI 调用真实模型，机器人受理和结果通知由人工模拟。连接真实设备见第 4 节。

## 1. 获取代码与安装依赖

安装 Git、Node.js **24.13.0 或以上版本**。仓库为私有，先让负责人为你的 GitHub 账号开通访问权限，再在 PowerShell 中执行：

```powershell
# 尚未安装指定版本的 pnpm 时执行
npm.cmd install --global pnpm@11.25.0

git clone https://github.com/madeshuang/BlueSword-Gateway.git
Set-Location BlueSword-Gateway
pnpm.cmd install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

后续操作均在项目根目录进行。Git 不包含依赖、密钥或数据库；已有 `.env` 不要覆盖。

## 2. 配置 AI 并一键启动

以下两种方式任选其一。配置文件与启动脚本都放在项目根目录；密钥只保存在本机，不提交 Git。

### 方式一：DeepSeek（.env）

第 1 节已从 `.env.example` 创建 `.env`，在 PowerShell 中用记事本打开：

```powershell
notepad.exe .env
```

找到以下字段并修改，其他配置保留。占位内容须替换为实际值，不保留尖括号；模型名使用账号可用的名称。

```dotenv
BOOTH_AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=<你的DeepSeek密钥>
DEEPSEEK_MODEL=<你的DeepSeek模型名>
```

按 Ctrl+S 保存并关闭记事本，再双击 **`start-deepseek.cmd`**。

### 方式二：GPT 中转（.env.relay）

首次使用时复制配置模板，再打开文件；已有文件时保留原配置：

```powershell
if (-not (Test-Path .env.relay)) { Copy-Item .env.example .env.relay }
notepad.exe .env.relay
```

找到以下字段并修改，地址、模型名和密钥均使用中转服务提供的实际值，不保留尖括号：

```dotenv
BOOTH_AI_PROVIDER=openai
OPENAI_BASE_URL=<中转服务的HTTPS API基址，包含所需版本路径>
OPENAI_MODEL=<中转服务支持的模型名>
OPENAI_API_KEY=<你的中转服务密钥>
```

中转服务须支持 Responses 结构化输出。`OPENAI_BASE_URL` 填 API 基址，不填聊天网页地址或完整的 `/responses` 接口地址。按 Ctrl+S 保存并关闭记事本，再双击 **`start-gpt-relay.cmd`**。

确认文件名仍为 `.env` 或 `.env.relay`，没有被保存成 `.txt` 文件。也可使用 `start-local.cmd`，按 `.env` 的 `BOOTH_AI_PROVIDER` 选择供应商；它不读取 `.env.relay`。两个专用脚本固定选择各自供应商。三个脚本均从对应文件读取 AI 配置，不沿用旧终端的同名 AI 变量，也不自动切换供应商。

脚本会检查配置、依赖和端口，自动检查类型、构建最新网页，并打开 4101 和 4201 两个页面，**无需提前构建、另开网关终端或启动 5173**。缺少密钥时脚本会退出；端口占用时先在原窗口停止旧服务。启动后发送一条聊天消息，确认模型能够正常回复；启动成功本身不代表模型调用成功。

保持启动窗口开启；输入 `q` 后回车或按 Ctrl+C，同时停止两个服务。修改配置或切换供应商后重新启动。后续更新时，先停止服务并核对本地修改，工作区干净时执行 `git pull --ff-only`、`pnpm.cmd install --frozen-lockfile`，再双击脚本。保留本地配置和 `.data/`。

## 3. 走通一次人工联调

1. 在 4101 手选一件有库存的物品，点击“确认取物”；也可先通过 AI 推荐，再由用户确认发单。
2. 切到 4201，核对物品、位置和数量，在 **120 秒内**点击“受理任务”。此时 4101 应继续等待，受理不代表完成。
3. 在 4201 点击“发送完成通知”，检查回执和 4101 的完成提示。另起任务可分别验证“拒绝任务”和“发送故障通知”；故障后按文末步骤处理。

任务不会自动完成；超时未受理会保留“受理不明”占用，须核对处理。需要留档时，在 4201 点击“下载本次接口记录 JSON”，工具重启会清空本次通信记录。页面中的出发、抓取、返回文字为预设模拟展示，实际结果以机器人通知为准。

## 4. 连接真实机器人

一键脚本固定连接本机人工工具。真实联调先停止脚本，在 `.env` 设置 `PORT=4100`、`BOOTH_HOST=0.0.0.0`、`BOOTH_ROBOT_MODE=http`、真实 `ROBOT_DISPATCH_URL` 和现场 `BOOTH_OPERATOR_TOKEN`。核对 `BOOTH_CATALOG_PATH` 指向目录的物品、位置、每单上限与初始库存后，才将 `BOOTH_CATALOG_CONFIRMED` 设为 `true`。然后执行：

```powershell
pnpm.cmd build
pnpm.cmd serve
```

网页和回调共用 `http://<网关电脑实际IP>:4100`。双方先核对 HTTP 双向连通，机器人不能用另一台设备的 `127.0.0.1` 访问网关。机器人接收任务后先回复是否受理，实际完成后再调用 `/api/task/finished`，不可恢复故障调用 `/api/task/error`。完整配置、报文和待确认项见拉取后仓库内的 `docs/机器人团队联调指南.md`、`docs/接口文档.md`。

本机模拟通过不代表真实机器人联调通过。当前协议没有任务关联字段，不要在下一单开始后重发上一单通知。

## 5. 4101、4201 与 /#operations

| 本机地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:4101/` | 网关主页面：AI 对话、手选物品、确认取物、查看任务状态；同时提供网关 API。 |
| `http://127.0.0.1:4201/` | 人工机器人工具：查看请求，手动受理、拒绝、发送完成或故障通知，查看和下载接口记录。 |
| `http://127.0.0.1:4101/#operations` | 工作人员页面：查看任务与异常、解除异常占用、补货重置。`/#operations` 是网页入口，不是独立的 HTTP API。 |

本机人工模式只监听本机地址，使用 `.data/booth-manual.sqlite`，工作人员凭据固定为 **`manual-local-only`**。真实环境使用 `http://<网关IP>:4100/#operations`，凭据为 `.env` 中设置的 `BOOTH_OPERATOR_TOKEN`。

- **单个补货**：先补满实物，输入工作人员凭据，在“补货重置”选择已补货物品，核对补满目标，勾选“已核对并补满所选物品”，点击“重置所选物品库存”。本机练习可模拟补货。
- **全部补货**：选择“全部物品”，逐项核对均已补满，勾选“已核对并补满全部物品”，点击“重置全部物品库存”。
- **故障或受理不明**：先确认机器人已停止并核对物品情况，输入凭据，勾选“已现场核对机器人停止及物品情况”，点击“解除本地占用”。此操作不停止机器人、不恢复库存，也不能取消执行中的任务。

有未结束任务或告警时不能重置库存。操作成功后凭据与对应勾选会清空，下次须重新填写。库存和任务记录跨重启保留，“开始新体验”不会补满；不要通过删库解除占用或补货。
