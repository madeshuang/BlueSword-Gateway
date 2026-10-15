import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createManualRobot } from "./robot-manual.js";

it("人工对端等待明确点击，展示原始接口记录，受理不会自动完成", async () => {
  const callbacks: {path:string; body:string}[] = [];
  const gateway = createServer(async (req,res)=>{
    let body=""; for await (const chunk of req) body+=chunk;
    callbacks.push({path:req.url!,body}); res.end(JSON.stringify({code:1,data:"OK",success:true}));
  });
  await new Promise<void>(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  const callback = "http://127.0.0.1:"+(gateway.address() as {port:number}).port;
  const robot = createManualRobot(callback);
  const base = "http://127.0.0.1:"+await robot.listen(0);
  const post = (path:string,body:unknown={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    expect(await (await fetch(base)).text()).toContain("原始接口记录");
    const raw = {location:"货架1-2层",item:"矿泉水",count:1};
    let replied=false;
    const dispatch = post("/api/task/dispatch",raw).then(response=>{replied=true;return response;});
    let state: any;
    for (let attempt=0;attempt<50;attempt++) {
      state=await (await fetch(base+"/manual/state")).json(); if(state.phase==="pending") break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(state.phase).toBe("pending"); expect(replied).toBe(false);
    expect((await post("/manual/finished")).status).toBe(409); expect(callbacks).toEqual([]);
    expect((await post("/manual/accept")).status).toBe(200);
    expect(await (await dispatch).json()).toEqual({code:1,data:"received",success:true});
    await new Promise(resolve=>setTimeout(resolve,100));
    expect(callbacks).toEqual([]);
    expect((await post("/manual/finished")).status).toBe(200);
    expect(callbacks).toEqual([{path:"/api/task/finished",body:'{"result":"success"}'}]);
    state=await (await fetch(base+"/manual/state")).json();
    expect(state.phase).toBe("idle"); expect(state.records[0].request.body).toBe(JSON.stringify(raw));
    expect(state.records[0].response.status).toBe(200);
    expect(state.records[0].response.headers["Cache-Control"]).toBe("no-store");
    expect(state.records[1].request.headersScope).toContain("显式");
    expect(state.records[1].request.url).toBe(callback+"/api/task/finished");
    expect(state.records[1].response.body).toBe('{"code":1,"data":"OK","success":true}');
    const second = post("/api/task/dispatch",raw);
    for (let attempt=0;attempt<50;attempt++) {
      if((await (await fetch(base+"/manual/state")).json()).phase==="pending") break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await post("/manual/reject"); expect((await (await second).json()).success).toBe(false);
    expect(callbacks).toHaveLength(1);
  } finally { await robot.close(); await new Promise<void>(resolve=>gateway.close(()=>resolve())); }
});
