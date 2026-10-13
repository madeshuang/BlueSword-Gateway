import {useEffect,useRef,useState} from "react";
import {ArrowRight,ArrowUpRight,Check,CheckCircle2,ChevronRight,Clock3,LoaderCircle,Minus,Plus,RefreshCw,Send,ShieldCheck,Sparkles,X,AlertCircle,AlertTriangle,CircleX,UserRoundCheck} from "lucide-react";
import type {BoothSnapshot,BoothProduct,BoothTask,BoothChatMessage,BoothAdvice} from "@bluesword/contracts";
import {ProductArt} from "./ProductArt";
import "./booth.css";
const labels:Record<BoothTask["status"],string>={submitting:"等待受理",executing:"正在执行",succeeded:"已完成",rejected:"未受理",uncertain:"等待核对",fault:"需要协助",resolved:"工作人员已处理"};
class RequestError extends Error { constructor(message:string,readonly status:number){super(message);} }
const pendingKey="bluesword.booth.pending";
type Pending={productId:string;count:number;requestId:string};
type DisplayStatus=BoothTask["status"]|"idle"|"alert";
type ConversationMessage=BoothChatMessage|{role:"event";content:string;status:DisplayStatus};
function StatusIcon({status}:{status:DisplayStatus}){
  const icons={idle:Clock3,submitting:LoaderCircle,executing:LoaderCircle,succeeded:CheckCircle2,rejected:CircleX,uncertain:AlertTriangle,fault:AlertCircle,resolved:UserRoundCheck,alert:AlertCircle};
  const names={idle:"等待选择",submitting:"等待受理",executing:"正在执行",succeeded:"取物完成",rejected:"未受理",uncertain:"需要核对",fault:"需要协助",resolved:"工作人员处理",alert:"需要协助"};
  const Icon=icons[status];
  return <Icon role="img" aria-label={names[status]} size={22} className={status==="submitting"||status==="executing"?"spin":undefined}/>;
}
const taskNotices:Partial<Record<BoothTask["status"],string>>={
  executing:"请求已受理，请等待取物结果。",
  succeeded:"取物已完成，请到交付处领取。",
  rejected:"这次取物暂未受理，请核对选择或联系现场工作人员。",
  uncertain:"这次请求是否受理、是否结束尚未确认，请勿再次提交。请联系现场工作人员，当前尚未确认机器人是否停止。",
  fault:"这次取物需要工作人员协助，是否结束尚未确认，请勿再次提交。当前尚未确认机器人是否停止。",
  resolved:"本次请求已由工作人员处理，领取情况请向现场工作人员确认。",
};
const globalAlertNotice="取物服务暂需工作人员核对，请稍候。当前尚未确认机器人是否停止。";
async function api<T>(url:string,body?:unknown,headers?:Record<string,string>):Promise<T>{
  const response=await fetch(url,{...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw new RequestError(typeof data.data==="string"?data.data:"暂时无法连接，请稍后重试",response.status);return data as T;
}
function loadPending():Pending|null{try{const p=JSON.parse(localStorage.getItem(pendingKey)??"null");return p&&typeof p.productId==="string"&&Number.isSafeInteger(p.count)&&typeof p.requestId==="string"?p:null;}catch{return null;}}
export function BoothApp(){
  const [,setWaitingTick]=useState(0);
  const waitingAnchor=useRef<{waiting:NonNullable<BoothSnapshot["waiting"]>;at:number}|null>(null);
  const [state,setState]=useState<BoothSnapshot|null>(null),[connected,setConnected]=useState(false);
  const [selectedId,setSelectedId]=useState<string|null>(null),[count,setCount]=useState(1),[category,setCategory]=useState("全部");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[pending,setPending]=useState<Pending|null>(loadPending);
  const [messages,setMessages]=useState<ConversationMessage[]>([]),[text,setText]=useState(""),[thinking,setThinking]=useState(false),[chatError,setChatError]=useState("");
  const snapshotInitialized=useRef(false),snapshotRevision=useRef(0),observedTasks=useRef(new Map<string,BoothTask["status"]>()),notifiedStates=useRef(new Set<string>()),previousAlert=useRef<string|null>(null);
  const [operator,setOperator]=useState(location.hash==="#operations"),[token,setToken]=useState(""),[checked,setChecked]=useState(false);
  const messageList=useRef<HTMLDivElement>(null),selectionVersion=useRef(0),experienceVersion=useRef(0),currentState=useRef(state);
  currentState.current=state;
  const selected=state?.products.find(p=>p.id===(pending?.productId??selectedId)),quantity=pending?.count??count;
  const [experienceTaskId,setExperienceTaskId]=useState<string|null>(null);
  const latest=state?.active??state?.tasks.find(task=>task.id===experienceTaskId),blocked=!!state?.active||!!state?.alert;
  function receiveSnapshot(snapshot:BoothSnapshot){
    snapshotRevision.current++;
    const additions:ConversationMessage[]=[];
    // The first snapshot is a baseline, not a replay of historical events.
    for(const task of [...snapshot.tasks].reverse()){
      const key=task.id+":"+task.status,previous=observedTasks.current.get(task.id);
      if(snapshotInitialized.current&&previous!==task.status&&!notifiedStates.current.has(key)){
        let notice=taskNotices[task.status];
        if(task.status==="succeeded"&&(snapshot.active||snapshot.alert))notice="取物已完成，请按当前提示继续操作。";
        if(notice){setExperienceTaskId(task.id);additions.push({role:"event",content:task.command.item+" × "+task.command.count+"："+notice,status:task.status});}
      }
      observedTasks.current.set(task.id,task.status);notifiedStates.current.add(key);
    }
    if(snapshotInitialized.current&&snapshot.alert&&snapshot.alert!==previousAlert.current)
      additions.push({role:"event",content:globalAlertNotice,status:"alert"});
    previousAlert.current=snapshot.alert;snapshotInitialized.current=true;
    if(additions.length)setMessages(current=>[...current,...additions]);
    if(snapshot.active)setExperienceTaskId(snapshot.active.id);
    setState(snapshot);
  }
  async function requestSnapshot(url:string,body?:unknown,headers?:Record<string,string>){
    const revision=snapshotRevision.current;
    const snapshot=await api<BoothSnapshot>(url,body,headers);
    // A newer SSE snapshot takes precedence over an HTTP response already in flight.
    if(revision===snapshotRevision.current)receiveSnapshot(snapshot);
  }
  useEffect(()=>{
    let alive=true,streamReceived=false;api<BoothSnapshot>("/api/booth").then(v=>{if(alive&&!streamReceived)receiveSnapshot(v);}).catch(e=>{if(alive&&!streamReceived)setError(e.message);});
    const events=new EventSource("/api/booth/events");
    events.onmessage=e=>{if(alive){streamReceived=true;receiveSnapshot(JSON.parse(e.data));setConnected(true);}};events.onerror=()=>{if(alive)setConnected(false);};
    const hash=()=>setOperator(location.hash==="#operations");window.addEventListener("hashchange",hash);
    return()=>{alive=false;events.close();window.removeEventListener("hashchange",hash);};
  },[]);
  useEffect(()=>{waitingAnchor.current=state?.waiting?{waiting:state.waiting,at:performance.now()}:null;},[state?.waiting]);
  useEffect(()=>{const timer=setInterval(()=>setWaitingTick(t=>t+1),1000);return()=>clearInterval(timer);},[]);
  const elapsedWaitMs=state?.waiting?state.waiting.elapsedMs+(waitingAnchor.current?.waiting===state.waiting?Math.max(0,performance.now()-waitingAnchor.current.at):0):0;
  const overdue=!!state?.waiting&&(state.waiting.overdue||elapsedWaitMs>=state.waiting.remindAfterMs);
  useEffect(()=>{const list=messageList.current;if(list)list.scrollTop=list.scrollHeight;},[messages,thinking]);
  useEffect(()=>{
    const list=messageList.current;if(!list)return;
    let followLatest=true,width=list.clientWidth,height=list.clientHeight;
    const trackPosition=()=>{
      if(list.clientWidth===width&&list.clientHeight===height)followLatest=Math.abs(list.scrollHeight-list.clientHeight-list.scrollTop)<2;
    };
    // Resize can arrive before the scroll event from the browser's End action.
    const trackKeyboard=(event:KeyboardEvent)=>{if(event.key==="End")followLatest=true;else if(event.key==="Home")followLatest=false;};
    const observer=new ResizeObserver(()=>{if(followLatest)list.scrollTop=list.scrollHeight;width=list.clientWidth;height=list.clientHeight;});
    list.addEventListener("scroll",trackPosition);list.addEventListener("keydown",trackKeyboard);observer.observe(list);
    return()=>{observer.disconnect();list.removeEventListener("scroll",trackPosition);list.removeEventListener("keydown",trackKeyboard);};
  },[!!state]);
  useEffect(()=>{if(pending&&state?.tasks.some(t=>t.requestId===pending.requestId)){setPending(null);localStorage.removeItem(pendingKey);}},[state,pending]);
  function choose(p:BoothProduct,n=1){if(pending||busy)return;selectionVersion.current++;setSelectedId(p.id);setCount(n);setError("");}
  function changeCount(n:number){selectionVersion.current++;setCount(n);}
  async function submit(){
    if(!selected||busy||!connected)return;selectionVersion.current++;setBusy(true);setError("");
    const request=pending??{productId:selected.id,count:quantity,requestId:crypto.randomUUID()};
    setPending(request);localStorage.setItem(pendingKey,JSON.stringify(request));
    try{await api("/api/booth/requests",request);setPending(null);localStorage.removeItem(pendingKey);await requestSnapshot("/api/booth");}
    catch(e){if(e instanceof RequestError&&[400,409,503].includes(e.status)){setPending(null);localStorage.removeItem(pendingKey);}setError(e instanceof RequestError?e.message:"提交反馈暂未取得，请核对这次请求");}finally{setBusy(false);}
  }
  function startExperience(){
    experienceVersion.current++;selectionVersion.current++;
    setMessages([]);setText("");setThinking(false);setChatError("");
    setSelectedId(null);setCount(1);setError("");setExperienceTaskId(null);
  }
  async function chat(input=text){
    if(!input.trim()||thinking)return;setThinking(true);setChatError("");
    const version=selectionVersion.current,experience=experienceVersion.current,taskId=state?.tasks[0]?.id;
    const userMessage:BoothChatMessage={role:"user",content:input.trim()};
    const next:BoothChatMessage[]=[...messages.filter((message):message is BoothChatMessage=>message.role!=="event"),userMessage];
    setMessages(current=>[...current,userMessage]);
    try{const advice=await api<BoothAdvice>("/api/booth/chat",{messages:next.slice(-11)});if(experience!==experienceVersion.current)return;setMessages(current=>[...current,{role:"assistant",content:advice.reply}]);setText("");
      const latestState=currentState.current,p=latestState?.products.find(p=>p.id===advice.selection?.productId);
      if(p&&advice.selection&&!blocked&&!latestState?.active&&!latestState?.alert&&taskId===latestState?.tasks[0]?.id&&version===selectionVersion.current)choose(p,advice.selection.count);}
    catch(e){if(experience===experienceVersion.current){setChatError(e instanceof Error?e.message:"智能助手暂不可用");setText(input);}}finally{if(experience===experienceVersion.current)setThinking(false);}
  }
  async function resolve(){
    setBusy(true);setError("");try{await requestSnapshot("/api/booth/operator/resolve",{confirmation:"已核对机器人停止"},{"X-Operator-Token":token});setChecked(false);setToken("");}
    catch(e){setError(e instanceof Error?e.message:"处理失败");}finally{setBusy(false);}
  }
  if(!state)return <div className="boot-screen"><div className="brand-mark"/><h1>兰剑 · 智能体验</h1>{error?<><p role="alert">{error}</p><button onClick={()=>location.reload()}>重新连接</button></>:<><LoaderCircle className="spin"/><p>正在准备你的体验</p></>}</div>;
  const categories=["全部",...new Set(state.products.map(p=>p.category))],visible=state.products.filter(p=>category==="全部"||p.category===category);
  const displayStatus:DisplayStatus=state.alert?"alert":latest?.status??"idle";
  const taskMessage=displayStatus==="alert"?globalAlertNotice:displayStatus==="idle"?"确认物品后，我们将在这里展示取物状态。":displayStatus==="submitting"?"正在提交，请稍候。":taskNotices[displayStatus];
  return <div className="booth-shell">
    <main>
      <section className="welcome"><div className="welcome-copy"><div className="eyebrow"><span/> HUMAN × TECHNOLOGY</div><h1>选一份心意。<br/><span>余下，交给机器人。</span></h1><p>从一次简单的选择开始，体验智能服务的更多可能。<br className="desktop-break"/>挑选你喜欢的物品，我们为你送达。</p><div className="welcome-note"><span className="round-icon"><ArrowUpRight size={17}/></span>一起，探索服务的下一种方式</div></div><section className={"task-panel "+displayStatus+" status-"+displayStatus} aria-label="当前取物任务" aria-live="polite"><div className="task-heading"><span className="eyebrow">SERVICE MOMENT</span>{latest&&<span className="task-updated">最近更新 <time>{new Date(latest.updatedAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></span>}<span className="task-status">{state.alert?"需要协助":latest?labels[latest.status]:"等待你的选择"}</span></div><div className="task-illustration" aria-hidden="true"><div className="robot-sculpture"><div className="robot-head"><div className="robot-face"><i/><i/></div></div><div className="robot-neck"/><div className="robot-body"><span className="robot-insignia"/><div className="robot-arm left"/><div className="robot-arm right"/></div><div className="robot-base"/></div></div><div className="task-main-icon"><StatusIcon status={displayStatus}/></div><h3>{state.alert?"请联系现场工作人员":latest?latest.command.item+" × "+latest.command.count:"你的下一份心意"}</h3><p>{taskMessage}</p>{overdue&&<div role="alert" className="waiting-reminder"><strong>等待时间较长，请联系工作人员核对</strong><p>已等待约 {Math.max(1,Math.floor(elapsedWaitMs/1000))} 秒。本次取物是否结束尚未确认，请勿再次提交。当前尚未确认机器人是否停止。</p><button onClick={()=>{location.hash="operations";setOperator(true);}}>联系工作人员核对</button></div>}</section></section>
      <div className="experience-grid">
        <aside className="concierge-column"><section className="assistant-panel"><div className="assistant-heading"><span className="assistant-avatar"><Sparkles size={21}/></span><div><h2>你的智能接待助手</h2><p>一份需求，一次贴心回应</p></div><button className="new-experience" onClick={startExperience} disabled={busy||!!pending}>开始新体验</button><span className="ai-label">AI</span></div><div className="assistant-intro"><span className="eyebrow">HELLO, NICE TO MEET YOU</span><h3>今天，想来点什么？</h3><p>聊聊需求，或直接选物品。</p></div>
          <div className="chat-messages" ref={messageList} role="log" aria-label="访客对话" tabIndex={0} aria-live="polite">{messages.length===0?<div className="chat-welcome"><span className="mini-avatar"><Sparkles size={13}/></span><p>欢迎来到兰剑智能体验。<br/>可以先问问这里有哪些物品，再告诉我你的选择。</p></div>:messages.map((m,i)=>m.role==="event"?<div key={i} className={"chat-event status-"+m.status} aria-label="任务状态通知"><StatusIcon status={m.status}/><p><span>取物通知</span>{m.content}</p></div>:<div key={i} className={"chat-bubble "+m.role}>{m.content}</div>)}{thinking&&<div className="chat-thinking"><span/><span/><span/>正在回复你</div>}</div>
          <div className="quick-prompts">{["我想要一瓶水","这里有什么？"].map(t=><button key={t} onClick={()=>void chat(t)} disabled={thinking||!state.ai.configured}>{t}<ArrowUpRight size={12}/></button>)}</div>{chatError&&<p role="alert" className="chat-error">{chatError}</p>}
          <form className="chat-composer" onSubmit={e=>{e.preventDefault();void chat();}}><input aria-label="告诉助手你的需求" placeholder={state.ai.configured?"告诉我你的需求…":"助手尚未连接，可直接选品"} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={thinking||!state.ai.configured}/><button aria-label="发送需求" disabled={thinking||!state.ai.configured||!text.trim()}>{thinking?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>}</button></form><div className="assistant-footnote"><ShieldCheck size={12}/>建议由你确认，取物由机器人完成</div></section>
        </aside>
        <aside className="service-column" aria-label="选品与任务状态">

        <details className="catalog-panel" open><summary id="catalog-title"><span>浏览物品 · 手动选择</span><span className="catalog-count">{state.products.length} 款</span></summary><div aria-labelledby="catalog-title">
          <div className="category-tabs" aria-label="物品分类">{categories.map(c=><button key={c} aria-pressed={category===c} onClick={()=>setCategory(c)} className={category===c?"active":""}>{c}</button>)}</div>
          <div className="product-grid" role="region" aria-label="可选物品列表" tabIndex={0}>{visible.map((p,i)=><button className={"product-card "+(selected?.id===p.id?"selected":"")} key={p.id} onClick={()=>choose(p)} aria-label={"选择"+p.name} aria-pressed={selected?.id===p.id} disabled={busy||!!pending}><div className="product-scene" style={{background:p.color}}><span className="product-category">{p.category}</span><span className="product-number">{(i+1).toString().padStart(2,"0")}</span><ProductArt product={p}/><span className="choose-mark">{selected?.id===p.id?<Check size={17}/>:<Plus size={17}/>}</span></div><div className="product-copy"><h3>{p.name}<ArrowUpRight size={17}/></h3><p>{p.subtitle}</p></div></button>)}</div><p className="catalog-scroll-hint">物品较多时，可在列表内滚动浏览。</p>
        </div></details>
          <section className={"order-panel "+(selected?"has-selection":"")} aria-label="取物确认">{selected?<><div className="order-art" style={{background:selected.color}}><ProductArt product={selected} small/></div><div className="order-details"><span className="eyebrow">YOUR SELECTION</span><h3>{selected.name}</h3><p>{selected.description}</p></div><div className="order-actions"><div className="quantity-control"><button aria-label="减少数量" onClick={()=>changeCount(Math.max(1,count-1))} disabled={quantity<=1||blocked||busy||!!pending}><Minus size={15}/></button><output aria-label="已选数量">{quantity}</output><button aria-label="增加数量" onClick={()=>changeCount(Math.min(selected.maxCount,count+1))} disabled={quantity>=selected.maxCount||blocked||busy||!!pending}><Plus size={15}/></button></div><button className="primary-button" onClick={()=>void submit()} disabled={busy||!connected||(blocked&&!pending)||(!state.dispatch.ready&&!pending)}>{busy?<><LoaderCircle size={17} className="spin"/>等待受理</>:<>{pending?"核对这次请求":blocked?"请等待当前任务":"确认取物"}<ArrowRight size={17}/></>}</button></div></>:<><span className="selection-placeholder"><ArrowUpRight size={22}/></span><div><h3>从一份喜欢开始</h3><p>告诉助手需求，或直接浏览物品；选好后由你确认。</p></div></>}</section>
          {state.dispatch.reason&&!pending&&<p role="status" className="task-note">{state.dispatch.reason}</p>}
          {!connected&&<p role="status" className="task-note">取物状态暂未同步，请稍候再确认；已有任务请勿重复提交。</p>}
          {error&&<div role="alert" className="feedback-error"><AlertCircle size={17}/><span>{error}</span><button onClick={()=>setError("")} aria-label="关闭提示"><X size={16}/></button></div>}
          <div className="experience-steps" aria-label="体验流程"><span><b>01</b>选择物品</span><ChevronRight size={14}/><span><b>02</b>确认数量</span><ChevronRight size={14}/><span><b>03</b>等待领取</span></div>
        </aside>
      </div>
    </main>
    <footer className="site-footer"><span>BLUESWORD <i>×</i> SEVENOVA</span><p>{state.mode==="simulator"?"当前为独立测试对端演示，未连接现场机器人。":!state.catalogConfirmed?"展示目录待现场确认，暂未开放取物。":"智能服务，从一次简单的选择开始。"}</p><a href="#operations">工作人员入口<ArrowUpRight size={12}/></a></footer>
    {operator&&<div className="modal-backdrop"><section className="operator-modal" role="dialog" aria-modal="true" aria-labelledby="operator-title"><button className="modal-close" aria-label="关闭工作人员入口" onClick={()=>{setOperator(false);location.hash="";}}><X/></button><span className="eyebrow">STAFF ONLY</span><h2 id="operator-title">现场异常核对</h2><p className="operator-system-status">{connected?"网关状态同步正常":"网关状态同步中断"}。{state.mode==="simulator"?"当前使用本地机器人模拟器，未连接真实机器人。":"此状态不证明真实机器人在线或可接单。"}</p><section className="operator-details" aria-label="工作人员任务详情"><dl>
      <dt>当前助手配置</dt><dd>{state.ai.provider} · {state.ai.model}（{state.ai.configured?"凭据已配置":"凭据未配置"}；不代表本次调用成功）</dd>
      <dt>当前状态</dt><dd>{state.alert?"全局告警":latest?labels[latest.status]:"无当前任务"}</dd>
      {latest&&<><dt>任务标识</dt><dd>{latest.id}</dd><dt>任务记录原文</dt><dd>{latest.message}</dd></>}
      {state.alert&&<><dt>告警原文</dt><dd>{state.alert}</dd></>}
    </dl></section><p>此操作仅解除我方占用，不向机器人发送停止或取消指令。请先现场确认机器人已停止、物品情况已核对。入口可见不代表拥有操作权限。</p>{!state.operator.configured&&<p role="status" className="operator-waiting">工作人员操作凭据尚未配置，暂不能解除占用。请由启动服务的负责人设置 BOOTH_OPERATOR_TOKEN 并重启 API；不要在展示页面分享凭据。</p>}{state.active?.status==="executing"&&<p className="operator-waiting">执行中任务仍保持占用；请核对机器人实际情况并联系机器人负责人。此入口不能取消执行中任务，也不能凭等待时长解除占用。</p>}<label>工作人员凭据<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off" disabled={!state.operator.configured}/></label><label className="check-label"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={!state.operator.configured}/>已现场核对机器人停止及物品情况</label><button className="primary-button" onClick={()=>void resolve()} disabled={busy||!connected||!state.operator.configured||!checked||!token||(!state.alert&&!["fault","uncertain"].includes(state.active?.status??""))}><RefreshCw size={16}/>解除本地占用</button>{error&&<p role="alert">{error}</p>}</section></div>}
  </div>;
}
