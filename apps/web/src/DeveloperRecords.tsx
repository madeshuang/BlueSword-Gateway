import {useState} from "react";
import type {SpeechRecord,WireRecord} from "@bluesword/contracts";
import "./developer.css";
const statusNames:Record<SpeechRecord["status"],string>={starting:"尚未结束",success:"已识别",empty:"没有文字",error:"失败",cancelled:"已取消"};
const ms=(value:number|undefined)=>value===undefined?"未记录":`${Math.round(value)} ms`;
export function DeveloperRecords({kind}:{kind:"speech"|"robot"}){
  const [token,setToken]=useState(""),[data,setData]=useState<{records:(SpeechRecord|WireRecord)[]}|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function load(download=false){setBusy(true);setError("");if(!download)setData(null);
    try{
      const response=await fetch(`/api/booth/developer/${kind}${download?"?download=1":""}`,{headers:{"X-Operator-Token":token},cache:"no-store"});
      if(!response.ok){const body=await response.json();throw new Error(typeof body.data==="string"?body.data:"读取失败");}
      if(download){const url=URL.createObjectURL(await response.blob()),link=document.createElement("a");link.href=url;link.download=`bluesword-${kind}-records-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      else setData(await response.json());
    }catch(error){setError(error instanceof Error?error.message:"无法读取记录，请检查连接");}finally{setBusy(false);}
  }
  return <main className="developer-records"><h1>{kind==="speech"?"语音识别记录":"机器人通信记录"}</h1>
    <p>运行记录每类保留最近200条，重启后保留。时间显示为本机时间，下载文件使用UTC。口令仅在当前页面内存中使用。</p>
    <form onSubmit={event=>{event.preventDefault();void load();}}><label>工作人员口令<input aria-label="工作人员口令" type="password" autoComplete="off" value={token} onChange={event=>{setToken(event.target.value);setData(null);}}/></label><button disabled={busy||!token}>读取／刷新</button><button type="button" disabled={busy||!data||!token} onClick={()=>void load(true)}>下载 JSON</button></form>
    {error&&<p role="alert">{error}</p>}
    {kind==="speech"?<p>不保存原始录音。识别原文与实际发送给文字AI的内容分别记录；未发送的记录不会标成已发送。连接耗时从浏览器建立语音连接开始计算，不含此前麦克风准备时间。停止至回填不包含此前自动停止所等待的停顿时间。浏览器未成功回传的草稿状态、断网期间无法创建的尝试可能缺失。</p>:<p>记录网关调用机器人和收到完成、故障通知时的实际报文。密钥等请求头已隐藏；请求头的采集范围在记录内说明。连接失败不证明请求没有送达，通信记录也不证明机器人执行了具体动作。单个请求或响应正文超过32 KiB时只保留开头，并标明截断。正文尚在采集或采集失败时会注明，不表示对端返回了空正文。</p>}
    {data&&<p>当前显示 {data.records.length} 条记录。</p>}
    {kind==="speech"&&data&&<div className="records-table"><table><thead><tr><th>时间／环境</th><th>供应商／模型</th><th>识别原文与发送文字</th><th>状态／停止原因</th><th>等待</th></tr></thead><tbody>{(data.records as SpeechRecord[]).map(record=><tr key={record.id}><td>{new Date(record.createdAt).toLocaleString("zh-CN")}<small>{record.mode==="http"?"真实机器人模式":"模拟机器人模式"}</small></td><td>{record.provider==="ali"?"阿里云":"腾讯云"}<small>{record.model}</small></td><td><div>识别原文：{record.text||"（无文字）"}</div><div>草稿：{record.applied===true?"已加入":record.applied===false?"未加入":"未收到回填状态"}</div><div>发送文字：{record.sentAt?record.sentText:"未记录到发送"}</div>{record.error&&<p>{record.error}</p>}</td><td>{statusNames[record.status]}<small>{record.stopReason||"未记录停止原因"}</small></td><td>连接：{ms(record.readyMs)}<br/>停止至最终结果：{ms(record.endToFinalMs)}<br/>停止至回填：{ms(record.endToDraftMs)}</td></tr>)}</tbody></table></div>}
    {kind==="robot"&&data&&(data.records as WireRecord[]).map(record=><details key={record.id}><summary>{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.direction==="gateway-to-robot"?"网关 → 机器人":"机器人 → 网关"} · {record.mode==="http"?"真实机器人模式":"模拟机器人模式"} · {record.response?.status??"未取得响应"}{record.response?.bodyState==="pending"?" · 正文采集中":record.response?.bodyState==="failed"?" · 正文采集失败":""}</summary><pre>{JSON.stringify(record,null,2)}</pre></details>)}
  </main>;
}
