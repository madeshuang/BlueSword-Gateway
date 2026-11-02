# BlueSword · 布鲁 展示前端

```bash
npm install
npm run dev          # 默认 /ws 代理到本地 8000 后端
VITE_AGENT_MODE=demo npm run dev   # 原来的纯前端动画演示，不需要后端
VITE_AGENT_WS=ws://localhost:8000/ws npm run dev   # 自定义后端地址
```

快捷键：`空格` 模拟一次语音唤醒 · `T` 切换深/浅色 · `Esc` 回首页

- 后端启动和整套 mock 测试：[项目说明](../README.md)
- 事件协议：`src/types.ts`（后端按 `ServerEvent` 推送，增加任务 ID、状态、取消及模拟器操作）
- 名字 / 唤醒词 / 建议问题：`src/config.ts`
- 演示脚本：`src/mock.ts`
- 后端模式不会在断线时排队/自动重放取物命令；重连恢复任务快照。
- 后端尚未接入 ASR 时，语音按钮只唤醒并提示输入文本，不伪造识别结果。
- 布鲁：`src/components/Pet.tsx` 优先加载 3D 版 `src/pet3d/BluePet3D.tsx`（网格与表情来自 `blueModel.js`，移植自 blue-3d/model.js，Three.js 单独拆包按需加载）；不支持 WebGL 时退回 2D 版 `BluePet.tsx`。固定在侧边栏左下角，眼睛/朝向跟随鼠标，单击 = 语音唤醒。
