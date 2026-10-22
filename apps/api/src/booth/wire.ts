import {randomUUID} from "node:crypto";
import type {IncomingMessage,ServerResponse} from "node:http";
import type {WireRecord} from "@bluesword/contracts";
import type {Diagnostics} from "./diagnostics.js";
const MAX_BODY=32768;
const replies=new WeakMap<ServerResponse,(status:number,headers:Record<string,string>,body:string)=>void>();
function bodyCopy(value:string|Buffer,truncated=false):{body:string;truncated?:boolean}{
  const bytes=typeof value==="string"?Buffer.from(value):value,cut=truncated||bytes.length>MAX_BODY;
  return {body:new TextDecoder().decode(bytes.subarray(0,MAX_BODY),{stream:cut}),...(cut?{truncated:true}:{})};
}
function headers(value:Record<string,unknown>){return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/authorization|cookie|token|experience|key|secret|signature/i.test(key)?"[已隐藏]":item]));}
function safeUrl(value:string){const url=new URL(value,"http://localhost");url.username="";url.password="";url.search="";url.hash="";return value.startsWith("/")?url.pathname:url.href;}
function safeSave(records:Diagnostics,record:Omit<WireRecord,"mode">){try{records.saveWire(record);}catch{console.warn(JSON.stringify({event:"developer_record_failed",kind:"robot"}));}}
export function captureRobotNotification(req:IncomingMessage,res:ServerResponse,records:Diagnostics):void {
  const started=performance.now(),chunks:Buffer[]=[];let total=0,reply:WireRecord["response"];
  const record:Omit<WireRecord,"mode">={id:randomUUID(),createdAt:new Date().toISOString(),direction:"robot-to-gateway",request:{url:safeUrl(req.url??"/"),method:req.method??"POST",headers:headers(req.headers),headersScope:"网关实际收到的请求头，凭据已隐藏",body:""}};
  req.on("data",(chunk:Buffer)=>{const data=Buffer.from(chunk);if(total<MAX_BODY)chunks.push(data.subarray(0,MAX_BODY-total));total+=data.length;});
  replies.set(res,(status,responseHeaders,body)=>{reply={status,headers:headers(responseHeaders),headersScope:"网关显式设置的响应头，不含 HTTP 自动补充字段",...bodyCopy(body)};});
  res.once("close",()=>{
    Object.assign(record.request,bodyCopy(Buffer.concat(chunks),total>MAX_BODY));
    if(reply)record.response=reply;
    if(!res.writableFinished)record.error="连接关闭，未确认响应已发送完毕";
    record.durationMs=Math.round(performance.now()-started);safeSave(records,record);replies.delete(res);
  });
}
export function captureRobotReply(res:ServerResponse,status:number,responseHeaders:Record<string,string>,body:string){replies.get(res)?.(status,responseHeaders,body);}
async function responseBody(response:Response):Promise<{body:string;truncated?:boolean}>{
  const reader=response.body?.getReader();if(!reader)return {body:""};const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;if(size+value.length>MAX_BODY){chunks.push(value.subarray(0,MAX_BODY-size));void reader.cancel().catch(()=>{});return bodyCopy(Buffer.concat(chunks),true);}chunks.push(value);size+=value.length;}
  return {body:Buffer.concat(chunks).toString("utf8")};
}
export function recordingRobotTransport(transport:typeof fetch,records:Diagnostics):typeof fetch {
  return async(input,init)=>{
    const started=performance.now(),requestHeaders=Object.fromEntries(new Headers(init?.headers).entries());
    const record:Omit<WireRecord,"mode">={id:randomUUID(),createdAt:new Date().toISOString(),direction:"gateway-to-robot",request:{url:safeUrl(String(input)),method:init?.method??"GET",headers:headers(requestHeaders),headersScope:"网关交给 HTTP 客户端的请求头，不含客户端自动补充字段",...bodyCopy(typeof init?.body==="string"?init.body:"")}};
    safeSave(records,record);
    try{
      const response=await transport(input,init);
      record.response={status:response.status,headers:headers(Object.fromEntries(response.headers.entries())),headersScope:"HTTP 客户端实际收到的响应头",body:"",bodyState:"pending"};
      record.durationMs=Math.round(performance.now()-started);safeSave(records,record);
      // 只读取通信副本，不能让运行记录延长原业务的等待。
      void responseBody(response.clone()).then(body=>{Object.assign(record.response!,body,{bodyState:"complete"});},()=>{record.response!.bodyState="failed";record.error="读取机器人原始响应失败";}).finally(()=>{
        record.durationMs=Math.round(performance.now()-started);safeSave(records,record);
      });
      return response;
    }catch(error){record.error="机器人连接失败或等待接单回复超时；无法确认请求是否已送达";record.durationMs=Math.round(performance.now()-started);safeSave(records,record);throw error;}
  };
}
