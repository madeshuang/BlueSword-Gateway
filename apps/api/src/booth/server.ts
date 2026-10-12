import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { BoothChatMessage } from "@bluesword/contracts";
import { ApplicationStorage } from "../storage.js";
import type { BoothConfig } from "./config.js";
import { BoothError, BoothService } from "./service.js";
import { DeepSeekBoothAssistant } from "./deepseek.js";
import { OpenAIBoothAssistant } from "./openai.js";

import type { AiCallObserver } from "./advice.js";

export function createBoothApplication(config: BoothConfig, options: { transport?: typeof fetch; assistantTransport?: typeof fetch; onAiCall?: AiCallObserver; assistant?: Pick<OpenAIBoothAssistant, "advise"> } = {}) {
  const storage = new ApplicationStorage(config.databasePath);
  const service = new BoothService(storage, config, options.transport);
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
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) throw new BoothError("服务正在关闭",503);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") return json(res,200,{ok:true,version:"booth-v1",mode:config.mode});
    if (req.method === "GET" && url.pathname === "/api/booth") return json(res,200,service.snapshot());
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
    if (url.pathname === "/api/task/finished") {
      if (Object.keys(body).length !== 0 && (body.result !== "success" || Object.keys(body).some(k=>k!=="result"))) throw new BoothError("完成通知仅接受空JSON对象或 result:success");
      service.finished(); return json(res,200,{code:1,data:"OK",success:true});
    }
    if (url.pathname === "/api/task/error") {
      if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 1000) throw new BoothError("故障描述不能为空且不得超过1000字");
      service.error(body.message.trim()); return json(res,200,{code:1,data:"OK",success:true});
    }
    if (url.pathname === "/api/booth/requests") {
      const task = await service.dispatch(body.productId,body.count,body.requestId);
      return json(res,200,{task});
    }
    if (url.pathname === "/api/booth/chat") {
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 12 ||
        body.messages.some(m => !m || typeof m !== "object" || !["user","assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim() || m.content.length > 2000) ||
        body.messages.at(-1).role !== "user") throw new BoothError("对话内容不合法");
      if (aiBusy) throw new BoothError("智能助手正在处理请求，请稍后再试",429);
      aiBusy = true;
      try { return json(res,200,await assistant.advise(body.messages as BoothChatMessage[])); }
      finally { aiBusy = false; }
    }
    if (url.pathname === "/api/booth/operator/resolve") {
      if (!config.operatorToken) throw new BoothError("工作人员操作凭据尚未配置",503);
      const provided = Buffer.from(typeof req.headers["x-operator-token"] === "string" ? req.headers["x-operator-token"] : "");
      const expected = Buffer.from(config.operatorToken);
      if (provided.length !== expected.length || !timingSafeEqual(provided,expected)) throw new BoothError("工作人员凭据不正确",403);
      service.resolve(body.confirmation); return json(res,200,service.snapshot());
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
      for (const res of streams) res.end();
      await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
      await Promise.allSettled([...work]); storage.close();
    },
  };
}
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(data));
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
