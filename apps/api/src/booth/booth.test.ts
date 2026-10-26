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
async function start(c:BoothConfig,options:Parameters<typeof createBoothApplication>[1]={}){app=createBoothApplication(c,options);base="http://127.0.0.1:"+await app.listen(0);}
async function post(path:string,body:unknown={},headers:Record<string,string>={}){return fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
async function recoveryTarget(){const s=await (await fetch(base+"/api/booth")).json();return {expectedTaskId:s.active?.id??null,expectedAlert:s.alert};}
// Controlled supplier outputs include the new internal intent field; HTTP advice remains unchanged.
const modelOutput=(value:unknown)=>JSON.stringify(value&&typeof value==="object"?{taskStatusQuery:false,...value}:value);
const command=(requestId="request-one",count=1,productId="water")=>({requestId,count,productId});

describe("体验关联取物进度 HTTP 边界",()=>{
  it.each(["openai","deepseek"] as const)("%s回复格式或内容无效时提供重新尝试和手选提示",async provider=>{
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    for(const value of ["not JSON",JSON.stringify({reply:"",selection:null,taskStatusQuery:false})]){
      transport.mockResolvedValueOnce(Response.json(provider==="openai"
        ?{status:"completed",output:[{type:"message",content:[{type:"output_text",text:value}]}]}
        :{choices:[{finish_reason:"stop",message:{content:value}}]}));
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"这里有什么？"}]});
      expect(response.status).toBe(502);
      expect((await response.json()).data).toBe("这次没能正常回复，可以再试一次，或直接选择物品。");
    }
    expect((await(await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });
  it.each(["openai","deepseek"] as const)("%s模型繁忙时提示稍后重试和直接选品，不建立任务",async provider=>{
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    for(const status of [429,500,503]){
      transport.mockResolvedValueOnce(new Response("busy",{status}));
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"这里有什么？"}]});
      expect(response.status).toBe(502);
      expect((await response.json()).data).toBe("助手暂时繁忙，请稍后再试，也可以直接选择物品。");
    }
    expect((await(await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });
  it.each(["openai","deepseek"] as const)("%s连接失败和超时时提示稍后连接，原始错误不会发给访客",async provider=>{
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture",openaiTimeoutMs:5,deepseekTimeoutMs:5}),{assistantTransport:transport});
    transport.mockRejectedValueOnce(new Error("internal connection detail"));
    const ask=()=>post("/api/booth/chat",{messages:[{role:"user",content:"这里有什么？"}]});
    expect((await(await ask()).json()).data).toBe("暂时连不上助手，请稍后再试，也可以直接选择物品。");
    transport.mockImplementationOnce(async(_url,init)=>new Promise((_ok,fail)=>init!.signal!.addEventListener("abort",()=>fail(init!.signal!.reason),{once:true})));
    expect((await(await ask()).json()).data).toBe("暂时连不上助手，请稍后再试，也可以直接选择物品。");
    transport.mockResolvedValueOnce(new Response("gateway timeout",{status:504}));
    expect((await(await ask()).json()).data).toBe("暂时连不上助手，请稍后再试，也可以直接选择物品。");
  });
  it.each(["openai","deepseek"] as const)("%s收到响应头后连接中断仍提示连接失败，不误报回复内容无效",async provider=>{
    const observations:unknown[]=[];
    const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({start(controller){
      controller.error(new TypeError("terminated",{cause:{code:"UND_ERR_SOCKET"}}));
    }}),{status:200}));
    await start(config({aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport,onAiCall:event=>{observations.push(event);}});
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"这里有什么？"}]});
    expect(response.status).toBe(504);
    expect((await response.json()).data).toBe("暂时连不上助手，请稍后再试，也可以直接选择物品。");
    expect(observations).toContainEqual(expect.objectContaining({category:"connection",connectionCode:"UND_ERR_SOCKET",upstreamStatus:200}));
  });
  it("现场目录中的十一种插图类型可以加载并通过网页快照读取",async()=>{
    const arts=["lighter_box","playing_card_box","pen_box","bottle","table_tennis_ball_box","shuttlecock_tube","air_pump","aoliao","anmuxi","haoliyou","shupian"];
    const products=arts.map(id=>({...config().products[0]!,id,name:id,art:id}));
    validateCatalog(products);
    await start(config({products}));
    const snapshot=await(await fetch(base+"/api/booth")).json();
    expect(snapshot.products.map((p:{art:string})=>p.art)).toEqual(arts);
  });
  it.each(["openai","deepseek"] as const)("%s润色期间收到完成通知时拒绝旧状态说法，采用重新核实的结论",async provider=>{
    let finishDuringReply=false;
    const reply="已经接单了，还没收到取好通知，请再等一会儿。";
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>{
      if(finishDuringReply)await post("/api/task/finished",{});
      return Response.json(provider==="openai"
        ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({reply,selection:null,taskStatusQuery:true})}]}]}
        : {choices:[{finish_reason:"stop",message:{content:JSON.stringify({reply,selection:null,taskStatusQuery:true})}}]});
    });
    await start(config({dispatchUrl:await fakeRobot(),aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    const experience=await (await post("/api/booth/experiences")).json(),headers={"X-Booth-Experience":experience.token};
    await post("/api/booth/requests",command(),headers);
    const body={messages:[{role:"user",content:"那现在呢？"}]};
    expect(await (await post("/api/booth/chat",body,headers)).json()).toEqual({reply,selection:null});
    finishDuringReply=true;
    const current=await (await post("/api/booth/chat",body,headers)).json();expect(current.reply).toContain("取物完成通知");expect(current.reply).not.toContain("还没收到");expect(current.selection).toBeNull();
    expect(received).toHaveLength(1);
  });
  it.each(["openai","deepseek"] as const)("%s等待、执行和异常等自然说法按真实状态使用，错误完成话术被拦截",async provider=>{
    let reply="还在等机器人接单，请稍候，先不要重复确认取物。",receipt:boolean|null=true;
    let release!:()=>void,arrived!:()=>void;
    let gate=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>arrived=r);
    const robotTransport=vi.fn<typeof fetch>().mockImplementation(async()=>{arrived();await gate;if(receipt===null)throw new Error("受理反馈丢失");return Response.json({success:receipt,data:"received"});});
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json(provider==="openai"
      ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({reply,selection:null,taskStatusQuery:true})}]}]}
      : {choices:[{finish_reason:"stop",message:{content:JSON.stringify({reply,selection:null,taskStatusQuery:true})}}]}));
    await start(config({dispatchUrl:"http://127.0.0.1:1/unused",aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{transport:robotTransport,assistantTransport:transport});
    const experience=await (await post("/api/booth/experiences")).json(),headers={"X-Booth-Experience":experience.token};
    const query=async()=>await (await post("/api/booth/chat",{messages:[{role:"user",content:"那现在呢？"}]},headers)).json();
    const pending=post("/api/booth/requests",command(),headers);
    try{await started;expect(await query()).toEqual({reply,selection:null});}finally{release();}
    await pending;gate=Promise.resolve();
    reply="已经接单了，还没收到取好通知，请再等一会儿。";expect(await query()).toEqual({reply,selection:null});
    reply="已经取好了，请到交付处领取。";expect((await query()).reply).toContain("尚未收到完成通知");
    await post("/api/task/error",{message:"测试故障"});
    reply="这次取物出了异常，是否结束、机器人是否停止都还未确认。先不要重复确认取物，请联系现场工作人员协助。";
    expect(await query()).toEqual({reply,selection:null});
    reply="机械臂已经抓到了水，预计十秒后送到。";expect((await query()).reply).toContain("出现异常");
    await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},{"X-Operator-Token":"test-operator"});
    reply="工作人员已核对并解除新任务限制，但这不代表物品已经取好。领取情况请向现场工作人员确认。";
    expect(await query()).toEqual({reply,selection:null});
    reply="已经取好了，请到交付处领取。";expect((await query()).reply).toContain("这不代表取物完成");
    receipt=false;await post("/api/booth/requests",command("rejected-natural"),headers);
    reply="机器人没有接下这次取物，请核对选择，或联系现场工作人员。";expect(await query()).toEqual({reply,selection:null});
    receipt=null;await post("/api/booth/requests",command("uncertain-natural"),headers);
    reply="现在还无法确认是否接单或取好，先不要重复确认取物。请联系现场工作人员核对，机器人是否停止也尚未确认。";
    expect(await query()).toEqual({reply,selection:null});
    reply="已经取好了，请到交付处领取。";expect((await query()).reply).toContain("机器人是否接单、取物是否结束尚未确认");
    expect(robotTransport).toHaveBeenCalledTimes(3);
  });
  it.each(["openai","deepseek"] as const)("%s完成查询按原话和前文保留自然回答，不再强制播放通知",async provider=>{
    const direct="已经取好了，请到交付处领取。",followUp="现在已经取好了，到交付处领取就可以。";
    let reply=direct;
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json(provider==="openai"
      ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({reply,selection:null,taskStatusQuery:true})}]}]}
      : {choices:[{finish_reason:"stop",message:{content:JSON.stringify({reply,selection:null,taskStatusQuery:true})}}]}));
    await start(config({dispatchUrl:await fakeRobot(),aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    const experience=await (await post("/api/booth/experiences")).json(),headers={"X-Booth-Experience":experience.token};
    await post("/api/booth/requests",command(),headers);await post("/api/task/finished",{});
    const messages=[{role:"user",content:"我的东西取好了吗？"}];
    expect(await (await post("/api/booth/chat",{messages},headers)).json()).toEqual({reply:direct,selection:null});
    reply=followUp;
    const context=[...messages,{role:"assistant",content:direct},{role:"user",content:"那现在呢？"}];
    expect(await (await post("/api/booth/chat",{messages:context},headers)).json()).toEqual({reply:followUp,selection:null});
    const body=JSON.parse(transport.mock.calls.at(-1)![1]!.body as string);
    const instructions=provider==="openai"?body.instructions:body.messages[0].content;
    expect(instructions).toContain(direct);expect(instructions).toContain(followUp);
    const sent=provider==="openai"?body.input:body.messages.slice(1);
    expect(sent.at(-1)).toEqual(context.at(-1));
    expect(provider==="openai"?sent[1].content:JSON.parse(sent[1].content).reply).toBe(direct);
    expect(received).toHaveLength(1);
  });
  const progressOutput=(provider:"openai"|"deepseek",query=true)=>Response.json(provider==="openai"
    ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({reply:"模型自行猜测的结论",selection:null,taskStatusQuery:query})}]}]}
    : {choices:[{finish_reason:"stop",message:{content:JSON.stringify({reply:"模型自行猜测的结论",selection:null,taskStatusQuery:query})}}]});
  const ask=async(token?:string)=>(await (await post("/api/booth/chat",{messages:[{role:"user",content:"我的东西取好了吗？"}]},token?{"X-Booth-Experience":token}:{})).json()).reply as string;
  it.each(["openai","deepseek"] as const)("%s等待、执行、完成、异常及人工处理的结论准确，两个会话与重启后仍隔离",async provider=>{
    let release!:()=>void,arrived!:()=>void;
    const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>arrived=r);
    const dispatchUrl=await fakeRobot({success:true,data:"received"},async()=>{arrived();await gate;});
    const d=mkdtempSync(join(tmpdir(),"booth-experience-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl,aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"});
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>progressOutput(provider));
    await start(c,{assistantTransport:transport});
    const a=await (await post("/api/booth/experiences")).json(),b=await (await post("/api/booth/experiences")).json();
    const pending=post("/api/booth/requests",command(),{"X-Booth-Experience":a.token});
    try{
      await started;expect(await ask(a.token)).toContain("等待机器人回复是否接单");
      expect(await ask(b.token)).toContain("暂时无法确认");
    }finally{release();}
    const first=(await (await pending).json()).task;
    expect(await ask(a.token)).toContain("机器人已接单，尚未收到完成通知");
    await post("/api/task/finished",{result:"success"});expect(await ask(a.token)).toContain("取物完成通知");
    const second=(await (await post("/api/booth/requests",command("request-two",1,"gift"),{"X-Booth-Experience":b.token})).json()).task;
    expect(second.id).not.toBe(first.id);
    expect(await ask(a.token)).toContain("矿泉水 × 1");expect(await ask(a.token)).not.toContain("纪念品");
    expect(await ask(b.token)).toContain("纪念品 × 1");
    await post("/api/task/error",{message:"测试故障"});const fault=await ask(b.token);
    expect(fault).toContain("出现异常");expect(fault).toContain("尚未确认机器人是否停止");expect(fault).toContain("请联系现场工作人员");
    await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},{"X-Operator-Token":"test-operator"});
    expect(await ask(b.token)).toContain("这不代表取物完成");
    await app!.close();app=undefined;await start(c,{assistantTransport:transport});
    expect(await ask(a.token)).toContain("取物完成通知");expect(await ask(b.token)).toContain("解除新任务限制");
    const fresh=await (await post("/api/booth/experiences")).json();expect(await ask(fresh.token)).toContain("暂时无法确认");
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toHaveLength(2);
    // An old retry must not replace the experience's newer associated task.
    await post("/api/booth/requests",command("request-three",1,"snack"),{"X-Booth-Experience":a.token});
    await post("/api/task/finished",{});
    await post("/api/booth/requests",command(),{"X-Booth-Experience":a.token});
    expect(await ask(a.token)).toContain("小面包 × 1");expect(received).toHaveLength(3);
    for(const [,init] of transport.mock.calls){const body=JSON.parse(init!.body as string);const instructions=provider==="openai"?body.instructions:body.messages[0].content;
      expect(instructions).not.toContain(first.id);expect(instructions).not.toContain(second.id);expect(instructions).not.toContain(a.token);}
  });
  it.each([false,true])("未接单或受理未确认时不冒充完成（受理=%s）",async accepted=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(progressOutput("openai"));
    await start(config({dispatchUrl:"http://127.0.0.1:1/unused",openaiKey:"fixture"}),{
      transport:async()=>accepted?new Response("",{status:503}):Response.json({success:false,data:"未受理"}),assistantTransport:transport});
    const experience=await (await post("/api/booth/experiences")).json();
    await post("/api/booth/requests",command(),{"X-Booth-Experience":experience.token});
    const reply=await ask(experience.token);expect(reply).toContain(accepted?"尚未确认":"未接下");expect(reply).not.toContain("取物完成通知");
    if(accepted){expect(reply).toContain("请勿重复确认取物");expect(reply).toContain("尚未确认机器人是否停止");}
  });
  it("查询记录损坏时明确无法确认，不当作没有任务；模型等待期间完成则采用最新状态",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-experience-read-"));directories.push(d);
    let completeDuringCall=false;
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot(),openaiKey:"fixture"});
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>{if(completeDuringCall)await post("/api/task/finished",{});return progressOutput("openai");});
    await start(c,{assistantTransport:transport});
    const experience=await (await post("/api/booth/experiences")).json();
    const task=(await (await post("/api/booth/requests",command(),{"X-Booth-Experience":experience.token})).json()).task;
    completeDuringCall=true;expect(await ask(experience.token)).toContain("取物完成通知");completeDuringCall=false;
    const fixture=new ApplicationStorage(c.databasePath);
    try{
      fixture.db.prepare("UPDATE records SET value=? WHERE scope='booth_tasks' AND key=?").run("invalid json",task.id);
      expect(await ask(experience.token)).toBe("暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。");
    }finally{fixture.close();}
  });
  it("体验关联保存失败时任务与防重记录一同回滚，不发送机器人请求",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-experience-write-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});await start(c);
    const experience=await (await post("/api/booth/experiences")).json(),fixture=new ApplicationStorage(c.databasePath);
    try{
      fixture.db.exec("CREATE TRIGGER refuse_experience BEFORE UPDATE ON records WHEN NEW.scope='booth_experiences' BEGIN SELECT RAISE(ABORT,'injected'); END;");
      expect((await post("/api/booth/requests",command(),{"X-Booth-Experience":experience.token})).status).toBe(500);
      expect(received).toHaveLength(0);expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
      fixture.db.exec("DROP TRIGGER refuse_experience");
      expect((await post("/api/booth/requests",command(),{"X-Booth-Experience":experience.token})).status).toBe(200);
      expect(received).toHaveLength(1);
    }finally{fixture.close();}
  });
  it.each(["openai","deepseek"] as const)("%s无可靠关联时覆盖模型猜测，不把共享活动任务认作访客任务",async provider=>{
    const guessed={reply:"你的东西已取好。",selection:[{productId:"water",count:1}],taskStatusQuery:true};
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json(provider==="openai"
      ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(guessed)}]}]}
      : {choices:[{finish_reason:"stop",message:{content:JSON.stringify(guessed)}}]}));
    await start(config({dispatchUrl:await fakeRobot(),aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    const task=(await (await post("/api/booth/requests",command())).json()).task;
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"我的东西取好了吗？"}],taskId:task.id,status:"succeeded"});
    expect(response.status).toBe(200);expect(await response.json()).toEqual({reply:"暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。",selection:null});
    const body=JSON.parse(transport.mock.calls[0]![1]!.body as string);
    const instructions=provider==="openai"?body.instructions:body.messages[0].content;
    expect(instructions).toContain("暂时无法确认");expect(instructions).not.toContain(task.id);expect(instructions).not.toContain(task.requestId);
    expect(received).toHaveLength(1);
  });
  it("新体验不能通过公开任务ID或相同requestId认领他人的任务",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const a=await (await post("/api/booth/experiences")).json();
    const b=await (await post("/api/booth/experiences")).json();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);expect(b.token).not.toBe(a.token);
    const headers={"X-Booth-Experience":a.token};
    const created=await post("/api/booth/requests",command(),headers);
    expect(created.status).toBe(200);const task=(await created.json()).task;
    expect((await post("/api/booth/requests",command(),{"X-Booth-Experience":b.token})).status).toBe(409);
    expect((await post("/api/booth/requests",command())).status).toBe(409);
    expect((await (await post("/api/booth/requests",command(),headers)).json()).task.id).toBe(task.id);
    expect(received).toHaveLength(1);
    const publicSnapshot=await (await fetch(base+"/api/booth")).text();
    expect(publicSnapshot).not.toContain(a.token);expect(publicSnapshot).not.toContain(b.token);
    expect((await post("/api/booth/requests",command("other-request"),{"X-Booth-Experience":task.id})).status).toBe(403);
  });
  it.each(["openai","deepseek"] as const)("%s意图字段必须为布尔值，遗漏或多字段不会被当作有效回复",async provider=>{
    const transport=vi.fn<typeof fetch>();await start(config({aiProvider:provider,openaiKey:"fixture",deepseekKey:"fixture"}),{assistantTransport:transport});
    for(const value of [{reply:"未知意图",selection:null},{reply:"错误意图",selection:null,taskStatusQuery:"true"},{reply:"额外字段",selection:null,taskStatusQuery:true,taskId:"公开任务ID"}]){
      transport.mockResolvedValueOnce(Response.json(provider==="openai"
        ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(value)}]}]}
        : {choices:[{finish_reason:"stop",message:{content:JSON.stringify(value)}}]}));
      expect((await post("/api/booth/chat",{messages:[{role:"user",content:"取物进度"}]})).status).toBe(502);
    }
  });
});

describe("正式三接口与任务事实",()=>{
  it("工作人员配置只公开是否启用，未配置时明确拒绝且不改变任务",async()=>{
    await start(config({operatorToken:undefined}));
    const snapshot=await (await fetch(base+"/api/booth")).json();
    expect(snapshot.operator).toEqual({configured:false});
    const response=await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()});
    expect(response.status).toBe(503);
    expect((await response.json()).data).toBe("工作人员操作凭据尚未配置");
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual(snapshot.tasks);
    await app!.close();app=undefined;
    await start(config());
    const enabled=await (await fetch(base+"/api/booth")).text();
    expect(JSON.parse(enabled).operator).toEqual({configured:true});
    expect(enabled).not.toContain("test-operator");
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()})).status).toBe(403);
  });
  it("P9快照提前说明发单配置缺口，不暴露地址或产生任务",async()=>{
    await start(config({dispatchUrl:undefined,catalogConfirmed:true}));
    const snapshot=await (await fetch(base+"/api/booth")).json();
    expect(snapshot.dispatch).toEqual({ready:false,reason:"机器人连接尚未配置，暂不能提交任务"});
    expect(snapshot.tasks).toEqual([]);
    expect((await post("/api/booth/requests",command())).status).toBe(503);
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
    await app!.close();app=undefined;
    const dispatchUrl=await fakeRobot();
    await start(config({dispatchUrl,catalogConfirmed:false}));
    expect((await (await fetch(base+"/api/booth")).json()).dispatch).toEqual({ready:false,reason:"现场物品位置尚未确认，暂不能提交任务"});
    expect((await post("/api/booth/requests",command())).status).toBe(503);expect(received).toEqual([]);
    await app!.close();app=undefined;
    await start(config({dispatchUrl,catalogConfirmed:true}));
    const ready=await (await fetch(base+"/api/booth")).text();
    expect(JSON.parse(ready).dispatch).toEqual({ready:true,reason:null});
    expect(ready).not.toContain(dispatchUrl);expect(ready).not.toContain("test-operator");
  });

  it("P3审计写入失败不更新任务，恢复后可接收同一通知",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-audit-failure-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});await start(c);
    await post("/api/booth/requests",command());const fixture=new ApplicationStorage(c.databasePath);
    try{
      fixture.db.exec(`CREATE TRIGGER refuse_audit BEFORE INSERT ON records WHEN NEW.scope='booth_callbacks'
        BEGIN SELECT RAISE(ABORT,'injected audit write failure'); END;`);
      const rejected=await post("/api/task/finished",{result:"success"});expect(rejected.status).toBe(500);
      expect((await rejected.json()).success).toBe(false);
      expect((await (await fetch(base+"/api/booth")).json()).active.status).toBe("executing");
      fixture.db.exec("DROP TRIGGER refuse_audit");
      expect(await (await post("/api/task/finished",{result:"success"})).json()).toEqual({code:1,data:"OK",success:true});
      expect((await (await fetch(base+"/api/booth")).json()).active).toBeNull();
    }finally{fixture.close();}
  });
  it("P3提交失败不确认或发布未提交状态；SSE只收到恢复后的真实故障",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-commit-atomic-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});await start(c);
    await post("/api/booth/requests",command());
    const controller=new AbortController();
    const events=await fetch(base+"/api/booth/events",{signal:controller.signal});const reader=events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"status":"executing"');
    const fixture=new ApplicationStorage(c.databasePath);
    try{
      // Deferred foreign-key violation fails COMMIT after both callback writes succeeded.
      fixture.db.exec(`CREATE TABLE injected_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE injected_child(parent_id INTEGER REFERENCES injected_parent(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER refuse_commit AFTER INSERT ON records WHEN NEW.scope='booth_callbacks'
        BEGIN INSERT INTO injected_child VALUES (123); END;`);
      expect((await post("/api/task/error",{message:"未提交的故障"})).status).toBe(500);
      expect((await (await fetch(base+"/api/booth")).json()).active.status).toBe("executing");
      fixture.db.exec("DROP TRIGGER refuse_commit");
      expect((await post("/api/task/error",{message:"已提交的故障"})).status).toBe(200);
      const pushed=new TextDecoder().decode((await reader.read()).value);
      expect(pushed).toContain("已提交的故障");expect(pushed).not.toContain("未提交的故障");
    }finally{fixture.close();controller.abort();await reader.cancel().catch(()=>{});}
    await app!.close();app=undefined;await start(c);
    expect((await (await fetch(base+"/api/booth")).json()).active).toMatchObject({status:"fault",message:"已提交的故障"});
  });
  it("P3无任务告警写入失败不留孤立审计，恢复后仍阻止发单",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-alert-atomic-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});await start(c);
    const fixture=new ApplicationStorage(c.databasePath);
    try{
      fixture.db.exec(`CREATE TRIGGER refuse_alert BEFORE INSERT ON records
        WHEN NEW.scope='booth' AND NEW.key='alert'
        BEGIN SELECT RAISE(ABORT,'injected alert write failure'); END;`);
      expect((await post("/api/task/error",{message:"系统故障"})).status).toBe(500);
      expect((await (await fetch(base+"/api/booth")).json()).alert).toBeNull();
      fixture.db.exec(`DROP TRIGGER refuse_alert;
        CREATE TRIGGER refuse_orphan_audit BEFORE INSERT ON records
        WHEN NEW.scope='booth_callbacks' AND EXISTS (SELECT 1 FROM records WHERE scope='booth_callbacks')
        BEGIN SELECT RAISE(ABORT,'prior uncommitted callback audit survived'); END;`);
      expect((await post("/api/task/error",{message:"系统故障"})).status).toBe(200);
      fixture.db.exec("DROP TRIGGER refuse_orphan_audit");
    }finally{fixture.close();}
    await app!.close();app=undefined;await start(c);
    expect((await (await fetch(base+"/api/booth")).json()).alert).toBe("系统故障");
    expect((await post("/api/booth/requests",command())).status).toBe(409);
    expect(received).toHaveLength(0);
  });
  it("P3故障状态写入失败应回滚审计；重试与重启不解除占用",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-fault-atomic-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});
    await start(c);const original=(await (await post("/api/booth/requests",command())).json()).task;
    const fixture=new ApplicationStorage(c.databasePath);
    try{
      fixture.db.exec(`CREATE TRIGGER refuse_fault BEFORE UPDATE ON records
        WHEN NEW.scope='booth_tasks' AND json_extract(NEW.value,'$.status')='fault'
        BEGIN SELECT RAISE(ABORT,'injected fault write failure'); END;`);
      expect((await post("/api/task/error",{message:"机械臂故障"})).status).toBe(500);
      expect((await (await fetch(base+"/api/booth")).json()).active).toMatchObject({id:original.id,status:"executing"});
      fixture.db.exec(`DROP TRIGGER refuse_fault;
        CREATE TRIGGER refuse_orphan_audit BEFORE INSERT ON records
        WHEN NEW.scope='booth_callbacks' AND EXISTS (
          SELECT 1 FROM records WHERE scope='booth_callbacks' AND json_extract(value,'$.kind')='error')
        BEGIN SELECT RAISE(ABORT,'prior uncommitted callback audit survived'); END;`);
      expect((await post("/api/task/error",{message:"机械臂故障"})).status).toBe(200);
      fixture.db.exec("DROP TRIGGER refuse_orphan_audit");
    }finally{fixture.close();}
    await app!.close();app=undefined;await start(c);
    expect((await (await fetch(base+"/api/booth")).json()).active).toMatchObject({id:original.id,status:"fault",message:"机械臂故障"});
    expect((await post("/api/task/error",{message:"机械臂故障"})).status).toBe(200);
    expect((await post("/api/booth/requests",command("request-two"))).status).toBe(409);
    expect(received).toHaveLength(1);
  });
  it("P3完成状态写入失败应回滚审计；重试与重启保持已提交事实",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-atomic-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot()});
    await start(c);
    const original=(await (await post("/api/booth/requests",command())).json()).task;
    const fixture=new ApplicationStorage(c.databasePath);
    try{
      // Real SQLite fault injection. Assertions below use only HTTP responses/snapshots.
      fixture.db.exec(`CREATE TRIGGER refuse_completion BEFORE UPDATE ON records
        WHEN NEW.scope='booth_tasks' AND json_extract(NEW.value,'$.status')='succeeded'
        BEGIN SELECT RAISE(ABORT,'injected task write failure'); END;`);
      expect((await post("/api/task/finished",{result:"success"})).status).toBe(500);
      expect((await (await fetch(base+"/api/booth")).json()).active).toMatchObject({id:original.id,status:"executing"});
      fixture.db.exec(`DROP TRIGGER refuse_completion;
        CREATE TRIGGER refuse_orphan_audit BEFORE INSERT ON records
        WHEN NEW.scope='booth_callbacks' AND EXISTS (
          SELECT 1 FROM records WHERE scope='booth_callbacks' AND json_extract(value,'$.kind')='finished')
        BEGIN SELECT RAISE(ABORT,'prior uncommitted callback audit survived'); END;`);
      // A successful retry proves the failed callback left no audit behind.
      expect((await post("/api/task/finished",{result:"success"})).status).toBe(200);
      fixture.db.exec("DROP TRIGGER refuse_orphan_audit");
    }finally{fixture.close();}
    await app!.close();app=undefined;await start(c);
    const restored=await (await fetch(base+"/api/booth")).json();
    expect(restored.active).toBeNull();expect(restored.tasks[0]).toMatchObject({id:original.id,status:"succeeded"});
    expect((await post("/api/task/finished",{result:"success"})).status).toBe(200);
    expect(received).toHaveLength(1);
  });
  it("P1已知限制复现：A完成后开始B，A的迟到完成误结束B（不是修复验收）",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const first=(await (await post("/api/booth/requests",command("request-a"))).json()).task;
    await post("/api/task/finished",{result:"success"});
    const second=(await (await post("/api/booth/requests",command("request-b",1,"gift"))).json()).task;
    expect((await (await fetch(base+"/api/booth")).json()).active.id).toBe(second.id);
    // The current protocol provides no way to distinguish a retry from A from a completion for B.
    await post("/api/task/finished",{result:"success"});
    const snapshot=await (await fetch(base+"/api/booth")).json();
    expect(snapshot.active).toBeNull();
    expect(snapshot.tasks.find((t:{id:string})=>t.id===second.id).status).toBe("succeeded");
    expect(snapshot.tasks.find((t:{id:string})=>t.id===first.id).status).toBe("succeeded");
  });
  it("发送且仅发送三字段；受理不完成；完成与重复完成按示例确认",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const response=await post("/api/booth/requests",command());expect(response.status).toBe(200);
    expect((await response.json()).task.status).toBe("executing");
    expect(received).toEqual([{method:"POST",path:"/api/task/dispatch",body:{items:[{location:"货架1-2层",item:"water",count:1}]}}]);
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
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()})).status).toBe(403);
    expect((await post("/api/booth/operator/resolve",{},{"X-Operator-Token":"test-operator"})).status).toBe(400);
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},{"X-Operator-Token":"test-operator"})).status).toBe(200);
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
  const answer={reply:"为你选择矿泉水，请确认数量。",selection:[{productId:"water",count:1}]};
  const response=(value:unknown=answer)=>Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(value)}]}]});
  it("使用官方URL/模型/结构化输出，仅给出建议，无机器人调用",async()=>{
    const transport=vi.fn<typeof fetch>().mockResolvedValue(response());
    const ai=new OpenAIBoothAssistant(config({openaiKey:"test-key"}),transport);expect(await ai.advise([{role:"user",content:"一瓶水"}])).toEqual({...answer,taskStatusQuery:false});
    const [url,options]=transport.mock.calls[0]!;expect(url).toBe("https://api.openai.com/v1/responses");
    const body=JSON.parse(options!.body as string);expect(body.model).toBe("gpt-4.1-mini");expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({type:"json_schema",strict:true});expect(body.input[0].content).toBe("一瓶水");expect(body.tools).toBeUndefined();expect(received).toHaveLength(0);
  });
  it.each([401,429,500])("处理OpenAI HTTP %i，不泄漏上游原文或密钥",async status=>{
    const ai=new OpenAIBoothAssistant(config({openaiKey:"test-key"}),vi.fn<typeof fetch>().mockResolvedValue(new Response("test-key",{status})));
    await expect(ai.advise([{role:"user",content:"你好"}])).rejects.toThrow(status===401?"智能助手认证或权限异常，请联系工作人员":"助手暂时繁忙，请稍后再试，也可以直接选择物品。");
  });
  it("密钥缺失、超时、未知物品、数量越界、不完整输出均显式失败",async()=>{
    await expect(new OpenAIBoothAssistant(config({openaiKey:undefined})).advise([])).rejects.toThrow("暂未连接");
    await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout"))).advise([])).rejects.toThrow("暂时连不上助手，请稍后再试，也可以直接选择物品。");
    for(const value of [{...answer,selection:[{productId:"missing",count:1}]},{...answer,selection:[{productId:"water",count:99}]}]){
      await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockResolvedValue(response(value))).advise([])).rejects.toThrow("这次没能正常回复，可以再试一次，或直接选择物品。");
    }
    await expect(new OpenAIBoothAssistant(config({openaiKey:"test"}),vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:"incomplete"}))).advise([])).rejects.toThrow("这次没能正常回复，可以再试一次，或直接选择物品。");
  });
  it("目录配置拒绝重复ID和非法取值",()=>{
    const p=config().products[0]!;expect(()=>validateCatalog([p,p])).toThrow();expect(()=>validateCatalog([{...p,maxCount:0}])).toThrow();
  });
});

describe("双供应商建议 HTTP 边界（可控对端，不冒充真实供应商）",()=>{
  it("DeepSeek后端配置在快照生效，不使用OpenAI密钥也不泄漏凭据",async()=>{
    vi.stubEnv("BOOTH_AI_PROVIDER","deepseek");vi.stubEnv("DEEPSEEK_API_KEY","deepseek-fixture-secret");vi.stubEnv("DEEPSEEK_MODEL","deepseek-flash");
    await start(config({openaiKey:"openai-fixture-secret"}));
    const response=await fetch(base+"/api/booth");const body=await response.text();
    expect(JSON.parse(body).ai).toEqual({provider:"DeepSeek",model:"deepseek-flash",configured:true});
    expect(body).not.toContain("fixture-secret");
  });
  it("DeepSeek通过统一聊天HTTP返回合法建议，使用选中供应商凭据且不发单",async()=>{
    const answer={reply:"请确认两瓶矿泉水。",selection:[{productId:"water",count:2}]};
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json({choices:[{finish_reason:"stop",message:{content:modelOutput(answer)}}]}));
    await start(config({aiProvider:"deepseek",deepseekKey:"deepseek-fixture-secret",openaiKey:undefined}),{assistantTransport:transport});
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"两瓶矿泉水"}]});
    expect(response.status).toBe(200);expect(await response.json()).toEqual(answer);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url,options]=transport.mock.calls[0]!;expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(new Headers(options!.headers).get("Authorization")).toBe("Bearer deepseek-fixture-secret");
    const body=JSON.parse(options!.body as string);expect(body.model).toBe("deepseek-flash");
    expect(body.response_format).toEqual({type:"json_object"});expect(body.thinking).toEqual({type:"disabled"});
    expect(body.messages[0].role).toBe("system");expect(body.messages[0].content).toContain("JSON");
    expect(body.messages.at(-1)).toEqual({role:"user",content:"两瓶矿泉水"});expect(body.tools).toBeUndefined();
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);expect(received).toHaveLength(0);
  });

  it.each(["openai","deepseek"] as const)("%s拒绝目录/数量越界和额外输出字段，失败后仍可继续提问",async provider=>{
    const answer={reply:"请确认矿泉水。",selection:[{productId:"water",count:1}]};
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"openai-fixture",deepseekKey:"deepseek-fixture"}),{assistantTransport:transport});
    const output=(value:unknown)=>provider==="openai"
      ? Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(value)}]}]})
      : Response.json({choices:[{finish_reason:"stop",message:{content:modelOutput(value)}}]});
    for(const invalid of [{...answer,debug:"不应返回给访客"},{...answer,selection:[{productId:"unknown",count:1}]},
      {...answer,selection:[{productId:"water",count:99}]},{...answer,selection:[{productId:"water",count:1.5}]},
      {...answer,selection:[{productId:"water",count:1,extra:"secret"}]},{reply:"漏掉selection"}]){
      transport.mockResolvedValueOnce(output(invalid));
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]});
      expect(response.status).toBe(502);expect(await response.text()).not.toContain("不应返回给访客");
    }
    transport.mockResolvedValueOnce(output({reply:"您想取几瓶矿泉水？",selection:null}));
    expect(await (await post("/api/booth/chat",{messages:[{role:"user",content:"想要水"}]})).json()).toEqual({reply:"您想取几瓶矿泉水？",selection:null});
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it.each(["openai","deepseek"] as const)("%s聊天记录区分配置与返回模型，仅读取安全用量字段",async provider=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const advice={reply:"private-answer",selection:[{productId:"water",count:1}]};
    const usage=provider==="openai"
      ? {input_tokens:37,output_tokens:11,total_tokens:48,input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:0},secret:"private-secret"}
      : {prompt_tokens:37,completion_tokens:11,total_tokens:48,secret:"private-secret"};
    const payload=provider==="openai"
      ? {status:"completed",model:"returned-model-2026",usage,output:[{type:"message",content:[{type:"output_text",text:modelOutput(advice)}]}]}
      : {model:"returned-model-2026",usage,choices:[{finish_reason:"stop",message:{content:modelOutput(advice)}}]};
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await start(config({aiProvider:provider,openaiKey:"private-secret",deepseekKey:"private-secret",openaiModel:"requested-model",deepseekModel:"requested-model"}),{assistantTransport:transport});
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"private-dialogue"}]});
    expect(response.status).toBe(200);expect(await response.json()).toEqual(advice);
    const event=JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(event).toMatchObject({model:"requested-model",returnedModel:"returned-model-2026",usage:{inputTokens:37,outputTokens:11,totalTokens:48},structureValidated:true,upstreamStatus:200});
    expect(JSON.stringify(event)).not.toMatch(/private-secret|private-answer|private-dialogue/);
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it("诊断消费者异步失败不影响本次或后续聊天",async()=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const advice={reply:"请确认一瓶水",selection:[{productId:"water",count:1}]};
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(advice)}]}]}));
    await start(config({aiProvider:"openai",openaiKey:"fixture"}),{assistantTransport:transport,onAiCall:async()=>{throw new Error("诊断消费者异常");}});
    for(let i=0;i<2;i++){
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]});
      expect(response.status).toBe(200);expect(await response.json()).toEqual(advice);
      await new Promise(resolve=>setImmediate(resolve));
    }
    expect(info).toHaveBeenCalledTimes(2);
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it("连接失败仅记录允许的网络错误码，不记录异常详情",async()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const transport=vi.fn<typeof fetch>().mockRejectedValue(new Error("private-secret",{cause:{code:"UND_ERR_CONNECT_TIMEOUT",address:"private-address"}}));
    await start(config({aiProvider:"openai",openaiKey:"private-secret"}),{assistantTransport:transport});
    expect((await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]})).status).toBe(504);
    const event=JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(event).toMatchObject({category:"connection",connectionCode:"UND_ERR_CONNECT_TIMEOUT",upstreamStatus:null});
    expect(JSON.stringify(event)).not.toMatch(/private-secret|private-address/);
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it("OpenAI路径或参数错误安全分类，不记录上游错误正文",async()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:"openai",openaiKey:"private-secret"}),{assistantTransport:transport});
    for(const status of [400,404,405,422]){
      transport.mockResolvedValueOnce(new Response("private-secret 上游错误正文",{status}));
      expect((await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]})).status).toBe(502);
      expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({category:"configuration",upstreamStatus:status,structureValidated:false,returnedModel:null,usage:null});
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-secret");
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it.each(["openai","deepseek"] as const)("%s认证、限流、上游失败与连接失败安全分类，不回退另一家或记录敏感内容",async provider=>{
    const info=vi.spyOn(console,"info").mockImplementation(()=>{}),warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"openai-private-secret",deepseekKey:"deepseek-private-secret",openaiModel:"configured-openai-model",deepseekModel:"configured-deepseek-model"}),{assistantTransport:transport});
    const categories=[[401,"authentication"],[403,"authentication"],[429,"rate_limit"],[500,"upstream"]] as const;
    for(const [status,category] of categories){
      transport.mockResolvedValueOnce(new Response("private-secret 上游内部详情",{status}));
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"private-dialogue 一瓶水"}]});
      expect(response.status).toBe(502);expect(await response.text()).not.toContain("private-secret");
      const event=JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
      expect(event).toMatchObject({event:"ai_call",provider:provider==="openai"?"OpenAI":"DeepSeek",category,upstreamStatus:status,outcome:"failed"});
      expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    transport.mockRejectedValueOnce(new Error("private-secret"));
    expect((await post("/api/booth/chat",{messages:[{role:"user",content:"private-dialogue"}]})).status).toBe(504);
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({category:"connection",upstreamStatus:null});
    const output={reply:"请确认。",selection:[{productId:"water",count:1}]};
    transport.mockResolvedValueOnce(provider==="openai"
      ? Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(output)}]}]})
      : Response.json({choices:[{finish_reason:"stop",message:{content:modelOutput(output)}}]}));
    expect((await post("/api/booth/chat",{messages:[{role:"user",content:"private-dialogue"}]})).status).toBe(200);
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toMatchObject({event:"ai_call",category:null,upstreamStatus:200,outcome:"succeeded"});
    expect(transport).toHaveBeenCalledTimes(6);
    for(const [url,init] of transport.mock.calls){
      expect(url).toBe(provider==="openai"?"https://api.openai.com/v1/responses":"https://api.deepseek.com/chat/completions");
      expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer "+provider+"-private-secret");
      const body=JSON.parse(init!.body as string);
      expect(body.model).toBe("configured-"+provider+"-model");
      expect(init!.redirect).toBe("error");
      if(provider==="openai"){expect(body.store).toBe(false);expect(body.text.format).toMatchObject({type:"json_schema",strict:true});}
    }
    const logs=JSON.stringify([...info.mock.calls,...warn.mock.calls]);
    expect(logs).not.toContain("private-secret");expect(logs).not.toContain("private-dialogue");expect(logs).not.toContain("请确认");
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it.each(["openai","deepseek"] as const)("%s超时预算覆盖响应正文；真实回环慢正文中止后恢复聊天",async provider=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});let slow=true;
    const answer={reply:"请确认一瓶水。",selection:[{productId:"water",count:1}]};
    robot=createServer((req,res)=>{
      req.resume();res.writeHead(200,{"Content-Type":"application/json"});
      if(slow){res.flushHeaders();return;}
      res.end(JSON.stringify(provider==="openai"
        ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(answer)}]}]}
        : {choices:[{finish_reason:"stop",message:{content:modelOutput(answer)}}]}));
    });
    await new Promise<void>(resolve=>robot!.listen(0,"127.0.0.1",resolve));
    const url="http://127.0.0.1:"+(robot.address() as {port:number}).port;
    const transport:typeof fetch=(_input,init)=>fetch(url,init);
    await start(config({aiProvider:provider,openaiKey:"test-openai",deepseekKey:"test-deepseek",openaiTimeoutMs:100,deepseekTimeoutMs:100}),{assistantTransport:transport});
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]});
    expect(response.status).toBe(504);
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({category:"timeout",upstreamStatus:200});
    slow=false;expect(await (await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]})).json()).toEqual(answer);
    expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

  it.each(["openai","deepseek"] as const)("%s未配置时不借用另一家凭据，返回503和未连接快照",async provider=>{
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:provider==="openai"?undefined:"other-key",deepseekKey:provider==="deepseek"?undefined:"other-key"}),{assistantTransport:transport});
    const snapshot=await (await fetch(base+"/api/booth")).json();
    expect(snapshot.ai).toMatchObject({provider:provider==="openai"?"OpenAI":"DeepSeek",configured:false});
    const response=await post("/api/booth/chat",{messages:[{role:"user",content:"你好"}]});
    expect(response.status).toBe(503);expect(await response.text()).toContain("暂未连接");expect(transport).not.toHaveBeenCalled();
    expect(snapshot.tasks).toEqual([]);
  });
  it.each(["openai","deepseek"] as const)("%s截断、拒绝、非JSON与空回答均不冒充成功建议",async provider=>{
    const transport=vi.fn<typeof fetch>();
    await start(config({aiProvider:provider,openaiKey:"test-openai",deepseekKey:"test-deepseek"}),{assistantTransport:transport});
    const text=(content:string,complete=true)=>provider==="openai"
      ? {status:complete?"completed":"incomplete",output:[{type:"message",content:[{type:"output_text",text:content}]}]}
      : {choices:[{finish_reason:complete?"stop":"length",message:{content}}]};
    const valid=JSON.stringify({reply:"请确认。",selection:[{productId:"water",count:1}]});
    const refusal=provider==="openai"?{status:"completed",output:[{type:"message",content:[{type:"refusal",refusal:"拒绝"}]}]}
      : {choices:[{finish_reason:"content_filter",message:{content:null}}]};
    for(const body of [text(valid,false),refusal,text("这不是JSON"),text(JSON.stringify({reply:" ",selection:null}))]){
      transport.mockResolvedValueOnce(Response.json(body));
      const response=await post("/api/booth/chat",{messages:[{role:"user",content:"一瓶水"}]});
      expect(response.status).toBe(502);expect((await response.json()).data).toBe("这次没能正常回复，可以再试一次，或直接选择物品。");
    }
    expect(transport).toHaveBeenCalledTimes(4);expect((await (await fetch(base+"/api/booth")).json()).tasks).toEqual([]);
  });

});
describe("等待提醒 HTTP 边界",()=>{
  it.each([true,false])("人工处理提交中的任务后，迟到接单回复 success=%s 不影响新任务或库存",async success=>{
    let release!:()=>void,arrived!:()=>void;
    const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>arrived=r);
    const receipt={success,data:"迟到的回复"};
    await start(config({dispatchUrl:await fakeRobot(receipt,async()=>{if(received.length===1){arrived();await gate;}})}));
    const pending=post("/api/booth/requests",command());
    try{
      await started;
      const before=await (await fetch(base+"/api/booth")).json();
      expect(before.active.status).toBe("submitting");
      expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},{"X-Operator-Token":"test-operator"})).status).toBe(200);
      expect((await (await fetch(base+"/api/booth")).json()).products).toEqual(before.products);
      // The second command is accepted independently of the held first receipt.
      receipt.success=true;
      await post("/api/booth/requests",command("next-while-receipt-pending"));
      const next=await (await fetch(base+"/api/booth")).json();
      expect(next.active.status).toBe("executing");receipt.success=success;
      release();expect((await pending).status).toBe(200);
      const after=await (await fetch(base+"/api/booth")).json();
      expect(after.tasks.find((t:{id:string})=>t.id===before.active.id).status).toBe("resolved");
      expect(after.active).toEqual(next.active);expect(after.products).toEqual(next.products);expect(after.alert).toBeNull();
      expect(received).toHaveLength(2);
    }finally{release();await pending;}
  });
  it("跨天旧任务重启后仍需核对，人工处理后清除提醒并保留库存与记录",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-recovery-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot(),taskReminderMs:1000});
    await start(c);const task=(await (await post("/api/booth/requests",command())).json()).task;
    vi.spyOn(Date,"now").mockReturnValue(Date.parse(task.createdAt)+3*24*60*60*1000);
    await app!.close();app=undefined;await start(c);
    const before=await (await fetch(base+"/api/booth")).json();
    expect(before.active).toMatchObject({id:task.id,status:"executing"});
    expect(before.waiting).toMatchObject({taskId:task.id,elapsedMs:259200000,overdue:true});
    expect((await post("/api/booth/requests",command("still-blocked"))).status).toBe(409);
    const response=await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},{"X-Operator-Token":"test-operator"});
    expect(response.status).toBe(200);const after=await response.json();
    expect(after.active).toBeNull();expect(after.waiting).toBeNull();expect(after.products).toEqual(before.products);
    expect(after.tasks).toHaveLength(1);expect(after.tasks[0]).toMatchObject({id:task.id,status:"resolved",createdAt:task.createdAt});
    await app!.close();app=undefined;await start(c);
    const restored=await (await fetch(base+"/api/booth")).json();
    expect(restored.waiting).toBeNull();expect(restored.active).toBeNull();expect(restored.tasks).toEqual(after.tasks);expect(restored.products).toEqual(before.products);
    expect(received).toHaveLength(1);
  });
  it("旧页面的人工解除不能处理后来出现的新任务或新告警",async()=>{
    await start(config({dispatchUrl:await fakeRobot()}));
    const staff={"X-Operator-Token":"test-operator"},confirmation="已核对机器人停止";
    await post("/api/booth/requests",command());
    const oldTarget=await recoveryTarget();
    expect((await post("/api/booth/operator/resolve",{confirmation,...oldTarget},staff)).status).toBe(200);
    const next=(await (await post("/api/booth/requests",command("new-task"))).json()).task;
    expect((await post("/api/booth/operator/resolve",{confirmation,...oldTarget},staff)).status).toBe(409);
    const current=await (await fetch(base+"/api/booth")).json();
    expect(current.active).toMatchObject({id:next.id,status:"executing"});
    expect(current.tasks.find((t:{id:string})=>t.id===oldTarget.expectedTaskId).status).toBe("resolved");
    expect(received).toHaveLength(2);
    await post("/api/task/finished",{});
    await post("/api/task/error",{message:"先前告警"});const oldAlert=await recoveryTarget();
    await post("/api/task/error",{message:"后来告警"});
    expect((await post("/api/booth/operator/resolve",{confirmation,...oldAlert},staff)).status).toBe(409);
    expect((await (await fetch(base+"/api/booth")).json()).alert).toBe("后来告警");
    expect((await post("/api/booth/operator/resolve",{confirmation,...await recoveryTarget()},staff)).status).toBe(200);
  });
  it.each(["http","simulator"] as const)("%s已接单任务经工作人员核对即可解除新任务限制，库存和历史保留",async mode=>{
    await start(config({mode,dispatchUrl:await fakeRobot()}));
    const task=(await (await post("/api/booth/requests",command())).json()).task;
    const before=await (await fetch(base+"/api/booth")).json();
    expect(task.status).toBe("executing");
    expect((await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()})).status).toBe(403);
    const staff={"X-Operator-Token":"test-operator"};
    expect((await post("/api/booth/operator/resolve",{},staff)).status).toBe(400);
    const response=await post("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",...await recoveryTarget()},staff);
    expect(response.status).toBe(200);
    const after=await response.json();
    expect(after.active).toBeNull();expect(after.waiting).toBeNull();
    expect(after.tasks).toHaveLength(1);expect(after.tasks[0]).toMatchObject({id:task.id,status:"resolved"});
    expect(after.products).toEqual(before.products);expect(received).toHaveLength(1);
    expect((await post("/api/booth/requests",command("after-operator-recovery"))).status).toBe(200);
    expect(received).toHaveLength(2);
  });
  it("超过提醒阈值仍执行且阻止新单，重启保留等待起点，完成后清除提醒",async()=>{
    const d=mkdtempSync(join(tmpdir(),"booth-reminder-"));directories.push(d);
    const c=config({databasePath:join(d,"state.sqlite"),dispatchUrl:await fakeRobot(),taskReminderMs:1000});
    await start(c);const task=(await (await post("/api/booth/requests",command())).json()).task;
    expect((await (await fetch(base+"/api/booth")).json()).waiting).toMatchObject({taskId:task.id,overdue:false,remindAfterMs:1000});
    vi.spyOn(Date,"now").mockReturnValue(Date.parse(task.createdAt)+2000);
    expect((await (await fetch(base+"/api/booth")).json()).waiting).toMatchObject({taskId:task.id,overdue:true,elapsedMs:2000});
    expect((await post("/api/booth/requests",command("next-request"))).status).toBe(409);
    await app!.close();app=undefined;await start(c);
    const restored=await (await fetch(base+"/api/booth")).json();
    expect(restored.active).toMatchObject({id:task.id,status:"executing"});expect(restored.waiting.overdue).toBe(true);
    await post("/api/task/finished",{result:"success"});expect((await (await fetch(base+"/api/booth")).json()).waiting).toBeNull();
    expect(received).toHaveLength(1);
  });
});

describe("OpenAI 独立端点 HTTP 边界",()=>{
  it("明确配置的Base URL只影响OpenAI，Luna关闭推理且保留结构化参数",async()=>{
    vi.stubEnv("OPENAI_BASE_URL","https://verified-relay.example/compatible/v1/");
    vi.stubEnv("OPENAI_MODEL","gpt-6-luna");
    const answer={reply:"请确认水。",selection:[{productId:"water",count:1}]};
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(answer)}]}]}));
    await start(config({aiProvider:"openai",openaiKey:"fixture"}),{assistantTransport:transport});
    expect(await (await post("/api/booth/chat",{messages:[{role:"user",content:"1瓶水"}]})).json()).toEqual(answer);
    expect(transport.mock.calls[0]![0]).toBe("https://verified-relay.example/compatible/v1/responses");
    const body=JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("gpt-6-luna");expect(body.reasoning).toEqual({effort:"none"});expect(body.text.format.strict).toBe(true);
    await app!.close();app=undefined;
    transport.mockResolvedValueOnce(Response.json({choices:[{finish_reason:"stop",message:{content:modelOutput(answer)}}]}));
    await start(config({aiProvider:"deepseek",deepseekKey:"deepseek-fixture"}),{assistantTransport:transport});
    await post("/api/booth/chat",{messages:[{role:"user",content:"1瓶水"}]});
    expect(transport.mock.calls.at(-1)![0]).toBe("https://api.deepseek.com/chat/completions");
  });
  it("未配置Base URL保持官方直连，Sol只使用支持的低推理设置",async()=>{
    vi.stubEnv("OPENAI_BASE_URL","");vi.stubEnv("OPENAI_MODEL","gpt-6.1-sol");
    const answer={reply:"请确认。",selection:null};
    const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:modelOutput(answer)}]}]}));
    await start(config({aiProvider:"openai",openaiKey:"fixture"}),{assistantTransport:transport});
    expect((await post("/api/booth/chat",{messages:[{role:"user",content:"想要水"}]})).status).toBe(200);
    expect(transport.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    const body=JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(body.reasoning).toEqual({effort:"low"});expect(body.max_output_tokens).toBe(2000);
    expect(body.text.format.strict).toBe(true);
  });

});
