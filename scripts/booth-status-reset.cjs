// Public browser/HTTP boundaries, real local gateway and SQLite, controlled robot peer.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-status-reset-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<150;i++){if(await check())return;await pause(50);}throw new Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.logs='';p.stdout.on('data',d=>p.logs+=d);p.stderr.on('data',d=>p.logs+=d);return p;}
async function ready(url,process){await until(async()=>{if(process.exitCode!==null)throw new Error(process.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
  let browser,robot;let robotCalls=0;const errors=[],passed=[];
  try{
    robot=createServer(async(req,res)=>{
      let text='';for await(const c of req)text+=c;
      assert.equal(req.url,'/api/task/dispatch');assert.deepEqual(Object.keys(JSON.parse(text)).sort(),['items']);robotCalls++;
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data:'received'}));
    });await new Promise(r=>robot.listen(0,'127.0.0.1',r));
    const upstream='http://127.0.0.1:'+robot.address().port,apiUrl='http://127.0.0.1:'+await port(),webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
    const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:apiUrl.split(':').at(-1),BOOTH_CATALOG_PATH:join(root,'scripts/fixtures/booth-catalog.json'),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_API_KEY:'',DEEPSEEK_API_KEY:'',BOOTH_TASK_REMINDER_MS:'120000'});
    await ready(apiUrl+'/api/health',api);
    const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const clockTime=new Date('2026-10-15T00:00:00+08:00');await page.clock.install({time:clockTime});await page.clock.pauseAt(clockTime);
    await page.goto(webUrl);await page.locator('.task-panel.idle').waitFor();
    async function submit(name){await page.getByRole('button',{name:'选择'+name,exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();}
    async function callback(path,body){const response=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);}
    await submit('矿泉水');await callback('/api/task/finished',{result:'success'});await page.locator('.task-panel.succeeded').waitFor();
    const completedSnapshot=await (await fetch(apiUrl+'/api/booth')).json();
    await page.clock.runFor(9000);assert.equal(await page.locator('.task-panel.succeeded').count(),1,'九秒时仍显示完成');
    await page.clock.runFor(1000);await page.locator('.task-panel.idle').waitFor({timeout:2000});
    await page.locator('.task-panel').getByText('等待你的选择',{exact:true}).waitFor();
    passed.push('完成状态保留十秒后恢复等待选择');
    assert.equal(await page.locator('.chat-bubble.assistant').getByText('物品已经取好，可以到交付处领取了。',{exact:true}).count(),1,'顶部复位保留完成回复');
    const idleSnapshot=await (await fetch(apiUrl+'/api/booth')).json();assert.deepEqual(idleSnapshot.tasks,completedSnapshot.tasks,'顶部复位保留任务记录');assert.equal(idleSnapshot.active,null);
    await page.getByRole('region',{name:'取物确认',exact:true}).getByRole('heading',{name:'请选择物品',exact:true}).waitFor();
    assert.equal(await page.locator('.order-panel .primary-button').count(),0,'完成后需要重新选择物品');
    await page.screenshot({path:join(output,'desktop-idle-after-completion.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'narrow-idle-after-completion.png'),fullPage:true});await page.setViewportSize({width:1440,height:900});
    passed.push('顶部复位保留聊天完成回复及后台任务记录');
    await submit('小面包');await callback('/api/task/finished',{});await page.locator('.task-panel.succeeded').waitFor();
    await page.clock.runFor(5000);await submit('纪念品');await page.clock.runFor(5000);
    assert.equal(await page.locator('.task-panel.executing').count(),1,'上一单计时到期不能清除新任务');
    await page.locator('.task-panel').getByRole('heading',{name:'纪念品 × 1',exact:true}).waitFor();
    await callback('/api/task/finished',{});await page.locator('.task-panel.succeeded').waitFor();
    await page.clock.runFor(5000);await callback('/api/task/error',{message:'受控测试：全局告警'});await page.locator('.task-panel.alert').waitFor();
    await page.clock.runFor(5000);assert.equal(await page.locator('.task-panel.alert').count(),1,'完成展示计时到期不能清除异常');
    await page.locator('.task-panel').getByText('请联系现场工作人员',{exact:true}).waitFor();
    passed.push('旧计时器不覆盖新任务或异常');
    assert.deepEqual(errors,[]);
    writeFileSync(join(output,'report.json'),JSON.stringify({passed,robotCalls,realAiCalls:0,realRobotCalls:0},null,2));console.log(JSON.stringify({output,passed,realAiCalls:0,realRobotCalls:0}));
  }finally{
    await browser?.close();for(const p of children){if(p.exitCode===null){const done=once(p,'exit');p.kill();await done;}}
    if(robot)await new Promise(r=>robot.close(r));
  }
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
