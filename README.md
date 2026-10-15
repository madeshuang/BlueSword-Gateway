# BlueSword-Gateway

展会机器人系统的用户侧网关。访客通过 AI 对话或手选物品，确认后由网关发单；机器人回复是否受理，并在完成或不可恢复故障时通知网关。受理不代表完成。

**机器人团队请先阅读[联调指南](docs/机器人团队联调指南.md)。** 其中包含安装、真实机器人配置、接口报文、双方联调顺序及工作人员操作。当前接口仍有待双方确认的部分；本机模拟通过不代表真实机器人联调通过。

## 获取代码

需要 Git、Node.js >=24.13.0 和 pnpm 11.25.0。仓库为私有，须先获得访问权限。在 PowerShell 中执行：

```powershell
git clone https://github.com/madeshuang/BlueSword-Gateway.git
Set-Location BlueSword-Gateway
pnpm.cmd install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Git 不包含依赖、密钥、数据库或已构建网页。不要覆盖已有 `.env`，也不要删除数据库来补货或解除任务。

## 连接真实机器人

按[联调指南](docs/机器人团队联调指南.md)填写 `.env` 中的真实机器人 URL、物品目录、网关监听地址和工作人员凭据，核对目录后再启用发单。然后运行：

```powershell
pnpm.cmd build
pnpm.cmd serve
```

网页与回调默认共用4100端口。本机打开 `http://127.0.0.1:4100`；机器人使用运行电脑的实际可达 IP。双方必须验证网关发单和机器人回调两个方向。真实联调只需网关进程，不启动下面的人工模拟器。

## 本机人工练习与 AI 对话

首次安装依赖并配置有效密钥后，Windows 双击根目录对应脚本：

| 脚本 | 配置来源 |
| --- | --- |
| `start-deepseek.cmd` | `.env` 的 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，固定使用 DeepSeek。 |
| `start-gpt-relay.cmd` | `.env.relay` 的 `OPENAI_BASE_URL`、`OPENAI_MODEL`、`OPENAI_API_KEY`，固定使用 OpenAI 协议中转；需支持 Responses 结构化输出。 |
| `start-local.cmd` | `.env` 中 `BOOTH_AI_PROVIDER` 指定的供应商及对应配置。 |

脚本检查配置、端口和类型，构建最新网页，同时打开4101主页面与4201人工工具。聊天调用真实模型；取物由操作者在4201点击受理、完成或故障，不会自动完成。使用独立 `.data/booth-manual.sqlite`，不连接真实机器人。此方式不使用5173，也不需另开网关终端。

保持启动窗口开启，输入 `q` 后回车或按 Ctrl+C 停止。切换供应商前先停止旧脚本。AI 配置从对应文件读取，不沿用旧终端的同名变量；缺少配置或端口占用时提示退出，不自动切换供应商、不结束已有进程。密钥和模型服务网络有效时才能对话，启动成功本身不证明模型调用成功。详细操作及原始接口记录见[人工测试指南](docs/manual-interface-test.md)。

工作人员入口为当前网页地址加 `/#operations`。人工练习凭据为 `manual-local-only`；真实环境使用负责人设置的 `BOOTH_OPERATOR_TOKEN`。库存跨重启保留，实际补货后才能在此重置；有任务或告警时需先核对处理。单个与全部补货规则见[库存说明](docs/booth-inventory.md)。

## 文档与检查

- [机器人团队联调指南](docs/机器人团队联调指南.md)：从 Git 安装到真实设备对接。
- [接口文档](docs/接口文档.md)：当前三项机器人接口及待确认项。
- [人工测试指南](docs/manual-interface-test.md)：本机受理、拒绝、完成、故障及补货操作。
- [现场交付包说明](docs/delivery-readme.md)：可选 ZIP 交付方式。
- [库存说明](docs/booth-inventory.md)：数量限制、持久化与补货接口。
- [任务关联建议](docs/task-id-proposal.md)：当前尚未实现的 `taskId` 提案及迟到通知风险。

需要自查时运行 `pnpm.cmd test` 和 `pnpm.cmd build`。测试中的一键启动检查会使用4101与4201，须先停止人工练习；可控测试不调用真实模型或真实机器人。`verify:ai`、`verify:relay` 是显式真实模型验证命令，会产生费用，不是启动步骤。
