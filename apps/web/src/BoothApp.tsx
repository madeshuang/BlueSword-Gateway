import {useEffect,useRef,useState} from "react";
import {ArrowRight,ArrowUpRight,Check,CheckCircle2,ChevronRight,Clock3,LoaderCircle,Minus,Plus,RefreshCw,Send,ShieldCheck,Sparkles,X,AlertCircle} from "lucide-react";
import type {BoothSnapshot,BoothProduct,BoothTask,BoothChatMessage,BoothAdvice} from "@bluesword/contracts";
import {ProductArt} from "./ProductArt";
import "./booth.css";
const labels:Record<BoothTask["status"],string>={submitting:"等待受理",executing:"正在执行",succeeded:"已完成",rejected:"未受理",uncertain:"等待核对",fault:"需要协助",resolved:"已人工处理"};
class RequestError extends Error { constructor(message:string,readonly status:number){super(message);} }
const pendingKey="bluesword.booth.pending";
type Pending={productId:string;count:number;requestId:string};
async function api<T>(url:string,body?:unknown,headers?:Record<string,string>):Promise<T>{
  const response=await fetch(url,{...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw new RequestError(typeof data.data==="string"?data.data:"暂时无法连接，请稍后重试",response.status);return data as T;
}
function loadPending():Pending|null{try{const p=JSON.parse(localStorage.getItem(pendingKey)??"null");return p&&typeof p.productId==="string"&&Number.isSafeInteger(p.count)&&typeof p.requestId==="string"?p:null;}catch{return null;}}
export function BoothApp(){
  const [state,setState]=useState<BoothSnapshot|null>(null),[connected,setConnected]=useState(false);
  const [selectedId,setSelectedId]=useState<string|null>(null),[count,setCount]=useState(1),[category,setCategory]=useState("全部");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[pending,setPending]=useState<Pending|null>(loadPending);
  const [messages,setMessages]=useState<BoothChatMessage[]>([]),[text,setText]=useState(""),[thinking,setThinking]=useState(false),[chatError,setChatError]=useState("");
  const [operator,setOperator]=useState(location.hash==="#operations"),[token,setToken]=useState(""),[checked,setChecked]=useState(false);
  const messageEnd=useRef<HTMLDivElement>(null);
  const selected=state?.products.find(p=>p.id===(pending?.productId??selectedId)),quantity=pending?.count??count;
  const latest=state?.active??state?.tasks[0],blocked=!!state?.active||!!state?.alert;
  useEffect(()=>{
    let alive=true;api<BoothSnapshot>("/api/booth").then(v=>{if(alive)setState(v);}).catch(e=>{if(alive)setError(e.message);});
    const events=new EventSource("/api/booth/events");
    events.onmessage=e=>{if(alive){setState(JSON.parse(e.data));setConnected(true);}};events.onerror=()=>{if(alive)setConnected(false);};
    const hash=()=>setOperator(location.hash==="#operations");window.addEventListener("hashchange",hash);
    return()=>{alive=false;events.close();window.removeEventListener("hashchange",hash);};
  },[]);
  useEffect(()=>{messageEnd.current?.scrollIntoView({block:"nearest"});},[messages,thinking]);
  useEffect(()=>{if(pending&&state?.tasks.some(t=>t.requestId===pending.requestId)){setPending(null);localStorage.removeItem(pendingKey);}},[state,pending]);
  function choose(p:BoothProduct,n=1){if(pending||busy)return;setSelectedId(p.id);setCount(n);setError("");}
  async function submit(){
    if(!selected||busy||!connected)return;setBusy(true);setError("");
    const request=pending??{productId:selected.id,count:quantity,requestId:crypto.randomUUID()};
    setPending(request);localStorage.setItem(pendingKey,JSON.stringify(request));
    try{await api("/api/booth/requests",request);setPending(null);localStorage.removeItem(pendingKey);setState(await api<BoothSnapshot>("/api/booth"));}
    catch(e){if(e instanceof RequestError&&[400,409,503].includes(e.status)){setPending(null);localStorage.removeItem(pendingKey);}setError(e instanceof RequestError?e.message:"提交反馈暂未取得，请核对这次请求");}finally{setBusy(false);}
  }
  async function chat(input=text){
    if(!input.trim()||thinking)return;setThinking(true);setChatError("");
    const next:BoothChatMessage[]=[...messages,{role:"user",content:input.trim()}];
    try{const advice=await api<BoothAdvice>("/api/booth/chat",{messages:next.slice(-11)});setMessages([...next,{role:"assistant",content:advice.reply}]);setText("");
      const p=state?.products.find(p=>p.id===advice.selection?.productId);if(p&&advice.selection&&!blocked)choose(p,advice.selection.count);}
    catch(e){setChatError(e instanceof Error?e.message:"智能助手暂不可用");setText(input);}finally{setThinking(false);}
  }
  async function resolve(){
    setBusy(true);setError("");try{setState(await api<BoothSnapshot>("/api/booth/operator/resolve",{confirmation:"已核对机器人停止"},{"X-Operator-Token":token}));setChecked(false);setToken("");}
    catch(e){setError(e instanceof Error?e.message:"处理失败");}finally{setBusy(false);}
  }
  if(!state)return <div className="boot-screen"><div className="brand-mark"/><h1>兰剑 · 智能体验</h1>{error?<><p role="alert">{error}</p><button onClick={()=>location.reload()}>重新连接</button></>:<><LoaderCircle className="spin"/><p>正在准备你的体验</p></>}</div>;
  const categories=["全部",...new Set(state.products.map(p=>p.category))],visible=state.products.filter(p=>category==="全部"||p.category===category);
  return <div className="booth-shell">
    <header className="site-header"><a className="brand" href="#" aria-label="兰剑智能体验首页"><div className="brand-mark"/><div><strong>兰剑智能</strong><span>BLUESWORD · EXPERIENCE</span></div></a><div className="header-right"><span className="exhibition-label">科技，让服务更有温度</span>{state.mode==="simulator"&&<span className="demo-pill">演示模式</span>}<span className={"connection-pill "+(connected?"online":"offline")}><i/>{connected?"服务已连接":"正在重新连接"}</span></div></header>
    <main>
      <section className="welcome"><div className="welcome-copy"><div className="eyebrow"><span/> HUMAN × TECHNOLOGY</div><h1>选一份心意。<br/><span>余下，交给机器人。</span></h1><p>从一次简单的选择开始，体验智能服务的更多可能。<br className="desktop-break"/>挑选你喜欢的物品，我们为你送达。</p><div className="welcome-note"><span className="round-icon"><ArrowUpRight size={17}/></span>一起，探索服务的下一种方式</div></div><div className="welcome-visual" aria-hidden="true"><div className="visual-orbit orbit-one"/><div className="visual-orbit orbit-two"/><div className="robot-sculpture"><div className="robot-head"><div className="robot-face"><i/><i/></div></div><div className="robot-neck"/><div className="robot-body"><span className="robot-insignia"/><div className="robot-arm left"/><div className="robot-arm right"/></div><div className="robot-base"/></div><span className="visual-caption">DESIGNED TO SERVE<br/><b>Connected with you.</b></span><span className="visual-index">01 / LIVE EXPERIENCE</span></div></section>
      <div className="experience-grid">
        <section className="catalog-panel" aria-labelledby="catalog-title"><div className="section-heading"><div><div className="eyebrow">CURATED FOR YOU</div><h2 id="catalog-title">为你精选</h2></div><span className="section-meta">{state.products.length.toString().padStart(2,"0")} 款展会好物</span></div>
          <div className="category-tabs" aria-label="物品分类">{categories.map(c=><button key={c} aria-pressed={category===c} onClick={()=>setCategory(c)} className={category===c?"active":""}>{c}</button>)}</div>
          <div className="product-grid">{visible.map((p,i)=><button className={"product-card "+(selected?.id===p.id?"selected":"")} key={p.id} onClick={()=>choose(p)} aria-label={"选择"+p.name} aria-pressed={selected?.id===p.id} disabled={busy||!!pending}><div className="product-scene" style={{background:p.color}}><span className="product-category">{p.category}</span><span className="product-number">{(i+1).toString().padStart(2,"0")}</span><ProductArt product={p}/><span className="choose-mark">{selected?.id===p.id?<Check size={17}/>:<Plus size={17}/>}</span></div><div className="product-copy"><h3>{p.name}<ArrowUpRight size={17}/></h3><p>{p.subtitle}</p></div></button>)}</div>
          <section className={"order-panel "+(selected?"has-selection":"")} aria-label="取物确认">{selected?<><div className="order-art" style={{background:selected.color}}><ProductArt product={selected} small/></div><div className="order-details"><span className="eyebrow">YOUR SELECTION</span><h3>{selected.name}</h3><p>{selected.description}</p></div><div className="order-actions"><div className="quantity-control"><button aria-label="减少数量" onClick={()=>setCount(Math.max(1,count-1))} disabled={quantity<=1||blocked||busy||!!pending}><Minus size={15}/></button><output aria-label="已选数量">{quantity}</output><button aria-label="增加数量" onClick={()=>setCount(Math.min(selected.maxCount,count+1))} disabled={quantity>=selected.maxCount||blocked||busy||!!pending}><Plus size={15}/></button></div><button className="primary-button" onClick={()=>void submit()} disabled={busy||!connected||(blocked&&!pending)||(!state.catalogConfirmed&&state.mode==="http")}>{busy?<><LoaderCircle size={17} className="spin"/>等待受理</>:<>{pending?"核对这次请求":blocked?"请等待当前任务":"确认取物"}<ArrowRight size={17}/></>}</button></div></>:<><span className="selection-placeholder"><ArrowUpRight size={22}/></span><div><h3>从一份喜欢开始</h3><p>选择上方物品，确认数量后开启取物体验。</p></div></>}</section>
          {error&&<div role="alert" className="feedback-error"><AlertCircle size={17}/><span>{error}</span><button onClick={()=>setError("")} aria-label="关闭提示"><X size={16}/></button></div>}
          <div className="experience-steps"><span><b>01</b>选择物品</span><ChevronRight size={14}/><span><b>02</b>确认数量</span><ChevronRight size={14}/><span><b>03</b>等待领取</span></div>
        </section>
        <aside className="concierge-column"><section className="assistant-panel"><div className="assistant-heading"><span className="assistant-avatar"><Sparkles size={21}/></span><div><h2>你的智能接待助手</h2><p>一份需求，一次贴心回应</p></div><span className="ai-label">AI</span></div><div className="assistant-intro"><span className="eyebrow">HELLO, NICE TO MEET YOU</span><h3>今天，想来点什么？</h3><p>告诉我你的想法，我来帮你挑选。<br/>也可以直接点击物品。</p></div>
          <div className="chat-messages" aria-live="polite">{messages.length===0?<div className="chat-welcome"><span className="mini-avatar"><Sparkles size={13}/></span><p>欢迎来到兰剑智能体验。<br/>从一瓶水、一份轻食，或一份纪念开始吧。</p></div>:messages.map((m,i)=><div key={i} className={"chat-bubble "+m.role}>{m.content}</div>)}{thinking&&<div className="chat-thinking"><span/><span/><span/>正在为你挑选</div>}<div ref={messageEnd}/></div>
          <div className="quick-prompts">{["我想要一瓶水","这里有什么？"].map(t=><button key={t} onClick={()=>void chat(t)} disabled={thinking||!state.ai.configured}>{t}<ArrowUpRight size={12}/></button>)}</div>{chatError&&<p role="alert" className="chat-error">{chatError}</p>}
          <form className="chat-composer" onSubmit={e=>{e.preventDefault();void chat();}}><input aria-label="告诉助手你的需求" placeholder={state.ai.configured?"告诉我你的需求…":"助手尚未连接，可直接选品"} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={thinking||!state.ai.configured}/><button aria-label="发送需求" disabled={thinking||!state.ai.configured||!text.trim()}>{thinking?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>}</button></form><div className="assistant-footnote"><ShieldCheck size={12}/>建议由你确认，取物由机器人完成</div></section>
          <section className={"task-panel "+(latest?.status??"idle")} aria-label="当前取物任务" aria-live="polite"><div className="task-heading"><span className="eyebrow">SERVICE MOMENT</span><span className="task-status">{state.alert?"需要协助":latest?labels[latest.status]:"等待你的选择"}</span></div><div className="task-main-icon">{latest?.status==="succeeded"?<CheckCircle2 size={26}/>:["fault","uncertain"].includes(latest?.status??"")||state.alert?<AlertCircle size={26}/>:latest&&["submitting","executing"].includes(latest.status)?<LoaderCircle size={26} className="spin"/>:<Clock3 size={26}/>}</div><h3>{state.alert?"请联系现场工作人员":latest?latest.command.item+" × "+latest.command.count:"你的下一份心意"}</h3><p>{state.alert??latest?.message??"确认物品后，我们将在这里展示取物状态。"}</p>{latest&&<div className="task-time"><span>最近更新</span><time>{new Date(latest.updatedAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></div>}{latest&&["executing","uncertain"].includes(latest.status)&&<p className="task-note">正在等待机器人通知，请勿重复提交。</p>}</section>
        </aside>
      </div>
      {state.tasks.length>0&&<section className="recent-section"><div className="recent-title"><h2>体验记录</h2><span>每一次服务，都有迹可循</span></div><div className="recent-list">{state.tasks.slice(0,4).map(t=><div className="recent-row" key={t.id}><span className={"history-dot "+t.status}/><strong>{t.command.item}</strong><span>{t.command.count} 件</span><span className="recent-time">{new Date(t.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</span><span className={"history-status "+t.status}>{labels[t.status]}</span></div>)}</div></section>}
    </main>
    <footer className="site-footer"><span>BLUESWORD <i>×</i> SEVENOVA</span><p>{state.mode==="simulator"?"当前为独立测试对端演示，未连接现场机器人。":!state.catalogConfirmed?"展示目录待现场确认，暂未开放取物。":"智能服务，从一次简单的选择开始。"}</p><a href="#operations">工作人员入口<ArrowUpRight size={12}/></a></footer>
    {operator&&<div className="modal-backdrop"><section className="operator-modal" role="dialog" aria-modal="true" aria-labelledby="operator-title"><button className="modal-close" aria-label="关闭工作人员入口" onClick={()=>{setOperator(false);location.hash="";}}><X/></button><span className="eyebrow">STAFF ONLY</span><h2 id="operator-title">现场异常核对</h2><p>此操作仅解除我方占用，不向机器人发送停止或取消指令。请先现场确认机器人已停止、物品情况已核对。</p><label>工作人员凭据<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off"/></label><label className="check-label"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>已现场核对机器人停止及物品情况</label><button className="primary-button" onClick={()=>void resolve()} disabled={busy||!checked||!token||(!state.alert&&!["fault","uncertain"].includes(state.active?.status??""))}><RefreshCw size={16}/>解除本地占用</button>{error&&<p role="alert">{error}</p>}</section></div>}
  </div>;
}
