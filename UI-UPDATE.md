# 对话界面同步说明

更新日期：2026-10-27。基于 main 的 0d2a29e，沿用 2026-10-26 交付包的对话布局。

## 页面变化

- 左侧导航、中央单列对话、底部输入框；物品选择、数量确认、任务详情和工作人员操作进入弹窗。
- 欢迎区并列展示 BlueSword 与 Blue Brain，顶部保留 Blue Brain 标识。顶栏不属于消息滚动区域，收起侧栏及手机访问时仍然可见。
- 品牌色统一为 RGB(0, 118, 135) / #007687，含 BlueSword SVG、主按钮、选中态、焦点及品牌文字。
- 页面使用白色和蓝灰底色；快捷卡片引入浅紫、暖米色。物品图标背景使用目录的 color 字段。
- 用户提供的 booth-catalog.example(1).json 与项目 config/booth-catalog.example.json 内容一致，保留最新版的 10 种物品。
- 任务对话展示接单和结果状态，不把预设导航、抓取过程文字作为实时反馈展示。

## 兼容处理

新增 useBooth 和 conversation 组件目录，把交互状态与布局分开。
工作人员操作仍调用最新版 /api/booth/operator/resolve，并发送确认时保存的 expectedTaskId、expectedAlert；收到 409 后刷新快照并要求重新核对。保留后台的本机人工机器人恢复机制。
本次未替换 API 业务实现、机器人协议或数据库实现。

## 验证

- pnpm build：类型检查、生产构建通过。
- pnpm test:conversation:browser：7 项通过，包含选择与取消、确认发单、数量、库存竞争、过期模型建议、补货、超时任务处理、任务变化保护及品牌在桌面/手机/长对话中的可见性。
- pnpm test:speech:browser 对应的浏览器用例：4 项通过；使用本地模拟语音服务，覆盖草稿、取消、权限失败、静音和录音时限，不代表真实供应商已配置。
- pnpm test：136 项通过，3 项启动用例因旧预览占用 4101 而失败。旧服务来自 /tmp/bluesword-delivery-preview.WW6jkh，未结束该服务。这些用例固定使用 4101/4201，需端口空闲再执行。
- git diff --check 通过。

现有浏览器 npm 入口已指向新的对话界面回归套件；旧 scripts/booth-*.cjs 文件保留作为历史脚本，其旧页面选择器未逐个迁移，不应直接用于新版页面验收。

## 本次预览

新版页面：http://127.0.0.1:4102/
人工机器人工具：http://127.0.0.1:4202/
本机人工操作口令：manual-local-only。
独立预览数据库：.data/booth-ui-preview.sqlite。
AI 与语音服务需另行配置凭据；本次预览未使用真实供应商。

截图位于 .tmp/ui-preview/：live-home.png、live-catalog.png 为运行中的新版页面；conversation.png、order-confirmation.png、mobile-welcome.png 等来自隔离的浏览器测试，测试对话与物品数据不代表真实模型响应。

手动启动新版预览（先安装依赖并构建，在两个终端分别执行）：

```bash
BOOTH_MANUAL_PORT=4102 BOOTH_MANUAL_ROBOT_PORT=4202 BOOTH_MANUAL_DB_PATH=.data/booth-ui-preview.sqlite node --import tsx apps/api/src/booth/index.ts --manual --serve-web
BOOTH_MANUAL_ROBOT_PORT=4202 BOOTH_MANUAL_CALLBACK_URL=http://127.0.0.1:4102 node --import tsx scripts/robot-manual.ts
```

## 后续比例调整

- 对话消息署名改为“兰剑助手”；顶部仍只展示 Blue Brain 图片和说明。
- 桌面内容区改为随视口变化的 900–1600px 上限，正文 17–25px；侧栏、品牌标识、快捷卡片、输入框与弹窗同步放大。
- 手机单列布局保留，正文提高至 16px；低高度窗口采用紧凑间距，欢迎区可滚动且默认从顶部展示。
- 新增屏幕适配回归，检查 320、390、768、1024、1366、1440、1920、2560、3840px 宽度及 600px 高度窗口。验证内容不横向溢出、输入框与顶部 Logo 可见、欢迎区顶部不裁切。
- 最终构建及 8 项对话浏览器回归通过。新版比例截图：.tmp/ui-preview/scaled-1920x1080.png、scaled-conversation.png。
