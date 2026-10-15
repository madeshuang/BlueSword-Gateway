/** 本机人工机器人工具：接单回复与结果通知均由按钮触发，不代表真实机器人。 */
import { createServer, type ServerResponse, type IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface WireMessage { url:string; method:string; headers:Record<string,unknown>; headersScope:string; body:string }
interface WireRecord { time:string; direction:string; request:WireMessage; response?:{status:number;headers:Record<string,unknown>;headersScope:string;body:string}; error?:string }
export function createManualRobot(callbackBase: string) {
  const callback = new URL(callbackBase);
  if (callback.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(callback.hostname) ||
    callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/") throw new Error("人工工具发送通知的目标只允许本机 HTTP 基址");
  const html = readFileSync(new URL("./robot-manual.html",import.meta.url));
  let phase: "idle" | "pending" | "accepted" | "sending" = "idle";
  let pending: {res:ServerResponse;record:WireRecord} | undefined;
  let item: unknown = null;
  const records: WireRecord[] = [];
  const responseHeaders={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"};
  const responseHeaderScope="本工具显式设置的头；不含 HTTP 服务自动补充字段";
  function record(direction:string,request:WireMessage) {
    const entry:WireRecord={time:new Date().toISOString(),direction,request}; records.push(entry);
    if(records.length>200) records.shift(); return entry;
  }
  function json(res:ServerResponse,status:number,value:unknown) {
    res.writeHead(status,responseHeaders);res.end(JSON.stringify(value));
  }
  function receipt(success:boolean) {
    if (!pending || pending.res.destroyed) throw new Error("该请求已断开，不能补发接单回复");
    const body=JSON.stringify({code:1,data:success?"received":"人工拒绝任务",success});
    pending.record.response={status:200,headers:responseHeaders,headersScope:responseHeaderScope,body};
    json(pending.res,200,JSON.parse(body)); pending=undefined; phase=success?"accepted":"idle";
  }
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??"/","http://localhost");
    try {
      if(req.method==="GET" && url.pathname==="/") {res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);return;}
      if(req.method==="GET" && ["/manual/state","/manual/report"].includes(url.pathname)) {
        if(url.pathname.endsWith("report")) res.setHeader("Content-Disposition",'attachment; filename="manual-interface-record.json"');
        return json(res,200,{scope:"本机人工机器人工具的 HTTP 通信记录；不证明真实机器人动作或真实 AI 效果",phase,item,records});
      }
      if(req.method!=="POST") return json(res,404,{error:"Not found"});
      if(!req.headers["content-type"]?.startsWith("application/json")) return json(res,415,{error:"请发送 application/json"});
      // 浏览器控制只接受本工具自身的页面，不提供跨源控制。
      if(url.pathname.startsWith("/manual/") && req.headers.origin && req.headers.origin!=="http://"+req.headers.host) return json(res,403,{error:"请从本机人工工具操作"});
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){const buffer=Buffer.from(chunk);size+=buffer.length;if(size>32768) return json(res,413,{error:"请求过大"});chunks.push(buffer);}
      const raw=Buffer.concat(chunks).toString("utf8");
      const body=raw?JSON.parse(raw):{};
      if(!body || typeof body!=="object" || Array.isArray(body)) return json(res,400,{error:"需要 JSON 对象"});
      if(url.pathname==="/api/task/dispatch") {
        const entry=record("网关 → 人工机器人",{url:"http://"+req.headers.host+url.pathname,method:"POST",headers:safeHeaders(req.headers),headersScope:"实际收到的头；敏感字段已隐藏",body:raw});
        if(typeof body.location!=="string" || !body.location.trim() || typeof body.item!=="string" || !body.item.trim() ||
          !Number.isSafeInteger(body.count) || body.count<1 || Object.keys(body).sort().join()!=="count,item,location") {
          const value={code:1,data:"报文不合法",success:false};entry.response={status:400,headers:responseHeaders,headersScope:responseHeaderScope,body:JSON.stringify(value)};return json(res,400,value);
        }
        if(phase!=="idle") {
          const value={code:1,data:"人工机器人工具中有尚未结束的任务",success:false};entry.response={status:200,headers:responseHeaders,headersScope:responseHeaderScope,body:JSON.stringify(value)};return json(res,200,value);
        }
        item=body;phase="pending";pending={res,record:entry};
        res.on("close",()=>{if(pending?.res===res){entry.error="连接已断开，未发送接单回复；请在网关核对是否已转为无法确认接单的状态";pending=undefined;phase="idle";}});
        return;
      }
      if(["/manual/accept","/manual/reject"].includes(url.pathname)) {
        if(phase!=="pending") return json(res,409,{error:"没有等待接受或拒绝的任务请求"});
        receipt(url.pathname.endsWith("accept"));return json(res,200,{phase});
      }
      if(["/manual/finished","/manual/error"].includes(url.pathname)) {
        if(phase!=="accepted") return json(res,409,{error:"请先接受任务；结果通知发送中或任务已结束时不能重复点击"});
        const failed=url.pathname.endsWith("error");
        if(failed && (typeof body.message!=="string" || !body.message.trim() || body.message.length>1000)) return json(res,400,{error:"故障说明需为1–1000字"});
        const target=new URL(failed?"/api/task/error":"/api/task/finished",callback).href;
        const data=JSON.stringify(failed?{message:body.message.trim()}:{result:"success"});
        const headers={"Content-Type":"application/json"};
        const entry=record("人工机器人 → 网关",{url:target,method:"POST",headers,headersScope:"本工具显式设置的头；不含 HTTP 客户端自动补充字段",body:data});phase="sending";
        try {
          const response=await fetch(target,{method:"POST",headers,body:data,signal:AbortSignal.timeout(5000),redirect:"error"});
          const text=await response.text();entry.response={status:response.status,headers:Object.fromEntries(response.headers),headersScope:"实际收到的响应头",body:text};
          let acknowledged=false;try{acknowledged=response.ok && JSON.parse(text).success===true;}catch{}
          phase=acknowledged?"idle":"accepted";
          return json(res,acknowledged?200:502,{phase,error:acknowledged?null:"网关未确认成功接收，请检查原始记录"});
        } catch(error) {entry.error=error instanceof Error?error.message:String(error);phase="accepted";return json(res,502,{phase,error:"向网关发送结果通知时连接失败，请检查原始记录"});}
      }
      json(res,404,{error:"Not found"});
    } catch {if(!res.headersSent)json(res,400,{error:"请求不合法"});else res.end();}
  });
  return {
    listen(port:number):Promise<number> {return new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",()=>{server.removeListener("error",reject);resolve((server.address() as {port:number}).port);});});},
    close():Promise<void> {pending?.res.destroy();return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
  };
}
function safeHeaders(headers:IncomingHttpHeaders):Record<string,unknown> {
  return Object.fromEntries(Object.entries(headers).map(([name,value])=>[name,/authorization|cookie|token|experience/i.test(name)?"[已隐藏]":value]));
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const port=Number(process.env.BOOTH_MANUAL_ROBOT_PORT??4201);
  if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error("人工机器人工具的端口不合法");
  const robot=createManualRobot(process.env.BOOTH_MANUAL_CALLBACK_URL??"http://127.0.0.1:4101");
  await robot.listen(port);console.log("人工机器人接口工具：http://127.0.0.1:"+port);
  process.once("SIGINT",()=>void robot.close());process.once("SIGTERM",()=>void robot.close());
}
