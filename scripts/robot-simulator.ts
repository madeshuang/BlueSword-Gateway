/** 独立机器人模拟器，只监听本机回环地址；不是正式机器人能力。 */
import { createServer } from "node:http";
const callback = process.env.SIMULATOR_CALLBACK_URL ?? "http://127.0.0.1:4100";
let scenario = process.env.SIMULATOR_SCENARIO ?? "success";
let busy = false;
const timers = new Set<ReturnType<typeof setTimeout>>();
const server = createServer(async(req,res)=>{
  const url = new URL(req.url ?? "/", "http://localhost");
  const reply = (success:boolean,data:string,status=200) => {res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify({code:1,data,success}));};
  try {
    let text=""; for await (const chunk of req) {text+=chunk;if(text.length>32768) throw new Error("请求过大");}
    const body=text?JSON.parse(text):{};
    if (req.method==="POST" && url.pathname==="/simulation/scenario" && ["success","error","rejected","silent"].includes(body.scenario)) {scenario=body.scenario;return reply(true,scenario);}
    if(req.method!=="POST" || url.pathname!=="/api/task/dispatch") return reply(false,"Not found",404);
    if(typeof body.location!=="string" || typeof body.item!=="string" || !Number.isSafeInteger(body.count) || body.count<1 || Object.keys(body).sort().join()!=="count,item,location") return reply(false,"报文不合法",400);
    if(busy || scenario==="rejected") return reply(false,"机器人模拟器当前不能接受任务");
    busy=true;reply(true,"received");
    if(scenario==="silent") return;
    const selected=scenario;
    const timer=setTimeout(async()=>{
      timers.delete(timer);
      try {
        const response=await fetch(callback+(selected==="error"?"/api/task/error":"/api/task/finished"),{
          method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(selected==="error"?{message:"测试故障：机械臂无法自动恢复"}:{result:"success"}),signal:AbortSignal.timeout(5000),
        });
        if(!response.ok) console.error("网关未成功接收模拟器的结果通知",response.status);
      } catch {console.error("模拟器向网关发送结果通知时连接失败");}
      finally {busy=false;}
    },2500);timers.add(timer);
  } catch {reply(false,"测试请求不合法",400);}
});
server.listen(Number(process.env.SIMULATOR_PORT??4200),"127.0.0.1",()=>console.log("独立机器人模拟器：http://127.0.0.1:4200"));
function close(){for(const t of timers)clearTimeout(t);server.close();}
process.once("SIGINT",close);process.once("SIGTERM",close);
