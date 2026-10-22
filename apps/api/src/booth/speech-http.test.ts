import {afterEach,expect,it} from "vitest";
import {createBoothApplication} from "./server.js";
import {readBoothConfig} from "./config.js";
import WebSocket,{WebSocketServer} from "ws";
import {once} from "node:events";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
let app:ReturnType<typeof createBoothApplication>|undefined;
afterEach(async()=>app?.close());
function expectInvalidAddressRejected(request:string):void {
  // 单独启动进程，让未捕获异常真实退出，避免由测试运行器代为捕获。
  const source=`
    import {createConnection} from "node:net";
    import {createBoothApplication} from "./apps/api/src/booth/server.ts";
    import {readBoothConfig} from "./apps/api/src/booth/config.ts";
    const app=createBoothApplication({...readBoothConfig(),databasePath:":memory:",mode:"http",dispatchUrl:undefined});
    try {
      const port=await app.listen(0);
      const response=await new Promise((resolve,reject)=>{
        let body="";
        const socket=createConnection({host:"127.0.0.1",port},()=>socket.write(${JSON.stringify(request)}));
        socket.setEncoding("utf8");
        socket.setTimeout(2000,()=>socket.destroy(new Error("等待非法请求回复超时")));
        socket.on("data",chunk=>{body+=chunk;});
        socket.once("error",reject);
        socket.once("end",()=>resolve(body));
      });
      const health=await fetch("http://127.0.0.1:"+port+"/api/health",{signal:AbortSignal.timeout(2000)});
      console.log(JSON.stringify({response,healthStatus:health.status,health:await health.json()}));
    } finally {await app.close();}
  `;
  const result=spawnSync(process.execPath,["--import","tsx","--input-type=module","--eval",source],{
    cwd:resolve("."),encoding:"utf8",windowsHide:true,timeout:10000,
  });
  expect(result.status,result.stderr||result.error?.message).toBe(0);
  const outcome=JSON.parse(result.stdout);
  expect(outcome.response).toMatch(/^HTTP\/1\.1 400\b/);
  expect(outcome.healthStatus).toBe(200);
  expect(outcome.health).toMatchObject({ok:true,mode:"http"});
}
it("非法HTTP请求地址返回400，网关仍能正常响应健康检查",()=>{
  expectInvalidAddressRejected("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
});
it("非法WebSocket升级地址返回400，网关仍能正常响应健康检查",()=>{
  expectInvalidAddressRejected("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
});
it("语音尝试可记录取消，查询和下载都需工作人员凭据，不能导出记录令牌",async()=>{
  app=createBoothApplication({...readBoothConfig(),databasePath:":memory:",operatorToken:"fixture-operator",speech:{enabled:true,provider:"ali",aliKey:"fixture-key",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}});
  const base="http://127.0.0.1:"+await app.listen(0);
  const post=(path:string,value:unknown)=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
  const response=await post("/api/booth/speech/attempts",{});expect(response.status).toBe(200);const receipt=await response.json();
  expect((await post(`/api/booth/speech/attempts/${receipt.id}`,{token:receipt.token,status:"cancelled",reason:"microphone-denied"})).status).toBe(200);
  expect((await fetch(base+"/api/booth/developer/speech")).status).toBe(403);
  expect((await fetch(base+"/api/booth/developer/speech?download=1")).status).toBe(403);
  const exported=await fetch(base+"/api/booth/developer/speech?download=1",{headers:{"X-Operator-Token":"fixture-operator"}});
  expect(exported.headers.get("Content-Disposition")).toContain("attachment");const body=await exported.text();
  expect(JSON.parse(body).records[0]).toMatchObject({status:"cancelled",stopReason:"microphone-denied",provider:"ali"});
  expect(body).not.toContain(receipt.token);expect(body).not.toContain("fixture-key");
});
it("运行记录写入失败不阻止原有文字聊天",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"speech-storage-")),path=join(directory,"test.sqlite");
  let database:DatabaseSync|undefined,aiCalls=0;
  try{
    app=createBoothApplication({...readBoothConfig(),databasePath:path,speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
      {assistant:{async advise(){aiCalls++;return {reply:"请核对物品和数量",selection:null,taskStatusQuery:false};}}});
    const base="http://127.0.0.1:"+await app.listen(0);
    const receipt=await(await fetch(base+"/api/booth/speech/attempts",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
    database=new DatabaseSync(path);
    // 在真实存储边界模拟磁盘写入失败，不替换记录实现。
    database.prepare("UPDATE booth_diagnostics SET value=json_set(value,'$.status','success','$.text','两瓶矿泉水') WHERE id=?").run(receipt.id);
    database.exec("CREATE TRIGGER fail_diagnostics BEFORE INSERT ON booth_diagnostics BEGIN SELECT RAISE(FAIL,'fixture disk full'); END");
    const response=await fetch(base+"/api/booth/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:"一瓶矿泉水"}],speechRecords:[receipt]})});
    expect(response.status).toBe(200);expect(aiCalls).toBe(1);expect((await response.json()).reply).toBe("请核对物品和数量");
  }finally{database?.close();await app?.close();app=undefined;rmSync(directory,{recursive:true,force:true});}
});
it.each(["http","simulator"] as const)("%s模式共用识别入口：只返回文字，记录取消，不触发聊天或任务",async mode=>{
  const cloud=new WebSocketServer({port:0,host:"127.0.0.1"});await once(cloud,"listening");
  cloud.on("connection",ws=>ws.on("message",(raw,binary)=>{if(binary)return;const data=JSON.parse(raw.toString());
    if(data.header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));
    if(data.header?.action==="finish-task"){
      ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"两个小面包",sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:"task-finished"}}));
    }
  }));
  try{
    app=createBoothApplication({...readBoothConfig(),mode,databasePath:":memory:",operatorToken:"fixture-operator",speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
      {speechConnect:()=>new WebSocket("ws://127.0.0.1:"+(cloud.address() as {port:number}).port),assistant:{async advise(){throw new Error("识别不得调用文字AI");}}});
    const base="http://127.0.0.1:"+await app.listen(0);
    const receipt=await(await fetch(base+"/api/booth/speech/attempts",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
    const ws=new WebSocket(base.replace("http:","ws:")+"/api/booth/speech/live",{origin:base});const messages:Record<string,any>[]=[];
    const done=new Promise<void>((resolve,reject)=>{ws.on("error",reject);ws.on("message",raw=>{const data=JSON.parse(raw.toString());messages.push(data);if(data.type==="ready"){ws.send(Buffer.alloc(6400));ws.send(JSON.stringify({type:"stop",reason:"manual"}));}if(data.type==="final")resolve();});});
    await once(ws,"open");ws.send(JSON.stringify({type:"start",...receipt}));await done;ws.close();
    expect(messages.find(m=>m.type==="final")).toMatchObject({text:"两个小面包"});
    const records=await(await fetch(base+"/api/booth/developer/speech",{headers:{"X-Operator-Token":"fixture-operator"}})).json();
    expect(records.records[0]).toMatchObject({status:"success",text:"两个小面包",stopReason:"manual",mode});
    expect((await(await fetch(base+"/api/booth")).json()).tasks).toHaveLength(0);
  }finally{for(const ws of cloud.clients)ws.terminate();await new Promise<void>(r=>cloud.close(()=>r()));}
});
it("语音记录写入失败仍返回识别文字，并告知记录未保存",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"speech-result-")),path=join(directory,"test.sqlite");
  const cloud=new WebSocketServer({port:0,host:"127.0.0.1"});await once(cloud,"listening");
  cloud.on("connection",ws=>ws.on("message",(raw,binary)=>{if(binary)return;const data=JSON.parse(raw.toString());
    if(data.header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));
    if(data.header?.action==="finish-task"){
      ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"一个纪念品",sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:"task-finished"}}));
    }
  }));
  let database:DatabaseSync|undefined;
  try{
    app=createBoothApplication({...readBoothConfig(),databasePath:path,speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
      {speechConnect:()=>new WebSocket("ws://127.0.0.1:"+(cloud.address() as {port:number}).port)});
    const base="http://127.0.0.1:"+await app.listen(0);
    const receipt=await(await fetch(base+"/api/booth/speech/attempts",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
    database=new DatabaseSync(path);database.exec("CREATE TRIGGER fail_diagnostics BEFORE INSERT ON booth_diagnostics BEGIN SELECT RAISE(FAIL,'fixture disk full'); END");
    const ws=new WebSocket(base.replace("http:","ws:")+"/api/booth/speech/live",{origin:base});
    const result=new Promise<Record<string,unknown>>((resolve,reject)=>{ws.on("error",reject);ws.on("message",raw=>{const data=JSON.parse(raw.toString());if(data.type==="ready")ws.send(JSON.stringify({type:"stop"}));if(data.type==="final"||data.type==="error")resolve(data);});});
    await once(ws,"open");ws.send(JSON.stringify({type:"start",...receipt}));
    expect(await result).toMatchObject({type:"final",text:"一个纪念品",recordSaved:false});ws.close();
    expect((await fetch(base+"/api/health")).status).toBe(200);
  }finally{database?.close();await app?.close();app=undefined;for(const ws of cloud.clients)ws.terminate();await new Promise<void>(r=>cloud.close(()=>r()));rmSync(directory,{recursive:true,force:true});}
});
