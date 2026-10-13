#  演示录制操作速查

命令均在演示电脑执行；另一台电脑只用于查看本页。**必录 3–8，可选 9；1–2 在录制前完成。** 旁白或字幕先说明：“本次使用真实 AI 和本地机器人模拟器，尚未完成真实机器人联调。”说明文字不要发进聊天框；输入任何凭据前暂停录制。

1. **启动（录制外）。** 在 `E:\Sevenova\BlueSword-Gateway` 按[交接文档](initial-demo-handoff.md)“选择 DeepSeek，启动三个服务”执行完整命令，最后运行 `pnpm.cmd dev:demo`。预期 API、模拟器、前端分别监听 4100、4200、5173；已有服务不重复启动。如录第 9 步，先按该文档“工作人员凭据由服务负责人设置”安全配置凭据，再启动 API。

2. **打开并预检（录制外）。** 在演示电脑 Edge 打开 `http://127.0.0.1:5173/`；另开终端执行交接文档“启动后先执行只读检查”的代码。预期供应商为 DeepSeek，布尔项均为 True；不录工作人员操作时，`OperatorConfigured` 可为 False。页面应为“等待你的选择”；有活动任务或告警先核对，不删库、不用新体验解除。预检不调用 AI；不要运行 `verify:relay` 作为预检。

3. **开始录制：目录与新体验。** 点击饮品、轻食、好礼、鲜选；选择蔬菜礼盒，展示数量只能为 1；折叠再展开目录。点击“开始新体验”→ 对话与选择清空，没有取物任务。

4. **连续问答与澄清（四次真实 DeepSeek 请求）。** 依次发送“这里有什么？”→ 介绍目录；“你是谁”→ 介绍助手；“给我矿泉水”→ 询问数量；回答“两瓶”→ 候选为矿泉水 × 2。每轮等回复再继续，建议出现不等于已经发单；回复失败或建议不符时，如实说明并改为手动选品。

5. **确认取物。** 数量减到 1，再加回 2，点击“确认取物”→ 等待受理、蓝色“正在执行”、约 2.5 秒后收到模拟完成通知，转绿色“已完成”。字幕：“受理不等于完成；这里展示的是模拟完成。”等待受理可能很短，无需重拍。

6. **手动体验。** 完成后点击“开始新体验”；手动选择小面包，数量加到 2、减回 1，再确认 → 模拟完成，无 AI 请求。可短暂缩窄窗口并滚动，再恢复桌面宽度。旁白：“新体验清理本页内容，不取消未结束任务。”

7. **暂停录制：切换中转。** 等所有任务及 AI 请求结束，在 DeepSeek 服务终端按 Ctrl+C，按交接文档第 1 节确认端口释放。三个终端均先进入项目目录；不要同时再运行 `dev:demo`。

   **终端 A（API）**执行交接文档第 4 节原命令。若录第 9 步，复用已设置工作人员凭据的原终端，或在启动前重新安全设置凭据。

   ```powershell
   Get-ChildItem Env: | Where-Object { $_.Name -match '^(OPENAI_|DEEPSEEK_|NODE_OPTIONS$)' } |
       ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
   $env:BOOTH_AI_PROVIDER = 'openai'
   @'
   for (const n of Object.keys(process.env)) {
       if (n.startsWith("DEEPSEEK_")) delete process.env[n];
   }
   process.argv.push("--simulator");
   await import("./apps/api/src/booth/index.ts");
   '@ | node --env-file=.env.relay --import tsx --input-type=module
   ```

   粘贴时 `@'` 与 `'@` 各占一行，结束标记 `'@` 须在行首。**终端 B、C**各自先执行 `$env:Path = (Join-Path $env:LOCALAPPDATA 'pnpm-global') + ';' + $env:Path`，再分别运行 `pnpm.cmd dev:robot`、`pnpm.cmd --filter @bluesword/web dev`。三项监听后刷新页面，重做第 2 步预检，供应商应为 OpenAI。恢复录制，打开工作人员入口展示“当前助手配置”，随后关闭。

8. **中转只尝试一次（一次真实请求）。** 新对话发送“请给我一瓶矿泉水”。正常回复、候选为矿泉水 × 1，且本次 `ai_call` 日志为 `outcome:succeeded`、`structureValidated:true`，才说明本次成功，然后确认模拟取物。**超时、报错或建议不符：**保留结果画面，不重试；说明“中转此前已有真实成功记录，本次未成功”，手动选择矿泉水 × 1 并确认，继续模拟流程。

9. **可选：异常与工作人员处理。** 确认无活动任务、操作凭据已配置。在额外控制终端执行：
   `Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4200/simulation/scenario' -ContentType 'application/json' -Body '{"scenario":"error"}'`
   返回成功后，手动确认小面包 × 1 → 红色“需要协助”。打开工作人员入口看异常原文；**暂停录制输入凭据**，核对仅为本地模拟、无真实机器人动作，再勾选“已现场核对机器人停止及物品情况”，点击“解除本地占用”→ 中性色“工作人员已处理”，不是取物完成。回到控制终端，将同一命令的 `error` 改为 `success` 执行，预期返回 `data: success`；只恢复后续场景，不解除旧任务。不要使用 `silent` 场景。

录完后在各服务终端按 Ctrl+C；核对端口释放，并在设置凭据的终端执行 `Remove-Item Env:BOOTH_OPERATOR_TOKEN -ErrorAction SilentlyContinue`。
