import {useEffect,useState} from "react";
import {LoaderCircle} from "lucide-react";
import blueBrain from "./assets/blue-brain.jpg";

export interface ThinkingMessage {
  role:"thinking";
  id:string;
  content:string;
  phase:"running"|"done"|"error";
  kind:"chat"|"task";
  requestId?:string;
}

/** A lightweight request indicator, not model reasoning or robot progress. */
export function ThinkingPanel({message}:{message:ThinkingMessage}){
  const [visible,setVisible]=useState(false);
  const running=message.phase==="running";
  useEffect(()=>{
    setVisible(false);
    if(!running)return;
    const timer=setTimeout(()=>setVisible(true),300);
    return()=>clearTimeout(timer);
  },[message.id,running]);
  if(message.phase==="done" || (running&&!visible))return null;
  return <article className="assistant-message thinking-message">
    <div className="assistant-identity"><img src={blueBrain} alt=""/><span>兰剑助手·布鲁</span></div>
    <div className="chat-waiting" role="status" aria-label="回复状态">
      {running&&<LoaderCircle size={18} className="spin" aria-hidden="true"/>}
      <span>{running?"正在回复…":"本次回复未完成，请稍后重试。"}</span>
    </div>
  </article>;
}
