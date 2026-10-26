import {afterEach,expect,it} from "vitest";
import {chromium,type Browser} from "playwright";
import WebSocket,{WebSocketServer} from "ws";
import {once} from "node:events";
import {resolve} from "node:path";
import {cpSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {createBoothApplication} from "./server.js";
import {readBoothConfig} from "./config.js";
let app:ReturnType<typeof createBoothApplication>|undefined,browser:Browser|undefined,cloud:WebSocketServer|undefined,webFixture:string|undefined;
afterEach(async()=>{await browser?.close();await app?.close();for(const ws of cloud?.clients??[])ws.terminate();await new Promise<void>(r=>cloud?cloud.close(()=>r()):r());if(webFixture){rmSync(webFixture,{recursive:true,force:true});webFixture=undefined;}});
it.each(["http","simulator"] as const)("%s浏览器录音、草稿竞争和记录下载不绕过用户确认",async mode=>{
  cloud=new WebSocketServer({port:0,host:"127.0.0.1"});await once(cloud,"listening");
  let releaseFinal:(()=>void)|undefined,holdFinal=false,failCloud=false;
  cloud.on("connection",ws=>ws.on("message",(raw,binary)=>{if(binary)return;const data=JSON.parse(raw.toString());
    if(data.header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));
    if(data.header?.action==="finish-task"){
      const send=()=>{if(ws.readyState!==WebSocket.OPEN)return;
        if(failCloud){ws.send(JSON.stringify({header:{event:"task-failed",error_message:"fixture-secret-should-not-leak"}}));return;}
        ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"两瓶矿泉水",sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:"task-finished"}}));};
      if(holdFinal)releaseFinal=send;else send();
    }
  }));
  let aiCalls=0;
  app=createBoothApplication({...readBoothConfig(),mode,databasePath:":memory:",operatorToken:"fixture-operator",openaiKey:"fixture",speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
    {webDirectory:resolve("apps/web/dist"),speechConnect:()=>new WebSocket("ws://127.0.0.1:"+(cloud!.address() as {port:number}).port),assistant:{async advise(){aiCalls++;return {reply:"请确认物品和数量",selection:[{productId:"water",count:1}],taskStatusQuery:false};}}});
  const base="http://127.0.0.1:"+await app.listen(0);
  browser=await chromium.launch({headless:true,channel:"msedge",args:["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"]});
  const context=await browser.newContext({permissions:["microphone"]}),page=await context.newPage();
  await page.goto(base);await page.getByRole("button",{name:"开始语音输入",exact:true}).click({timeout:3000});
  await page.getByRole("button",{name:"停止语音输入",exact:true}).waitFor({timeout:30000});
  await page.waitForTimeout(300);await page.getByRole("button",{name:"停止语音输入",exact:true}).click();
  const draft=page.getByRole("textbox",{name:"告诉助手你的需求"});await expect.poll(()=>draft.inputValue()).toBe("两瓶矿泉水");expect(aiCalls).toBe(0);
  await draft.fill("一瓶矿泉水");await page.getByRole("button",{name:"发送需求",exact:true}).click();
  await expect.poll(()=>aiCalls).toBe(1);expect(app.service.snapshot().tasks).toHaveLength(0);
  const records=await(await fetch(base+"/api/booth/developer/speech",{headers:{"X-Operator-Token":"fixture-operator"}})).json();
  expect(records.records[0]).toMatchObject({text:"两瓶矿泉水",sentText:"一瓶矿泉水"});
  await page.getByText("请确认物品和数量",{exact:true}).waitFor();
  const begin=async()=>{await page.getByRole("button",{name:"开始语音输入",exact:true}).click();await page.getByRole("button",{name:"停止语音输入",exact:true}).waitFor();};
  await draft.fill("保留草稿");await begin();await page.getByRole("button",{name:"取消语音输入",exact:true}).click();expect(await draft.inputValue()).toBe("保留草稿");
  await begin();await draft.fill("录音期间的新草稿");await page.getByRole("button",{name:"停止语音输入",exact:true}).click();
  await page.getByRole("status").filter({hasText:"输入内容已更改"}).waitFor();expect(await draft.inputValue()).toBe("录音期间的新草稿");
  await begin();await page.getByRole("button",{name:"发送需求",exact:true}).click();await expect.poll(()=>aiCalls).toBe(2);
  await draft.fill("发送后的新草稿");await page.waitForTimeout(100);expect(await draft.inputValue()).toBe("发送后的新草稿");
  holdFinal=true;await begin();await page.getByRole("button",{name:"停止语音输入",exact:true}).click();await expect.poll(()=>!!releaseFinal).toBe(true);
  await page.getByRole("button",{name:"开始新体验",exact:true}).click();releaseFinal?.();holdFinal=false;expect(await draft.inputValue()).toBe("");
  await draft.fill("失败时保留");failCloud=true;await begin();await page.getByRole("button",{name:"停止语音输入",exact:true}).click();
  await page.getByRole("status").filter({hasText:"拒绝本次识别"}).waitFor();expect(await draft.inputValue()).toBe("失败时保留");failCloud=false;
  await begin();await page.getByRole("button",{name:"停止语音输入",exact:true}).click();await expect.poll(()=>draft.inputValue()).toBe("失败时保留\n两瓶矿泉水");
  expect(app.service.snapshot().tasks).toHaveLength(0);expect(aiCalls).toBe(2);
  await page.goto(base+"/developer/speech");await page.getByRole("textbox",{name:"工作人员口令"}).fill("wrong");await page.getByRole("button",{name:"读取／刷新"}).click();await page.getByRole("alert").waitFor();
  expect(await page.locator("tbody tr").count()).toBe(0);await page.getByRole("textbox",{name:"工作人员口令"}).fill("fixture-operator");await page.getByRole("button",{name:"读取／刷新"}).click();await expect.poll(()=>page.locator("tbody tr").count()).toBe(7);
  const download=page.waitForEvent("download");await page.getByRole("button",{name:"下载 JSON"}).click();expect((await download).suggestedFilename()).toContain("speech");
  expect(await page.content()).not.toContain("fixture-secret-should-not-leak");
},90000);
it("未检测到讲话自动退出，麦克风权限拒绝不清空已有草稿",async()=>{
  cloud=new WebSocketServer({port:0,host:"127.0.0.1"});await once(cloud,"listening");
  cloud.on("connection",ws=>ws.on("message",(raw,binary)=>{if(!binary&&JSON.parse(raw.toString()).header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));}));
  app=createBoothApplication({...readBoothConfig(),databasePath:":memory:",openaiKey:"fixture",operatorToken:"fixture-operator",speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
    {webDirectory:resolve("apps/web/dist"),speechConnect:()=>new WebSocket("ws://127.0.0.1:"+(cloud!.address() as {port:number}).port)});
  const base="http://127.0.0.1:"+await app.listen(0);
  browser=await chromium.launch({headless:true,channel:"msedge",args:["--use-fake-device-for-media-stream"]});
  const context=await browser.newContext({permissions:["microphone"]}),page=await context.newPage();
  await page.goto(base);const draft=page.getByRole("textbox",{name:"告诉助手你的需求"});await draft.fill("已有草稿");
  await page.getByRole("button",{name:"开始语音输入",exact:true}).click();await page.getByRole("status").filter({hasText:"没有听到说话"}).waitFor({timeout:20000});expect(await draft.inputValue()).toBe("已有草稿");
  await context.grantPermissions([],{origin:base});await page.getByRole("button",{name:"开始语音输入",exact:true}).click();await page.getByRole("status").filter({hasText:"麦克风权限未允许"}).waitFor({timeout:5000});expect(await draft.inputValue()).toBe("已有草稿");
  await expect.poll(async()=>{const data=await(await fetch(base+"/api/booth/developer/speech",{headers:{"X-Operator-Token":"fixture-operator"}})).json();return data.records[0];}).toMatchObject({status:"error",stopReason:"microphone-denied"});
},35000);
it("自动停止资源缺失时可手动停止，连续录音达到60秒仍能正常收尾",async()=>{
  webFixture=mkdtempSync(resolve(tmpdir(),"speech-assets-"));cpSync(resolve("apps/web/dist"),webFixture,{recursive:true});rmSync(resolve(webFixture,"assets/speech-vad/vad.worklet.bundle.min.js"));
  cloud=new WebSocketServer({port:0,host:"127.0.0.1"});await once(cloud,"listening");
  const audioBytes:number[]=[];
  cloud.on("connection",ws=>{let bytes=0;ws.on("message",(raw,binary)=>{if(binary){bytes+=Buffer.from(raw as Buffer).length;return;}const data=JSON.parse(raw.toString());
    if(data.header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));
    if(data.header?.action==="finish-task"){audioBytes.push(bytes);ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"一瓶矿泉水",sentence_end:true}}}}));ws.send(JSON.stringify({header:{event:"task-finished"}}));}
  });});
  app=createBoothApplication({...readBoothConfig(),mode:"simulator",databasePath:":memory:",openaiKey:"fixture",operatorToken:"fixture-operator",speech:{enabled:true,provider:"ali",aliKey:"fixture",aliWorkspace:undefined,tencentAppId:undefined,tencentSecretId:undefined,tencentSecretKey:undefined}},
    {webDirectory:webFixture,speechConnect:()=>new WebSocket("ws://127.0.0.1:"+(cloud!.address() as {port:number}).port)});
  const base="http://127.0.0.1:"+await app.listen(0);
  browser=await chromium.launch({headless:true,channel:"msedge",args:["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"]});
  const page=await browser.newPage({permissions:["microphone"]});
  await page.goto(base);await page.getByRole("button",{name:"开始语音输入",exact:true}).click({timeout:5000});
  await page.getByRole("status").filter({hasText:"请说完后点击停止"}).waitFor({timeout:15000});
  await page.getByRole("button",{name:"停止语音输入",exact:true}).click();
  await expect.poll(()=>page.getByRole("textbox",{name:"告诉助手你的需求"}).inputValue()).toBe("一瓶矿泉水");
  await page.getByRole("button",{name:"开始语音输入",exact:true}).click();
  await expect.poll(()=>page.getByRole("textbox",{name:"告诉助手你的需求"}).inputValue(),{timeout:70000}).toBe("一瓶矿泉水\n一瓶矿泉水");
  expect(audioBytes.at(-1)).toBeLessThanOrEqual(1920000);expect(audioBytes.at(-1)).toBeGreaterThan(1800000);
  const records=await(await fetch(base+"/api/booth/developer/speech",{headers:{"X-Operator-Token":"fixture-operator"}})).json();
  expect(records.records[0]).toMatchObject({status:"success",stopReason:"limit"});
},90000);
