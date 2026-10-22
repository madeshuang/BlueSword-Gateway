import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from "react";
import {Mic,Square,X,LoaderCircle} from "lucide-react";
import type {SpeechReceipt} from "@bluesword/contracts";
import {prepareMicrophone} from "./capture";
import {SpeechDraft} from "./draft";
import {SpeechEndpoint,type StopReason} from "./endpoint";
type Attempt={controller:AbortController;receipt?:SpeechReceipt;mic?:Awaited<ReturnType<typeof prepareMicrophone>>;socket?:WebSocket;timer?:ReturnType<typeof setInterval>;draftId:number;stoppedAt?:number;done:boolean;startedAt:number};
export interface VoiceControl {cancel(reason?:string):void;takeReceipts():SpeechReceipt[];clearReceipts():void}
async function post(path:string,body:unknown){const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok)throw new Error(typeof data.data==="string"?data.data:"语音连接失败，请重试");return data;}
export const VoiceInput=forwardRef<VoiceControl,{draft:SpeechDraft;onText:(text:string)=>void;disabled:boolean}>(function VoiceInput({draft,onText,disabled},ref){
  const [configured,setConfigured]=useState(false),[phase,setPhase]=useState("idle"),[message,setMessage]=useState(""),[partial,setPartial]=useState("");
  const active=useRef<Attempt|undefined>(undefined),receipts=useRef<SpeechReceipt[]>([]);
  function update(attempt:Attempt,value:Record<string,unknown>){if(attempt.receipt)void post(`/api/booth/speech/attempts/${attempt.receipt.id}`,{token:attempt.receipt.token,...value}).catch(()=>{console.warn("语音运行记录的草稿状态未能保存");});}
  function release(attempt:Attempt){clearInterval(attempt.timer);attempt.controller.abort();void attempt.mic?.cancel();attempt.socket?.close();if(active.current===attempt){active.current=undefined;setPhase("idle");}}
  function cancel(reason="cancelled"){
    const attempt=active.current;if(!attempt)return;attempt.done=true;draft.cancel();
    if(attempt.socket?.readyState===WebSocket.OPEN)attempt.socket.send(JSON.stringify({type:"cancel",reason}));
    update(attempt,{status:"cancelled",reason});release(attempt);setPartial("");setMessage(reason==="no-speech"?"没有听到说话，请重试。":reason==="experience-changed"||reason==="sent-draft"?"":"已取消。");
  }
  useImperativeHandle(ref,()=>({cancel,takeReceipts(){const current=receipts.current;receipts.current=[];setMessage("");setPartial("");return current;},clearReceipts(){receipts.current=[];setMessage("");setPartial("");}}));
  useEffect(()=>{let alive=true;void fetch("/api/booth/speech").then(r=>r.json()).then(data=>{if(alive)setConfigured(data.configured===true);}).catch(()=>{});return()=>{alive=false;const attempt=active.current;if(attempt){attempt.done=true;draft.cancel();if(attempt.socket?.readyState===WebSocket.OPEN)attempt.socket.send(JSON.stringify({type:"cancel",reason:"experience-changed"}));update(attempt,{status:"cancelled",reason:"experience-changed"});release(attempt);}};},[]);
  async function stop(reason:StopReason|"manual"="manual"){
    const attempt=active.current;if(!attempt||attempt.done||!attempt.mic||attempt.stoppedAt!==undefined)return;
    attempt.stoppedAt=performance.now();clearInterval(attempt.timer);setPhase("waiting");setMessage("正在识别…");
    try{await attempt.mic.stop();if(!attempt.controller.signal.aborted)attempt.socket?.send(JSON.stringify({type:"stop",reason}));}catch{fail(attempt,"录音停止失败，请重新尝试","capture-failed");}
  }
  function fail(attempt:Attempt,text:string,reason="connection-failed"){
    if(attempt.done||active.current!==attempt)return;attempt.done=true;draft.cancel();update(attempt,{status:"error",reason});release(attempt);setPartial("");setMessage(text.replace(/[，。；]+$/u,"")+"。");
  }
  async function begin(){
    if(active.current||!configured||disabled)return;
    const attempt:Attempt={controller:new AbortController(),draftId:draft.begin(),done:false,startedAt:0};active.current=attempt;setPhase("starting");setPartial("");setMessage("正在准备麦克风…");
    const endpoint=new SpeechEndpoint();
    const microphone=prepareMicrophone(attempt.controller.signal,pcm=>{
      if(attempt.socket?.readyState===WebSocket.OPEN){if(attempt.socket.bufferedAmount>128000){fail(attempt,"语音传输积压，请检查网络");return;}attempt.socket.send(pcm);}
    },probability=>endpoint.activity(probability,performance.now()-attempt.startedAt),()=>{void stop("limit");});void microphone.catch(()=>{});
    try{
      attempt.receipt=await post("/api/booth/speech/attempts",{});
      if(attempt.controller.signal.aborted){update(attempt,{status:"cancelled",reason:"cancelled"});return;}
      attempt.mic=await microphone;if(attempt.controller.signal.aborted){await attempt.mic.cancel();return;}
      const socket=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/api/booth/speech/live`);attempt.socket=socket;
      socket.onopen=()=>{if(!attempt.done)socket.send(JSON.stringify({type:"start",...attempt.receipt}));};
      socket.onerror=()=>fail(attempt,"语音连接失败");
      socket.onclose=()=>{if(!attempt.done)fail(attempt,"语音连接已中断");};
      socket.onmessage=event=>{void(async()=>{
        if(attempt.done||active.current!==attempt)return;const data=JSON.parse(event.data);
        if(data.type==="ready"){
          attempt.startedAt=performance.now();await attempt.mic!.start();if(attempt.controller.signal.aborted)return;
          setPhase("recording");setMessage(attempt.mic!.autoStopAvailable?"正在聆听，说完后稍等片刻，或点击停止。":"正在聆听，请说完后点击停止。");
          attempt.timer=setInterval(()=>{const elapsed=performance.now()-attempt.startedAt;const reason=attempt.mic!.autoStopAvailable?endpoint.poll(elapsed):elapsed>=60000?"limit":null;
            if(reason==="no-speech")cancel("no-speech");else if(reason)void stop(reason);},100);return;
        }
        if(data.type==="partial"){setPartial(typeof data.text==="string"?data.text:"");return;}
        if(data.type==="error"){fail(attempt,typeof data.message==="string"?data.message:"语音识别失败");return;}
        if(data.type==="final"){
          const text=typeof data.text==="string"?data.text:"",elapsed=attempt.stoppedAt===undefined?undefined:performance.now()-attempt.stoppedAt;
          const applied=draft.complete(attempt.draftId,text);attempt.done=true;setPartial(applied?"":text);
          if(applied){onText(draft.value);receipts.current.push(attempt.receipt!);}
          update(attempt,{applied,...(applied&&elapsed!==undefined?{endToDraftMs:elapsed}:{})});release(attempt);
          if(data.recordSaved===false)console.warn("本次语音运行记录未能保存");
          setMessage(!text.trim()?"没有识别到文字，请重试。":applied?"可以修改文字，确认后发送。":"输入内容已更改或文字过长，请按需复制下方结果。");
        }
      })().catch(()=>fail(attempt,"语音处理失败"));};
    }catch(error){const denied=error instanceof DOMException&&error.name==="NotAllowedError";fail(attempt,denied?"麦克风权限未允许":error instanceof Error?error.message:"无法启动录音",denied?"microphone-denied":"capture-failed");}
  }
  const busy=phase!=="idle";
  return <><button type="button" className={"speech-button "+(busy?"active":"")} aria-label={phase==="recording"?"停止语音输入":busy?"正在处理语音":"开始语音输入"} title={!configured?"语音暂未配置，可继续打字":undefined} disabled={disabled||!configured||phase==="starting"||phase==="waiting"} onClick={()=>phase==="recording"?void stop():void begin()}>{phase==="recording"?<Square size={16}/>:busy?<LoaderCircle size={17} className="spin"/>:<Mic size={18}/>}</button>
    {(busy||message)&&<div className="speech-feedback"><div className="speech-feedback-heading"><span role="status">{message}</span>{busy&&<button type="button" className="speech-cancel" aria-label="取消语音输入" onClick={()=>cancel()}><X size={15}/>取消</button>}</div>{partial&&<p className="speech-preview" aria-label="语音识别预览">{partial}</p>}</div>}</>;
});
