import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { readBoothConfig } from "../apps/api/src/booth/config.js";
import { createBoothApplication } from "../apps/api/src/booth/server.js";
import type { BoothAdvice, BoothSnapshot } from "../packages/contracts/src/booth.js";
import type { BoothChatMessage } from "../packages/contracts/src/booth.js";

// Explicit, paid integration tests. Never included in the default test command.
describe.runIf(process.env.BOOTH_LIVE_AI_TESTS === "true")("真实付费对话回归（显式启用）", () => {
let app: ReturnType<typeof createBoothApplication>;
let base: string;
const observations: unknown[] = [];
beforeAll(async () => {
  const config = readBoothConfig();
  if (!config.deepseekKey) throw new Error("真实对话回归需要本地 DeepSeek 凭据");
  app = createBoothApplication({ ...config, aiProvider: "deepseek", databasePath: ":memory:", dispatchUrl: undefined }, {
    assistantTransport: async (url, options) => {
      const response = await fetch(url, options);
      if (response.ok) {
        const data = await response.clone().json();
        const choice = data.choices?.[0];
        let value;
        try { value = JSON.parse(choice?.message?.content ?? ""); } catch { /* Shape only, never raw text. */ }
        observations.push({ event: "live_output_shape", upstreamStatus: response.status,
          finishReason: choice?.finish_reason, choiceCount: data.choices?.length,
          contentType: typeof choice?.message?.content,
          contentLength: typeof choice?.message?.content === "string" ? choice.message.content.length : null,
          fenced: typeof choice?.message?.content === "string" && choice.message.content.trim().startsWith("```"),
          startsAsObject: typeof choice?.message?.content === "string" && choice.message.content.trim().startsWith("{"),
          jsonKeys: value && typeof value === "object" ? Object.keys(value) : null,
          replyType: typeof value?.reply, replyLength: typeof value?.reply === "string" ? value.reply.length : null,
          selectionType: value?.selection === null ? "null" : typeof value?.selection,
          selectionKeys: value?.selection && typeof value.selection === "object" ? Object.keys(value.selection) : null });
      }
      return response;
    },
  });
  base = "http://127.0.0.1:" + await app.listen(0);
});
afterAll(async () => {
  await app?.close();
  mkdirSync(".tmp/conversation-2026-10-12", { recursive: true });
  writeFileSync(".tmp/conversation-2026-10-12/live-report-" + new Date().toISOString().replace(/[:.]/g,"-") + ".json",
    JSON.stringify({ checkedAt: new Date().toISOString(), realProvider: "deepseek_official", observations }, null, 2));
});

async function chat(content: string, history: BoothChatMessage[] = []) {
  const response = await fetch(base + "/api/booth/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [...history, { role: "user", content }] }) });
  const advice = await response.json() as BoothAdvice;
  const snapshot = await (await fetch(base + "/api/booth")).json() as BoothSnapshot;
  observations.push({ event: "http_result",
    status: response.status, selection: advice.selection ?? null, taskCount: snapshot.tasks.length });
  expect(snapshot.tasks.length).toBe(0);
  return { response, advice, snapshot };
}

it("真实 DeepSeek：这里有什么正常介绍当前目录，不选品、不发单", async () => {
  const { response, advice, snapshot } = await chat("这里有什么？");
  expect(response.status).toBe(200);
  expect(advice.selection).toBeNull();
  expect(snapshot.products.every(product => advice.reply.includes(product.name))).toBe(true);
}, 60000);

it("真实 DeepSeek：目录和身份连续澄清仍正常回复，不选品、不发单", async () => {
  const history: BoothChatMessage[] = [];
  for (const content of ["这里有什么？", "你是谁", "你好", "你能帮我做什么？", "介绍一下每种物品", "那有什么可以选？"]) {
    const { response, advice } = await chat(content, history);
    expect(response.status).toBe(200);
    expect(advice.selection).toBeNull();
    history.push({ role: "user", content }, { role: "assistant", content: advice.reply });
  }
}, 180000);

it("真实 DeepSeek：偏离取物业务的问题得到友好引导，不作为技术故障", async () => {
  const { response, advice } = await chat("帮我写一个炒股赚钱的方案");
  expect(response.status).toBe(200);
  expect(advice.selection).toBeNull();
  expect(advice.reply).toMatch(/物品|选品|取物|展会/);
  expect(advice.reply).not.toMatch(/服务故障|未能给出有效建议/);
}, 60000);

it("真实 DeepSeek：你是谁正常说明接待助手身份，不选品、不发单", async () => {
  const { response, advice } = await chat("你是谁");
  expect(response.status).toBe(200);
  expect(advice.selection).toBeNull();
  expect(/助手|接待/.test(advice.reply)).toBe(true);
}, 60000);

it("真实 DeepSeek：需求或数量不明确时先澄清，明确两瓶水才形成候选", async () => {
  for (const content of ["我想喝点什么", "给我矿泉水"]) {
    const { response, advice } = await chat(content);
    expect(response.status).toBe(200);
    expect(advice.selection).toBeNull();
    expect(advice.reply).toMatch(/哪|几|多少|数量|想|选择|确认/);
  }
  const { response, advice } = await chat("请给我两瓶矿泉水");
  expect(response.status).toBe(200);
  expect(advice.selection).toEqual({ productId: "water", count: 2 });
  const first = await chat("给我矿泉水");
  const followup = await chat("两瓶", [{ role: "user", content: "给我矿泉水" }, { role: "assistant", content: first.advice.reply }]);
  expect(followup.response.status).toBe(200);
  expect(followup.advice.selection).toEqual({ productId: "water", count: 2 });
}, 180000);

it("真实 DeepSeek：输出被截断时保留技术错误，不责怪访客表达", async () => {
  const config = readBoothConfig();
  const limited = createBoothApplication({ ...config, aiProvider: "deepseek", databasePath: ":memory:", dispatchUrl: undefined }, {
    // Fault injection changes only the outbound token budget. The response is
    // still supplied by the official API, not replaced with a fixture.
    assistantTransport: (url, options) => fetch(url, { ...options,
      body: JSON.stringify({ ...JSON.parse(String(options?.body)), max_tokens: 1 }) }),
    onAiCall: event => { observations.push(event); },
  });
  const url = "http://127.0.0.1:" + await limited.listen(0);
  try {
    const response = await fetch(url + "/api/booth/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "这里有什么？" }] }) });
    expect(response.status).toBe(502);
    expect((await response.json()).data).toBe("智能助手回复暂时无法处理，请稍后重试或直接选择物品");
    expect(observations).toContainEqual(expect.objectContaining({ upstreamStatus: 200, category: "invalid_output" }));
    expect((await (await fetch(url + "/api/booth")).json()).tasks).toEqual([]);
  } finally { await limited.close(); }
}, 60000);

it("真实 DeepSeek：供应商拒绝错误模型配置时返回技术故障并保留安全诊断", async () => {
  const failed = createBoothApplication({ ...readBoothConfig(), aiProvider: "deepseek", deepseekModel: "bluesword-invalid-model-for-live-test",
    databasePath: ":memory:", dispatchUrl: undefined }, { onAiCall: event => { observations.push(event); } });
  const url = "http://127.0.0.1:" + await failed.listen(0);
  try {
    const response = await fetch(url + "/api/booth/chat", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "这里有什么？" }] }) });
    expect(response.status).toBe(502);
    expect((await response.json()).data).toBe("智能助手暂不可用，请直接选择物品");
    expect(observations).toContainEqual(expect.objectContaining({ outcome: "failed", category: "configuration", structureValidated: false }));
    expect((await (await fetch(url + "/api/booth")).json()).tasks).toEqual([]);
  } finally { await failed.close(); }
}, 60000);
});
