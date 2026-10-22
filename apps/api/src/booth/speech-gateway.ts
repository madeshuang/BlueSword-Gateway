import type {Server} from "node:http";
import WebSocket,{WebSocketServer} from "ws";
import {openRecognizer,speechConfigured,type SpeechConfig,type SpeechConnect,type RecognitionStream} from "./speech-provider.js";
import type {Diagnostics} from "./diagnostics.js";

export function attachSpeech(server:Server,config:SpeechConfig|undefined,records:Diagnostics,connect?:SpeechConnect){
  const wss=new WebSocketServer({noServer:true,maxPayload:16384});let active=0;
  const claimed=new Set<string>();
  server.on("upgrade",(req,socket,head)=>{
    let path:string;
    try {path=new URL(req.url??"/","http://localhost").pathname;}
    catch {socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return;}
    if(path!=="/api/booth/speech/live"){socket.destroy();return;}
    if(!config||!speechConfigured(config)||active>=2||!["http://"+req.headers.host,"https://"+req.headers.host].includes(req.headers.origin??"")){
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws));
  });
  wss.on("connection",ws=>{
    active++;const controller=new AbortController();const started=performance.now();
    let stream:RecognitionStream|undefined,id:string|undefined,phase:"waiting"|"connecting"|"recording"|"finishing"|"closed"="waiting";
    let readyMs:number|undefined,stoppedAt=0,queue=Promise.resolve(),recordingTimer:ReturnType<typeof setTimeout>|undefined;
    const send=(value:unknown)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));};
    const timer=setTimeout(()=>fail("语音连接或录音超过最长等待时间"),110000);
    function persist(result:Parameters<Diagnostics["finishSpeech"]>[1]):boolean {
      if(!id)return true;
      try{records.finishSpeech(id,result);return true;}
      catch{console.warn(JSON.stringify({event:"developer_record_failed",kind:"speech"}));return false;}
    }
    function finishRecord(status:"error"|"cancelled",error?:string,reason?:string){
      if(phase==="closed")return;phase="closed";clearTimeout(timer);clearTimeout(recordingTimer);controller.abort();stream?.cancel();
      persist({status,...(error?{error}:{}),...(reason?{stopReason:reason}:{}),...(readyMs===undefined?{}:{readyMs})});
    }
    function fail(message:string){finishRecord("error",message);send({type:"error",message});ws.close();}
    async function handle(data:WebSocket.RawData,binary:boolean){
      if(phase==="closed")return;
      if(binary){if(phase!=="recording"||!stream)throw new Error("录音尚未就绪或已经停止");stream.push(Buffer.from(data as Buffer));return;}
      let message;try{message=JSON.parse(data.toString());}catch{throw new Error("语音消息不合法");}
      if(message.type==="start"){
        if(phase!=="waiting"||typeof message.id!=="string"||typeof message.token!=="string"||message.token.length>128)throw new Error("识别开始信息不合法");
        const record=records.authorizeSpeech(message.id,message.token);
        if(record.status!=="starting"||claimed.has(record.id))throw new Error("本次识别已经开始或结束");
        id=record.id;claimed.add(id);phase="connecting";
        stream=await openRecognizer(config!,text=>send({type:"partial",text}),controller.signal,connect);
        if(controller.signal.aborted){stream.cancel();return;}
        readyMs=performance.now()-started;phase="recording";recordingTimer=setTimeout(()=>fail("录音超过60秒，请分段说话"),61000);send({type:"ready"});return;
      }
      if(message.type==="stop"){
        if(phase!=="recording"||!stream)throw new Error("当前不在录音中");phase="finishing";clearTimeout(recordingTimer);stoppedAt=performance.now();
        const reason=["manual","pause","limit"].includes(message.reason)?message.reason:"manual";
        const result=await stream.finish();if(controller.signal.aborted)return;
        const recordSaved=persist({status:result.text.trim()?"success":"empty",text:result.text,readyMs:readyMs!,endToFinalMs:performance.now()-stoppedAt,stopReason:reason});
        phase="closed";clearTimeout(timer);send({type:"final",text:result.text,recordSaved});ws.close();return;
      }
      throw new Error("语音消息不合法");
    }
    ws.on("message",(data,binary)=>{
      if(!binary){try{const m=JSON.parse(data.toString());if(m.type==="cancel"){finishRecord("cancelled",undefined,["no-speech","experience-changed","sent-draft"].includes(m.reason)?m.reason:"cancelled");ws.close();return;}}catch{fail("语音消息不合法");return;}}
      queue=queue.then(()=>handle(data,binary)).catch(error=>{if(!controller.signal.aborted)fail(error instanceof Error?error.message:"识别处理失败");});
    });
    ws.on("error",()=>finishRecord("error","浏览器语音连接中断"));
    ws.on("close",()=>{finishRecord("error","浏览器连接提前断开");clearTimeout(timer);active--;if(id)claimed.delete(id);});
  });
  return {async close(){for(const ws of wss.clients)ws.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));}};
}
