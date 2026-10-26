import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBoothConfig, type BoothConfig } from "./config.js";
import { createBoothApplication } from "./server.js";
import { ApplicationStorage } from "../storage.js";

let app: ReturnType<typeof createBoothApplication> | undefined;
let base = "", received: unknown[] = [], pendingReply: ServerResponse | undefined;
let hold = false, accepted = true;
const robot = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  received.push(JSON.parse(body));
  if (hold) { pendingReply = res; return; }
  res.end(JSON.stringify({success: accepted, data: "received"}));
});
let directory = "";
afterEach(async () => {
  pendingReply?.destroy(); pendingReply = undefined;
  await app?.close(); app = undefined;
  if (robot.listening) await new Promise<void>(resolve => robot.close(() => resolve()));
  if (directory) rmSync(directory, {recursive: true, force: true});
  received = []; hold = false; accepted = true;
});
async function setup(initialStock = 1) {
  await new Promise<void>(resolve => robot.listen(0, "127.0.0.1", resolve));
  directory = mkdtempSync(join(tmpdir(), "booth-integration-"));
  const source = readBoothConfig();
  const config: BoothConfig = {...source, mode: "http", catalogConfirmed: true, operatorToken: "integration-staff",
    robotTimeoutMs: 10000, databasePath: join(directory, "state.sqlite"),
    dispatchUrl: `http://127.0.0.1:${(robot.address() as {port:number}).port}/api/task/dispatch`,
    products: [
      {...source.products[0]!, id: "playing_card_box", name: "扑克牌", art: "playing_card_box", location: "练习架1", initialStock, maxCount: 3},
      {...source.products[0]!, id: "pen_box", name: "圆珠笔", art: "pen_box", location: "练习架2", initialStock, maxCount: 3},
    ]};
  await start(config); return config;
}
async function start(config: BoothConfig, options: Parameters<typeof createBoothApplication>[1] = {}) {
  app = createBoothApplication(config,options); base = "http://127.0.0.1:" + await app.listen(0);
}
const post = (path: string, body: unknown, staff = false) => fetch(base + path, {method: "POST",
  headers: {"Content-Type": "application/json", ...(staff ? {"X-Operator-Token":"integration-staff"} : {})}, body: JSON.stringify(body)});
const snapshot = async () => (await fetch(base + "/api/booth")).json();
const order = (requestId: string, items = [{productId:"playing_card_box",count:1}]) => ({requestId, items});

it("确认一件扑克牌后机器人收到v1.1编码，接单后等待整单通知", async () => {
  await setup();
  expect((await post("/api/booth/requests", order("single-card"))).status).toBe(200);
  expect(received).toEqual([{items:[{location:"练习架1",item:"playing_card_box",count:1}]}]);
  expect((await snapshot()).active.status).toBe("executing");
  await post("/api/task/finished", {});
  expect((await snapshot()).tasks[0].status).toBe("succeeded");
});

it.each(["openai","deepseek"] as const)("%s 给两项建议但不发单，超量或清单外建议不进入确认", async aiProvider => {
  const config=await setup(3);await app!.close();
  let selection:unknown=[{productId:"playing_card_box",count:1},{productId:"pen_box",count:1}];
  const assistantTransport:typeof fetch=async (_url,init)=>{
    const request=JSON.parse(String(init?.body));
    const instructions=request.instructions??request.messages[0].content;
    expect(instructions).toContain("每单总数最多两件");
    expect(instructions).not.toContain('"maxCount":3');
    const advice={reply:"请核对所选物品。",selection,taskStatusQuery:false};
    return Response.json(aiProvider==="openai"?{status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(advice)}]}]}:{choices:[{finish_reason:"stop",message:{content:JSON.stringify(advice)}}]});
  };
  await start({...config,aiProvider,openaiKey:"local-fixture",deepseekKey:"local-fixture"},{assistantTransport});
  const chat=()=>post("/api/booth/chat",{messages:[{role:"user",content:"扑克牌和圆珠笔各一件"}]});
  const result=await chat();expect(result.status).toBe(200);expect((await result.json()).selection).toEqual(selection);
  expect(received).toHaveLength(0);expect((await snapshot()).tasks).toHaveLength(0);
  selection=[{productId:"playing_card_box",count:3}];expect((await chat()).status).toBe(502);
  selection=[{productId:"outside",count:1}];expect((await chat()).status).toBe(502);
});

it("确认两件扑克牌后只下发一项，目录上限三件也不能突破整单两件", async () => {
  await setup(3);
  expect((await post("/api/booth/requests", order("three-cards",[{productId:"playing_card_box",count:3}]))).status).toBe(400);
  expect((await post("/api/booth/requests", order("two-cards",[{productId:"playing_card_box",count:2}]))).status).toBe(200);
  expect(received).toEqual([{items:[{location:"练习架1",item:"playing_card_box",count:2}]}]);
});

it("两种各一件作为整单预留，重启及再次核对同一次取物不重复发单", async () => {
  const config = await setup();
  const request = order("two-products",[{productId:"playing_card_box",count:1},{productId:"pen_box",count:1}]);
  expect((await post("/api/booth/requests", request)).status).toBe(200);
  expect(received).toEqual([{items:[{location:"练习架2",item:"pen_box",count:1},{location:"练习架1",item:"playing_card_box",count:1}]}]);
  await app!.close(); await start(config);
  expect((await post("/api/booth/requests", {...request,items:[...request.items].reverse()})).status).toBe(200);
  const state = await snapshot();
  expect(state.tasks).toHaveLength(1); expect(state.active.status).toBe("executing");
  expect(state.products.map((p:{availableCount:number})=>p.availableCount)).toEqual([0,0]);
  expect(received).toHaveLength(1);
});

it("等待接单时只补扑克牌，迟到拒绝只退圆珠笔且重启不重复退回", async () => {
  const config = await setup();
  await app!.close(); const upgraded = {...config,products:config.products.map(p=>({...p,initialStock:10}))}; await start(upgraded);
  hold=true;
  const request=order("restock-pending",[{productId:"playing_card_box",count:1},{productId:"pen_box",count:1}]);
  const response=post("/api/booth/requests",request);
  await expect.poll(()=>!!pendingReply).toBe(true);
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([0,0]);
  expect((await post("/api/booth/operator/stock/reset",{productId:"playing_card_box",confirmation:"已核对并补满库存"},true)).status).toBe(200);
  expect((await snapshot()).active.status).toBe("submitting");
  pendingReply!.end(JSON.stringify({success:false}));pendingReply=undefined;
  expect((await response).status).toBe(200);
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([10,1]);
  await app!.close();await start(upgraded);
  await post("/api/booth/requests",request);
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([10,1]);
  expect(received).toHaveLength(1);
});

it("确认前圆珠笔取完，整单拒绝且扑克牌不被单独预留", async () => {
  await setup();
  await post("/api/booth/requests",order("take-last-pen",[{productId:"pen_box",count:1}]));await post("/api/task/finished",{});
  const request=order("late-shortage",[{productId:"playing_card_box",count:1},{productId:"pen_box",count:1}]);
  expect((await post("/api/booth/requests",request)).status).toBe(409);
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([1,0]);
  for(const items of [[],[{productId:"outside",count:1}],[{productId:"playing_card_box",count:1},{productId:"playing_card_box",count:1}],[{productId:"playing_card_box",count:2},{productId:"pen_box",count:1}]]){
    expect((await post("/api/booth/requests",order("invalid-selection",items))).status).toBe(400);
  }
  expect(received).toHaveLength(1);
});

it("已有单物品数据库升级后保留历史报文和库存，即使目录变更仍能核对原请求", async () => {
  const config=await setup();await app!.close();app=undefined;
  const storage=new ApplicationStorage(config.databasePath),id="legacy-task",requestId="legacy-order";
  const legacy={id,requestId,productId:"playing_card_box",command:{location:"旧货架",item:"扑克牌",count:3},status:"submitting",message:"等待接单",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  storage.set("booth_tasks",id,legacy);storage.set("booth_requests",requestId,id);storage.set("booth","active",id);storage.close();
  await start({...config,products:config.products.filter(p=>p.id!=="playing_card_box")});
  const result=await post("/api/booth/requests",order(requestId,[{productId:"playing_card_box",count:3}]));
  expect(result.status).toBe(200);expect((await result.json()).task).toMatchObject({id,status:"uncertain",command:{items:[legacy.command]}});
  expect((await snapshot()).tasks).toHaveLength(1);expect(received).toHaveLength(0);
});

it("全部补货到10后收到迟到拒绝，重复补货和重启后仍为10", async () => {
  const config=await setup();await app!.close();const updated={...config,products:config.products.map(p=>({...p,initialStock:10}))};await start(updated);
  hold=true;const request=order("all-reset-reject");const response=post("/api/booth/requests",request);await expect.poll(()=>!!pendingReply).toBe(true);
  for(let i=0;i<2;i++)expect((await post("/api/booth/operator/stock/reset-all",{confirmation:"已核对并补满全部库存"},true)).status).toBe(200);
  pendingReply!.end(JSON.stringify({success:false}));pendingReply=undefined;await response;
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([10,10]);
  await app!.close();await start(updated);await post("/api/booth/requests",request);
  expect((await snapshot()).products.map((p:{availableCount:number})=>p.availableCount)).toEqual([10,10]);
});

it.each(["finished","error"])("等待结果时补货，重启后收到%s通知不重复结算库存", async kind => {
  const config=await setup(10);await post("/api/booth/requests",order("reset-before-result"));
  expect((await post("/api/booth/operator/stock/reset-all",{confirmation:"已核对并补满全部库存"},true)).status).toBe(200);
  expect((await snapshot()).active.status).toBe("executing");
  expect((await post("/api/booth/requests",order("blocked-after-reset"))).status).toBe(409);
  await app!.close();await start(config);await post("/api/task/"+kind,kind==="error"?{message:"本机故障"}:{});
  const state=await snapshot();expect(state.products.map((p:{availableCount:number})=>p.availableCount)).toEqual([10,10]);
  expect(state.tasks[0].status).toBe(kind==="error"?"fault":"succeeded");
});

it("明确要求三件或两加一时，模型即使建议一件也不能进入确认区", async () => {
  const config=await setup(3);await app!.close();
  await start(config,{assistant:{async advise(){return {reply:"可以取三件",selection:[{productId:"playing_card_box",count:1}],taskStatusQuery:false};}}});
  for(const content of ["我要3份扑克牌。","请给我三件扑克牌","取两份扑克牌和一支圆珠笔","我要两种物品各两件","我要三种物品各一件","我要2种物品各2件","我要10种各1件"]){
    const response=await post("/api/booth/chat",{messages:[{role:"user",content}]});expect(response.status).toBe(200);
    expect(await response.json()).toEqual({reply:"每单最多两件，请重新确认想取的物品和数量。",selection:null});
  }
  for(const content of ["我昨天取了三件，今天只取一件扑克牌","我要一副扑克牌，不是三副","我要一副扑克牌和一支圆珠笔，共两件","我要两件：一副扑克牌和一支圆珠笔","我要两副扑克牌，2副就够了","我要一副扑克牌或者两支圆珠笔","我要的3件物品取好了吗？"]){
    const response=await post("/api/booth/chat",{messages:[{role:"user",content}]});
    expect((await response.json()).selection).toEqual([{productId:"playing_card_box",count:1}]);
  }
  expect(received).toHaveLength(0);
});
