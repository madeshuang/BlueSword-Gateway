# BlueSword-Gateway 联调指南

本文说明 Windows 下如何安装项目，并选择连接真实机器人或进行本机人工练习。接口字段见[接口文档](docs/接口文档.md)，常用词语见[项目术语说明](GLOSSARY.md)。

首次使用时，先按第 1、2 节安装依赖并配置 AI，再从第 3 节进入所选指南，完成配置、启动和联调。

## 1. 获取代码与安装依赖

安装 Git、Node.js **24.13.0 或以上版本**，在准备存放项目的目录打开 PowerShell，执行：

```powershell
# 尚未安装指定版本的 pnpm 时执行
npm.cmd install --global pnpm@11.25.0

git clone https://github.com/madeshuang/BlueSword-Gateway.git
Set-Location BlueSword-Gateway
pnpm.cmd install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

后续命令均在项目根目录执行；已经获取代码时无需重复克隆。

## 2. 配置 AI

两种联调方式共用这里的 AI 配置，读取项目根目录的 `.env`。`.env.relay` 不再使用。修改配置后需要重启服务。

在 PowerShell 中打开配置文件：

```powershell
notepad.exe .env
```

从以下三种方式中选择一种，来修改 `.env` 中对应的AI配置项。

`BOOTH_AI_PROVIDER` 决定使用哪个 AI 服务，与连接真实机器人还是人工工具无关。

### DeepSeek

```dotenv
BOOTH_AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=<你的DeepSeek密钥>
DEEPSEEK_MODEL=<账号可用的模型名>
```

程序固定使用 DeepSeek 官方接口，无需填写 URL。

### GPT 中转

```dotenv
BOOTH_AI_PROVIDER=openai
OPENAI_BASE_URL=<中转服务提供的HTTPS API基址，包含所需版本路径>
OPENAI_MODEL=<中转服务支持的模型名>
OPENAI_API_KEY=<你的中转服务密钥>
```

`OPENAI_BASE_URL` 填 API 基址，不追加 `/responses`。中转服务及所选模型须支持 OpenAI Responses API 的结构化输出（JSON Schema，严格模式）。

### OpenAI 官方直连

```dotenv
BOOTH_AI_PROVIDER=openai
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=<账号可用且支持Responses结构化输出的模型名>
OPENAI_API_KEY=<你的OpenAI官方API密钥>
```

### AI 回复的等待时间

`.env.example` 中的 `OPENAI_TIMEOUT_MS` 和 `DEEPSEEK_TIMEOUT_MS` 分别设置对应服务的回复超时时间，单位为毫秒，默认 `20000`，即 20 秒。程序只使用所选服务的配置；GPT 中转使用 `OPENAI_TIMEOUT_MS`。这两个时间与等待机器人接单或任务结果的时间无关。

保存 `.env` 后，按下一节选择联调方式。各指南会在启动后安排聊天验证，确认 AI 能够实际回复并推荐物品。

## 3. 选择联调方式

| 场景      | 一键启动入口              | 默认端口              | 配置与操作步骤                        |
| ------- | ------------------- | ----------------- | ------------------------------ |
| 连接真实机器人 | `start-gateway.cmd` | 网关 4100           | [真实机器人联调指南](docs/真实机器人联调指南.md) |
| 本机人工练习  | `start-local.cmd`   | 网关 4101、人工工具 4201 | [本机人工联调指南](docs/本机人工联调指南.md)   |

按所选指南完成该场景的配置后再启动，两种入口都会构建网页。连接真实机器人时，直接阅读真实机器人联调指南即可。人工练习由按钮模拟接单和结果通知，不能作为真实机器人验证。

切换联调方式前，先在原启动窗口停止服务，再按另一份指南配置和启动。
