import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {ArrowRight,ArrowUpRight,Check,CheckCircle2,ChevronRight,Clock3,LoaderCircle,Minus,Plus,RefreshCw,Send,ShieldCheck,Sparkles,X,AlertCircle,AlertTriangle,CircleX,UserRoundCheck} from "lucide-react";
import type {BoothSnapshot,BoothStockProduct,BoothTask,BoothChatMessage,BoothAdvice,BoothSelectionItem} from "@bluesword/contracts";
import {taskSummary} from "@bluesword/contracts";
import {ProductArt} from "./ProductArt";
import blueswordLogo from "./assets/bluesword-logo.svg";
import {openExperience,savedExperience,forgetExperience,type BoothExperience} from "./experience";
import {ThinkingPanel,type ThinkingMessage} from "./ThinkingPanel";
import {StockResetPanel} from "./StockResetPanel";
import "./booth.css";
import {SpeechDraft} from "./speech/draft";
import {VoiceInput,type VoiceControl} from "./speech/VoiceInput";
const labels:Record<BoothTask["status"],string>={submitting:"等待机器人接单",executing:"机器人已接单",succeeded:"已完成",rejected:"机器人未接单",uncertain:"等待核对",fault:"需要协助",resolved:"工作人员已处理"};
class RequestError extends Error { constructor(message:string,readonly status:number){super(message);} }
const pendingKey="bluesword.booth.pending";
type Pending={items:BoothSelectionItem[];requestId:string;experienceId?:string};
type Feedback={message:string;source:"request"|"selection"|"state"|"other";requestId?:string};
type DisplayStatus=BoothTask["status"]|"idle"|"alert";
type ConversationMessage=BoothChatMessage|ThinkingMessage;
function taskThinkingContent(task:Pick<BoothTask,"items"|"status">){
  const item=taskSummary(task),location=task.items.map(line=>line.name+"在"+line.location).join("、");
  const opening=`我先核对你要的${item}，取物位置为${location}。确认物品和数量后，把这次取物请求交给机器人，等待它接单。`;
  return opening+(task.status==="submitting"?"":
    `\n\n机器人已经接单，导航任务正在执行。我正在读取导航反馈：机器人已从待命位置出发，正沿规划路线前往${location}，接近取物区域时减速并调整朝向。`+
    `\n\n取物区域的定位反馈已经返回，机器人正在调整停靠位置，对准${location}。正在根据识别画面确认${item}的位置，检查周围物品，并准备机械臂的抓取姿态。`+
    `\n\n机械臂正在靠近目标，调整夹爪开合并执行抓取。我在核对夹持反馈和物品数量，按这次任务清单取出${item}，再确认物品放置和携带状态。`+
    `\n\n抓取动作正在收尾，机械臂逐步收拢，机器人退出取物位置并切换到返回路线。当前携带的是${item}，我会继续跟踪返回导航和路径状态。`+
    "\n\n机器人正携带物品返回交付区域，接近交付点后调整朝向、减速停靠。我会继续核对交付位置并等待本次任务的最终确认。收到完成结果后，再告诉你可以领取。");
}
function StatusIcon({status}:{status:DisplayStatus}){
  const icons={idle:Clock3,submitting:LoaderCircle,executing:LoaderCircle,succeeded:CheckCircle2,rejected:CircleX,uncertain:AlertTriangle,fault:AlertCircle,resolved:UserRoundCheck,alert:AlertCircle};
  const names={idle:"等待选择",submitting:"等待机器人接单",executing:"机器人已接单",succeeded:"取物完成",rejected:"机器人未接单",uncertain:"需要核对",fault:"需要协助",resolved:"工作人员处理",alert:"需要协助"};
  const Icon=icons[status];
  return <Icon role="img" aria-label={names[status]} size={22} className={status==="submitting"||status==="executing"?"spin":undefined}/>;
}
const taskNotices:Partial<Record<BoothTask["status"],string>>={
  executing:"已接单，请稍候。",
  succeeded:"已取好，请到交付处领取。",
  rejected:"机器人未接下这次取物，请核对选择或联系现场工作人员。",
  uncertain:"机器人是否接单、这次取物是否结束尚未确认，请勿重复确认取物。请联系现场工作人员，当前尚未确认机器人是否停止。",
  fault:"这次取物需要工作人员协助，是否结束尚未确认，请勿重复确认取物。当前尚未确认机器人是否停止。",
  resolved:"这次取物已由工作人员处理，领取情况请向现场工作人员确认。",
};
const taskReplies:Record<Exclude<BoothTask["status"],"submitting"|"executing">,string>={
  resolved:"这次取物已由工作人员处理。是否可以领取，请向现场工作人员确认。",
  fault:"这次取物遇到了问题，请联系现场工作人员协助处理，先不要重复确认取物。",
  uncertain:"暂时无法确认机器人是否接下这次取物，请联系现场工作人员核对，先不要重复确认取物。",
  rejected:"机器人这次没有接下取物请求，可以核对选择后再试，或联系现场工作人员。",
  succeeded:"物品已经取好，可以到交付处领取了。",
};
const globalAlertNotice="取物服务暂需工作人员核对，请稍候。当前尚未确认机器人是否停止。";
async function api<T>(url:string,body?:unknown,headers?:Record<string,string>):Promise<T>{
  const response=await fetch(url,{...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();if(!response.ok)throw new RequestError(typeof data.data==="string"?data.data:"暂时无法连接，请稍后重试",response.status);return data as T;
}
function loadPending():Pending|null{try{
  const p=JSON.parse(localStorage.getItem(pendingKey)??"null");
  if(!p||typeof p.requestId!=="string"||(p.experienceId&&p.experienceId!==savedExperience()?.id))return null;
  const items=p.items??[{productId:p.productId,count:p.count}];
  return Array.isArray(items)&&items.length>0&&items.every(line=>line&&typeof line.productId==="string"&&Number.isSafeInteger(line.count)&&line.count>0)?{items,requestId:p.requestId,...(p.experienceId?{experienceId:p.experienceId}:{})}:null;
}catch{return null;}}
function clearSavedPending(request:Pending){try{if(JSON.parse(localStorage.getItem(pendingKey)??"null")?.requestId===request.requestId)localStorage.removeItem(pendingKey);}catch{/* A saved requestId remains safe to check again. */}}
function resizeComposer(input:HTMLTextAreaElement){
  input.style.height="32px";
  input.style.height=input.scrollHeight+input.offsetHeight-input.clientHeight+"px";
}
export function BoothApp(){
  const [,setWaitingTick]=useState(0);
  const waitingAnchor=useRef<{waiting:NonNullable<BoothSnapshot["waiting"]>;at:number}|null>(null);
  const [state,setState]=useState<BoothSnapshot|null>(null),[connected,setConnected]=useState(false);
  const [selection,setSelection]=useState<BoothSelectionItem[]>([]),[category,setCategory]=useState("全部");
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState<Feedback|null>(null),[pending,setPending]=useState<Pending|null>(loadPending);
  const error=feedback?.message??"";
  function setError(message:string,source:Feedback["source"]="other",requestId?:string){setFeedback(message?{message,source,...(requestId?{requestId}:{})}:null);}
  const submission=useRef<{request:Pending;recorded:boolean;snapshotSeen:boolean}|null>(null);
  const [messages,setMessages]=useState<ConversationMessage[]>([]),[text,setText]=useState(""),[thinking,setThinking]=useState(false);
  const snapshotInitialized=useRef(false),snapshotRevision=useRef(0),observedTasks=useRef(new Map<string,BoothTask["status"]>()),notifiedStates=useRef(new Set<string>());
  const [operatorBusy,setOperatorBusy]=useState(false);
  const [operator,setOperator]=useState(location.hash==="#operations"),[token,setToken]=useState(""),[checked,setChecked]=useState(false);
  const messageList=useRef<HTMLDivElement>(null),selectionVersion=useRef(0),experienceVersion=useRef(0),draftVersion=useRef(0),currentState=useRef(state);
  const composerInput=useRef<HTMLTextAreaElement>(null),composing=useRef(false);
  const speechDraft=useRef(new SpeechDraft()),voice=useRef<VoiceControl>(null);
  function updateText(value:string){speechDraft.current.edit(value);draftVersion.current++;setText(value);}
  const transcript=useRef<HTMLDivElement>(null);
  const followLatest=useRef(true);
  const experienceReady=useRef<Promise<BoothExperience>|null>(null),releaseExperience=useRef<(()=>void)|null>(null);
  const experienceAbort=useRef<AbortController|null>(null);
  const taskThought=useRef<{id:string;requestId:string;notifiedStatuses:Set<BoothTask["status"]>}|null>(null);
  function prepareExperience(fresh=false){
    experienceAbort.current?.abort();const controller=new AbortController();experienceAbort.current=controller;
    releaseExperience.current?.();releaseExperience.current=null;
    const version=experienceVersion.current;
    const ready=openExperience(fresh,controller.signal).then(({credential,release})=>{
      if(version!==experienceVersion.current){release();throw new Error("体验已切换，请重新操作。");}
      releaseExperience.current=release;
      setPending(current=>current?.experienceId&&current.experienceId!==credential.id?null:current);
      return credential;
    });
    experienceReady.current=ready;
    void ready.catch(e=>{if(version===experienceVersion.current)setError(e.message);});
  }
  useEffect(()=>{prepareExperience();return()=>{experienceVersion.current++;experienceAbort.current?.abort();releaseExperience.current?.();};},[]);
  currentState.current=state;
  const selectedItems=pending?.items??selection,total=selectedItems.reduce((sum,line)=>sum+line.count,0);
  const invalidSelection=selectedItems.some(line=>{const p=state?.products.find(p=>p.id===line.productId);return !p||line.count>Math.min(2,p.maxCount,p.availableCount);})||total>2;
  const [experienceTaskId,setExperienceTaskId]=useState<string|null>(null);
  const [dismissedCompletionId,setDismissedCompletionId]=useState<string|null>(null);
  const awaitingTaskSnapshot=!!(submission.current?.recorded&&!submission.current.snapshotSeen);
  const latest=state?.active??state?.tasks.find(task=>task.id===experienceTaskId),blocked=!!state?.active||!!state?.alert||awaitingTaskSnapshot;
  const completedTaskId=latest?.status==="succeeded"?latest.id:null;
  useEffect(()=>{
    if(!completedTaskId)return;
    const timer=setTimeout(()=>setDismissedCompletionId(completedTaskId),10000);
    return()=>clearTimeout(timer);
  },[completedTaskId]);
  const displayTask=latest?.status==="succeeded"&&latest.id===dismissedCompletionId?null:latest;
  function receiveSnapshot(snapshot:BoothSnapshot){
    snapshotRevision.current++;
    const previous=currentState.current;
    if(previous?.active?.id!==snapshot.active?.id||previous?.alert!==snapshot.alert)setChecked(false);
    currentState.current=snapshot;
    if(submission.current&&snapshot.tasks.some(task=>task.requestId===submission.current!.request.requestId))submission.current.snapshotSeen=true;
    setFeedback(current=>current?.source==="state"?null:current);
    // The first snapshot is a baseline, not a replay of historical events.
    for(const task of [...snapshot.tasks].reverse()){
      const key=task.id+":"+task.status,previous=observedTasks.current.get(task.id);
      if(snapshotInitialized.current&&previous!==task.status&&!notifiedStates.current.has(key)){
        let notice=taskNotices[task.status];
        if(task.status==="succeeded"&&(snapshot.active||snapshot.alert))notice="取物已完成，请按当前提示继续操作。";
        if(notice)setExperienceTaskId(task.id);
      }
      if(task.requestId===taskThought.current?.requestId&&(task.status==="submitting"||task.status==="executing")){
        const id=taskThought.current.id;
        setMessages(current=>current.map(message=>message.role==="thinking"&&message.id===id?{...message,content:taskThinkingContent(task)}:message));
      }
      if(task.requestId===taskThought.current?.requestId&&task.status!=="submitting"&&task.status!=="executing"&&!taskThought.current.notifiedStatuses.has(task.status)){
        const id=taskThought.current.id;
        taskThought.current.notifiedStatuses.add(task.status);
        const reply=taskReplies[task.status];
        setMessages(current=>[...current.map(message=>message.role==="thinking"&&message.id===id?{...message,phase:"done" as const}:message),{role:"assistant",content:reply}]);
      }
      observedTasks.current.set(task.id,task.status);notifiedStates.current.add(key);
    }
    snapshotInitialized.current=true;
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
    let alive=true,streamReceived=false;api<BoothSnapshot>("/api/booth").then(v=>{if(alive&&!streamReceived)receiveSnapshot(v);}).catch(e=>{if(alive&&!streamReceived)setError(e.message,"state");});
    const events=new EventSource("/api/booth/events");
    events.onmessage=e=>{if(alive){streamReceived=true;receiveSnapshot(JSON.parse(e.data));setConnected(true);}};events.onerror=()=>{if(alive)setConnected(false);};
    const hash=()=>setOperator(location.hash==="#operations");window.addEventListener("hashchange",hash);
    return()=>{alive=false;events.close();window.removeEventListener("hashchange",hash);};
  },[]);
  useEffect(()=>{waitingAnchor.current=state?.waiting?{waiting:state.waiting,at:performance.now()}:null;},[state?.waiting]);
  useEffect(()=>{const timer=setInterval(()=>setWaitingTick(t=>t+1),1000);return()=>clearInterval(timer);},[]);
  const elapsedWaitMs=state?.waiting?state.waiting.elapsedMs+(waitingAnchor.current?.waiting===state.waiting?Math.max(0,performance.now()-waitingAnchor.current.at):0):0;
  const overdue=!!state?.waiting&&(state.waiting.overdue||elapsedWaitMs>=state.waiting.remindAfterMs);
  useLayoutEffect(()=>{
    if(messages.length===0)followLatest.current=true;
    const list=messageList.current;if(list&&followLatest.current)list.scrollTop=list.scrollHeight;
  },[messages,thinking]);
  useLayoutEffect(()=>{if(composerInput.current)resizeComposer(composerInput.current);},[text,!!state]);
  useEffect(()=>{
    const input=composerInput.current;if(!input)return;
    let width=input.clientWidth;
    const observer=new ResizeObserver(()=>{if(input.clientWidth!==width){width=input.clientWidth;resizeComposer(input);}});
    observer.observe(input);return()=>observer.disconnect();
  },[!!state]);
  useEffect(()=>{
    const list=messageList.current;if(!list)return;
    let width=list.clientWidth,height=list.clientHeight,contentHeight=list.scrollHeight,touchY:number|null=null;
    const trackPosition=()=>{
      const bottom=Math.abs(list.scrollHeight-list.clientHeight-list.scrollTop)<2;
      // Content growth and browser scroll anchoring are not a request to read earlier messages.
      if(bottom)followLatest.current=true;
      else if(list.clientWidth===width&&list.clientHeight===height&&list.scrollHeight===contentHeight)followLatest.current=false;
    };
    // Record upward intent before concurrent typing or resize can move the content.
    const trackKeyboard=(event:KeyboardEvent)=>{
      if(event.key==="End")followLatest.current=true;
      else if(["Home","PageUp","ArrowUp"].includes(event.key)||(event.key===" "&&event.shiftKey))followLatest.current=false;
    };
    const trackWheel=(event:WheelEvent)=>{if(event.deltaY<0)followLatest.current=false;};
    const trackTouchStart=(event:TouchEvent)=>{touchY=event.touches[0]?.clientY??null;};
    const trackTouchMove=(event:TouchEvent)=>{
      const next=event.touches[0]?.clientY??null;
      if(touchY!==null&&next!==null&&next>touchY)followLatest.current=false;
      touchY=next;
    };
    const observer=new ResizeObserver(()=>{
      if(followLatest.current)list.scrollTop=list.scrollHeight;
      width=list.clientWidth;height=list.clientHeight;contentHeight=list.scrollHeight;
    });
    list.addEventListener("scroll",trackPosition);list.addEventListener("keydown",trackKeyboard);
    list.addEventListener("wheel",trackWheel,{passive:true});list.addEventListener("touchstart",trackTouchStart,{passive:true});list.addEventListener("touchmove",trackTouchMove,{passive:true});observer.observe(list);
    if(transcript.current)observer.observe(transcript.current);
    return()=>{
      observer.disconnect();list.removeEventListener("scroll",trackPosition);list.removeEventListener("keydown",trackKeyboard);
      list.removeEventListener("wheel",trackWheel);list.removeEventListener("touchstart",trackTouchStart);list.removeEventListener("touchmove",trackTouchMove);
    };
  },[!!state]);
  function confirmRecordedRequest(request:Pending){
    const current=submission.current;
    if(current?.request.requestId===request.requestId){
      if(!current.recorded){current.recorded=true;selectionVersion.current++;setSelection([]);}
      setBusy(false);
    }
    setPending(current=>current?.requestId===request.requestId?null:current);
    clearSavedPending(request);
    setFeedback(current=>current?.source==="request"&&current.requestId===request.requestId?null:current);
  }
  useEffect(()=>{if(pending&&state?.tasks.some(t=>t.requestId===pending.requestId))confirmRecordedRequest(pending);},[state,pending]);
  function choose(p:BoothStockProduct){
    if(pending||busy||p.availableCount<1)return;
    selectionVersion.current++;
    if(selection.some(line=>line.productId===p.id))return;
    if(total>=2){setError("每单最多两件，请先移除物品或减少数量。","selection");return;}
    setSelection([...selection,{productId:p.id,count:1}]);setFeedback(current=>current?.source==="selection"?null:current);
  }
  function changeCount(productId:string,n:number){selectionVersion.current++;setSelection(current=>current.map(line=>line.productId===productId?{...line,count:n}:line));setFeedback(current=>current?.source==="selection"?null:current);}
  function removeItem(productId:string){selectionVersion.current++;setSelection(current=>current.filter(line=>line.productId!==productId));setFeedback(current=>current?.source==="selection"?null:current);}
  async function submit(){
    if((!pending&&(selection.length===0||blocked))||busy||!connected)return;selectionVersion.current++;setBusy(true);setError("");
    if(!pending&&invalidSelection){setError("所选数量超过当前可取数量，请重新确认。","selection");setBusy(false);return;}
    let credential:BoothExperience;
    try{if(!experienceReady.current)throw new Error("本页体验信息尚未准备好，请稍候。");credential=await experienceReady.current;}
    catch(e){setError(e instanceof Error?e.message:"无法建立本页体验信息，本次未发送。");setBusy(false);return;}
    if(pending?.experienceId&&pending.experienceId!==credential.id){setError("这次取物属于另一段体验，请联系工作人员核对。");setBusy(false);return;}
    const request=pending??{items:selection,requestId:crypto.randomUUID(),experienceId:credential.id};
    // Do not send without a saved requestId that can be recovered after reload.
    try{localStorage.setItem(pendingKey,JSON.stringify(request));}
    catch{setError("无法保存取物信息，本次未发送。请检查浏览器存储设置后重试。");setBusy(false);return;}
    const attempt={request,recorded:false,snapshotSeen:false};submission.current=attempt;setPending(request);
    if(taskThought.current?.requestId!==request.requestId){
      const id=crypto.randomUUID();taskThought.current={id,requestId:request.requestId,notifiedStatuses:new Set()};
      setMessages(current=>[...current,{role:"thinking",id,requestId:request.requestId,kind:"task",phase:"running",content:taskThinkingContent({items:request.items.map(line=>{const p=state!.products.find(p=>p.id===line.productId);return {...line,name:p?.name??line.productId,location:p?.location??"待核对"};}),status:"submitting"})}]);
    }
    let submitted=false;
    try{await api("/api/booth/requests",request,request.experienceId?{"X-Booth-Experience":credential.token}:undefined);submitted=true;if(submission.current!==attempt)return;confirmRecordedRequest(request);await requestSnapshot("/api/booth");}
    catch(e){
      if(submission.current!==attempt)return;
      if(attempt.recorded||currentState.current?.tasks.some(task=>task.requestId===request.requestId)){
        confirmRecordedRequest(request);
        if(submitted&&!currentState.current?.tasks.some(task=>task.requestId===request.requestId))setError("取物请求已提交，但暂时无法更新页面状态，请等待状态恢复，请勿重复确认取物。","state",request.requestId);
        return;
      }
      const rejectedBeforeTask=!submitted&&e instanceof RequestError&&[400,409,503].includes(e.status);
      if(rejectedBeforeTask){setPending(null);clearSavedPending(request);}
      if(!submitted&&e instanceof RequestError&&[400,403,409,503].includes(e.status)&&!currentState.current?.tasks.some(task=>task.requestId===request.requestId)){
        const id=taskThought.current?.id;
        setMessages(current=>[...current.map(message=>message.role==="thinking"&&message.id===id?{...message,phase:"done" as const}:message),{role:"assistant",content:"这次取物未能提交。"+e.message}]);
      }
      setError(e instanceof RequestError?e.message:"尚未收到取物确认的反馈，请核对这次取物",rejectedBeforeTask?"selection":"request",request.requestId);
    }finally{if(submission.current===attempt)setBusy(false);}
  }
  function startExperience(){
    try{forgetExperience();}catch{setError("无法开始新体验，请检查浏览器存储设置或联系工作人员。");return;}
    experienceVersion.current++;selectionVersion.current++;
    submission.current=null;
    voice.current?.cancel("experience-changed");voice.current?.clearReceipts();
    taskThought.current=null;
    setMessages([]);updateText("");setThinking(false);
    setSelection([]);setError("");setExperienceTaskId(null);
    prepareExperience(true);
  }
  async function chat(input=text,fromQuickPrompt=false){
    if(!input.trim()||thinking||(fromQuickPrompt&&text.length>0))return;
    voice.current?.cancel("sent-draft");const speechRecords=voice.current?.takeReceipts()??[];
    setThinking(true);updateText("");
    const version=selectionVersion.current,experience=experienceVersion.current,draft=draftVersion.current,taskId=state?.tasks[0]?.id;
    const userMessage:BoothChatMessage={role:"user",content:input.trim()};
    const next:BoothChatMessage[]=[...messages.filter((message):message is BoothChatMessage=>message.role==="user"||message.role==="assistant"),userMessage];
    const thoughtId=crypto.randomUUID();
    setMessages(current=>[...current,userMessage,{role:"thinking",id:thoughtId,kind:"chat",phase:"running",content:"我会先结合你的需求和可选物品整理回复。如果需要取物，请先确认物品和数量，再交由机器人完成取送。"}]);
    try{const credential=await experienceReady.current?.catch(()=>null);if(experience!==experienceVersion.current)return;const advice=await api<BoothAdvice>("/api/booth/chat",{messages:next.slice(-11),speechRecords},credential?{"X-Booth-Experience":credential.token}:undefined);if(experience!==experienceVersion.current)return;setMessages(current=>[...current.map(message=>message.role==="thinking"&&message.id===thoughtId?{...message,phase:"done" as const}:message),{role:"assistant",content:advice.reply}]);
      const latestState=currentState.current,proposal=advice.selection;
      if(proposal&&proposal.length>0&&proposal.reduce((sum,line)=>sum+line.count,0)<=2&&proposal.every(line=>{const p=latestState?.products.find(p=>p.id===line.productId);return p&&line.count>=1&&line.count<=Math.min(p.maxCount,p.availableCount);})&&!blocked&&!latestState?.active&&!latestState?.alert&&!pending&&!busy&&taskId===latestState?.tasks[0]?.id&&version===selectionVersion.current){selectionVersion.current++;setSelection(proposal);}}

    catch(e){if(experience===experienceVersion.current){
      const notice=e instanceof RequestError?e.message:"暂时连不上助手，请稍后再试，也可以直接选择物品。";
      setMessages(current=>[...current.map(message=>message.role==="thinking"&&message.id===thoughtId?{...message,phase:"done" as const}:message),{role:"assistant",content:notice}]);
      if(draft===draftVersion.current)updateText(input);
    }}finally{if(experience===experienceVersion.current)setThinking(false);}
  }
  async function resolve(){
    if(!state||!checked)return;
    setOperatorBusy(true);setError("");try{await requestSnapshot("/api/booth/operator/resolve",{confirmation:"已核对机器人停止",expectedTaskId:state.active?.id??null,expectedAlert:state.alert},{"X-Operator-Token":token});setChecked(false);setToken("");}
    catch(e){
      if(e instanceof RequestError&&e.status===409){setChecked(false);try{await requestSnapshot("/api/booth");}catch{/* Keep the recovery error visible if refreshing also fails. */}}
      setError(e instanceof Error?e.message:"处理失败");
    }finally{setOperatorBusy(false);}
  }
  async function resetStock(productId:string|null):Promise<boolean>{
    setOperatorBusy(true);setError("");
    try{await requestSnapshot(productId===null?"/api/booth/operator/stock/reset-all":"/api/booth/operator/stock/reset",productId===null?{confirmation:"已核对并补满全部库存"}:{productId,confirmation:"已核对并补满库存"},{"X-Operator-Token":token});setToken("");return true;}
    catch(e){setError(e instanceof Error?e.message:"库存重置失败");return false;}finally{setOperatorBusy(false);}
  }
  if(!state)return <div className="boot-screen"><img className="bluesword-logo" src={blueswordLogo} alt="BlueSword 兰剑" width={221} height={59}/><h1>兰剑 · 智能体验</h1>{error?<><p role="alert">{error}</p><button onClick={()=>location.reload()}>重新连接</button></>:<><LoaderCircle className="spin"/><p>正在加载，请稍候</p></>}</div>;
  const categories=["全部",...new Set(state.products.map(p=>p.category))],visible=state.products.filter(p=>category==="全部"||p.category===category);
  const displayStatus:DisplayStatus=state.alert?"alert":displayTask?.status??"idle";
  const taskMessage=displayStatus==="alert"?globalAlertNotice:displayStatus==="idle"?"确认取物后，可以在这里查看进展。":displayStatus==="submitting"?"正在等待机器人接单，请稍候。":taskNotices[displayStatus];
  return <div className="booth-shell">
    <main>
      <section className="welcome"><div className="welcome-copy"><div className="eyebrow"><img className="bluesword-logo" src={blueswordLogo} alt="BlueSword 兰剑" width={221} height={59}/>兰剑展台服务</div><h1>选好喜欢的物品，<br/><span>确认后等候领取。</span></h1><p>可以自己选物品，也可以向助手提问。<br className="desktop-break"/>选好后，核对数量，再点击“确认取物”。</p><div className="welcome-note"><span className="round-icon"><ArrowUpRight size={17}/></span>取物完成后，请到交付处领取</div></div><section className={"task-panel "+displayStatus+" status-"+displayStatus} aria-label="当前取物任务" aria-live="polite"><div className="task-heading"><span className="eyebrow">取物状态</span>{displayTask&&<span className="task-updated">最近更新 <time>{new Date(displayTask.updatedAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time></span>}<span className="task-status">{state.alert?"需要协助":displayTask?labels[displayTask.status]:"等待你的选择"}</span></div><div className="task-illustration" aria-hidden="true"><div className="robot-sculpture"><div className="robot-head"><div className="robot-face"><i/><i/></div></div><div className="robot-neck"/><div className="robot-body"><span className="robot-insignia"/><div className="robot-arm left"/><div className="robot-arm right"/></div><div className="robot-base"/></div></div><div className="task-main-icon"><StatusIcon status={displayStatus}/></div><h3>{state.alert?"请联系现场工作人员":displayTask?taskSummary(displayTask):"请选择物品"}</h3><p>{taskMessage}</p>{overdue&&<div role="alert" className="waiting-reminder"><strong>等待时间较长，请联系工作人员核对</strong><p>已等待约 {Math.max(1,Math.floor(elapsedWaitMs/1000))} 秒。本次取物是否结束尚未确认，请勿重复确认取物。当前尚未确认机器人是否停止。</p><button onClick={()=>{location.hash="operations";setOperator(true);}}>联系工作人员核对</button></div>}</section></section>
      <div className="experience-grid">
        <aside className="concierge-column"><section className="assistant-panel"><div className="assistant-heading"><span className="assistant-avatar"><Sparkles size={21}/></span><div><h2>展台助手</h2></div><button className="new-experience" onClick={startExperience} disabled={busy||!!pending||awaitingTaskSnapshot}>开始新体验</button><span className="ai-label">AI</span></div>
          <div className="chat-messages" ref={messageList} role="log" aria-label="访客对话" tabIndex={0} aria-live="polite"><div className="chat-transcript" ref={transcript}>{messages.length===0?<div className="chat-welcome">欢迎来到兰剑展台。想了解物品或需要选品建议，都可以在这里提问。</div>:messages.map((m,i)=>m.role==="thinking"?<ThinkingPanel key={i} message={m}/>:<div key={i} className={"chat-bubble "+m.role}>{m.content}</div>)}</div></div>
          <div className="quick-prompts">{["帮我选一件物品","这里有什么？"].map(t=><button key={t} onClick={()=>void chat(t,true)} disabled={thinking||!state.ai.configured||text.length>0} title={text.length>0?"请先发送或清空输入框中的草稿":undefined}>{t}<ArrowUpRight size={12}/></button>)}</div>
          <form className="chat-composer" onSubmit={e=>{e.preventDefault();void chat();}}><VoiceInput ref={voice} draft={speechDraft.current} onText={updateText} disabled={!state.ai.configured}/><textarea ref={composerInput} rows={1} aria-label="告诉助手你的需求" placeholder={state.ai.configured?"想了解什么？":"助手暂未配置，可直接选物品"} maxLength={2000} value={text} onCompositionStart={()=>{composing.current=true;speechDraft.current.cancel();}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key!=="Enter"||e.shiftKey||e.nativeEvent.isComposing||composing.current||e.keyCode===229)return;e.preventDefault();void chat();}} onChange={e=>{updateText(e.target.value);if(!e.target.value)voice.current?.clearReceipts();}} disabled={!state.ai.configured}/><button aria-label="发送需求" aria-busy={thinking} disabled={thinking||!state.ai.configured||!text.trim()}>{thinking?<><LoaderCircle size={17} className="spin chat-send-spinner"/><span className="chat-send-waiting">稍候</span></>:<Send size={17}/>}</button></form><div className="assistant-footnote"><ShieldCheck size={12}/>助手提供建议，取物前请确认物品和数量</div></section>
        </aside>
        <aside className="service-column" aria-label="选品与任务状态">
        <div className="selection-workspace">
        <details className="catalog-panel" open><summary id="catalog-title"><span>浏览物品 · 手动选择</span><span className="catalog-count">{state.products.length} 款</span></summary><div aria-labelledby="catalog-title">
          <div className="category-tabs" aria-label="物品分类">{categories.map(c=><button key={c} aria-pressed={category===c} onClick={()=>setCategory(c)} className={category===c?"active":""}>{c}</button>)}</div>
          <div className="product-grid" role="region" aria-label="可选物品列表" tabIndex={0}>{visible.map((p,i)=><button className={"product-card "+(selectedItems.some(line=>line.productId===p.id)?"selected":"")} key={p.id} onClick={()=>choose(p)} aria-label={"选择"+p.name} aria-pressed={selectedItems.some(line=>line.productId===p.id)} disabled={busy||!!pending||p.availableCount===0}><div className="product-scene" style={{background:p.color}}><span className="product-category">{p.category}</span><span className="product-stock">{p.availableCount===0?"已取完":"剩余 "+p.availableCount+" 份"}</span><span className="product-number">{(i+1).toString().padStart(2,"0")}</span><ProductArt product={p}/><span className="choose-mark">{selectedItems.some(line=>line.productId===p.id)?<Check size={17}/>:<Plus size={17}/>}</span></div><div className="product-copy"><h3>{p.name}<ArrowUpRight size={17}/></h3><p>{p.subtitle}</p></div></button>)}</div>
        </div></details>
          <section className={"order-panel "+(selectedItems.length?"has-selection":"")} aria-label="取物确认">{selectedItems.length?<>
            {selectedItems.map(line=>{const p=state.products.find(p=>p.id===line.productId);return <div className="order-line" key={line.productId}>
              {p&&<div className="order-art" style={{background:p.color}}><ProductArt product={p} small/></div>}
              <div className="order-details"><span className="eyebrow">已选物品</span><h3>{p?.name??line.productId}</h3><p>{p?.description}</p><p>当前可取 {p?.availableCount??0} 份</p></div>
              <div className="quantity-control"><button aria-label="减少数量" onClick={()=>changeCount(line.productId,line.count-1)} disabled={line.count<=1||busy||!!pending}><Minus size={15}/></button><output aria-label="已选数量">{line.count}</output><button aria-label="增加数量" onClick={()=>changeCount(line.productId,line.count+1)} disabled={!p||line.count>=Math.min(p.maxCount,p.availableCount)||total>=2||busy||!!pending}><Plus size={15}/></button></div>
              <button aria-label={"移除"+(p?.name??line.productId)} onClick={()=>removeItem(line.productId)} disabled={busy||!!pending}><X size={16}/></button>
            </div>;})}
            {!pending&&invalidSelection&&<p role="status" className="stock-shortage">所选数量超过当前可取数量或每单两件的限制，请重新确认。</p>}
            <div className="order-actions"><p>共 {total} 件 · 每单最多两件</p><button className="primary-button" onClick={()=>void submit()} disabled={busy||!connected||(blocked&&!pending)||(!state.dispatch.ready&&!pending)||(!pending&&invalidSelection)}>{busy?<><LoaderCircle size={17} className="spin"/>正在确认</>:<>{pending?"核对这次取物":blocked?"请等待当前任务":invalidSelection?"请重新确认数量":"确认取物"}<ArrowRight size={17}/></>}</button></div>
          </>:<><span className="selection-placeholder"><ArrowUpRight size={22}/></span><div><h3>请选择物品</h3><p>请在物品列表中选择，或让助手帮你选。每单最多两件。</p></div></>}</section>
        </div>
          {state.dispatch.reason&&!pending&&<p role="status" className="task-note">{state.dispatch.reason}</p>}
          {!connected&&<p role="status" className="task-note">取物状态暂未更新，请稍候再确认；已有任务请勿重复确认取物。</p>}
          {error&&<div role="alert" className="feedback-error"><AlertCircle size={17}/><span>{error}</span><button onClick={()=>setError("")} aria-label="关闭提示"><X size={16}/></button></div>}
          <div className="experience-steps" aria-label="体验流程"><span><b>01</b>选择物品</span><ChevronRight size={14}/><span><b>02</b>确认数量</span><ChevronRight size={14}/><span><b>03</b>等待领取</span></div>
        </aside>
      </div>
    </main>
    {state.mode!=="simulator"&&<footer className="site-footer"><p>{!state.catalogConfirmed?"物品目录待现场确认，暂未开放取物。":"如需帮助，请联系现场工作人员。"}</p></footer>}
    {operator&&<div className="modal-backdrop"><section className="operator-modal" role="dialog" aria-modal="true" aria-labelledby="operator-title"><button className="modal-close" aria-label="关闭工作人员入口" onClick={()=>{setOperator(false);location.hash="";}}><X/></button><span className="eyebrow">STAFF ONLY</span><h2 id="operator-title">现场异常核对</h2><p className="operator-system-status">{connected?"网关状态同步正常":"网关状态同步中断"}。{state.mode==="simulator"?"当前使用本地机器人模拟器，未连接真实机器人。":"此状态不证明真实机器人在线或可接单。"}</p><section className="operator-details" aria-label="工作人员任务详情"><dl>
      <dt>当前助手配置</dt><dd>{state.ai.provider} · {state.ai.model}（{state.ai.configured?"凭据已配置":"凭据未配置"}；不代表本次调用成功）</dd>
      <dt>当前状态</dt><dd>{state.alert?"全局告警":latest?labels[latest.status]:"无当前任务"}</dd>
      {latest&&<><dt>任务标识</dt><dd>{latest.id}</dd><dt>任务记录原文</dt><dd>{latest.message}</dd></>}
      {state.alert&&<><dt>告警原文</dt><dd>{state.alert}</dd></>}
    </dl></section><p>此操作仅解除网关接收新任务的限制，不向机器人发送停止或取消指令，也不会恢复库存。请先现场确认机器人已停止、物品情况已核对。入口可见不代表拥有操作权限。</p>{!state.operator.configured&&<p role="status" className="operator-waiting">工作人员操作凭据尚未配置，暂不能解除新任务限制或重置库存。请由启动服务的负责人设置 BOOTH_OPERATOR_TOKEN 并重启 API；不要在展示页面分享凭据。</p>}{state.active&&<p className="operator-waiting">如机器人已在现场停止、物品情况已核对，可以解除新任务限制，无需等待机器人补发完成或故障通知。等待时间较长本身不代表机器人已经停止。</p>}<label>工作人员凭据<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off" disabled={!state.operator.configured}/></label><label className="check-label"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={!state.operator.configured}/>已现场核对机器人停止及物品情况</label><button className="primary-button" onClick={()=>void resolve()} disabled={operatorBusy||!state.operator.configured||!checked||!token||(!state.alert&&!state.active)}><RefreshCw size={16}/>解除新任务限制</button><StockResetPanel products={state.products} disabled={operatorBusy||!connected||!state.operator.configured||!token} onReset={resetStock}/>{error&&<p role="alert">{error}</p>}</section></div>}
  </div>;
}
