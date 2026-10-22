import {randomUUID,createHmac} from "node:crypto";
import WebSocket,{type ClientOptions} from "ws";
import type {SpeechProvider} from "@bluesword/contracts";
export const speechModels:Record<SpeechProvider,string>={ali:"qwen-audio-3.1-asr-flash-message",tencent:"Hy-ASR-3.0-preview"};
export interface SpeechConfig {
  enabled:boolean;provider:SpeechProvider;aliKey:string|undefined;aliWorkspace:string|undefined;
  tencentAppId:string|undefined;tencentSecretId:string|undefined;tencentSecretKey:string|undefined;
}
export type SpeechConnect=(url:string,options:ClientOptions)=>WebSocket;
export interface RecognitionStream {push(pcm:Buffer):void;finish():Promise<{text:string}>;cancel():void}
export function speechConfigured(config:SpeechConfig):boolean {
  return config.enabled&&(config.provider==="ali"?!!config.aliKey:!!(config.tencentAppId&&config.tencentSecretId&&config.tencentSecretKey));
}
/** 供应商 Adapter 只接收音频和返回文字，不持有聊天或发单能力。 */
export async function openRecognizer(config:SpeechConfig,onText:(text:string)=>void,signal:AbortSignal,connect:SpeechConnect=(url,options)=>new WebSocket(url,options)):Promise<RecognitionStream> {
  if(!speechConfigured(config))throw new Error("语音服务尚未配置");
  if(signal.aborted)throw new Error("识别已取消");
  const ali=config.provider==="ali",id=randomUUID().replaceAll("-","");
  let url:string;const headers:Record<string,string>={};
  if(ali){
    url=config.aliWorkspace?`wss://${config.aliWorkspace}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`:"wss://dashscope.aliyuncs.com/api-ws/v1/inference";
    headers.Authorization=`Bearer ${config.aliKey}`;
  }else{
    const now=Math.floor(Date.now()/1000),params:Record<string,string>={secretid:config.tencentSecretId!,timestamp:String(now),expired:String(now+3600),nonce:String(Math.floor(Math.random()*1e9)),engine_model_type:speechModels.tencent,voice_id:id,voice_format:"1",filter_modal:"0",filter_punc:"0",convert_num_mode:"1"};
    const query=Object.keys(params).sort().map(key=>`${key}=${params[key]}`).join("&");
    const signature=createHmac("sha1",config.tencentSecretKey!).update(`asr.cloud.tencent.com/asr/v2/${config.tencentAppId}?${query}`).digest("base64");
    const encoded=new URLSearchParams(params);encoded.set("signature",signature);url=`wss://asr.cloud.tencent.com/asr/v2/${config.tencentAppId}?${encoded}`;
  }
  const socket=connect(url,{headers,handshakeTimeout:12000,maxPayload:262144});
  const sentences=new Map<number,{text:string;final:boolean}>();
  let settled=false,ready=false,bytes=0,finishing=false;
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void,resolve!:(value:{text:string})=>void,reject!:(error:Error)=>void;
  const readyPromise=new Promise<void>((yes,no)=>{readyResolve=yes;readyReject=no;});
  const done=new Promise<{text:string}>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
  let finishTimer:ReturnType<typeof setTimeout>|undefined;
  const readyTimer=setTimeout(()=>fail("识别服务连接超时，请重试"),15000);
  const combined=(finalOnly=false)=>[...sentences.entries()].sort(([a],[b])=>a-b).filter(([,s])=>!finalOnly||s.final).map(([,s])=>s.text).join("");
  function cleanup(){clearTimeout(readyTimer);clearTimeout(finishTimer);signal.removeEventListener("abort",aborted);}
  function fail(message:string){if(settled)return;settled=true;cleanup();const error=new Error(message);readyReject(error);reject(error);socket.terminate();}
  function aborted(){fail("识别已取消");}
  function markReady(){if(!ready){ready=true;clearTimeout(readyTimer);readyResolve();}}
  function complete(){if(settled)return;settled=true;cleanup();resolve({text:combined(true)});socket.close();}
  function update(sentence:Record<string,unknown>,v2=false){
    if(sentence.heartbeat)return;
    const text=ali?sentence.text:v2?(sentence.sentence??sentence.text):sentence.voice_text_str;
    const index=sentence.sentence_id??sentence.index??0;if(typeof text!=="string"||typeof index!=="number"||!Number.isSafeInteger(index)||index<0)return;
    if(text.length>8000||sentences.size>500)return fail("识别结果过长，请分段说话");
    const final=ali?sentence.sentence_end===true:v2?sentence.sentence_type===1:sentence.slice_type===2;
    if(sentences.get(index)?.final&&!final)return;
    sentences.set(index,{text,final});const preview=combined();if(preview.length>8000)return fail("识别结果过长，请分段说话");onText(preview);
  }
  signal.addEventListener("abort",aborted,{once:true});
  socket.on("error",()=>fail("语音服务连接失败，请检查网络或配置后重试"));
  socket.on("close",()=>{if(!settled)fail("语音服务提前断开，请重试");});
  socket.on("open",()=>{if(ali&&!settled)socket.send(JSON.stringify({header:{action:"run-task",task_id:id,streaming:"duplex"},payload:{task_group:"audio",task:"asr",function:"recognition",model:speechModels.ali,parameters:{format:"pcm",sample_rate:16000,disfluency_removal_enabled:false,intermediate_result_enabled:true},input:{}}}));});
  socket.on("message",raw=>{
    if(settled)return;
    try{
      const packet=JSON.parse(raw.toString());
      if(ali){
        if(packet.header?.event==="task-failed")return fail("语音服务拒绝本次识别，请检查权限、额度或稍后重试");
        if(packet.header?.event==="task-started")markReady();
        if(packet.payload?.output?.sentence)update(packet.payload.output.sentence);
        if(packet.header?.event==="task-finished")complete();
      }else{
        if(packet.code!==undefined&&packet.code!==0)return fail("腾讯语音服务拒绝本次识别，请检查权限、额度或稍后重试");
        markReady();
        if(packet.sentences)for(const sentence of Array.isArray(packet.sentences)?packet.sentences:[packet.sentences])update(sentence,true);
        else if(packet.result)update(packet.result);
        if(packet.final===1)complete();
      }
    }catch{fail("语音服务返回了无法解析的数据，请重试");}
  });
  if(signal.aborted)aborted();await readyPromise;
  return {
    push(pcm){if(settled||finishing||socket.readyState!==WebSocket.OPEN)throw new Error("识别连接已结束");bytes+=pcm.length;if(bytes>1920000||pcm.length%2)throw new Error("录音格式不合法或超过60秒");if(socket.bufferedAmount>128000)throw new Error("语音网络传输积压，请重试");socket.send(pcm);},
    cancel:aborted,
    finish(){if(!settled&&!finishing){finishing=true;socket.send(JSON.stringify(ali?{header:{action:"finish-task",task_id:id,streaming:"duplex"},payload:{input:{}}}:{type:"end"}));finishTimer=setTimeout(()=>fail("等待最终识别结果超时，请重试"),30000);}return done;},
  };
}
