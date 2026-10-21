import {afterEach,expect,it} from "vitest";
import {createServer,type Server} from "node:http";
import {createBoothApplication} from "./server.js";
import {readBoothConfig} from "./config.js";
let app:ReturnType<typeof createBoothApplication>|undefined,robot:Server|undefined;
afterEach(async()=>{await app?.close();if(robot)await new Promise<void>(r=>robot!.close(()=>r()));});
it("机器人通信记录保存实际请求和原始响应，包括格式错误的回复和通知",async()=>{
  let received="";const rawReceipt=' { "success" : true, "data" : "对端原样回复" } ';
  robot=createServer(async(req,res)=>{for await(const chunk of req)received+=chunk;res.writeHead(200,{"Content-Type":"application/json","X-Robot":"fixture"});res.end(rawReceipt);});
  await new Promise<void>(r=>robot!.listen(0,"127.0.0.1",r));
  app=createBoothApplication({...readBoothConfig(),databasePath:":memory:",mode:"http",catalogConfirmed:true,operatorToken:"fixture",dispatchUrl:"http://127.0.0.1:"+(robot.address() as {port:number}).port+"/api/task/dispatch"});
  const base="http://127.0.0.1:"+await app.listen(0);
  await fetch(base+"/api/booth/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:"water",count:1,requestId:"wire-fixture"})});
  const callback=' { "result" : "success" } ';
  await fetch(base+"/api/task/finished",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"secret-fixture"},body:callback});
  await fetch(base+"/api/task/error",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"bad":'});
  const records=await(await fetch(base+"/api/booth/developer/robot",{headers:{"X-Operator-Token":"fixture"}})).json();
  expect(records.records).toHaveLength(3);
  const dispatch=records.records.find((r:any)=>r.direction==="gateway-to-robot");
  expect(dispatch.request.body).toBe(received);expect(dispatch.response.body).toBe(rawReceipt);
  const finished=records.records.find((r:any)=>r.request.url.endsWith("/finished"));expect(finished.request.body).toBe(callback);expect(finished.request.url).toBe("/api/task/finished");
  expect(finished.response.body).toBe('{"code":1,"data":"OK","success":true}');
  const malformed=records.records.find((r:any)=>r.request.url.endsWith("/error"));expect(malformed.request.body).toBe('{"bad":');expect(malformed.response.status).toBe(400);
  expect(JSON.stringify(records)).not.toContain("secret-fixture");
});
it("机器人错误状态不等待运行记录读完正文",async()=>{
  let finishBody:(()=>void)|undefined;
  robot=createServer((_req,res)=>{res.writeHead(500,{"Content-Type":"application/json"});res.flushHeaders();finishBody=()=>res.end('{"error":"fixture"}');});
  await new Promise<void>(r=>robot!.listen(0,"127.0.0.1",r));
  app=createBoothApplication({...readBoothConfig(),databasePath:":memory:",mode:"http",catalogConfirmed:true,operatorToken:"fixture",dispatchUrl:"http://127.0.0.1:"+(robot.address() as {port:number}).port+"/api/task/dispatch"});
  const base="http://127.0.0.1:"+await app.listen(0);
  const pending=fetch(base+"/api/booth/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:"water",count:1,requestId:"delayed-body"})});
  try{
    const response=await Promise.race([pending,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error("业务等待了记录正文")),500))]);
    expect(response.status).toBe(200);
    const records=await(await fetch(base+"/api/booth/developer/robot",{headers:{"X-Operator-Token":"fixture"}})).json();
    expect(records.records[0].response.bodyState).toBe("pending");
  }finally{finishBody?.();await pending;}
  await expect.poll(async()=>{const data=await(await fetch(base+"/api/booth/developer/robot",{headers:{"X-Operator-Token":"fixture"}})).json();return data.records[0]?.response?.body;}).toBe('{"error":"fixture"}');
});
it("通信记录截断超过32KiB的正文，实际发送内容保持完整",async()=>{
  let received="";
  robot=createServer(async(req,res)=>{for await(const chunk of req)received+=chunk;res.end(JSON.stringify({success:true,data:"received"}));});
  await new Promise<void>(r=>robot!.listen(0,"127.0.0.1",r));
  const config=readBoothConfig();config.products=config.products.map(p=>p.id==="water"?{...p,name:"矿泉水".repeat(5000)}:p);
  app=createBoothApplication({...config,databasePath:":memory:",mode:"http",catalogConfirmed:true,operatorToken:"fixture",dispatchUrl:"http://127.0.0.1:"+(robot.address() as {port:number}).port+"/api/task/dispatch"});
  const base="http://127.0.0.1:"+await app.listen(0);
  await fetch(base+"/api/booth/requests",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:"water",count:1,requestId:"large-body"})});
  expect(Buffer.byteLength(received)).toBeGreaterThan(32768);
  const records=await(await fetch(base+"/api/booth/developer/robot",{headers:{"X-Operator-Token":"fixture"}})).json();
  const request=records.records[0].request;expect(request.truncated).toBe(true);expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(32768);expect(received.startsWith(request.body)).toBe(true);
});
