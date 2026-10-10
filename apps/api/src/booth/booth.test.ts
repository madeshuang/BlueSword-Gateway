import {createServer,type Server} from "node:http";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {readBoothConfig,validateCatalog,type BoothConfig} from "./config.js";
import {createBoothApplication} from "./server.js";
import {OpenAIBoothAssistant} from "./openai.js";
import {ApplicationStorage} from "../storage.js";

type App=ReturnType<typeof createBoothApplication>;
let app:App|undefined,robot:Server|undefined,base="",received:unknown[]=[];
const directories:string[]=[];
afterEach(async()=>{await app?.close();app=undefined;if(robot){await new Promise<void>(resolve=>robot!.close(()=>resolve()));robot=undefined;}vi.restoreAllMocks();vi.unstubAllEnvs();received=[];for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
function config(overrides:Partial<BoothConfig>={}):BoothConfig{return {...readBoothConfig(),databasePath:":memory:",mode:"http",catalogConfirmed:true,operatorToken:"test-operator",...overrides};}
async function fakeRobot(reply:{success:boolean;data:string}={success:true,data:"received"},beforeReply?:()=>Promise<void>){
  robot=createServer(async(req,res)=>{let body="";for await(const c of req)body+=c;received.push({method:req.method,path:req.url,body:JSON.parse(body)});await beforeReply?.();res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({code:1,...reply}));});
  await new Promise<void>(resolve=>robot!.listen(0,"127.0.0.1",resolve));return "http://127.0.0.1:"+((robot!.address() as {port:number}).port)+"/api/task/dispatch";
}
async function start(c:BoothConfig){app=createBoothApplication(c);base="http://127.0.0.1:"+await app.listen(0);}
async function post(path:string,body:unknown={},headers:Record<string,string>={}){return fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
const command=(requestId="request-one",count=1,productId="water")=>({requestId,count,productId});

describe("正式三接口与任务事实",()=>{
  it("发送且仅发送三字段；受理不完成；完成与重复完成按示例确认",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const response=await post("/api/booth/requests",command());expect(response.status).toBe(200);
    expect((await response.json()).task.status).toBe("executing");
    expect(received).toEqual([{method:"POST",path:"/api/task/dispatch",body:{location:"货架1-2层",item:"矿泉水",count:1}}]);
    for(const payload of [{result:"success"},{}])expect(await (await post("/api/task/finished",payload)).json()).toEqual({code:1,data:"OK",success:true});
    expect(app!.service.snapshot().active).toBeNull();expect(app!.service.snapshot().tasks[0]!.status).toBe("succeeded");
    expect(received).toHaveLength(1);
  });
  it("code为1仍按success:false拒绝，保留可读原因且释放占用",async()=>{
    await start(config({dispatchUrl:await fakeRobot({success:false,data:"机械臂忙碌"})}));
    const body=await (await post("/api/booth/requests",command())).json();
    expect(body.task).toMatchObject({status:"rejected",message:"机械臂忙碌"});expect(app!.service.active()).toBeNull();
  });
  it("同键同时提交只发一次，不同参数冲突，另一访客被阻止",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const responses=await Promise.all([post("/api/booth/requests",command()),post("/api/booth/requests",command())]);
    expect(responses.every(r=>r.ok)).toBe(true);expect(received).toHaveLength(1);
    expect((await post("/api/booth/requests",command("request-one",2))).status).toBe(409);
    expect((await post("/api/booth/requests",command("request-two"))).status).toBe(409);
    expect(received).toHaveLength(1);
  });
  it("提前完成回调不能被随后受理回执覆盖",async()=>{
    const url=await fakeRobot({success:true,data:"received"},async()=>{await post("/api/task/finished",{result:"success"});});
    await start(config({dispatchUrl:url}));expect((await (await post("/api/booth/requests",command())).json()).task.status).toBe("succeeded");
  });
  it("提前故障和重复故障可见、不解锁；操作凭据和现场确认缺一不可",async()=>{
    const url=await fakeRobot({success:true,data:"received"},async()=>{await post("/api/task/error",{message:"机械臂故障"});});
    await start(config({dispatchUrl:url}));expect((await (await post("/api/booth/requests",command())).json()).task.status).toBe("fault");
    expect(await (await post("/api/task/error",{message:"机械臂故障"})).json()).toEqual({code:1,data:"OK",success:true});
    expect((await post("/api/booth/requests",command("request-two"))).status).toBe(409);
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止"})).status).toBe(403);
    expect((await post("/api/booth/operator/resolve",{},{"X-Operator-Token":"test-operator"})).status).toBe(400);
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止"},{"X-Operator-Token":"test-operator"})).status).toBe(200);
    expect(app!.service.snapshot().active).toBeNull();expect(app!.service.snapshot().tasks[0]!.status).toBe("resolved");
  });
  it("响应丢失不重发、不解锁；重启与同键核对保持同一任务",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-v1-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:"http://127.0.0.1:1/api/task/dispatch"});
    await start(c);const original=(await (await post("/api/booth/requests",command())).json()).task;
    expect(original.status).toBe("uncertain");await app!.close();app=undefined;await start(c);
    expect((await (await post("/api/booth/requests",command())).json()).task.id).toBe(original.id);
    expect((await post("/api/booth/requests",command("request-two"))).status).toBe(409);
    await post("/api/task/finished",{result:"success"});expect(app!.service.active()).toBeNull();
  });
  it("持久化的提交中记录重启后变为不明，执行中不会按时间自动完成",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-restart-"));directories.push(d);const databasePath=join(d,"state.sqlite");
    const storage=new ApplicationStorage(databasePath);
    storage.set("booth","active","one");storage.set("booth_tasks","one",{id:"one",requestId:"request-one",productId:"water",command:{item:"矿泉水",location:"货架1-2层",count:1},status:"submitting",message:"待受理",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:00:00Z"});storage.close();
    await start(config({databasePath}));expect(app!.service.active()!.status).toBe("uncertain");
    expect((await post("/api/booth/requests",command("request-two"))).status).toBe(409);
  });
  it("真实目录未确认或URL缺失时零发单；错误输入不污染任务",async()=>{
    await start(config({dispatchUrl:await fakeRobot(),catalogConfirmed:false}));
    expect((await post("/api/booth/requests",command())).status).toBe(503);expect(received).toHaveLength(0);
    expect((await post("/api/booth/requests",command("request-two",0))).status).toBe(400);
    expect((await post("/api/booth/requests",command("request-two",1,"unknown"))).status).toBe(400);
    expect((await post("/api/task/finished",{result:"failed"})).status).toBe(400);
    expect((await post("/api/task/error",{message:""})).status).toBe(400);
    const malformed=await fetch(base+"/api/task/error",{method:"POST",headers:{"Content-Type":"application/json"},body:"{"});expect(malformed.status).toBe(400);
    expect(app!.service.snapshot().tasks).toHaveLength(0);
    const tooLarge=await post("/api/task/error",{message:"x".repeat(40000)});expect(tooLarge.status).toBe(413);
  });
  it("无当前任务的故障仍展示并阻止发单；孤立完成不伪造任务",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));await post("/api/task/finished");expect(app!.service.snapshot().tasks).toHaveLength(0);
    await post("/api/task/error",{message:"系统故障"});expect(app!.service.snapshot().alert).toBe("系统故障");
    expect((await post("/api/booth/requests",command())).status).toBe(409);
  });
  it("SSE传递我方真实快照，密钥不出现在快照里",async()=>{
    await start(config({openaiKey:"secret-for-test"}));const controller=new AbortController();
    const response=await fetch(base+"/api/booth/events",{signal:controller.signal});const reader=response.body!.getReader();
    const text=new TextDecoder().decode((await reader.read()).value);expect(text).toContain('"provider":"OpenAI"');expect(text).not.toContain("secret-for-test");controller.abort();await reader.cancel().catch(()=>{});
  });
});

describe("OpenAI Responses选品接入（可控对端，不冒充真实GPT）",()=>{
  const answer={reply:"为你选择矿泉水，请确认数量。",selection:{productId:"water",count:1}};
  const response=(value:unknown=answer)=>Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(value)}]}]});
  it("使用官方URL/模型/结构化输出，仅给出建议，无机器人调用",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(response());
    const ai=new OpenAIBoothAssistant(config({openaiKey:"test-key"}),transport);expect(await ai.advise([{role:"user",content:"一瓶水"}])).toEqual(answer);
    const [url,options]=transport.mock.calls[0]!;expect(url).toBe("https://api.openai.com/v1/responses");
    const body=JSON.parse(options!.body as string);expect(body.model).toBe("gpt-4.1-mini");expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({type:"json_schema",strict:true});expect(body.input[0].content).toBe("一瓶水");expect(body.tools).toBeUndefined();expect(received).toHaveLength(0);
  });
  it.each([401,429,500])("处理OpenAI HTTP %i，不泄漏上游原文或密钥",async status=>{
    const ai=new OpenAIBoothAssistant(config({openaiKey:"test-key"}),vi.fn<typeof fetch>().mockResolvedValue(new Response("test-key",{status})));
    await expect(ai.advise([{role:"user",content:"你好"}])).rejects.toThrow(/智能助手/);
  });
  it("密钥缺失、超时、未知物品、数量越界、不完整输出均显式失败",async()=>{
    await expect(new OpenAIBoothAssistant(config({openaiKey:undefined})).advise([])).rejects.toThrow("暂未连接");
    await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout"))).advise([])).rejects.toThrow("超时");
    for(const value of [{...answer,selection:{productId:"missing",count:1}},{...answer,selection:{productId:"water",count:99}}]){
      await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockResolvedValue(response(value))).advise([])).rejects.toThrow("有效建议");
    }
    await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:"incomplete"}))).advise([])).rejects.toThrow("有效建议");
  });
  it("目录配置拒绝重复ID和非法取值",()=>{
    const p=config().products[0]!;expect(()=>validateCatalog([p,p])).toThrow();expect(()=>validateCatalog([{...p,maxCount:0}])).toThrow();
  });
});
