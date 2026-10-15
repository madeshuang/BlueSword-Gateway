import {useEffect,useRef,useState} from "react";
import {ChevronRight,LoaderCircle} from "lucide-react";

export interface ThinkingMessage {
  role:"thinking";
  id:string;
  content:string;
  phase:"running"|"done"|"error";
  kind:"chat"|"task";
  requestId?:string;
}

export function ThinkingPanel({message}:{message:ThinkingMessage}){
  const [expanded,setExpanded]=useState(message.phase==="running");
  const [visible,setVisible]=useState(0);
  const previousContent=useRef("");
  const characters=Array.from(message.content);
  useEffect(()=>{
    if(message.phase!=="running")setExpanded(false);
  },[message.phase]);
  useEffect(()=>{
    const length=Array.from(message.content).length;
    const appending=message.content.startsWith(previousContent.current);
    previousContent.current=message.content;
    if(message.phase!=="running"){setVisible(length);return;}
    if(!appending)setVisible(0);
    const timer=setInterval(()=>setVisible(current=>{
      const next=Math.min(current+1,length);
      if(next===length)clearInterval(timer);
      return next;
    }),35);
    return()=>clearInterval(timer);
  },[message.content,message.phase]);
  const title=message.phase==="running"?"思考中":message.phase==="done"?"思考已结束":"思考已中止";
  return <details className={"thinking-panel phase-"+message.phase} role="group" aria-label="思考过程" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary><span>{message.phase==="running"&&<LoaderCircle size={14} className="spin"/>}{title}<ChevronRight size={16} className="thinking-toggle-icon" aria-hidden="true"/></span></summary>
    <div className="thinking-copy" aria-live="off">{characters.slice(0,visible).join("").split("\n\n").map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>
  </details>;
}
