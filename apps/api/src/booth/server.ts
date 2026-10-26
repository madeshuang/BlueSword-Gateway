import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { BoothChatMessage } from "@bluesword/contracts";
import { ApplicationStorage } from "../storage.js";
import type { BoothConfig } from "./config.js";
import { BoothError, BoothService } from "./service.js";
import { DeepSeekBoothAssistant } from "./deepseek.js";
import { OpenAIBoothAssistant } from "./openai.js";

import { explicitlyExceedsOrderLimit, type AiCallObserver } from "./advice.js";
import { builtWeb } from "./static.js";
import {Diagnostics} from "./diagnostics.js";
import {speechModels,speechConfigured,type SpeechConnect} from "./speech-provider.js";
import {attachSpeech} from "./speech-gateway.js";
import {captureRobotNotification,captureRobotReply,recordingRobotTransport} from "./wire.js";

export function createBoothApplication(config: BoothConfig, options: { webDirectory?: string; transport?: typeof fetch; assistantTransport?: typeof fetch; onAiCall?: AiCallObserver; assistant?: Pick<OpenAIBoothAssistant, "advise">; speechConnect?:SpeechConnect } = {}) {
  const serveWeb = options.webDirectory ? builtWeb(options.webDirectory) : undefined;
  const storage = new ApplicationStorage(config.databasePath);
  const diagnostics=new Diagnostics(storage,config.mode);
  const recoverManualTask = config.manualRobot ? async (taskId:string|null) => {
    if(!config.dispatchUrl)throw new BoothError("人工机器人工具地址未配置，新任务限制仍保留",503);
    const target=new URL("/manual/reset",config.dispatchUrl);
    if(target.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(target.hostname)||target.username||target.password)
      throw new BoothError("人工练习恢复只允许连接本机人工机器人工具",503);
    let response:Response;
    try{response=await fetch(target,{method:"POST",headers:{"Content-Type":"application/json","X-Operator-Token":config.operatorToken!},body:JSON.stringify({taskId}),signal:AbortSignal.timeout(5000),redirect:"error"});}
    catch{throw new BoothError("无法确认人工工具是否已清理旧练习，新任务限制仍保留，请检查工具后重试",503);}
    const result=await response.json().catch(()=>null);
    if(!response.ok||result?.success!==true)throw new BoothError(typeof result?.error==="string"?result.error:"人工工具未确认清理旧练习，新任务限制仍保留",response.status===409?409:503);
  } : undefined;
  const service = new BoothService(storage, config, recordingRobotTransport(options.transport??fetch,diagnostics),recoverManualTask);
  const assistant = options.assistant ?? (config.aiProvider === "deepseek"
    ? new DeepSeekBoothAssistant(config,options.assistantTransport,options.onAiCall)
    : new OpenAIBoothAssistant(config,options.assistantTransport,options.onAiCall));
  const streams = new Set<ServerResponse>();
  const work = new Set<Promise<unknown>>();
  let closing = false, aiBusy = false;
  const server = createServer((req, res) => {
    const operation = handle(req,res).catch(error => {
      if (!res.headersSent) json(res, error instanceof BoothError ? error.status : 500, {
        code:1, data:error instanceof BoothError ? error.message : "服务暂不可用，请联系工作人员", success:false,
      });
      else res.end();
    }).finally(() => work.delete(operation));
    work.add(operation);
  });
  const speech=attachSpeech(server,config.speech,diagnostics,options.speechConnect);
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url:URL;
    try {url=new URL(req.url??"/","http://localhost");}
    catch {throw new BoothError("请求地址不合法",400);}
    if(["/api/task/finished","/api/task/error"].includes(url.pathname))captureRobotNotification(req,res,diagnostics);
    if (closing) throw new BoothError("服务正在关闭",503);
    if (serveWeb?.(req,res,url.pathname)) return;
    if (req.method === "GET" && url.pathname === "/api/health") return json(res,200,{ok:true,version:"booth-v1",mode:config.mode});
    if (req.method === "GET" && url.pathname === "/api/booth") return json(res,200,service.snapshot());
    if(req.method==="GET"&&url.pathname==="/api/booth/speech")return json(res,200,{configured:!!config.speech&&speechConfigured(config.speech)});
    if(req.method==="GET"&&["/api/booth/developer/speech","/api/booth/developer/robot"].includes(url.pathname)){
      requireOperator(req,config.operatorToken);
      const kind=url.pathname.endsWith("speech")?"speech":"robot";
      if(url.searchParams.get("download")==="1")res.setHeader("Content-Disposition",`attachment; filename="bluesword-${kind}-records.json"`);
      return json(res,200,{scope:"网关运行记录；仅证明本机采集到的请求和结果",limit:200,audioSaved:false,records:kind==="speech"?diagnostics.listSpeech():diagnostics.listWire()});
    }
    if (req.method === "GET" && url.pathname === "/api/booth/events") {
      res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform",Connection:"keep-alive"});
      const send = () => res.write("data: " + JSON.stringify(service.snapshot()) + "\n\n");
      const unsubscribe = service.subscribe(send);
      streams.add(res); send();
      const heartbeat = setInterval(()=>res.write(": heartbeat\n\n"),5000);
      res.on("close",()=>{clearInterval(heartbeat);unsubscribe();streams.delete(res);});
      return;
    }
    if (req.method !== "POST") return json(res,404,{code:1,data:"Not found",success:false});
    const body = await readBody(req);
    if(url.pathname.startsWith("/api/booth/speech/")){
      if(req.headers.origin&&req.headers.origin!=="http://"+req.headers.host&&req.headers.origin!=="https://"+req.headers.host)throw new BoothError("请从网关页面操作",403);
      if(url.pathname==="/api/booth/speech/attempts"){
        if(!config.speech||!speechConfigured(config.speech))throw new BoothError("语音服务尚未配置，可继续打字",503);
        return json(res,200,diagnostics.startSpeech(config.speech.provider,speechModels[config.speech.provider]));
      }
      const match=/^\/api\/booth\/speech\/attempts\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(match){
        if(typeof body.token!=="string"||body.token.length>128)throw new BoothError("识别记录凭据不合法",403);
        try{
          const record=diagnostics.authorizeSpeech(match[1]!,body.token);
          if(body.status==="cancelled"||body.status==="error"){
            if(body.status==="cancelled"||record.status==="starting")diagnostics.finishSpeech(record.id,{status:body.status,stopReason:["cancelled","microphone-denied","no-speech","capture-failed","connection-failed","experience-changed","sent-draft"].includes(body.reason)?body.reason:"cancelled"});
          }else{
            if(typeof body.applied!=="boolean")throw new Error("草稿状态不合法");
            diagnostics.updateSpeech(record.id,body.token,{applied:body.applied,...(body.endToDraftMs===undefined?{}:{endToDraftMs:body.endToDraftMs})});
          }
        }catch{throw new BoothError("记录更新失败，请核对记录凭据和字段",400);}
        return json(res,200,{saved:true});
      }
    }
    if (url.pathname === "/api/booth/experiences") return json(res,200,service.createExperience());
    if (url.pathname === "/api/task/finished") {
      if (Object.keys(body).length !== 0 && (body.result !== "success" || Object.keys(body).some(k=>k!=="result"))) throw new BoothError("完成通知仅接受空JSON对象或 result:success");
      service.finished(); return json(res,200,{code:1,data:"OK",success:true});
    }
    if (url.pathname === "/api/task/error") {
      if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 1000) throw new BoothError("故障描述不能为空且不得超过1000字");
      service.error(body.message.trim()); return json(res,200,{code:1,data:"OK",success:true});
    }
    if (url.pathname === "/api/booth/requests") {
      // Old pages can still check their saved single-item request after an upgrade.
      const selection = body.items === undefined ? [{productId:body.productId,count:body.count}] : body.items;
      const task = await service.dispatch(selection,body.requestId,req.headers["x-booth-experience"]);
      return json(res,200,{task});
    }
    if (url.pathname === "/api/booth/chat") {
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 12 ||
        body.messages.some(m => !m || typeof m !== "object" || !["user","assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim() || m.content.length > 2000) ||
        body.messages.at(-1).role !== "user") throw new BoothError("对话内容不合法");
      if (aiBusy) throw new BoothError("助手暂时繁忙，请稍后再试，也可以直接选择物品。",429);
      if(Array.isArray(body.speechRecords)&&body.speechRecords.length<=20){
        const receipts=body.speechRecords.filter((r:unknown):r is {id:string;token:string}=>!!r&&typeof r==="object"&&typeof (r as {id?:unknown}).id==="string"&&typeof (r as {token?:unknown}).token==="string"&&(r as {token:string}).token.length<=128);
        try{diagnostics.linkSent(receipts,body.messages.at(-1).content);}
        catch{console.warn(JSON.stringify({event:"developer_record_failed",kind:"speech-send"}));}
      }
      if (explicitlyExceedsOrderLimit(body.messages.at(-1).content)) return json(res,200,{reply:"每单最多两件，请重新确认想取的物品和数量。",selection:null});
      aiBusy = true;
      try {
        const token = req.headers["x-booth-experience"];
        const advice = await assistant.advise(body.messages as BoothChatMessage[],service.taskProgress(token),service.products());
        // Re-read after the model call: a completion may have arrived while it was thinking.
        if (advice.taskStatusQuery) {
          const current = service.taskProgress(token);
          return json(res,200,{reply:current.replyOptions.includes(advice.reply) ? advice.reply : current.conclusion,selection:null});
        }
        return json(res,200,service.stockAdvice({reply:advice.reply,selection:advice.selection}));
      }
      finally { aiBusy = false; }
    }
    if (url.pathname === "/api/booth/operator/resolve") {
      requireOperator(req,config.operatorToken);
      await service.resolve(body.confirmation,body.expectedTaskId,body.expectedAlert); return json(res,200,service.snapshot());
    }
    if (url.pathname === "/api/booth/operator/stock/reset") {
      requireOperator(req,config.operatorToken);
      service.resetStock(body.productId,body.confirmation); return json(res,200,service.snapshot());
    }
    if (url.pathname === "/api/booth/operator/stock/reset-all") {
      requireOperator(req,config.operatorToken);
      service.resetAllStock(body.confirmation); return json(res,200,service.snapshot());
    }
    json(res,404,{code:1,data:"Not found",success:false});
  }
  return {
    service,
    listen(port: number, host = "127.0.0.1"): Promise<number> {
      return new Promise((resolve,reject) => {
        server.once("error",reject);
        server.listen(port,host,()=>{server.removeListener("error",reject);resolve((server.address() as {port:number}).port);});
      });
    },
    async close(): Promise<void> {
      closing=true;
      await speech.close();
      for (const res of streams) res.end();
      await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
      await Promise.allSettled([...work]); storage.close();
    },
  };
}
function requireOperator(req: IncomingMessage, token: string | undefined): void {
  if (!token) throw new BoothError("工作人员操作凭据尚未配置",503);
  const provided = Buffer.from(typeof req.headers["x-operator-token"] === "string" ? req.headers["x-operator-token"] : "");
  const expected = Buffer.from(token);
  if (provided.length !== expected.length || !timingSafeEqual(provided,expected)) throw new BoothError("工作人员凭据不正确",403);
}
function json(res: ServerResponse, status: number, data: unknown): void {
  const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"},body=JSON.stringify(data);
  captureRobotReply(res,status,headers,body);
  res.writeHead(status,headers);
  res.end(body);
}
async function readBody(req: IncomingMessage): Promise<Record<string,any>> {
  if (req.headers["content-type"] && !req.headers["content-type"].startsWith("application/json")) throw new BoothError("请发送JSON请求",415);
  const chunks: Buffer[]=[]; let bytes=0;
  for await (const chunk of req) {
    const buffer=Buffer.from(chunk); bytes+=buffer.length;
    if(bytes>32768) throw new BoothError("请求内容过大",413);
    chunks.push(buffer);
  }
  try {
    const body=chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if(!body || typeof body!=="object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new BoothError("请求必须是JSON对象"); }
}
