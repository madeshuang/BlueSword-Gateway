async function selectOnly(page,name){const remove=page.locator('.order-line button[aria-label^="移除"]');while(await remove.count())await remove.first().click();await page.getByRole('button',{name:'选择'+name,exact:true}).click();}
// Real local API + SQLite + browser, with controlled HTTP AI/robot peers only.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-experience-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<100;i++){if(await check())return;await pause(50);}throw new Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.logs='';p.stdout.on('data',d=>p.logs+=d);p.stderr.on('data',d=>p.logs+=d);return p;}
async function ready(url,process){await until(async()=>{if(process.exitCode!==null)throw new Error(process.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
  let browser,peer,releaseReceipt,robotCalls=0,modelCalls=0;const errors=[],passed=[];
  try{
    peer=createServer(async(req,res)=>{
      let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
      res.writeHead(200,{'Content-Type':'application/json'});
      if(req.url==='/responses'){
        modelCalls++;assert.equal(body.tools,undefined);
        return res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'不可采用的模型猜测：已完成',selection:[{productId:'water',count:1}],taskStatusQuery:true})}]}]}));
      }
      assert.equal(req.url,'/api/task/dispatch');assert.deepEqual(Object.keys(body).sort(),['items']);robotCalls++;
      if(robotCalls===1)await new Promise(r=>releaseReceipt=r);
      res.end(JSON.stringify({success:true,data:'received'}));
    });await new Promise(r=>peer.listen(0,'127.0.0.1',r));
    const upstream='http://127.0.0.1:'+peer.address().port,apiUrl='http://127.0.0.1:'+await port(),webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
    const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:apiUrl.split(':').at(-1),BOOTH_CATALOG_PATH:join(root,'scripts/fixtures/booth-catalog.json'),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_BASE_URL:upstream,OPENAI_API_KEY:'controlled-fixture',DEEPSEEK_API_KEY:'',BOOTH_OPERATOR_TOKEN:'test-staff',BOOTH_TASK_REMINDER_MS:'120000'});
    await ready(apiUrl+'/api/health',api);
    const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const experience=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('bluesword.booth.experience')||'null'));
    async function visit(page){page.on('pageerror',e=>errors.push(e.message));await page.goto(webUrl);await page.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();await until(async()=>!!await experience(page));}
    async function ask(page,expected){const input=page.getByRole('textbox',{name:'告诉助手你的需求'});const replies=page.locator('.chat-bubble.assistant');const n=await replies.count();await input.fill('我的东西取好了吗？');await input.press('Enter');await until(async()=>await replies.count()===n+1);const text=await replies.last().innerText();assert(text.includes(expected),text);assert(!text.includes('模型猜测'));return text;}
    async function callback(path,body){const res=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(res.status,200);}
    const a=await context.newPage();await visit(a);const original=await experience(a);
    await selectOnly(a,'矿泉水');await a.getByRole('button',{name:'确认取物',exact:true}).click();await a.locator('.task-panel.submitting').waitFor();
    await ask(a,'等待机器人回复是否接单');await a.reload();await until(async()=>!!await experience(a));assert.deepEqual(await experience(a),original);await ask(a,'等待机器人回复是否接单');
    releaseReceipt();await a.locator('.task-panel.executing').waitFor();await ask(a,'机器人已接单，尚未收到完成通知');assert.equal(robotCalls,1);passed.push('等待受理期间刷新恢复关联且不重复发送');
    await callback('/api/task/finished',{});await a.locator('.task-panel.succeeded').waitFor();await ask(a,'取物完成通知');passed.push('任务完成后仍可查询');
    const b=await context.newPage();await visit(b);assert.notEqual((await experience(b)).token,original.token);await ask(b,'暂时无法确认');
    await selectOnly(b,'纪念品');await b.getByRole('button',{name:'确认取物',exact:true}).click();await b.locator('.task-panel.executing').waitFor();
    await ask(b,'纪念品 × 1');await ask(a,'矿泉水 × 1');passed.push('两个标签各自只查询自己的任务');
    // window.open copies the opener's sessionStorage; the lifetime lock must split it.
    const popupReady=a.waitForEvent('popup');await a.evaluate(url=>window.open(url,'_blank'),webUrl);const duplicate=await popupReady;
    duplicate.on('pageerror',e=>errors.push(e.message));await until(async()=>{const v=await experience(duplicate);return !!v&&v.token!==original.token;});
    await ask(duplicate,'暂时无法确认');passed.push('继承sessionStorage的新标签不认领原任务');
    const separate=await browser.newContext({viewport:{width:390,height:844}}),other=await separate.newPage();await visit(other);await ask(other,'暂时无法确认');passed.push('独立浏览器上下文不认领共享任务');
    await callback('/api/task/error',{message:'测试故障'});await b.locator('.task-panel.fault').waitFor();const fault=await ask(b,'出现异常');assert(fault.includes('尚未确认机器人是否停止'));
    const resolved=await fetch(apiUrl+'/api/booth/operator/resolve',{method:'POST',headers:{'Content-Type':'application/json','X-Operator-Token':'test-staff'},body:JSON.stringify({confirmation:'已核对机器人停止'})});assert.equal(resolved.status,200);await ask(b,'这不代表取物完成');passed.push('异常与人工解除不冒充完成');
    await a.getByRole('button',{name:'开始新体验',exact:true}).click();await until(async()=>{const v=await experience(a);return !!v&&v.token!==original.token;});await ask(a,'暂时无法确认');await a.reload();await ask(a,'暂时无法确认');passed.push('开始新体验后及刷新后保持隔离');
    await ask(other,'暂时无法确认');
    await a.screenshot({path:join(output,'desktop-new-experience.png'),fullPage:true});await b.screenshot({path:join(output,'desktop-resolved.png'),fullPage:true});await other.screenshot({path:join(output,'narrow-unassociated.png'),fullPage:true});
    // Reproduce a copied tab whose source closes before the copied document initializes.
    const inherited=await experience(b);await b.close();const lateCopy=await context.newPage();
    await lateCopy.addInitScript(value=>sessionStorage.setItem('bluesword.booth.experience',JSON.stringify(value)),inherited);
    await visit(lateCopy);assert.notEqual((await experience(lateCopy)).token,inherited.token,'原页已关闭也不能让新标签继承任务');await ask(lateCopy,'暂时无法确认');passed.push('复制标签在原页关闭后初始化也保持隔离');
    // Saving a credential must succeed before any task can be dispatched.
    const fail=await browser.newContext(),blocked=await fail.newPage();blocked.on('pageerror',e=>errors.push(e.message));
    await blocked.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='bluesword.booth.experience')throw new DOMException('Injected','QuotaExceededError');return set.call(this,k,v);};});
    await blocked.goto(webUrl);await selectOnly(blocked,'矿泉水');await blocked.getByRole('button',{name:'确认取物',exact:true}).click();await blocked.getByRole('alert').filter({hasText:'无法保存本页体验信息'}).first().waitFor();assert.equal(robotCalls,2);await ask(blocked,'暂时无法确认');passed.push('体验存储失败不发单且查询明确无法确认');
    assert.deepEqual(errors,[]);assert.equal(robotCalls,2);
    writeFileSync(join(output,'report.json'),JSON.stringify({passed,robotCalls,controlledModelCalls:modelCalls,realAiCalls:0,realRobotCalls:0},null,2));console.log(JSON.stringify({output,passed,realAiCalls:0,realRobotCalls:0}));
  }finally{
    releaseReceipt?.();
    await browser?.close();for(const p of children){if(p.exitCode===null){const done=once(p,'exit');p.kill();await done;}}
    if(peer)await new Promise(r=>peer.close(r));
  }
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
