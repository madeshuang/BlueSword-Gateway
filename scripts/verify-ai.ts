import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBoothConfig } from "../apps/api/src/booth/config.js";
import { createBoothApplication } from "../apps/api/src/booth/server.js";
import type { AiCallDiagnostics } from "../apps/api/src/booth/advice.js";
import type { BoothAdvice } from "../packages/contracts/src/booth.js";

// Explicit invocation only. Fixed non-sensitive samples, no dispatch endpoint call.
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(x=>x!=="--");
  const selected = args[1];
  const sampleId = args.length === 4 ? args[3] : undefined;
  if (![2,4].includes(args.length) || args[0] !== "--provider" || !["openai","deepseek","both"].includes(selected ?? "") ||
    (args.length === 4 && (args[2] !== "--sample" || !["positive","clarify","outside"].includes(sampleId ?? "")))) {
    throw new Error("请显式指定 --provider openai、deepseek 或 both；可选 --sample positive、clarify 或 outside；此命令会产生真实 API 调用费用");
  }
  const providers = selected === "both" ? ["openai","deepseek"] as const : [selected as "openai" | "deepseek"];
  const configs = providers.map(aiProvider=>{
    const config = { ...readBoothConfig(), aiProvider, databasePath: ":memory:", dispatchUrl: undefined,
      catalogConfirmed: false, operatorToken: undefined };
    const endpoint = new URL(config.openaiBaseUrl);
    const endpointType = aiProvider === "deepseek" ? "deepseek_official"
      : ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ? "openai_loopback"
      : endpoint.origin === "https://api.openai.com" ? "openai_official" : "openai_custom";
    return { ...config, endpointType };
  });
  // Check all requested providers before the first paid call.
  for (const c of configs) {
    if (!(c.aiProvider === "openai" ? c.openaiKey : c.deepseekKey)) {
      throw new Error(c.aiProvider === "openai" ? "本地 OPENAI_API_KEY 未配置，未执行真实调用" : "本地 DEEPSEEK_API_KEY 未配置，未执行真实调用");
    }
  }
  const results: unknown[] = [];
  let failed = false;
  let stoppedEarly = false;
  for (const c of configs) {
    const product = c.products[0]!;
    const samples = [
      { id: "positive", name: "明确单物品和数量", content: `我要1份${product.name}。`, expected: { productId: product.id, count: 1 } },
      { id: "clarify", name: "数量待澄清", content: `我想要${product.name}，还没有决定数量。`, expected: null },
      { id: "outside", name: "目录外物品", content: "我要100块火星陨石。", expected: null },
    ].filter(sample=>sampleId === undefined || sample.id === sampleId);
    const observations: AiCallDiagnostics[] = [];
    const app = createBoothApplication(c,{onAiCall:event=>{observations.push(event);}});
    try {
      const base = "http://127.0.0.1:" + await app.listen(0);
      for (const sample of samples) {
        observations.length = 0;
        const startedAt = Date.now();
        const response = await fetch(base+"/api/booth/chat", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: sample.content }] }) });
        const data = await response.json() as BoothAdvice;
        const snapshot = await (await fetch(base+"/api/booth")).json() as { tasks: unknown[] };
        const diagnostics = observations.at(-1);
        const matches = sample.expected === null ? data.selection === null
          : data.selection?.productId === sample.expected.productId && data.selection.count === sample.expected.count;
        const valid = response.ok && matches && snapshot.tasks.length === 0;
        failed ||= !valid;
        // Never persist keys, headers, raw upstream errors or full dialogue.
        results.push({ provider: c.aiProvider, endpointType: c.endpointType, model: c.aiProvider === "openai" ? c.openaiModel : c.deepseekModel,
          returnedModel: diagnostics?.returnedModel ?? null, usage: diagnostics?.usage ?? null,
          connectionCode: diagnostics?.connectionCode ?? null,
          upstreamStatus: diagnostics?.upstreamStatus ?? null, errorCategory: diagnostics?.category ?? null,
          upstreamElapsedMs: diagnostics?.elapsedMs ?? null, structureValidated: diagnostics?.structureValidated ?? false,
          selectionMatched: response.ok && matches,
          sampleId: sample.id, sample: sample.name, httpStatus: response.status, elapsedMs: Date.now()-startedAt, passed: valid,
          expectedSelection: sample.expected, actualSelection: response.ok ? data.selection : null, taskCount: snapshot.tasks.length });
        // Configuration failures cannot be repaired by submitting more paid samples.
        if (diagnostics && ["unconfigured","authentication","configuration"].includes(diagnostics.category ?? "")) {
          stoppedEarly = true; break;
        }
      }
    } finally { await app.close(); }
    if (stoppedEarly) break;
  }
  const directory = resolve(".tmp/ai-verification"); mkdirSync(directory,{recursive:true});
  const reportPath = resolve(directory,"report-"+new Date().toISOString().replace(/[:.]/g,"-")+".json");
  writeFileSync(reportPath,JSON.stringify({ checkedAt: new Date().toISOString(), realProviders: configs.every(c=>c.endpointType !== "openai_loopback"),
    scope: "每家最多3条选中的固定文本；配置或认证失败立即停止；不重试、不发单，不证明多轮/展会可靠性",
    plannedSamples: configs.length*(sampleId === undefined ? 3 : 1), attemptedSamples: results.length, stoppedEarly, results },null,2));
  console.info(JSON.stringify({ event: "ai_verification", reportPath, total: results.length, passed: !failed }));
  if (failed) process.exitCode = 1;
}
main().catch(error=>{
  // Startup/configuration failures are reported without dumping environment or stack.
  const safe = error instanceof Error && /^(请显式指定|本地 (OPENAI|DEEPSEEK)_API_KEY)/.test(error.message)
    ? error.message : "验证未完成，请核对本地配置和服务日志；没有把此次调用记为通过";
  console.error(safe); process.exitCode = 1;
});
