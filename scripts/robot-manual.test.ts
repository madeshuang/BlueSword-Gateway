import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createManualRobot } from "./robot-manual.js";
import {createBoothApplication} from "../apps/api/src/booth/server.js";
import {readBoothConfig} from "../apps/api/src/booth/config.js";

it.each(["pending","accepted"] as const)("人工模式在%s时解除旧任务后，下一单能正常进入实际人工工具",async phase=>{
  const config={...readBoothConfig(),databasePath:":memory:",mode:"simulator" as const,manualRobot:true,catalogConfirmed:true,operatorToken:"test-staff",dispatchUrl:"http://127.0.0.1:1/unused"};
  const app=createBoothApplication(config),base="http://127.0.0.1:"+await app.listen(0);
  const robot=createManualRobot(base,"test-staff"),tool="http://127.0.0.1:"+await robot.listen(0);
  config.dispatchUrl=tool+"/api/task/dispatch";
  const post=(url:string,body:unknown={},headers:Record<string,string>={})=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const toolState=async()=>await(await fetch(tool+"/manual/state")).json();
  const waitPending=async()=>{for(let i=0;i<100;i++){const s=await toolState();if(s.phase==="pending")return s;await new Promise(r=>setTimeout(r,10));}throw Error("人工工具未收到请求");};
  let first:Promise<Response>|undefined,next:Promise<Response>|undefined;
  try{
    const order=(requestId:string)=>({requestId,productId:config.products[0]!.id,count:1});
    first=post(base+"/api/booth/requests",order("manual-old"));let s=await waitPending();
    if(phase==="accepted"){await post(tool+"/manual/accept",{taskId:s.taskId});await first;}
    const before=await(await fetch(base+"/api/booth")).json();
    const response=await post(base+"/api/booth/operator/resolve",{confirmation:"已核对机器人停止",expectedTaskId:before.active.id,expectedAlert:before.alert},{"X-Operator-Token":"test-staff"});
    expect(response.status).toBe(200);
    const after=await response.json();expect(after.active).toBeNull();expect(after.tasks[0].status).toBe("resolved");expect(after.products).toEqual(before.products);
    s=await toolState();expect(s.phase).toBe("idle");expect(s.item).toBeNull();
    expect(s.records.some((r:{request:{url:string}})=>/\/api\/task\/(finished|error)$/.test(r.request.url))).toBe(false);
    await first;
    next=post(base+"/api/booth/requests",order("manual-next"));s=await waitPending();
    expect((await post(tool+"/manual/accept",{taskId:before.active.id})).status).toBe(409);
    expect((await post(tool+"/manual/finished",{taskId:before.active.id})).status).toBe(409);
    expect((await post(tool+"/manual/accept",{taskId:s.taskId})).status).toBe(200);
    expect((await (await next).json()).task.status).toBe("executing");
    expect((await post(tool+"/manual/finished",{taskId:s.taskId})).status).toBe(200);
    const done=await(await fetch(base+"/api/booth")).json();expect(done.active).toBeNull();expect(done.tasks.map((t:{status:string})=>t.status)).toEqual(["succeeded","resolved"]);
  }finally{await robot.close();await Promise.allSettled([first,next].filter(Boolean) as Promise<Response>[]);await app.close();}
});

it("人工工具连接失败时，保留旧任务限制和库存，不把人工处理记为成功",async()=>{
  const config={...readBoothConfig(),databasePath:":memory:",mode:"simulator" as const,manualRobot:true,catalogConfirmed:true,operatorToken:"test-staff",dispatchUrl:"http://127.0.0.1:1/unused"};
  const app=createBoothApplication(config),base="http://127.0.0.1:"+await app.listen(0),robot=createManualRobot(base,"test-staff");
  const tool="http://127.0.0.1:"+await robot.listen(0);config.dispatchUrl=tool+"/api/task/dispatch";
  const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const request=post(base+"/api/booth/requests",{requestId:"manual-unavailable",productId:config.products[0]!.id,count:1});
  let toolClosed=false;
  try{
    let s:any;for(let i=0;i<100;i++){s=await(await fetch(tool+"/manual/state")).json();if(s.phase==="pending")break;await new Promise(r=>setTimeout(r,10));}
    await post(tool+"/manual/accept",{taskId:s.taskId});await request;
    const before=await(await fetch(base+"/api/booth")).json();await robot.close();toolClosed=true;
    expect((await post(base+"/api/booth/operator/resolve",{confirmation:"已核对机器人停止",expectedTaskId:before.active.id,expectedAlert:null},{"X-Operator-Token":"test-staff"})).status).toBe(503);
    const after=await(await fetch(base+"/api/booth")).json();expect(after.active).toEqual(before.active);expect(after.products).toEqual(before.products);
    expect((await post(base+"/api/booth/requests",{requestId:"manual-still-blocked",productId:config.products[0]!.id,count:1})).status).toBe(409);
  }finally{if(!toolClosed)await robot.close();await request;await app.close();}
});

it("人工工具发送结果通知期间不清理旧练习，通知完成后才允许清理",async()=>{
  let callbackResponse:import("node:http").ServerResponse|undefined;
  const gateway=createServer(async(req,res)=>{for await(const _ of req){}callbackResponse=res;});
  await new Promise<void>(ok=>gateway.listen(0,"127.0.0.1",ok));
  const robot=createManualRobot("http://127.0.0.1:"+(gateway.address() as {port:number}).port,"test-staff"),tool="http://127.0.0.1:"+await robot.listen(0);
  const post=(path:string,body:unknown={},headers:Record<string,string>={})=>fetch(tool+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const taskId="sending-old-task",body={taskId};let notification:Promise<Response>|undefined;
  const dispatch=post("/api/task/dispatch",{items:[{location:"货架",item:"water",count:1}]},{"X-Booth-Manual-Task":taskId});
  try{
    for(let i=0;i<100;i++){if((await(await fetch(tool+"/manual/state")).json()).phase==="pending")break;await new Promise(r=>setTimeout(r,10));}
    await post("/manual/accept",body);await dispatch;
    notification=post("/manual/finished",body);
    for(let i=0;i<100&&!callbackResponse;i++)await new Promise(r=>setTimeout(r,10));
    expect(callbackResponse).toBeDefined();
    expect((await post("/manual/reset",body,{"X-Operator-Token":"test-staff"})).status).toBe(409);
    expect((await(await fetch(tool+"/manual/state")).json()).phase).toBe("sending");
    callbackResponse!.end(JSON.stringify({success:true}));expect((await notification).status).toBe(200);
    expect((await post("/manual/reset",body,{"X-Operator-Token":"test-staff"})).status).toBe(200);
    expect((await(await fetch(tool+"/manual/state")).json()).phase).toBe("idle");
  }finally{callbackResponse?.end(JSON.stringify({success:true}));await notification;await robot.close();await new Promise<void>(ok=>gateway.close(()=>ok()));}
});

it("人工对端等待明确点击，展示原始接口记录，受理不会自动完成", async () => {
  const callbacks: {path:string; body:string}[] = [];
  const gateway = createServer(async (req,res)=>{
    let body=""; for await (const chunk of req) body+=chunk;
    callbacks.push({path:req.url!,body}); res.end(JSON.stringify({code:1,data:"OK",success:true}));
  });
  await new Promise<void>(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  const callback = "http://127.0.0.1:"+(gateway.address() as {port:number}).port;
  const robot = createManualRobot(callback);
  const base = "http://127.0.0.1:"+await robot.listen(0);
  const post = (path:string,body:unknown={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    expect(await (await fetch(base)).text()).toContain("原始接口记录");
    const raw = {items:[{location:"货架1-2层",item:"water",count:1},{location:"货架2",item:"snack",count:1}]};
    let replied=false;
    const dispatch = post("/api/task/dispatch",raw).then(response=>{replied=true;return response;});
    let state: any;
    for (let attempt=0;attempt<50;attempt++) {
      state=await (await fetch(base+"/manual/state")).json(); if(state.phase==="pending") break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(state.phase).toBe("pending"); expect(replied).toBe(false);
    expect((await post("/manual/finished")).status).toBe(409); expect(callbacks).toEqual([]);
    expect((await post("/manual/accept")).status).toBe(200);
    expect(await (await dispatch).json()).toEqual({code:1,data:"received",success:true});
    await new Promise(resolve=>setTimeout(resolve,100));
    expect(callbacks).toEqual([]);
    expect((await post("/manual/finished")).status).toBe(200);
    expect(callbacks).toEqual([{path:"/api/task/finished",body:'{"result":"success"}'}]);
    state=await (await fetch(base+"/manual/state")).json();
    expect(state.phase).toBe("idle"); expect(state.records[0].request.body).toBe(JSON.stringify(raw));
    expect(state.records[0].response.status).toBe(200);
    expect(state.records[0].response.headers["Cache-Control"]).toBe("no-store");
    expect(state.records[1].request.headersScope).toContain("显式");
    expect(state.records[1].request.url).toBe(callback+"/api/task/finished");
    expect(state.records[1].response.body).toBe('{"code":1,"data":"OK","success":true}');
    const second = post("/api/task/dispatch",raw);
    for (let attempt=0;attempt<50;attempt++) {
      if((await (await fetch(base+"/manual/state")).json()).phase==="pending") break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await post("/manual/reject"); expect((await (await second).json()).success).toBe(false);
    expect(callbacks).toHaveLength(1);
  } finally { await robot.close(); await new Promise<void>(resolve=>gateway.close(()=>resolve())); }
});
