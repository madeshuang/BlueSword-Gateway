import {it,expect} from "vitest";
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {spawnSync,spawn} from "node:child_process";
import {createServer} from "node:net";
import {createServer as createHttpServer} from "node:http";

it("一键启动以.env选择AI，允许空密钥并拒绝已被占用的端口",async()=>{
  const root=mkdtempSync(join(tmpdir(),"booth-launch-"));
  const blocker=createServer();
  try {
    mkdirSync(join(root,"scripts"));
    copyFileSync(resolve("scripts/start-local.cjs"),join(root,"scripts/start-local.cjs"));
    symlinkSync(resolve("node_modules"),join(root,"node_modules"),"junction");
    mkdirSync(join(root,"apps/web"),{recursive:true});
    symlinkSync(resolve("apps/web/node_modules"),join(root,"apps/web/node_modules"),"junction");
    const run=()=>spawnSync(process.execPath,[join(root,"scripts/start-local.cjs"),"--check"],{
      encoding:"utf8",env:{...process.env,BOOTH_AI_PROVIDER:"openai",OPENAI_API_KEY:"inherited-must-not-win"},timeout:15000,
    });
    writeFileSync(join(root,".env"),"BOOTH_AI_PROVIDER=openai\nDEEPSEEK_API_KEY=test-only\n");
    let result=run();
    expect(result.status).toBe(0);expect(result.stdout).toContain("openai");
    expect(result.stdout+result.stderr).not.toMatch(/密钥已配置|inherited-must-not-win|test-only/);
    writeFileSync(join(root,".env"),"BOOTH_AI_PROVIDER=deepseek\nDEEPSEEK_API_KEY=test-only\n");
    await new Promise<void>((ok,fail)=>{blocker.once("error",fail);blocker.listen(4101,"127.0.0.1",ok);});
    result=run();expect(result.status).toBe(1);expect(result.stderr).toContain("4101");
    expect(blocker.listening).toBe(true);
    await new Promise<void>(ok=>blocker.close(()=>ok()));
    result=run();expect(result.status).toBe(0);expect(result.stdout).toContain("deepseek");
    expect(result.stdout).not.toContain("test-only");
    writeFileSync(join(root,".env.relay"),"BOOTH_AI_PROVIDER=openai\nOPENAI_API_KEY=relay-test-only\n");
    result=run();
    expect(result.status).toBe(0);expect(result.stdout).toContain("deepseek");
    expect(result.stdout+result.stderr).not.toMatch(/\.env\.relay|relay-test-only|test-only|inherited-must-not-win/);
  } finally {
    if(blocker.listening)await new Promise<void>(ok=>blocker.close(()=>ok()));
    rmSync(root,{recursive:true,force:true});
  }
});

it.each([false,true])("一键入口隔离练习数据库，按配置加载练习清单（指定清单：%s），接单后等待完成并正常退出",async(customCatalog)=>{
  const root=mkdtempSync(join(tmpdir(),"booth-launch-http-"));
  let child:ReturnType<typeof spawn>|undefined;
  try {
    mkdirSync(join(root,"scripts"));
    for(const file of ["start-local.cjs","robot-manual.ts","robot-manual.html"])copyFileSync(resolve("scripts",file),join(root,"scripts",file));
    for(const directory of ["node_modules","packages","config"])symlinkSync(resolve(directory),join(root,directory),"junction");
    cpSync(resolve("apps"),join(root,"apps"),{recursive:true,filter:source=>!/[\\/](node_modules|dist)([\\/]|$)/.test(source)});
    for(const app of ["api","web"])if(existsSync(resolve("apps",app,"node_modules")))symlinkSync(resolve("apps",app,"node_modules"),join(root,"apps",app,"node_modules"),"junction");
    copyFileSync(resolve("tsconfig.json"),join(root,"tsconfig.json"));
    copyFileSync(resolve("scripts/package.json"),join(root,"scripts/package.json"));
    if(customCatalog){
      const products=JSON.parse(readFileSync(resolve("config/booth-catalog.example.json"),"utf8"));
      products[1].name="练习用扑克牌";
      writeFileSync(join(root,"practice-catalog.json"),JSON.stringify(products));
    }
    const settings="BOOTH_AI_PROVIDER=deepseek\nDEEPSEEK_API_KEY=\nPORT=1\nBOOTH_HOST=192.0.2.1\nROBOT_DISPATCH_URL=http://127.0.0.1:1/forbidden\nBOOTH_DB_PATH=must-not-open.sqlite\nBOOTH_MANUAL_DB_PATH=must-not-open.sqlite\nBOOTH_CATALOG_PATH=must-not-load.json\n"+(customCatalog?"BOOTH_MANUAL_CATALOG_PATH=practice-catalog.json\n":"");
    writeFileSync(join(root,".env"),settings);
    child=spawn(process.execPath,[join(root,"scripts/start-local.cjs"),"--no-browser"],{stdio:["pipe","pipe","pipe"]});
    const exited=new Promise<number|null>(ok=>child!.once("exit",ok));
    let output="";
    child.stderr!.on("data",chunk=>{output+=chunk.toString();});
    await new Promise<void>((ok,fail)=>{
      const timer=setTimeout(()=>fail(Error("启动超时")),30000);
      child!.stdout!.on("data",chunk=>{output+=chunk.toString();if(output.includes("启动成功。主页面")){clearTimeout(timer);ok();}});
      child!.once("exit",()=>{clearTimeout(timer);fail(Error("启动提前退出："+output));});
    });
    expect(existsSync(join(root,"must-not-open.sqlite"))).toBe(false);
    expect(existsSync(join(root,".data/booth-manual.sqlite"))).toBe(true);
    const post=(base:string,path:string,body:unknown={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const gateway="http://127.0.0.1:4101",robot="http://127.0.0.1:4201";
    expect(await(await fetch(gateway)).text()).toContain('<div id="root">');
    const initial=await(await fetch(gateway+"/api/booth")).json();
    expect(initial.ai).toMatchObject({provider:"DeepSeek",configured:false});
    expect(initial.products.map((p:{id:string})=>p.id)).toEqual(["lighter_box","playing_card_box","pen_box","bottle","table_tennis_ball_box","shuttlecock_tube","air_pump","aoliao","anmuxi","haoliyou","shupian"]);
    expect(initial.products[1].name).toBe(customCatalog?"练习用扑克牌":"兰剑智能扑克牌");
    const items=[{productId:"playing_card_box",count:1},{productId:"pen_box",count:1}];
    const dispatch=post(gateway,"/api/booth/requests",{items,requestId:"launcher-test-001"});
    for(let n=0;n<100;n++){
      if((await(await fetch(robot+"/manual/state")).json()).phase==="pending")break;
      await new Promise(ok=>setTimeout(ok,20));
    }
    const manualState=await(await fetch(robot+"/manual/state")).json();
    expect(manualState.item).toEqual({items:[{location:"待配置",item:"pen_box",count:1},{location:"待配置",item:"playing_card_box",count:1}]});
    expect((await post(robot,"/manual/accept",{taskId:manualState.taskId})).status).toBe(200);
    expect((await(await dispatch).json()).task.status).toBe("executing");
    expect((await(await fetch(gateway+"/api/booth")).json()).active.status).toBe("executing");
    expect((await post(robot,"/manual/finished",{taskId:manualState.taskId})).status).toBe(200);
    const state=await(await fetch(gateway+"/api/booth")).json();
    expect(state.tasks[0].status).toBe("succeeded");
    child.stdin!.write("q\n");expect(await exited).toBe(0);
    expect(readFileSync(join(root,".env"),"utf8")).toBe(settings);
    await expect(fetch(gateway+"/api/health")).rejects.toThrow();
    await expect(fetch(robot+"/manual/state")).rejects.toThrow();
  } finally {
    if(child && child.exitCode===null){child.kill();await new Promise(ok=>child!.once("exit",ok));}
    rmSync(root,{recursive:true,force:true});
  }
},45000);

it("正式一键入口使用.env的端口、机器人地址和数据库，未配置AI仍可完成手选任务并退出",async()=>{
  const root=mkdtempSync(join(tmpdir(),"booth-gateway-"));
  let child:ReturnType<typeof spawn>|undefined;
  const received:unknown[]=[];
  const robot=createHttpServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    received.push({path:req.url,body:JSON.parse(raw)});
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({code:1,data:"received",success:true}));
  });
  const reservation=createServer();
  try {
    await new Promise<void>(ok=>robot.listen(0,"127.0.0.1",ok));
    await new Promise<void>(ok=>reservation.listen(0,"127.0.0.1",ok));
    const port=(reservation.address() as {port:number}).port;
    await new Promise<void>(ok=>reservation.close(()=>ok()));
    mkdirSync(join(root,"scripts"));
    copyFileSync(resolve("scripts/start-local.cjs"),join(root,"scripts/start-local.cjs"));
    for(const directory of ["node_modules","packages","config"])symlinkSync(resolve(directory),join(root,directory),"junction");
    cpSync(resolve("apps"),join(root,"apps"),{recursive:true,filter:source=>!/[\\/](node_modules|dist)([\\/]|$)/.test(source)});
    for(const app of ["api","web"])if(existsSync(resolve("apps",app,"node_modules")))symlinkSync(resolve("apps",app,"node_modules"),join(root,"apps",app,"node_modules"),"junction");
    copyFileSync(resolve("tsconfig.json"),join(root,"tsconfig.json"));
    copyFileSync(resolve("scripts/package.json"),join(root,"scripts/package.json"));
    const base="http://127.0.0.1:"+port;
    const robotBase="http://127.0.0.1:"+(robot.address() as {port:number}).port;
    writeFileSync(join(root,".env"),[
      "PORT="+port,"BOOTH_HOST=127.0.0.1","BOOTH_ROBOT_MODE=http","BOOTH_AI_PROVIDER=openai","OPENAI_API_KEY=",
      "ROBOT_DISPATCH_URL="+robotBase+"/api/task/dispatch","BOOTH_CATALOG_CONFIRMED=true","BOOTH_DB_PATH=.data/gateway-test.sqlite",
    ].join("\n"));
    writeFileSync(join(root,".env.relay"),"BOOTH_AI_PROVIDER=deepseek\nDEEPSEEK_API_KEY=must-not-load\n");
    child=spawn(process.execPath,[join(root,"scripts/start-local.cjs"),"--gateway","--no-browser"],{
      stdio:["pipe","pipe","pipe"],env:{...process.env,PORT:"1",OPENAI_API_KEY:"must-not-inherit",ROBOT_DISPATCH_URL:"http://127.0.0.1:1/forbidden"},
    });
    const exited=new Promise<number|null>(ok=>child!.once("exit",ok));
    let output="";
    await new Promise<void>((ok,fail)=>{
      const timer=setTimeout(()=>fail(Error("正式网关启动超时："+output)),30000);
      child!.stdout!.on("data",chunk=>{output+=chunk.toString();if(output.includes("启动成功。主页面")){clearTimeout(timer);ok();}});
      child!.stderr!.on("data",chunk=>{output+=chunk.toString();});
      child!.once("exit",()=>{clearTimeout(timer);fail(Error("正式网关提前退出："+output));});
    });
    expect(await(await fetch(base+"/api/health")).json()).toMatchObject({ok:true,mode:"http"});
    expect(await(await fetch(base)).text()).toContain('<div id="root">');
    const state=await(await fetch(base+"/api/booth")).json();
    expect(state.ai).toMatchObject({provider:"OpenAI",configured:false});
    expect(existsSync(join(root,".data/gateway-test.sqlite"))).toBe(true);
    expect(existsSync(join(root,".data/booth-manual.sqlite"))).toBe(false);
    const post=(route:string,body:unknown)=>fetch(base+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    expect(state.products).toHaveLength(11);
    const dispatched=await post("/api/booth/requests",{productId:"playing_card_box",count:1,requestId:"gateway-launch-001"});
    expect((await dispatched.json()).task.status).toBe("executing");
    expect(received).toEqual([{path:"/api/task/dispatch",body:{items:[{location:"待配置",item:"playing_card_box",count:1}]}}]);
    expect((await post("/api/task/finished",{result:"success"})).status).toBe(200);
    expect((await(await fetch(base+"/api/booth")).json()).tasks[0].status).toBe("succeeded");
    child.stdin!.write("q\n");expect(await exited).toBe(0);
    await expect(fetch(base+"/api/health")).rejects.toThrow();
    expect(output).not.toMatch(/must-not-load|must-not-inherit|人工机器人工具/);
  } finally {
    if(child && child.exitCode===null){child.kill();await new Promise(ok=>child!.once("exit",ok));}
    robot.closeAllConnections();await new Promise<void>(ok=>robot.close(()=>ok()));
    if(reservation.listening)await new Promise<void>(ok=>reservation.close(()=>ok()));
    rmSync(root,{recursive:true,force:true});
  }
},45000);
