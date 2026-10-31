import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoothConfig, type BoothConfig } from "./config.js";
import { createBoothApplication } from "./server.js";
import { ApplicationStorage } from "../storage.js";

let app: ReturnType<typeof createBoothApplication> | undefined, robot: Server | undefined, base = "";
let receipt: boolean | null = true, received: unknown[] = [];
const directories: string[] = [];
afterEach(async () => {
  await app?.close(); app = undefined;
  if (robot) await new Promise<void>(resolve => robot!.close(() => resolve()));
  robot = undefined; receipt = true; received = [];
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function config(): Promise<BoothConfig> {
  robot = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    if (receipt === null) { res.destroy(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: receipt, data: receipt ? "received" : "未受理" }));
  });
  await new Promise<void>(resolve => robot!.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "booth-inventory-")); directories.push(directory);
  return { ...readBoothConfig(), databasePath: join(directory, "state.sqlite"), mode: "http", catalogConfirmed: true,
    dispatchUrl: `http://127.0.0.1:${(robot.address() as { port: number }).port}/api/task/dispatch`,
    operatorToken: "test-operator", openaiKey: undefined, deepseekKey: undefined };
}
async function start(configuration: BoothConfig, options: Parameters<typeof createBoothApplication>[1] = {}) {
  app = createBoothApplication(configuration, options); base = "http://127.0.0.1:" + await app.listen(0);
}
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(base + path,
  { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const order = (requestId: string, count = 1) => ({ requestId, productId: "water", count });
const snapshot = async () => (await fetch(base + "/api/booth")).json();
const recoveryTarget = async () => {const s=await snapshot();return {expectedTaskId:s.active?.id??null,expectedAlert:s.alert};};
const remaining = async () => (await snapshot()).products.find((p: { id: string }) => p.id === "water").availableCount;

describe("剩余库存 HTTP 边界", () => {
  it.each(["openai","deepseek"] as const)("%s：连续取完补货后省略追加不受旧缺货回复影响，确认才扣库存",async provider=>{
    const configuration=await config();
    const product={...configuration.products[0]!,id:'shuttlecock_tube',name:'羽毛球',initialStock:2,maxCount:2};
    let modelCalls=0;
    await start({...configuration,products:[product],aiProvider:provider,openaiKey:'fixture',deepseekKey:'fixture'},{assistantTransport:async()=>{
      modelCalls++;
      const output=JSON.stringify({reply:'羽毛球已取完，暂时无法取物。',selection:null,taskStatusQuery:false,intent:null});
      return Response.json(provider==='openai'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:output}]}]}:{choices:[{finish_reason:'stop',message:{content:output}}]});
    }});
    const stock=()=>app!.service.products()[0]!.availableCount;
    const ask=(input:string,currentSelection=[{productId:product.id,count:1}])=>post('/api/booth/chat',{currentSelection,messages:[{role:'assistant',content:'羽毛球已取完，请补货。'},{role:'user',content:input}]}).then(r=>r.json());
    for(let cycle=0;cycle<2;cycle++) {
      for(let i=0;i<2;i++) {
        expect((await post('/api/booth/requests',{requestId:`refill-${cycle}-${i}`,items:[{productId:product.id,count:1}]})).status).toBe(200);
        await post('/api/task/finished',{});
      }
      expect(stock()).toBe(0);
      expect((await ask('一桶羽毛球',[])).reply).toContain('已取完');
      expect((await post('/api/booth/operator/stock/reset',{productId:product.id,confirmation:'已核对并补满库存'},{'X-Operator-Token':'test-operator'})).status).toBe(200);
    }
    for(const input of ['一桶羽毛球','我要一桶羽毛球'])expect((await ask(input,[])).selection).toEqual([{productId:product.id,count:1}]);
    for(const input of ['再来一桶','再取一桶','改成两桶','两桶羽毛球','我要两桶羽毛球'])expect((await ask(input)).selection).toEqual([{productId:product.id,count:2}]);
    expect(modelCalls).toBeGreaterThan(0);
    expect(stock()).toBe(2);expect(received).toHaveLength(4);
    const request={requestId:'confirm-refill-two',items:[{productId:product.id,count:2}]};
    expect((await post('/api/booth/requests',request)).status).toBe(200);
    expect((await post('/api/booth/requests',request)).status).toBe(200);
    expect(stock()).toBe(0);expect(received).toHaveLength(5);
    expect((await ask('再来一桶')).reply).toContain('已提交');
    await post('/api/task/finished',{});
    expect((await ask('再来一桶')).reply).toContain('已取完');
    expect(stock()).toBe(0);
  });
  it("重复请求与重复完成不重复扣减，并发请求不超卖", async () => {
    await start(await config());
    const first = await (await post("/api/booth/requests", order("inventory-repeat", 2))).json();
    expect(await (await post("/api/booth/requests", order("inventory-repeat", 2))).json()).toEqual(first);
    expect(await remaining()).toBe(1);
    await post("/api/task/finished", {}); await post("/api/task/finished", {});
    expect(await remaining()).toBe(1);
    const responses = await Promise.all([post("/api/booth/requests", order("inventory-last-a")), post("/api/booth/requests", order("inventory-last-b"))]);
    expect(responses.map(response => response.status).sort()).toEqual([200,409]);
    expect(await remaining()).toBe(0);
    await post("/api/task/finished", {});
    expect((await post("/api/booth/requests", order("inventory-repeat", 2))).status).toBe(200);
    expect(await remaining()).toBe(0); expect(received).toHaveLength(2);
  });
  it("取两瓶后只剩一瓶，超量请求不发送给机器人", async () => {
    await start(await config());
    expect(await remaining()).toBe(3);
    expect((await post("/api/booth/requests", order("inventory-two", 2))).status).toBe(200);
    expect(await remaining()).toBe(1);
    await post("/api/task/finished", {});
    expect(await remaining()).toBe(1);
    const excess = await post("/api/booth/requests", order("inventory-excess", 2));
    expect(excess.status).toBe(409); expect((await excess.json()).data).toMatch(/剩余|只剩/);
    expect(received).toEqual([{items:[{ location: "货架1-2层", item: "water", count: 2 }]}]);
  });
  it("明确拒绝退回预留，受理不明、故障及人工解除不自动补回", async () => {
    await start(await config());
    receipt = false; await post("/api/booth/requests", order("inventory-refusal", 2));
    expect(await remaining()).toBe(3);
    receipt = null; await post("/api/booth/requests", order("inventory-uncertain"));
    expect(await remaining()).toBe(2);
    await post("/api/booth/operator/resolve", { confirmation:"已核对机器人停止",...await recoveryTarget()}, { "X-Operator-Token": "test-operator" });
    expect(await remaining()).toBe(2);
    receipt = true; await post("/api/booth/requests", order("inventory-fault"));
    await post("/api/task/error", { message: "测试：抓取中故障" });
    expect(await remaining()).toBe(1);
    await post("/api/booth/operator/resolve", { confirmation:"已核对机器人停止",...await recoveryTarget()}, { "X-Operator-Token": "test-operator" });
    expect(await remaining()).toBe(1);
  });
  it("重启保留剩余数量和受理不明的预留，修改初始配置不自动补满", async () => {
    const configuration = await config(); await start(configuration);
    await post("/api/booth/requests", order("inventory-before-restart", 2)); await post("/api/task/finished", {});
    await app!.close(); app = undefined; await start(configuration);
    expect(await remaining()).toBe(1);
    receipt = null; await post("/api/booth/requests", order("inventory-unconfirmed"));
    await app!.close(); app = undefined;
    await start({ ...configuration, products: configuration.products.map(p => ({ ...p, initialStock: 10 })) });
    expect(await remaining()).toBe(0); expect((await snapshot()).active.status).toBe("uncertain");
  });
  it("首次启用库存时为历史未结束任务保留数量，不从历史完成记录猜测现场库存", async () => {
    const configuration = await config(), storage = new ApplicationStorage(configuration.databasePath);
    const task = { id: "legacy-task", requestId: "legacy-request", productId: "water", status: "submitting",
      command: { item: "矿泉水", location: "货架1-2层", count: 2 }, message: "等待受理",
      createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" };
    storage.set("booth_tasks", task.id, task); storage.set("booth", "active", task.id); storage.close();
    await start(configuration);
    expect(await remaining()).toBe(1); expect((await snapshot()).active.status).toBe("uncertain");
    await app!.close(); app = undefined; await start(configuration);
    expect(await remaining()).toBe(1); expect(received).toHaveLength(0);
  });
  it("补货重置需要凭据及现场确认，任务和告警不阻止重置，完成记录保留", async () => {
    const configuration = await config(); await start(configuration);
    const resetBody = { productId: "water", confirmation: "已核对并补满库存" }, staff = { "X-Operator-Token": "test-operator" };
    const reset = (headers: Record<string,string> = staff, body: unknown = resetBody) => post("/api/booth/operator/stock/reset", body, headers);
    expect((await reset({})).status).toBe(403);
    expect((await reset(staff, { ...resetBody, confirmation: "" })).status).toBe(400);
    await post("/api/booth/requests", order("inventory-before-refill", 2));
    expect((await reset()).status).toBe(200);
    await post("/api/task/error", { message: "测试：库存未确认" }); expect((await reset()).status).toBe(200);
    await post("/api/booth/operator/resolve", { confirmation:"已核对机器人停止",...await recoveryTarget()}, staff);
    await post("/api/task/error", { message: "测试：全局告警" }); expect((await reset()).status).toBe(200);
    await post("/api/booth/operator/resolve", { confirmation:"已核对机器人停止",...await recoveryTarget()}, staff);
    const history = (await snapshot()).tasks;
    const response = await reset(); expect(response.status).toBe(200);
    expect((await response.json()).products.find((p: { id: string }) => p.id === "water").availableCount).toBe(3);
    expect((await snapshot()).tasks).toEqual(history);
    await app!.close(); app = undefined; await start({ ...configuration, operatorToken: undefined });
    expect((await reset()).status).toBe(503); expect(await remaining()).toBe(3);
  });
  it("全部补货一次恢复各物品配置数量，保留任务记录且重启后保留", async () => {
    const configuration = await config(); await start(configuration);
    await post("/api/booth/requests", order("bulk-water", 2)); await post("/api/task/finished");
    await post("/api/booth/requests", { requestId:"bulk-snack", productId:"snack", count:1 }); await post("/api/task/finished");
    const history = (await snapshot()).tasks;
    const response = await post("/api/booth/operator/stock/reset-all", {confirmation:"已核对并补满全部库存"}, {"X-Operator-Token":"test-operator"});
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.products.map((p: {availableCount:number})=>p.availableCount)).toEqual([3,3,2,1]);
    expect(state.tasks).toEqual(history);
    await app!.close(); app = undefined; await start(configuration);
    expect((await snapshot()).products.map((p: {availableCount:number})=>p.availableCount)).toEqual([3,3,2,1]);
    expect((await snapshot()).tasks).toEqual(history);
  });
  it("全部补货需要独立确认与凭据，任务和告警时可补货但不解除任务限制", async () => {
    const configuration = await config(); await start(configuration);
    await post("/api/booth/requests", order("bulk-guard-water", 2)); await post("/api/task/finished");
    await post("/api/booth/requests", {requestId:"bulk-guard-snack",productId:"snack",count:1}); await post("/api/task/finished");
    const staff = {"X-Operator-Token":"test-operator"}, body = {confirmation:"已核对并补满全部库存"};
    const denied = async (status:number, headers:Record<string,string>=staff, input:unknown=body) => {
      const products = (await snapshot()).products;
      expect((await post("/api/booth/operator/stock/reset-all",input,headers)).status).toBe(status);
      expect((await snapshot()).products).toEqual(products);
    };
    await denied(403, {}); await denied(403, {"X-Operator-Token":"incorrect"});
    await denied(400, staff, {confirmation:"已核对并补满库存"});
    await post("/api/booth/requests", {requestId:"bulk-guard-active",productId:"gift",count:1}); expect((await post("/api/booth/operator/stock/reset-all",body,staff)).status).toBe(200);
    expect((await snapshot()).active.status).toBe("executing");
    await post("/api/task/error", {message:"测试：批量补货前核对"}); expect((await post("/api/booth/operator/stock/reset-all",body,staff)).status).toBe(200);
    await post("/api/booth/operator/resolve", {confirmation:"已核对机器人停止",...await recoveryTarget()}, staff);
    await post("/api/task/error", {message:"测试：全局告警"}); expect((await post("/api/booth/operator/stock/reset-all",body,staff)).status).toBe(200);
    await post("/api/booth/operator/resolve", {confirmation:"已核对机器人停止",...await recoveryTarget()}, staff);
    await app!.close(); app = undefined; await start({...configuration,operatorToken:undefined});
    await denied(503);
  });
  it.each(["openai","deepseek"] as const)("%s使用当前库存，超量建议转为正常拒绝回复而不偷偷改小数量", async provider => {
    let sent: Record<string,any> = {};
    const transport: typeof fetch = async (_url, init) => {
      sent = JSON.parse(init!.body as string);
      const output = JSON.stringify({ reply: "请确认两瓶水", selection: null, intent:{kind:"choose",items:[{productId:"water",count:2}]}, taskStatusQuery: false });
      return Response.json(provider === "openai"
        ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: output }] }] }
        : { choices: [{ finish_reason: "stop", message: { content: output } }] });
    };
    await start({ ...await config(), aiProvider:provider, openaiKey:"fixture", deepseekKey:"fixture" }, { assistantTransport:transport });
    await post("/api/booth/requests", order("inventory-ai-used", 2)); await post("/api/task/finished", {});
    const response = await post("/api/booth/chat", { messages: [{ role:"user", content:"我想取两瓶水" }] });
    expect(response.status).toBe(200);
    const advice = await response.json(); expect(advice.selection).toBeNull(); expect(advice.reply).toMatch(/只剩 1/); expect(advice.reply).toContain("2");
    const instructions = provider === "openai" ? sent.instructions : sent.messages[0].content;
    expect(instructions).not.toContain('availableCount'); expect(instructions).toContain("不把超出范围的数量偷偷改小");
    expect(await remaining()).toBe(1); expect(received).toHaveLength(1);
  });
  it.each(["openai","deepseek"] as const)("%s回复等待期间库存变化时重新核对，售罄建议也不能选取", async provider => {
    let changeDuringReply = true, suggestion = 2;
    const transport: typeof fetch = async () => {
      if (changeDuringReply) {
        await post("/api/booth/requests", order("inventory-during-ai", 2)); await post("/api/task/finished", {});
      }
      const output = JSON.stringify({ reply:"请确认取物", selection:null,intent:{kind:"choose",items:[{productId:"water",count:suggestion}]},taskStatusQuery:false });
      return Response.json(provider === "openai"
        ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:output}]}]}
        : {choices:[{finish_reason:"stop",message:{content:output}}]});
    };
    await start({ ...await config(), aiProvider:provider, openaiKey:"fixture", deepseekKey:"fixture" }, {assistantTransport:transport});
    const chat = () => post("/api/booth/chat",{messages:[{role:"user",content:"请给我水"}]}).then(response=>response.json());
    const stale = await chat(); expect(stale.selection).toBeNull(); expect(stale.reply).toMatch(/只剩 1/);
    changeDuringReply = false; suggestion = 1;
    expect((await chat()).selection).toEqual([{productId:"water",count:1}]);
    await post("/api/booth/requests",order("inventory-ai-last")); await post("/api/task/finished",{});
    const empty = await chat(); expect(empty.selection).toBeNull(); expect(empty.reply).toContain("已取完");
    expect((await post("/api/booth/requests",order("inventory-ai-empty"))).status).toBe(409);
    expect(await remaining()).toBe(0); expect(received).toHaveLength(2);
  });
});
