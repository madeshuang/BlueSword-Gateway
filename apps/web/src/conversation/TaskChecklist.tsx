import {useEffect,useState} from "react";
import {Check,ChevronDown,ChevronUp,Circle,ClipboardList,LoaderCircle,TriangleAlert} from "lucide-react";
import {type BoothTask} from "@bluesword/contracts";
import {labels} from "../useBooth";

export function TaskChecklist({task}:{task:BoothTask}) {
  const [expanded,setExpanded]=useState(true);
  const [progress,setProgress]=useState(0);
  // Presentation-only stages. Never write simulated progress into task state.
  useEffect(()=>{
    if(task.status!=="executing")return;
    const update=()=>{
      const elapsed=Math.max(0,Date.now()-Date.parse(task.updatedAt));
      setProgress(elapsed>=12000?3:elapsed>=4000?2:elapsed>=1500?1:0);
    };
    update();
    const timer=setInterval(update,250);
    return()=>clearInterval(timer);
  },[task.id,task.status,task.updatedAt]);
  const completed=task.status==="succeeded";
  const attention=["uncertain","fault","rejected","resolved"].includes(task.status);
  const stage=completed?4:progress;
  const steps=[
    {title:"查询货物是否存在",waiting:"等待查询货物",running:"正在查询物品与可领取数量",done:"已确认物品可领取"},
    {title:"调度空闲机器人",waiting:"等待货物确认",running:"正在调度机器人，请稍候",done:"机器人已就位"},
    {title:"执行抓取",waiting:"等待机器人就位",running:"机器人正在抓取，请稍候",done:"物品已抓取"},
    {title:"运输回到原位",waiting:"等待抓取完成",running:"机器人正在运输，请稍候",done:"已送达，请领取物品"},
  ].map((step,index)=>{
    const state=index<stage?"done":index===stage?(attention?"attention":"running"):"pending";
    return {...step,state,detail:state==="done"?step.done:state==="running"?step.running:state==="attention"?"任务已暂停，请联系工作人员":step.waiting};
  });
  const count=steps.filter(step=>step.state==="done").length;
  return <section className="task-checklist" aria-label="取物任务清单">
    <header>
      <h3><ClipboardList size={23}/>取物任务清单</h3>
      <span className={attention?"checklist-status attention":"checklist-status"}>{task.status==="executing"?"执行中":labels[task.status]}</span>
      <span className="checklist-count">已完成 {count} / {steps.length}</span>
    </header>
    {expanded&&<>
      <ol>
        {steps.map(step=><li key={step.title} className={"checklist-step "+step.state}>
          <span className="checklist-icon" aria-hidden="true">{step.state==="done"?<Check size={21}/>:step.state==="running"?<LoaderCircle size={23} className="spin"/>:step.state==="attention"?<TriangleAlert size={22}/>:<Circle size={23}/>}</span>
          <div><strong>{step.title}</strong><p>{step.detail}</p></div>
          <span className="checklist-step-label">{step.state==="done"?"已完成":step.state==="running"?"进行中":step.state==="attention"?"需核对":attention?"未完成":"待执行"}</span>
        </li>)}
      </ol>
      {attention&&<p className="checklist-notice">{task.message} {task.status==="resolved"?"领取情况请向工作人员确认。":"请联系工作人员核对。"}</p>}
    </>}
    <footer><span>{completed?"取物已完成":attention?"进度已暂停":"进度将自动更新"}</span><button aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?<ChevronUp size={18}/>:<ChevronDown size={18}/>} {expanded?"收起":"展开"}</button></footer>
  </section>;
}
