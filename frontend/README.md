# BlueSword · 布鲁 展示前端

在项目根目录执行以下 Bash 命令（Windows 安装与启动见[项目说明](../README.md#windows-原生安装与启动)）：

```bash
cd frontend
npm ci
npm run dev          # 默认 /ws 代理到本地 8000 后端
VITE_AGENT_MODE=demo npm run dev   # 原来的纯前端动画演示，不需要后端
VITE_AGENT_WS=ws://localhost:8000/ws npm run dev   # 自定义后端地址
```

快捷键：`空格` 开启语音 · `T` 切换深/浅色 · `Esc` 回首页（确认条打开时为取消，`Enter` 为允许）

- 后端启动和整套 mock 测试：[项目说明](../README.md)
- 事件协议：`src/types.ts`（后端按 `ServerEvent` 推送，增加任务 ID、状态、取消及模拟器操作）
- 名字 / 唤醒词 / 建议问题：`src/config.ts`
- 演示脚本：`src/mock.ts`
- 后端模式不会在断线时排队/自动重放取物命令；重连恢复任务快照。
- 后端已接入阿里云语音识别和播报；需配置 `DASHSCOPE_API_KEY` 并授予麦克风权限。未配置时使用文字输入。跨设备使用麦克风需要 HTTPS。
- `VITE_AGENT_WS` 在构建时生效；启用后端访问 token 时，按[网页访问配置](../README.md#可选网页访问-token)设置本机 `frontend/.env.local`，重新构建或重启 Vite。
- 布鲁：`src/components/Pet.tsx` 优先加载 3D 版 `src/pet3d/BluePet3D.tsx`（网格与表情来自 `blueModel.js`，移植自 blue-3d/model.js，Three.js 单独拆包按需加载）；不支持 WebGL 时退回 2D 版 `BluePet.tsx`。固定在侧边栏左下角，眼睛/朝向跟随鼠标，单击 = 语音唤醒。
