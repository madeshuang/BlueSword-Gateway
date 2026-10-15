import {it,expect} from "vitest";
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,symlinkSync,rmSync,existsSync,cpSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {spawnSync,spawn} from "node:child_process";
import {createServer} from "node:net";

it("一键启动检查以配置文件选择AI，拒绝缺少密钥及被占用的端口",async()=>{
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
    expect(result.status).toBe(1);expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain("inherited-must-not-win");
    writeFileSync(join(root,".env"),"BOOTH_AI_PROVIDER=deepseek\nDEEPSEEK_API_KEY=test-only\n");
    await new Promise<void>((ok,fail)=>{blocker.once("error",fail);blocker.listen(4101,"127.0.0.1",ok);});
    result=run();expect(result.status).toBe(1);expect(result.stderr).toContain("4101");
    expect(blocker.listening).toBe(true);
    await new Promise<void>(ok=>blocker.close(()=>ok()));
    result=run();expect(result.status).toBe(0);expect(result.stdout).toContain("deepseek");
    expect(result.stdout).not.toContain("test-only");
    writeFileSync(join(root,".env.relay"),"BOOTH_AI_PROVIDER=deepseek\nOPENAI_BASE_URL=https://relay.example/v1\nOPENAI_MODEL=relay-model\nOPENAI_API_KEY=relay-test-only\n");
    const relay=spawnSync(process.execPath,[join(root,"scripts/start-local.cjs"),"--relay","--check"],{encoding:"utf8",timeout:15000});
    expect(relay.status).toBe(0);expect(relay.stdout).toContain("openai");
    expect(relay.stdout).toContain(".env.relay");expect(relay.stdout).not.toContain("relay-test-only");
    writeFileSync(join(root,".env.relay"),"OPENAI_API_KEY=relay-test-only\n");
    const invalid=spawnSync(process.execPath,[join(root,"scripts/start-local.cjs"),"--relay","--check"],{encoding:"utf8",timeout:15000});
    expect(invalid.status).toBe(1);expect(invalid.stderr).toContain("OPENAI_BASE_URL");
  } finally {
    if(blocker.listening)await new Promise<void>(ok=>blocker.close(()=>ok()));
    rmSync(root,{recursive:true,force:true});
  }
});

it("一键入口隔离练习数据库，真实HTTP受理后等待完成，q退出释放两个服务",async()=>{
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
    writeFileSync(join(root,".env"),"BOOTH_AI_PROVIDER=deepseek\nDEEPSEEK_API_KEY=test-not-used\nBOOTH_MANUAL_DB_PATH=must-not-open.sqlite\n");
    child=spawn(process.execPath,[join(root,"scripts/start-local.cjs"),"--deepseek","--no-browser"],{stdio:["pipe","pipe","pipe"]});
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
    const dispatch=post(gateway,"/api/booth/requests",{productId:"water",count:1,requestId:"launcher-test-001"});
    for(let n=0;n<100;n++){
      if((await(await fetch(robot+"/manual/state")).json()).phase==="pending")break;
      await new Promise(ok=>setTimeout(ok,20));
    }
    expect((await post(robot,"/manual/accept")).status).toBe(200);
    expect((await(await dispatch).json()).task.status).toBe("executing");
    expect((await(await fetch(gateway+"/api/booth")).json()).active.status).toBe("executing");
    expect((await post(robot,"/manual/finished")).status).toBe(200);
    const state=await(await fetch(gateway+"/api/booth")).json();
    expect(state.tasks[0].status).toBe("succeeded");
    child.stdin!.write("q\n");expect(await exited).toBe(0);
    await expect(fetch(gateway+"/api/health")).rejects.toThrow();
    await expect(fetch(robot+"/manual/state")).rejects.toThrow();
  } finally {
    if(child && child.exitCode===null){child.kill();await new Promise(ok=>child!.once("exit",ok));}
    rmSync(root,{recursive:true,force:true});
  }
},45000);
