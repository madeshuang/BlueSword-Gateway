async function selectOnly(page,name){const remove=page.locator('.order-line button[aria-label^="移除"]');while(await remove.count())await remove.first().click();await page.getByRole('button',{name:'选择'+name,exact:true}).click();}
// Browser and public HTTP boundaries; AI and robot peers are controlled local services.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const adviceReply='当前可选矿泉水等物品，请选择你需要的物品和数量。'.repeat(12);
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-thinking-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<400;i++){if(await check())return;await pause(50);}throw new Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.logs='';p.stdout.on('data',d=>p.logs+=d);p.stderr.on('data',d=>p.logs+=d);return p;}
async function ready(url,process){await until(async()=>{if(process.exitCode!==null)throw new Error(process.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
  let browser,peer,releaseModel,releaseReceipt,heldSnapshot,modelFailure=null;const passed=[],errors=[];let robotCalls=0;const modelRequests=[],controlledStreams=new Set();
  try{
    peer=createServer(async(req,res)=>{
      if(req.method==='GET'&&req.url==='/events'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});
        controlledStreams.add(res);res.write('data: '+JSON.stringify(heldSnapshot)+'\n\n');res.on('close',()=>controlledStreams.delete(res));return;
      }
      let text='';for await(const c of req)text+=c;const body=JSON.parse(text);
      if(req.url==='/responses'){
        modelRequests.push(body);await new Promise(r=>releaseModel=r);
        if(modelFailure==='connection'){res.destroy();return;}
        res.writeHead(typeof modelFailure==='number'?modelFailure:200,{'Content-Type':'application/json'});
        if(modelFailure)return res.end(JSON.stringify({error:'controlled failure'}));
        return res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:adviceReply,selection:null,taskStatusQuery:false})}]}]}));
      }
      res.writeHead(200,{'Content-Type':'application/json'});
      assert.equal(req.url,'/api/task/dispatch');assert.deepEqual(Object.keys(body).sort(),['items']);robotCalls++;
      await new Promise(r=>releaseReceipt=r);res.end(JSON.stringify({success:true,data:'received'}));
    });await new Promise(r=>peer.listen(0,'127.0.0.1',r));
    const upstream='http://127.0.0.1:'+peer.address().port,apiUrl='http://127.0.0.1:'+await port(),webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
    const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:apiUrl.split(':').at(-1),BOOTH_CATALOG_PATH:join(root,'scripts/fixtures/booth-catalog.json'),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_BASE_URL:upstream,OPENAI_API_KEY:'controlled-fixture',DEEPSEEK_API_KEY:'',BOOTH_OPERATOR_TOKEN:'test-staff',BOOTH_TASK_REMINDER_MS:'120000'});
    await ready(apiUrl+'/api/health',api);
    const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(webUrl);const input=page.getByRole('textbox',{name:'告诉助手你的需求'});await input.waitFor();
    await input.fill('这里有什么？');await input.press('Enter');await until(()=>!!releaseModel);
    const thought=page.getByRole('group',{name:'思考过程'}).first();await thought.waitFor({timeout:2000});
    const toggle=thought.locator('summary');assert.match(await toggle.innerText(),/思考中/);
    const body=thought.locator('.thinking-copy');await until(async()=>(await body.innerText()).length>0);
    const first=await body.innerText();await until(async()=>(await body.innerText()).length>first.length);
    await toggle.click();assert.equal(await body.isVisible(),false,'可折叠隐藏正文');
    await toggle.click();assert.equal(await body.isVisible(),true,'可重新展开');
    releaseModel();releaseModel=null;
    await page.locator('.chat-bubble.assistant').getByText(adviceReply,{exact:true}).waitFor();
    assert.match(await toggle.innerText(),/思考已结束/);assert.equal(await body.isVisible(),false,'回复就绪后收起说明');
    const finishedLabel=await thought.getByText('思考已结束',{exact:true}).boundingBox(),finishedArrow=await toggle.locator('svg').last().boundingBox();
    assert(finishedArrow.x<=finishedLabel.x+finishedLabel.width+24,'折叠箭头紧邻结束文字，不能放在远处');
    await toggle.click();assert.equal(await body.isVisible(),true,'结束后也可通过箭头所在标题展开');await toggle.click();
    assert.equal(robotCalls,0,'普通聊天不发单');passed.push('每轮聊天逐字展示、手动折叠和回复后结束');
    modelFailure=429;await input.fill('请再介绍一下物品');await input.press('Enter');await until(()=>!!releaseModel);
    releaseModel();releaseModel=null;
    await until(()=>page.getByRole('button',{name:'发送需求'}).getAttribute('aria-busy').then(value=>value==='false'));
    const failedThought=page.getByRole('group',{name:'思考过程'}).last();
    assert.match(await failedThought.locator('summary').innerText(),/思考已结束/,'模型失败也使用统一结束标题');
    assert.equal(await failedThought.locator('summary').evaluate(el=>getComputedStyle(el).color),await thought.locator('summary').evaluate(el=>getComputedStyle(el).color),'结束标题不再按成功或失败区分颜色');
    await page.locator('.chat-bubble.assistant').getByText('助手暂时繁忙，请稍后再试，也可以直接选择物品。',{exact:true}).waitFor();
    assert.equal(await input.inputValue(),'请再介绍一下物品','失败后保留可重试的草稿');
    modelFailure=null;await input.fill('现在再介绍一次');await input.press('Enter');await until(()=>!!releaseModel);
    releaseModel();releaseModel=null;await until(()=>page.getByRole('button',{name:'发送需求'}).getAttribute('aria-busy').then(value=>value==='false'));
    assert.equal(await page.locator('.chat-bubble.assistant').getByText('助手暂时繁忙，请稍后再试，也可以直接选择物品。',{exact:true}).count(),1,'新一轮回复不会清掉上次失败提示');
    passed.push('模型失败统一结束，提示保留在对应对话，后续重试仍保留记录');
    for(const [failure,notice] of [
      ['connection','暂时连不上助手，请稍后再试，也可以直接选择物品。'],
      [504,'暂时连不上助手，请稍后再试，也可以直接选择物品。'],
      ['invalid','这次没能正常回复，可以再试一次，或直接选择物品。'],
    ]){
      modelFailure=failure;await input.fill('继续介绍物品');await input.press('Enter');await until(()=>!!releaseModel);
      releaseModel();releaseModel=null;await until(()=>page.getByRole('button',{name:'发送需求'}).getAttribute('aria-busy').then(value=>value==='false'));
      assert.match(await page.getByRole('group',{name:'思考过程'}).last().locator('summary').innerText(),/思考已结束/);
      await page.locator('.chat-bubble.assistant').last().getByText(notice,{exact:true}).waitFor();
      assert.equal(await page.getByRole('group',{name:'思考过程'}).last().locator('.thinking-copy').isVisible(),false);
    }
    modelFailure=null;
    await page.route('**/api/booth/chat',route=>route.abort(),{times:1});
    await input.fill('连接中断时的提问');await input.press('Enter');
    await page.locator('.chat-bubble.assistant').last().getByText('暂时连不上助手，请稍后再试，也可以直接选择物品。',{exact:true}).waitFor();
    assert.equal(await input.inputValue(),'连接中断时的提问');await input.fill('');
    assert.equal(robotCalls,0,'所有模型失败和重试均不发取物请求');
    await page.screenshot({path:join(output,'model-failure-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'model-failure-narrow.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:900});
    passed.push('模型连接失败、超时、无效回复及页面连接中断均在对话中提示');
    const chatCallsBeforeTasks=modelRequests.length;
    await page.emulateMedia({reducedMotion:'reduce'});
    await selectOnly(page,'矿泉水');
    await page.getByRole('button',{name:'确认取物',exact:true}).click();await until(()=>!!releaseReceipt);
    const taskThought=page.getByRole('group',{name:'思考过程'}).last();
    await taskThought.waitFor({timeout:2000});assert.match(await taskThought.locator('summary').innerText(),/思考中/);
    const log=page.getByRole('log',{name:'访客对话'});
    await until(()=>log.evaluate(el=>el.scrollHeight>el.clientHeight));
    await log.focus();await page.keyboard.press('Home');await until(()=>log.evaluate(el=>el.scrollTop<2));
    releaseReceipt();releaseReceipt=null;await page.locator('.task-panel.executing').waitFor();
    await page.evaluate(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok))));
    assert.equal(await log.evaluate(el=>el.scrollTop<2),true,'主动向上阅读时，接单和思考内容更新不能强制跳到底部');
    await log.focus();await page.keyboard.press('End');await until(()=>log.evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2));
    const taskCopy=taskThought.locator('.thinking-copy');await until(async()=>(await taskCopy.innerText()).length>0);
    const taskFirst=await taskCopy.innerText();await until(async()=>(await taskCopy.innerText()).length>taskFirst.length);
    await log.hover();await page.mouse.wheel(0,-600);
    await until(()=>log.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>100));
    const readingCopy=await taskCopy.innerText();await until(async()=>(await taskCopy.innerText()).length>readingCopy.length+25);
    assert.equal(await log.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>100),true,'滚轮向上阅读后，逐字更新不能拉回底部');
    await log.focus();await page.keyboard.press('End');
    await until(()=>log.evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2));
    assert(!(await taskThought.locator('summary').innerText()).includes('取物流程'),'去掉不必要的流程标题');
    await until(async()=>(await taskThought.innerText()).includes('收到完成结果后，再告诉你可以领取。'));
    const plan=await taskThought.innerText();assert.match(plan,/出发/);assert.match(plan,/抓取/);assert.match(plan,/返回/);
    assert.match(plan,/导航反馈/,'以模拟细粒度反馈的口吻展示导航');assert.match(plan,/停靠|定位/);assert.match(plan,/夹持/);
    assert.match(await taskThought.locator('summary').innerText(),/思考中/,'接单后继续显示思考中');
    assert.equal(await page.locator('.chat-bubble.assistant').filter({hasText:'物品已经取好'}).count(),0,'仅接单不播报完成');
    assert.equal(await page.locator('.chat-event').count(),0,'移除原来的取物进度卡');
    await until(async()=>(await taskThought.innerText()).includes('收到完成结果后，再告诉你可以领取。'));
    assert((await taskCopy.locator('p').count())>=3,'展示连续的自然语言段落');
    await pause(100);
    assert.equal(await page.getByRole('log',{name:'访客对话'}).evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2),true,'逐字内容增高后跟随最新文字');
    passed.push('逐字更新跟随底部，主动向上阅读时暂停，回到底部后恢复');
    await page.screenshot({path:join(output,'desktop-thinking.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await pause(100);
    await page.screenshot({path:join(output,'narrow-thinking.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'窄屏不横向溢出');
    await page.setViewportSize({width:1440,height:900});
    passed.push('确认后展示完整固定流程，接单后持续思考');
    async function callback(path,body){const response=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);}
    await callback('/api/task/finished',{result:'success'});await page.locator('.task-panel.succeeded').waitFor();
    const completed=page.locator('.chat-bubble.assistant').getByText('物品已经取好，可以到交付处领取了。',{exact:true});
    await completed.waitFor({timeout:2000});assert.match(await taskThought.locator('summary').innerText(),/思考已结束/);
    assert.equal(await taskThought.locator('.thinking-copy').isVisible(),false);
    await callback('/api/task/finished',{});await pause(150);assert.equal(await completed.count(),1,'重复完成通知不重复回复');
    assert.equal(modelRequests.length,chatCallsBeforeTasks,'完成通知直接形成助手消息，无需额外模型调用');
    passed.push('完成通知结束思考并自动回复，重复通知不重复回复');
    await selectOnly(page,'小面包');await page.getByRole('button',{name:'确认取物',exact:true}).click();
    await until(()=>!!releaseReceipt);releaseReceipt();releaseReceipt=null;await page.locator('.task-panel.executing').waitFor();
    await callback('/api/task/error',{message:'受控测试故障'});await page.locator('.task-panel.fault').waitFor();
    const faultThought=page.getByRole('group',{name:'思考过程'}).last();
    assert.match(await faultThought.locator('summary').innerText(),/思考已结束/);
    const faultReply=page.locator('.chat-bubble.assistant').getByText('这次取物遇到了问题，请联系现场工作人员协助处理，先不要重复确认取物。',{exact:true});await faultReply.waitFor();
    assert.equal(await completed.count(),1,'故障不发送取好消息');
    await callback('/api/task/error',{message:'重复受控故障'});await pause(150);assert.equal(await faultReply.count(),1);
    passed.push('故障中止思考并提示协助，重复故障不重复回复');
    const recoverySnapshot=await (await fetch(apiUrl+'/api/booth')).json();
    const resolved=await fetch(apiUrl+'/api/booth/operator/resolve',{method:'POST',headers:{'Content-Type':'application/json','X-Operator-Token':'test-staff'},body:JSON.stringify({confirmation:'已核对机器人停止',expectedTaskId:recoverySnapshot.active?.id??null,expectedAlert:recoverySnapshot.alert})});assert.equal(resolved.status,200);
    await page.locator('.task-panel.resolved').waitFor();
    await page.locator('.chat-bubble.assistant').getByText('这次取物已由工作人员处理。是否可以领取，请向现场工作人员确认。',{exact:true}).waitFor();
    assert.equal(await completed.count(),1,'工作人员处理不能冒充完成');
    await selectOnly(page,'纪念品');await page.getByRole('button',{name:'确认取物',exact:true}).click();
    await until(()=>!!releaseReceipt);releaseReceipt();releaseReceipt=null;await page.locator('.task-panel.executing').waitFor();
    await input.fill('继续介绍可选物品');await input.press('Enter');await until(()=>!!releaseModel);
    assert(!JSON.stringify(modelRequests.at(-1)).includes('我正在读取导航反馈'),'固定脚本不作为模型历史发送');
    await page.getByRole('button',{name:'开始新体验',exact:true}).click();
    assert.equal(await page.getByRole('group',{name:'思考过程'}).count(),0,'新体验清空旧思考展示');
    assert.equal(await page.locator('.task-panel.executing').count(),1,'新体验保留后台任务');
    releaseModel();releaseModel=null;await callback('/api/task/finished',{});await page.locator('.task-panel.succeeded').waitFor();
    await pause(150);assert.equal(await page.locator('.chat-bubble.assistant').count(),0,'旧回复和旧任务完成消息不串入新体验');
    passed.push('新体验隔离旧流程、迟到回复和旧任务完成通知');
    await page.route('**/api/booth/requests',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({data:'受控测试：暂不能提交取物'})}),{times:1});
    await selectOnly(page,'矿泉水');await page.getByRole('button',{name:'确认取物',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'受控测试：暂不能提交取物'}).waitFor();
    assert.match(await page.getByRole('group',{name:'思考过程'}).last().locator('summary').innerText(),/思考已结束/,'明确提交失败不能留在思考中');
    assert.equal(robotCalls,3,'明确提交失败不额外发单');passed.push('明确提交失败中止思考');
    heldSnapshot=await (await fetch(apiUrl+'/api/booth')).json();
    const syncContext=await browser.newContext(),syncPage=await syncContext.newPage();syncPage.on('pageerror',e=>errors.push(e.message));
    await syncPage.route('**/api/booth/events',route=>route.continue({url:upstream+'/events'}));
    await syncPage.goto(webUrl);await syncPage.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
    await syncPage.route('**/api/booth',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({data:'受控测试：状态同步暂不可用'})}));
    await selectOnly(syncPage,'矿泉水');await syncPage.getByRole('button',{name:'确认取物',exact:true}).click();
    await until(()=>!!releaseReceipt);releaseReceipt();releaseReceipt=null;
    await syncPage.getByRole('alert').filter({hasText:'取物请求已提交，但暂时无法更新页面状态'}).waitFor();
    assert.match(await syncPage.getByRole('group',{name:'思考过程'}).last().locator('summary').innerText(),/思考中/,'成功提交后的同步失败保留思考');
    assert.equal(await syncPage.locator('.chat-bubble.assistant').filter({hasText:'未能提交'}).count(),0);
    await syncPage.unroute('**/api/booth');await syncPage.unroute('**/api/booth/events');
    for(const stream of controlledStreams)stream.end();
    await syncPage.locator('.task-panel.executing').waitFor();await callback('/api/task/finished',{});
    await syncPage.locator('.chat-bubble.assistant').getByText('物品已经取好，可以到交付处领取了。',{exact:true}).waitFor();await syncContext.close();
    passed.push('提交成功后的状态同步失败不误报未提交');
    const recoveredRequest={productId:'water',count:1,requestId:'thinking-recovered-request'};
    const originalRequest=fetch(apiUrl+'/api/booth/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recoveredRequest)});
    await until(()=>!!releaseReceipt);releaseReceipt();releaseReceipt=null;assert.equal((await originalRequest).status,200);
    await callback('/api/task/finished',{});const completedSnapshot=await (await fetch(apiUrl+'/api/booth')).json();
    heldSnapshot={...completedSnapshot,tasks:[],active:null};
    const recoveryContext=await browser.newContext(),recoveryPage=await recoveryContext.newPage();recoveryPage.on('pageerror',e=>errors.push(e.message));
    let releaseCredential;const credentialGate=new Promise(r=>releaseCredential=r);
    await recoveryPage.addInitScript(request=>localStorage.setItem('bluesword.booth.pending',JSON.stringify(request)),recoveredRequest);
    await recoveryPage.route('**/api/booth/experiences',async route=>{await credentialGate;await route.continue();});
    await recoveryPage.route('**/api/booth/events',route=>route.continue({url:upstream+'/events'}));
    await recoveryPage.route('**/api/booth',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(heldSnapshot)}));
    await recoveryPage.goto(webUrl);await recoveryPage.getByRole('button',{name:'核对这次取物',exact:true}).click();
    await recoveryPage.getByRole('button',{name:'正在确认',exact:true}).waitFor();
    for(const stream of controlledStreams)stream.write('data: '+JSON.stringify(completedSnapshot)+'\n\n');
    await recoveryPage.locator('.task-panel.succeeded').waitFor();
    await recoveryPage.unroute('**/api/booth');releaseCredential();
    await until(()=>recoveryPage.evaluate(()=>localStorage.getItem('bluesword.booth.pending')===null));
    const recoveredThought=recoveryPage.getByRole('group',{name:'思考过程'}).last();
    await until(async()=>/思考已结束/.test(await recoveredThought.locator('summary').innerText()));
    assert.equal(await recoveryPage.locator('.chat-bubble.assistant').getByText('物品已经取好，可以到交付处领取了。',{exact:true}).count(),1);
    assert.equal(robotCalls,5,'核对已完成请求不重新发单');await recoveryContext.close();
    passed.push('凭据等待期间先收到完成，随后核对仍正确结束思考');
    const streamContext=await browser.newContext({reducedMotion:'reduce'}),streamPage=await streamContext.newPage();streamPage.on('pageerror',e=>errors.push(e.message));
    const clockTime=new Date('2026-10-15T00:00:00+08:00');await streamPage.clock.install({time:clockTime});await streamPage.clock.pauseAt(clockTime);
    await streamPage.goto(webUrl);await streamPage.locator('.task-panel.idle').waitFor();
    await selectOnly(streamPage,'纪念品');await streamPage.getByRole('button',{name:'确认取物',exact:true}).click();
    await until(()=>!!releaseReceipt);releaseReceipt();releaseReceipt=null;await streamPage.locator('.task-panel.executing').waitFor();
    const streamThought=streamPage.getByRole('group',{name:'思考过程'}).last(),streamCopy=streamThought.locator('.thinking-copy');
    for(let tick=0;tick<5;tick++) {
      const before=Array.from(await streamCopy.textContent()).length;await streamPage.clock.runFor(35);
      assert.equal(Array.from(await streamCopy.textContent()).length,before+1,'逐字流每次只增加一个字');
    }
    await streamThought.locator('summary').click();const folded=Array.from(await streamCopy.textContent()).length;await streamPage.clock.runFor(35);
    await streamThought.locator('summary').click();assert.equal(Array.from(await streamCopy.textContent()).length,folded+1,'折叠展开保留进度而不跳到全部文字');
    await callback('/api/task/finished',{});await streamPage.locator('.chat-bubble.assistant').getByText('物品已经取好，可以到交付处领取了。',{exact:true}).waitFor();
    await streamContext.close();passed.push('减少动态效果时仍逐字吐出，折叠展开保留逐字进度');
    assert.deepEqual(errors,[]);
    writeFileSync(join(output,'report.json'),JSON.stringify({passed,robotCalls,controlledModelCalls:modelRequests.length,realAiCalls:0,realRobotCalls:0},null,2));
    console.log(JSON.stringify({output,passed,realAiCalls:0,realRobotCalls:0}));
  }finally{
    releaseModel?.();releaseReceipt?.();await browser?.close();
    for(const stream of controlledStreams)stream.end();
    for(const p of children){if(p.exitCode===null){const done=once(p,'exit');p.kill();await done;}}
    if(peer)await new Promise(r=>peer.close(r));
  }
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
