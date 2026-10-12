import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";

let upstream: Server | undefined;
afterEach(async()=>{if(upstream){await new Promise<void>(resolve=>upstream!.close(()=>resolve()));upstream=undefined;}});
async function run(args: string[], base: string) {
  const env: NodeJS.ProcessEnv = {};
  for(const [name,value] of Object.entries(process.env)) {
    if(!/^(OPENAI_|DEEPSEEK_|BOOTH_|ROBOT_|NODE_OPTIONS$)/i.test(name))env[name]=value;
  }
  Object.assign(env,{OPENAI_API_KEY:"cli-fixture-key",OPENAI_MODEL:"cli-fixture-model",OPENAI_BASE_URL:base,
    ROBOT_DISPATCH_URL:base+"/api/task/dispatch",BOOTH_CATALOG_CONFIRMED:"true"});
  const child=spawn(process.execPath,["--import","tsx","scripts/verify-ai.ts",...args],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  child.stdout.on("data",value=>{stdout+=value;});child.stderr.on("data",value=>{stderr+=value;});
  const exitCode=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
  return {exitCode,stdout,stderr};
}
it("验证命令选择positive时仅发送原正向样本一次，报告结构与零任务",async()=>{
  const requests: Array<{path:string;body:any}>=[];
  upstream=createServer(async(req,res)=>{
    let text="";for await(const chunk of req)text+=chunk;
    requests.push({path:req.url??"",body:JSON.parse(text)});
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({status:"completed",model:"returned-fixture-model",usage:{input_tokens:37,output_tokens:11,total_tokens:48},
      output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({reply:"fixture private reply",selection:{productId:"water",count:1}})}]}]}));
  });
  await new Promise<void>(resolve=>upstream!.listen(0,"127.0.0.1",resolve));
  const base="http://127.0.0.1:"+(upstream.address() as {port:number}).port;
  const result=await run(["--provider","openai","--sample","positive"],base);
  expect(result.exitCode).toBe(0);
  expect(requests).toHaveLength(1);expect(requests[0]?.path).toBe("/responses");
  expect(requests[0]?.body.input).toEqual([{role:"user",content:"我要1份矿泉水。"}]);
  const summary=result.stdout.trim().split("\n").map(line=>JSON.parse(line)).find(event=>event.event==="ai_verification");
  const report=JSON.parse(readFileSync(summary.reportPath,"utf8"));
  expect(report).toMatchObject({realProviders:false,plannedSamples:1,attemptedSamples:1,stoppedEarly:false});
  expect(report.results).toHaveLength(1);
  expect(report.results[0]).toMatchObject({endpointType:"openai_loopback",sampleId:"positive",model:"cli-fixture-model",returnedModel:"returned-fixture-model",structureValidated:true,selectionMatched:true,actualSelection:{productId:"water",count:1},taskCount:0});
  expect(JSON.stringify(report)).not.toMatch(/cli-fixture-key|fixture private reply/);
},20000);
