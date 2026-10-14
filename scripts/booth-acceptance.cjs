const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),children=new Set();
mkdirSync(join(root,'.tmp'),{recursive:true});
const output=mkdtempSync(join(root,'.tmp','booth-acceptance-'));
const webRequire=createRequire(join(root,'apps/web/package.json'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function launch(args,env={},cwd=root){
  const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.add(p);p.logs='';
  p.stdout.on('data',d=>{p.logs+=d;});p.stderr.on('data',d=>{p.logs+=d;});return p;
}
async function stop(p){if(p.exitCode!==null){children.delete(p);return;}const done=once(p,'exit');p.kill();await done;children.delete(p);}
async function ready(url,p){for(let i=0;i<100;i++){if(p.exitCode!==null)throw new Error(p.logs);try{if((await fetch(url)).ok)return;}catch{}await pause(100);}throw new Error('Service not ready '+url+' '+p.logs);}
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await pause(100);}throw new Error('Assertion timed out');}
async function testStorageSubmission(browser,webUrl){
 const context=await browser.newContext(),page=await context.newPage(),errors=[],sent=[];
 let status=502,gate=Promise.resolve(),release;
 try{
  await page.addInitScript(()=>{
   const setItem=Storage.prototype.setItem;
   window.failPendingWrite=true;
   Storage.prototype.setItem=function(key,value){
    if(key==='bluesword.booth.pending'&&window.failPendingWrite)throw new DOMException('测试：存储写入失败','QuotaExceededError');
    return setItem.call(this,key,value);
   };
  });
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/booth/requests',async route=>{
   sent.push(route.request().postDataJSON());
   await gate;
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{}:{data:'测试：未收到确认反馈'})});
  });
  await page.goto(webUrl);await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  const submit=page.locator('.order-panel .primary-button');await until(()=>submit.isEnabled());await submit.click();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  console.log('Storage failure observation: '+JSON.stringify({disabled:await submit.isDisabled(),button:await submit.innerText(),sent:sent.length,errors}));
  assert.equal(sent.length,0,'本地保存失败时不得发送取物请求');
  assert.equal(await submit.isDisabled(),false,'本地保存失败后必须退出提交状态');
  await page.getByRole('alert').filter({hasText:'无法保存取物信息'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).isEnabled(),true,'未发送的新取物信息不应锁定选品');
  assert.equal(await page.evaluate(()=>localStorage.getItem('bluesword.booth.pending')),null);

  // After storage recovers, uncertain HTTP feedback must retain the saved requestId.
  await page.evaluate(()=>{window.failPendingWrite=false;});await submit.click();
  await page.getByRole('alert').filter({hasText:'测试：未收到确认反馈'}).waitFor();
  const saved=await page.evaluate(()=>localStorage.getItem('bluesword.booth.pending'));
  assert.equal(sent.length,1);assert.deepEqual(JSON.parse(saved),sent[0]);
  await page.evaluate(()=>{window.failPendingWrite=true;});await page.getByRole('button',{name:'核对这次取物',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'无法保存取物信息'}).waitFor();
  assert.equal(sent.length,1,'已有待核对信息再次保存失败，也不得发送');
  assert.equal(await submit.isEnabled(),true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('bluesword.booth.pending')),saved,'保存失败不得删除或替换已有请求标识');
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).isDisabled(),true,'已有待核对信息仍须锁定选品');

  await page.reload();await page.getByRole('button',{name:'核对这次取物',exact:true}).waitFor();await until(()=>submit.isEnabled());
  assert.equal(sent.length,1,'刷新仅恢复待核对信息，不自动重新发送');
  await submit.click();await page.getByRole('alert').filter({hasText:'无法保存取物信息'}).waitFor();
  assert.equal(sent.length,1);assert.equal(await page.evaluate(()=>localStorage.getItem('bluesword.booth.pending')),saved);
  await page.evaluate(()=>{window.failPendingWrite=false;});status=200;gate=new Promise(r=>release=r);
  await submit.click();await until(()=>sent.length===2);
  assert.deepEqual(sent[1],sent[0],'恢复存储后核对必须使用原请求标识及原选品数量');
  assert.equal(await submit.isDisabled(),true,'等待反馈期间仍阻止重复确认');
  release();await until(()=>page.getByRole('button',{name:'选择纪念品',exact:true}).isEnabled());
  assert.equal(await page.evaluate(()=>localStorage.getItem('bluesword.booth.pending')),null);
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[],'保存失败不应产生未处理异常');
  console.log('Storage submission regression passed: fresh failure, pending preservation, reload, same-ID retry, success cleanup');
 }finally{release?.();await context.close();}
}
(async()=>{
 let browser,robot,releaseReceipt;const callbacks=new Set();let mode='success',requests=[],apiUrl='';
 try{
  const apiPort=await port(),webPort=await port(),robotPort=await port();apiUrl='http://127.0.0.1:'+apiPort;const webUrl='http://127.0.0.1:'+webPort;
  robot=createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    assert.equal(req.url,'/api/task/dispatch');assert.equal(req.method,'POST');
    const command=JSON.parse(body);assert.deepEqual(Object.keys(command).sort(),['count','item','location']);requests.push(command);
    if(mode==='receipt-pending')await new Promise(resolve=>releaseReceipt=resolve);
    res.writeHead(mode==='uncertain'?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:1,data:mode==='rejected'?'测试拒绝':'received',success:mode!=='rejected'}));
    if(mode==='success'||mode==='error'){const selected=mode;const t=setTimeout(async()=>{
      callbacks.delete(t);await fetch(apiUrl+(selected==='error'?'/api/task/error':'/api/task/finished'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selected==='error'?{message:'测试故障：机械臂无法自动恢复'}:{result:'success'})}).catch(()=>{});
    },1600);callbacks.add(t);}
  });await new Promise(r=>robot.listen(robotPort,'127.0.0.1',r));
  const env={PORT:String(apiPort),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:'http://127.0.0.1:'+robotPort+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_TASK_REMINDER_MS:'500',BOOTH_AI_PROVIDER:'openai',DEEPSEEK_API_KEY:'',OPENAI_API_KEY:'',BOOTH_OPERATOR_TOKEN:'browser-test-operator'};
  let api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const chatRequests=[];page.on('request',request=>{if(request.url().endsWith('/api/booth/chat'))chatRequests.push(request.postDataJSON());});
  const notices=page.getByLabel('任务状态通知');
  // Inspect rendered styles and accessible icons, rather than class names alone.
  async function assertStatusAppearance(panel,notice,color,icon){
    const backgrounds={'等待选择':'rgb(240, 242, 244)','等待机器人接单':'rgb(240, 242, 244)','机器人已接单':'rgb(238, 244, 250)','取物完成':'rgb(238, 245, 236)','机器人未接单':'rgb(255, 246, 231)','需要核对':'rgb(255, 246, 231)','需要协助':'rgb(252, 240, 238)','工作人员处理':'rgb(240, 242, 244)'};
    const status=panel.locator('.task-status');
    assert.equal(await status.evaluate(el=>getComputedStyle(el).color),color,'任务卡应使用对应状态颜色');
    assert.equal(await panel.evaluate(el=>getComputedStyle(el).backgroundColor),backgrounds[icon],'任务卡背景也应符合状态语义');
    await panel.getByRole('img',{name:icon,exact:true}).waitFor();
    if(notice){
      assert.equal(await notice.evaluate(el=>getComputedStyle(el).color),color,'对话通知与任务卡应使用相同状态颜色');
      assert.equal(await notice.evaluate(el=>getComputedStyle(el).backgroundColor),backgrounds[icon],'对话通知背景应与任务卡一致');
      await notice.getByRole('img',{name:icon,exact:true}).waitFor();
    }
  }
  // P9: missing dispatch URL must be visible before the visitor submits.
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{...env,ROBOT_DISPATCH_URL:'',BOOTH_OPERATOR_TOKEN:''});await ready(apiUrl+'/api/health',api);
  await page.goto(webUrl);await page.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'确认取物',exact:true}).isDisabled(),true,'缺少机器人地址时不能确认取物');
  await page.getByText('机器人连接尚未配置，暂不能提交任务',{exact:true}).waitFor();
  assert.equal(await page.locator('.site-header').count(),0,'访客顶部品牌、标语及技术状态栏应删除');
  await page.getByRole('link',{name:'工作人员入口'}).click();
  await page.getByText('网关状态同步正常',{exact:false}).waitFor();
  await page.getByText('工作人员操作凭据尚未配置',{exact:false}).waitFor();
  assert.equal(await page.getByLabel('工作人员凭据').isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'解除本地占用',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  assert.equal(requests.length,0);assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).tasks.length,0);
  await page.screenshot({path:join(output,'desktop-not-configured.png'),fullPage:true});
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  await page.reload();await page.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'告诉助手你的需求'}).isDisabled(),true);
  await assertStatusAppearance(page.locator('.task-panel'),null,'rgb(82, 96, 109)','等待选择');
  await page.screenshot({path:join(output,'desktop-initial.png'),fullPage:true});
  await testStorageSubmission(browser,webUrl);
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  await page.getByRole('button',{name:'增加数量',exact:true}).click();
  assert.equal(await page.getByLabel('已选数量').innerText(),'2');
  mode='receipt-pending';await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.submitting').waitFor();
  assert.equal(await notices.count(),0,'点击确认而未取得受理回执时不能播报受理或完成');
  await assertStatusAppearance(page.locator('.task-panel'),null,'rgb(82, 96, 109)','等待机器人接单');
  await until(()=>typeof releaseReceipt==='function');mode='success';releaseReceipt();await page.locator('.task-panel.executing').waitFor();
  assert.equal(requests[0].count,2);
  await notices.filter({hasText:'机器人已接单，请等待取物结果'}).waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(49, 95, 134)','机器人已接单');
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),0,'受理不能显示完成通知');
  await page.locator('.task-panel.succeeded').waitFor();await page.screenshot({path:join(output,'desktop-success.png'),fullPage:true});
  await notices.filter({hasText:'取物已完成，请到交付处领取'}).waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(63, 107, 67)','取物完成');
  assert.equal(await notices.filter({hasText:'机器人已接单'}).count(),1);
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),1);
  assert.equal(chatRequests.length,0,'任务通知不得触发模型请求');
  await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),1,'重复完成回调不重播通知');
  await page.setViewportSize({width:390,height:844});await pause(100);
  assert.equal(await page.getByRole('log',{name:'访客对话'}).evaluate(el=>Math.abs(el.scrollHeight-el.clientHeight-el.scrollTop)<2),true,'已有完成通知缩窗换行后仍须停在最新消息');
  await page.setViewportSize({width:1440,height:900});
  const freshVisitor=await browser.newPage();
  try{
    const historyBefore=(await (await fetch(apiUrl+'/api/booth')).json()).tasks;
    await freshVisitor.goto(webUrl);await freshVisitor.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
    assert.equal(await freshVisitor.locator('.task-panel.idle').count(),1,'无活动任务的新页面不能把上一单完成当作当前状态');
    assert.equal(await freshVisitor.getByRole('heading',{name:'体验记录',exact:true}).count(),0,'访客主界面不展示上一位访客记录');
    assert.deepEqual((await (await fetch(apiUrl+'/api/booth')).json()).tasks,historyBefore,'清理访客显示不能删除历史任务');
  }finally{await freshVisitor.close();}

  mode='rejected';await page.getByRole('button',{name:'选择纪念品',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.rejected').waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(133, 98, 40)','机器人未接单');
  assert.match(await page.locator('.task-panel').innerText(),/机器人未接下这次取物/);
  assert.doesNotMatch(await page.locator('.task-panel').innerText(),/测试拒绝|取物已完成/);
  await page.getByRole('link',{name:'工作人员入口'}).click();
  await page.getByRole('dialog').getByText('测试拒绝',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  mode='error';await page.getByRole('button',{name:'选择小面包',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.fault').waitFor();
  await notices.filter({hasText:'这次取物需要工作人员协助'}).waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(158, 69, 62)','需要协助');
  await fetch(apiUrl+'/api/task/error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'重复故障：仍需核对'})});
  await until(async()=>(await (await fetch(apiUrl+'/api/booth')).json()).active.message==='重复故障：仍需核对');
  assert.equal(await page.getByRole('main').getByText('重复故障：仍需核对',{exact:true}).count(),0,'异常原文只在工作人员入口展示');
  assert.equal(await page.locator('.task-panel').getByText('测试故障：机械臂无法自动恢复',{exact:true}).count(),0);
  assert.match(await page.locator('.task-panel').innerText(),/是否结束尚未确认/);
  assert.match(await notices.last().innerText(),/尚未确认机器人是否停止/);
  await page.getByRole('link',{name:'工作人员入口'}).click();
  await page.getByRole('dialog').getByText('重复故障：仍需核对',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  assert.equal(await notices.filter({hasText:'这次取物需要工作人员协助'}).count(),1,'相同任务故障状态重复推送不重播');
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),1,'故障不能冒充完成');
  await page.screenshot({path:join(output,'desktop-fault.png'),fullPage:true});
  await page.getByRole('link',{name:'工作人员入口'}).click();await page.getByLabel('工作人员凭据').fill('browser-test-operator');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'解除本地占用'}).click();await page.locator('.task-panel.resolved').waitFor();await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  await notices.filter({hasText:'这次取物已由工作人员处理，领取情况请向现场工作人员确认'}).waitFor();
  assert.match(await page.locator('.task-panel').innerText(),/领取情况请向现场工作人员确认/);
  assert.doesNotMatch(await page.locator('.task-panel').innerText(),/取物已完成|占用|本地/);
  await page.getByRole('link',{name:'工作人员入口'}).click();
  await page.getByRole('dialog').getByText('工作人员已现场核对并解除本地占用',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(82, 96, 109)','工作人员处理');
  mode='uncertain';await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.uncertain').waitFor();
  await notices.filter({hasText:'机器人是否接单、这次取物是否结束尚未确认'}).waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(133, 98, 40)','需要核对');
  assert.match(await page.locator('.task-panel').innerText(),/是否结束尚未确认/);
  assert.doesNotMatch(await page.locator('.task-panel').innerText(),/占用|本地/);
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),1,'受理不明不能冒充完成');
  assert.equal(chatRequests.length,0,'故障、收尾与受理不明也不得调用模型');
  await page.getByRole('link',{name:'工作人员入口'}).click();await page.getByLabel('工作人员凭据').fill('browser-test-operator');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'解除本地占用'}).click();await page.locator('.task-panel.resolved').waitFor();await page.getByRole('button',{name:'关闭工作人员入口'}).click();

  await page.clock.setSystemTime(new Date(Date.now()-3600000));
  mode='silent';const before=requests.length;
  await page.route('**/api/booth/requests',async route=>{await route.fetch();await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({data:'测试：反馈丢失'})});},{times:1});
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  await page.getByRole('alert').filter({hasText:'反馈丢失'}).waitFor();assert.equal(requests.length,before+1);
  const otherContext=await browser.newContext(),other=await otherContext.newPage();await other.goto(webUrl);await other.locator('.task-panel.executing').waitFor();
  await other.getByRole('button',{name:'选择纪念品',exact:true}).click();assert.equal(await other.getByRole('button',{name:'请等待当前任务',exact:true}).isDisabled(),true);
  await otherContext.close();
  const taskId=(await (await fetch(apiUrl+'/api/booth')).json()).active.id;
  await page.getByRole('alert').filter({hasText:'等待时间较长'}).waitFor({timeout:5000});
  assert.match(await page.locator('.waiting-reminder').innerText(),/是否结束尚未确认/);
  assert.doesNotMatch(await page.locator('.waiting-reminder').innerText(),/占用|本地/);
  assert.equal(await notices.filter({hasText:'机器人已接单'}).count(),3,'等待提醒不能新增任务通知');
  assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).active.status,'executing');
  assert.equal(requests.length,before+1);
  await page.getByRole('button',{name:'联系工作人员核对',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button',{name:'解除本地占用',exact:true}).isDisabled(),true);
  await page.getByText('执行中任务仍保持占用',{exact:false}).waitFor();
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  assert.equal(chatRequests.length,0);
  await page.reload();await page.locator('.task-panel.executing').waitFor();await page.getByRole('alert').filter({hasText:'等待时间较长'}).waitFor();assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).active.id,taskId);assert.equal(requests.length,before+1);
  assert.equal(await notices.count(),0,'刷新页面不重播历史状态');
  await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});await page.locator('.task-panel.succeeded').waitFor();

  assert.equal(await page.getByRole('alert').filter({hasText:'等待时间较长'}).count(),0);

  // Browser only fixture: no request is sent to OpenAI; this checks recommendation UX, not model quality.
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{...env,OPENAI_API_KEY:'browser-fixture-not-a-real-key'});await ready(apiUrl+'/api/health',api);
  await page.route('**/api/booth/chat',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({reply:'已为你选择两瓶矿泉水，请在取物栏确认。',selection:{productId:'water',count:2}})}));
  await page.reload();const input=page.getByRole('textbox',{name:'告诉助手你的需求'});await until(()=>input.isEnabled());
  assert.equal(await notices.count(),0,'首次快照不播报历史完成任务');
  const dialogueOrder=await page.evaluate(()=>{const chat=document.querySelector('[aria-label="告诉助手你的需求"]');const catalog=document.getElementById('catalog-title');return Boolean(chat.compareDocumentPosition(catalog)&Node.DOCUMENT_POSITION_FOLLOWING);});
  assert.equal(dialogueOrder,true,'对话应在选品目录之前');
  assert.equal(await page.getByRole('button',{name:'选择矿泉水',exact:true}).isVisible(),true,'AI可用时目录也应默认展开，访客不用先点击展开');
  await input.fill('帮我选两瓶水');await input.press('Enter');await page.getByText('已为你选择两瓶矿泉水，请在取物栏确认。',{exact:true}).waitFor();
  assert.equal(chatRequests.at(-1).messages.length,1,'新页面只发送访客输入，不发送历史状态事件');
  assert.equal(await page.getByLabel('已选数量').innerText(),'2');assert.equal(requests.length,before+1);
  async function delayedAdvice(action,reply='延迟建议：两瓶矿泉水',status=200){
    await page.unroute('**/api/booth/chat');
    let release,arrived;
    const held=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
    await page.route('**/api/booth/chat',async route=>{arrived();await held;await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{reply,selection:{productId:'water',count:2}}:{data:reply})});});
    const completed=page.waitForResponse(r=>r.url().endsWith('/api/booth/chat'));
    await input.fill('请帮我选择');await page.getByRole('button',{name:'发送需求'}).click();await started;
    try{await action();}finally{release();}
    await completed;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await until(()=>input.isEnabled());
  }
  // P2: controlled delayed advice must not overwrite a newer manual selection.
  await delayedAdvice(()=>page.getByRole('button',{name:'选择纪念品',exact:true}).click());
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByLabel('已选数量').innerText(),'1');
  assert.equal(requests.length,before+1);
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  await page.getByRole('button',{name:'增加数量',exact:true}).click();
  await delayedAdvice(()=>page.getByRole('button',{name:'增加数量',exact:true}).click());
  assert.equal(await page.getByLabel('已选数量').innerText(),'3');
  await delayedAdvice(async()=>{await page.getByRole('button',{name:'减少数量',exact:true}).click();await page.getByRole('button',{name:'减少数量',exact:true}).click();});
  assert.equal(await page.getByLabel('已选数量').innerText(),'1');
  mode='rejected';const submittedBefore=requests.length;
  await delayedAdvice(async()=>{await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.rejected').waitFor();});
  assert.equal(await page.getByLabel('已选数量').innerText(),'1');
  assert.equal(requests.length,submittedBefore+1);
  await delayedAdvice(async()=>{await page.getByRole('button',{name:'开始新体验',exact:true}).click();},'上一位访客的迟到建议');
  assert.equal(await page.locator('.chat-bubble').count(),0);
  assert.equal(await page.locator('.product-card[aria-pressed="true"]').count(),0);
  assert.equal(await page.locator('.task-panel.idle').count(),1,'新体验清理已结束任务的展示，保留后台历史');
  assert.equal(requests.length,submittedBefore+1);
  await delayedAdvice(async()=>{await page.getByRole('button',{name:'开始新体验',exact:true}).click();await input.fill('新访客的输入');},'上一位访客的错误',503);
  assert.equal(await page.locator('.chat-error').count(),0);
  assert.equal(await input.inputValue(),'新访客的输入');
  await page.clock.setSystemTime(new Date(Date.now()+3600000));
  mode='silent';await page.getByRole('button',{name:'选择纪念品',exact:true}).click();
  await delayedAdvice(async()=>{
    const response=await fetch(apiUrl+'/api/booth/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'other-browser-delayed-advice',productId:'water',count:1})});assert.equal(response.status,200);
    await page.locator('.task-panel.executing').waitFor();
    const elapsed=Number((await page.locator('.waiting-reminder p').allTextContents()).join('').match(/(\d+) 秒/)?.[1]??0);
    assert(elapsed<60,'浏览器快1小时不能显示等待1小时');
  });
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await notices.filter({hasText:'机器人已接单'}).count(),1,'迟到AI回复不得移除任务通知');
  const activeBeforeReset=(await (await fetch(apiUrl+'/api/booth')).json()).active;
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).active.id,activeBeforeReset.id);
  assert.equal(await page.locator('.task-panel.executing').count(),1);
  assert.equal(await notices.count(),0,'开始新体验清空通知，但不重置任务去重记录');
  await page.getByRole('button',{name:'选择纪念品',exact:true}).click();
  await delayedAdvice(async()=>{
    await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});await page.locator('.task-panel.succeeded').waitFor();
  });
  assert.equal(await page.getByRole('button',{name:'选择纪念品',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await notices.filter({hasText:'取物已完成'}).count(),1,'新体验中的实际完成通知不能被迟到AI回复覆盖');
  await page.unroute('**/api/booth/chat');await page.route('**/api/booth/chat',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({data:'测试：助手暂不可用'})}));
  await input.fill('再帮我看看');await page.getByRole('button',{name:'发送需求'}).click();await page.getByRole('alert').filter({hasText:'助手暂不可用'}).waitFor();assert.equal(await input.inputValue(),'再帮我看看');
  assert.equal(chatRequests.length,10,'只有十次显式聊天操作产生请求，状态变化没有额外请求');
  for(const {messages} of chatRequests){
    assert(messages.every(message=>['user','assistant'].includes(message.role)),'系统事件不得进入AI请求');
    assert(messages.every(message=>!/(机器人已接单，请等待取物结果|取物已完成，请到交付处领取|这次取物需要工作人员协助|机器人是否接单、这次取物是否结束尚未确认|这次取物已由工作人员处理)/.test(message.content)),'固定通知文本不得消耗模型token');
  }

  await fetch(apiUrl+'/api/task/error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'测试全局告警'})});
  await notices.filter({hasText:'取物服务暂需工作人员核对'}).waitFor();
  await assertStatusAppearance(page.locator('.task-panel'),notices.last(),'rgb(158, 69, 62)','需要协助');
  assert.equal(await page.getByRole('main').getByText('测试全局告警',{exact:true}).count(),0,'全局告警原文不出现在访客主界面');
  assert.match(await page.locator('.task-panel').innerText(),/尚未确认机器人是否停止/);
  await page.getByRole('link',{name:'工作人员入口'}).click();
  await page.getByRole('dialog').getByText('测试全局告警',{exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭工作人员入口'}).click();
  assert.equal(await page.locator('.task-panel').getByRole('img',{name:'取物完成',exact:true}).count(),0,'全局告警不能保留上一单完成图标');
  await fetch(apiUrl+'/api/task/error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'测试全局告警'})});
  await fetch(apiUrl+'/api/booth/operator/resolve',{method:'POST',headers:{'Content-Type':'application/json','X-Operator-Token':'browser-test-operator'},body:JSON.stringify({confirmation:'已核对机器人停止'})});
  await page.locator('.task-panel').getByText('取物已完成，请到交付处领取。',{exact:true}).waitFor();
  assert.equal(await notices.filter({hasText:'取物服务暂需工作人员核对'}).count(),1,'重复全局告警不刷屏');
  assert.equal(chatRequests.length,10);

  // A delayed GET must not roll a committed completion back to executing.
  let releaseSnapshot,snapshotArrived;
  const heldSnapshot=new Promise(resolve=>releaseSnapshot=resolve),snapshotStarted=new Promise(resolve=>snapshotArrived=resolve);
  await page.route('**/api/booth',async route=>{const response=await route.fetch();snapshotArrived();await heldSnapshot;await route.fulfill({response});},{times:1});
  mode='silent';await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await snapshotStarted;
  await page.locator('.task-panel.executing').waitFor();
  const staleDelivered=page.waitForResponse(response=>response.url().endsWith('/api/booth'));
  try{
    await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});
    await page.locator('.task-panel.succeeded').waitFor();
  }finally{releaseSnapshot();}
  await staleDelivered;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.task-panel.succeeded').count(),1,'迟到HTTP快照不能覆盖更新的完成SSE');
  assert.equal(await page.locator('.task-panel.executing').count(),0);
  assert.equal(chatRequests.length,10);

  // End one SSE response deliberately, then let native EventSource reconnect
  // to the real gateway. Every frame comes from its actual HTTP snapshot.
  const reconnectContext=await browser.newContext(),reconnectPage=await reconnectContext.newPage();
  let releaseStream,sseRequests=0,reconnectChatRequests=0;
  const heldStream=new Promise(resolve=>releaseStream=resolve);
  reconnectPage.on('request',request=>{if(request.url().endsWith('/api/booth/events'))sseRequests++;if(request.url().endsWith('/api/booth/chat'))reconnectChatRequests++;});
  await reconnectPage.route('**/api/booth/events',async route=>{
    await heldStream;
    const snapshot=await (await fetch(apiUrl+'/api/booth')).json();
    await route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify(snapshot)+'\n\n'});
  },{times:1});
  try{
    await reconnectPage.goto(webUrl);await reconnectPage.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
    assert.equal(await reconnectPage.getByLabel('任务状态通知').count(),0);
    mode='silent';
    const dispatched=await fetch(apiUrl+'/api/booth/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'sse-reconnect-notification',productId:'water',count:1})});assert.equal(dispatched.status,200);
    releaseStream();
    await reconnectPage.getByLabel('任务状态通知').filter({hasText:'机器人已接单'}).waitFor();
    await until(()=>sseRequests>=2);
    await reconnectPage.getByRole('link',{name:'工作人员入口'}).click();await reconnectPage.getByText('网关状态同步正常',{exact:false}).waitFor();
    assert.equal(await reconnectPage.getByLabel('任务状态通知').filter({hasText:'机器人已接单'}).count(),1,'原生SSE重连的重复快照不能重播受理通知');
    assert.equal(reconnectChatRequests,0);
    await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});
    await page.locator('.task-panel.succeeded').waitFor();
  }finally{releaseStream();await reconnectContext.close();}
  assert.equal(chatRequests.length,10);

  let desktopCatalogHeight;
  for(const [width,height] of [[1440,900],[1366,768],[1024,768],[768,1024],[390,844],[320,568]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:join(output,'viewport-'+width+'x'+height+'.png'),fullPage:true});
    const metrics=await page.evaluate(()=>({width:document.documentElement.scrollWidth,cardCount:document.querySelectorAll('.product-card').length}));
    assert(metrics.width<=width,'Horizontal overflow '+JSON.stringify({width,metrics}));assert.equal(metrics.cardCount,4);
    const layout=await page.evaluate(()=>{
      const task=document.querySelector('.task-panel').getBoundingClientRect(),catalog=document.querySelector('.catalog-panel').getBoundingClientRect(),order=document.querySelector('.order-panel').getBoundingClientRect(),chat=document.querySelector('.assistant-panel').getBoundingClientRect();
      return {taskFirst:task.bottom<=Math.min(catalog.top,order.top),catalogFirst:catalog.top<=order.top,wideColumns:task.left>chat.left+chat.width,taskTop:task.top,chatTop:chat.top,chatWidth:chat.width,catalogWidth:catalog.width,orderWidth:order.width,decoration:!!document.querySelector('.welcome-visual'),robot:!!document.querySelector('.task-illustration .robot-sculpture')};
    });
    assert.equal(layout.taskFirst,true,'真实任务状态应位于选品区上方');assert.equal(layout.decoration,false);assert.equal(layout.robot,true);
    assert.equal(layout.catalogFirst,true,'目录之后应呈现独立全宽确认区');
    if(width>850){
      assert(layout.taskTop<layout.chatTop,'紧凑任务卡应进入欢迎区右上方，利用现有空白');
      assert(Math.abs(layout.catalogWidth-layout.orderWidth)<1,'桌面目录与确认区应各自使用完整右栏宽度');
      assert.equal(layout.wideColumns,true,'宽屏任务卡应在右栏');
      assert(layout.orderWidth<=layout.chatWidth,'桌面右侧功能区不应宽于左侧对话区 '+JSON.stringify({width,layout}));
      const confirm=await page.getByRole('button',{name:'确认取物',exact:true}).boundingBox();
      assert(confirm&&confirm.y>=0&&confirm.y+confirm.height<=height,'默认展开目录时，桌面首屏应完整呈现确认取物按钮 '+JSON.stringify({width,height,confirm}));
      const selection=await page.getByText('已选物品',{exact:true}).boundingBox(),quantity=await page.getByLabel('已选数量').boundingBox();
      assert(selection&&selection.y>=0&&selection.y+selection.height<=height,'选品标题应在首屏');
      assert(quantity&&quantity.y>=0&&quantity.y+quantity.height<=height,'数量调整应在首屏');
      const productTitle=await page.getByRole('button',{name:'选择矿泉水',exact:true}).locator('h3').boundingBox();
      assert(productTitle&&productTitle.y>=0&&productTitle.y+productTitle.height<=height,'首行商品名称应在桌面首屏清楚可见 '+JSON.stringify({width,height,productTitle}));
    }
    if(width===1366)desktopCatalogHeight=(await page.locator('.catalog-panel').boundingBox()).height;
  }
  await page.getByRole('button',{name:'饮品',exact:true}).click();assert.equal(await page.locator('.product-card').count(),1);await page.getByRole('button',{name:'全部',exact:true}).click();
  const proportionPage=await browser.newPage();
  try{
    for(const [width,height] of [[1440,900],[1366,768],[1024,768]]){
      await proportionPage.setViewportSize({width,height});await proportionPage.goto(webUrl);
      await proportionPage.getByRole('button',{name:'选择矿泉水',exact:true}).click();
      await proportionPage.getByRole('button',{name:'增加数量',exact:true}).click();
      const chat=await proportionPage.locator('.assistant-panel').boundingBox(),order=await proportionPage.getByRole('region',{name:'取物确认'}).boundingBox();
      assert(chat&&order&&Math.abs(chat.y+chat.height-order.y-order.height)<=12,'初始桌面对话区应延伸到确认卡底部附近 '+JSON.stringify({width,chat,order}));
      const input=await proportionPage.getByRole('textbox',{name:'告诉助手你的需求'}).boundingBox();
      assert(input&&input.y+input.height<=height,'加高后的桌面对话输入仍在首屏可见');
      assert.equal(await proportionPage.getByLabel('已选数量').textContent(),'2');
    }
  }finally{await proportionPage.close();}
  const scrollingPage=await browser.newPage();
  let scrollingRequests=0;
  await scrollingPage.route('**/api/booth/chat',route=>{
    scrollingRequests++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({reply:'布局回归第 '+scrollingRequests+' 轮（可控响应）。\n'+('这里仅测试长对话显示，可通过目录选择物品，确认后才会发单。\n').repeat(10),selection:null})});
  });
  try{
    for(const [width,height] of [[1440,900],[1366,768],[1024,768],[390,844]]){
      await scrollingPage.setViewportSize({width,height});await scrollingPage.goto(webUrl);
      const composer=scrollingPage.getByRole('textbox',{name:'告诉助手你的需求'});await until(()=>composer.isEnabled());
      const initialCard=await scrollingPage.locator('.assistant-panel').boundingBox();
      for(let turn=0;turn<4;turn++){
        await composer.fill('长对话布局检查');await composer.press('Enter');
        await until(()=>composer.isEnabled());
      }
      const card=await scrollingPage.locator('.assistant-panel').boundingBox();
      assert(Math.abs(card.height-initialCard.height)<1,'对话增加只能滚动内部列表，不能拉长卡片 '+JSON.stringify({width,initialCard,card}));
      const list=scrollingPage.locator('.chat-messages'),inputBounds=await composer.boundingBox();
      assert(inputBounds.y+inputBounds.height<=card.y+card.height,'输入框应保留在卡片内部底部');
      assert.equal(await list.evaluate(el=>el.scrollHeight>el.clientHeight&&el.scrollHeight-el.clientHeight-el.scrollTop<3),true,'长对话最新消息应自动滚动至可见区域');
      assert.equal(await scrollingPage.evaluate(()=>scrollY),0,'收到回复只滚动消息列表，不移动整个页面');
      await list.focus();await scrollingPage.keyboard.press('Home');await until(()=>list.evaluate(el=>el.scrollTop<3));
      await scrollingPage.keyboard.press('End');await until(()=>list.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<3));
      await list.hover();await scrollingPage.mouse.wheel(0,-600);await until(()=>list.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop>20));
      await list.focus();await scrollingPage.keyboard.press('End');
      assert.equal(await scrollingPage.getByLabel('任务状态通知').count(),0);
      await scrollingPage.screenshot({path:join(output,'stable-dialogue-'+width+'x'+height+'.png'),fullPage:true});
    }
    assert.equal(scrollingRequests,16,'长对话只使用显式浏览器可控响应，不触发额外模型请求');
    const resizedLog=scrollingPage.getByRole('log',{name:'访客对话'});
    for(let resize=0;resize<3;resize++){
      await resizedLog.focus();await scrollingPage.keyboard.press('Home');await until(()=>resizedLog.evaluate(el=>el.scrollTop<3));
      await scrollingPage.setViewportSize({width:1440,height:900});await pause(100);
      assert.equal(await resizedLog.evaluate(el=>el.scrollTop<3),true,'人工向上阅读时调整窗口不能强制跳到末尾');
      await resizedLog.focus();await scrollingPage.keyboard.press('End');await until(()=>resizedLog.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<3));
      await scrollingPage.setViewportSize({width:390,height:844});
      await until(()=>resizedLog.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<3));
    }
    await scrollingPage.unroute('**/api/booth/chat');
    await scrollingPage.route('**/api/booth/chat',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({data:'可控错误：服务暂不可用，请稍后重试或直接选择物品。'})}));
    const errorCardBefore=await scrollingPage.locator('.assistant-panel').boundingBox();
    const errorInput=scrollingPage.getByRole('textbox',{name:'告诉助手你的需求'});await errorInput.fill('检查错误提示');await errorInput.press('Enter');
    await scrollingPage.getByRole('alert').filter({hasText:'可控错误'}).waitFor();
    assert.equal((await scrollingPage.locator('.assistant-panel').boundingBox()).height,errorCardBefore.height,'技术错误提示也不能拉长对话卡');
    assert.equal(await errorInput.inputValue(),'检查错误提示');
  }finally{await scrollingPage.close();}
  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const touchPage=await touchContext.newPage();await touchPage.goto(webUrl);await touchPage.getByRole('textbox',{name:'告诉助手你的需求'}).waitFor();
  await touchPage.screenshot({path:join(output,'mobile-dialogue-initial.png'),fullPage:true});
  const touchInput=await touchPage.getByRole('textbox',{name:'告诉助手你的需求'}).boundingBox();
  assert(touchInput&&touchInput.y<844,'手机初始首屏应呈现对话输入');
  assert.equal(await touchPage.getByRole('button',{name:'选择矿泉水',exact:true}).isVisible(),true,'窄屏目录也默认展开');
  await touchPage.getByText('浏览物品 · 手动选择',{exact:true}).tap();
  assert.equal(await touchPage.getByRole('button',{name:'选择矿泉水',exact:true}).isVisible(),false,'仍可手动折叠目录');
  await touchPage.getByText('浏览物品 · 手动选择',{exact:true}).tap();
  await touchPage.getByRole('button',{name:'选择矿泉水',exact:true}).tap();
  await touchPage.getByRole('button',{name:'增加数量',exact:true}).tap();
  assert.equal(await touchPage.getByLabel('已选数量').innerText(),'2');
  const touchRequests=requests.length;
  await touchPage.getByRole('button',{name:'开始新体验',exact:true}).tap();
  assert.equal(await touchPage.locator('.product-card[aria-pressed="true"]').count(),0);
  await touchPage.route('**/api/booth/chat',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({reply:('触摸滚动回归使用可控响应，不代表真实模型验证。\n').repeat(15),selection:null})}));
  const touchComposer=touchPage.getByRole('textbox',{name:'告诉助手你的需求'});await touchComposer.fill('触摸滚动检查');await touchPage.getByRole('button',{name:'发送需求'}).tap();await until(()=>touchComposer.isEnabled());
  const touchLog=touchPage.getByRole('log',{name:'访客对话'}),touchBox=await touchLog.boundingBox(),touchBefore=await touchLog.evaluate(el=>el.scrollTop);
  assert(touchBefore>0,'长回复应先滚动到末尾');
  const touchSession=await touchContext.newCDPSession(touchPage),touchX=touchBox.x+touchBox.width/2,touchY=touchBox.y+10;
  await touchSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchX,y:touchY}]});
  for(let step=1;step<=8;step++){await touchSession.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchX,y:touchY+step*(touchBox.height-20)/8}]});await pause(20);}
  await touchSession.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await until(async()=>await touchLog.evaluate(el=>el.scrollTop)<touchBefore);
  await touchSession.detach();
  assert.equal(requests.length,touchRequests);await touchContext.close();

  // Load a larger, explicitly synthetic catalog through the test API's normal
  // configuration. It never changes the running demo catalog or sends a task.
  const catalog=(await (await fetch(apiUrl+'/api/booth')).json()).products;
  const largerCatalog=[...catalog,...Array.from({length:24},(_,i)=>({...catalog[i%catalog.length],id:'layout-'+i,name:'测试物品 '+(i+1)}))];
  const catalogPath=join(output,'layout-catalog.json');writeFileSync(catalogPath,JSON.stringify(largerCatalog));
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{...env,OPENAI_API_KEY:'',BOOTH_CATALOG_PATH:catalogPath});await ready(apiUrl+'/api/health',api);
  await page.setViewportSize({width:1366,height:768});await page.reload();
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).waitFor();
  assert.equal(await page.locator('.product-card').count(),28);
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));
  const largerHeight=(await page.locator('.catalog-panel').boundingBox()).height;
  assert(Math.abs(largerHeight-desktopCatalogHeight)<1,'目录从4款增至28款不应增加目录卡或页面主体高度');
  const list=page.getByRole('region',{name:'可选物品列表'}),listBox=await list.boundingBox();
  const scrollMetrics=await list.evaluate(el=>({scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,overflow:getComputedStyle(el).overflowY,rows:getComputedStyle(el).gridTemplateRows,firstHeight:el.firstElementChild.getBoundingClientRect().height}));
  assert(scrollMetrics.scrollHeight>scrollMetrics.clientHeight,'更多物品应在独立滚动区内 '+JSON.stringify(scrollMetrics));
  await page.mouse.move(listBox.x+listBox.width/2,listBox.y+listBox.height/2);await page.mouse.wheel(0,500);
  await until(()=>list.evaluate(el=>el.scrollTop>0));
  await list.focus();await page.keyboard.press('End');
  await page.getByRole('button',{name:'选择测试物品 24',exact:true}).click();
  await page.getByRole('region',{name:'取物确认'}).getByRole('heading',{name:'测试物品 24',exact:true}).waitFor();
  assert.equal(await page.getByLabel('已选数量').innerText(),'1');
  assert.equal(await page.getByRole('button',{name:'增加数量',exact:true}).isDisabled(),true,'末项沿用蔬菜礼盒的数量上限1');
  assert.equal(await page.evaluate(()=>window.scrollY),0,'在商品列表内浏览和选品不应推走首屏确认区');
  const lastConfirm=await page.getByRole('button',{name:'确认取物',exact:true}).boundingBox();
  assert(lastConfirm&&lastConfirm.y+lastConfirm.height<=768,'列表末项仍可在首屏确认');
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  await page.getByRole('button',{name:'增加数量',exact:true}).click();
  assert.equal(await page.getByLabel('已选数量').innerText(),'2');
  assert.equal(requests.length,touchRequests,'浏览、选品和数量调整不能自动发单');
  assert.equal(chatRequests.length,10,'目录操作不能增加模型请求');
  await page.screenshot({path:join(output,'large-catalog-fixture.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const report={passed:true,robotRequests:requests.length,viewports:6,touchEmulation:true,keyboardChat:true,
    storageSubmission:{failureBlocksSend:true,busyRecovered:true,pendingPreserved:true,reloadWithoutSend:true,sameRequestIdOnRetry:true,successCleanup:true},
    taskNotifications:{actualAcceptanceAndCompletion:true,duplicateCallbackAndSnapshotDeduplicated:true,nativeSseReconnectDeduplicated:true,staleHttpSnapshotIgnored:true,experienceIsolation:true,excludedFromModelHistory:true,automaticModelRequests:0},
    catalogLayout:{defaultExpanded:true,desktopConfirmationInViewport:true,largeCatalogIndependentScroll:true,mouseAndKeyboardScroll:true,manualCollapse:true},
    visitorPresentation:{idleWithoutHistoricalTask:true,historyPreserved:true,fixedDialogueHeight:true,latestMessageVisible:true,mouseKeyboardAndTouchScroll:true,conversationFixtures:17,realAiCalls:0},
    statusPresentation:{stateColorsAndIcons:true,globalAlertOverridesCompletion:true,visitorCopyPreservesUncertainty:true,rawDetailsInOperatorDialog:true},
    flows:['任务通知等待实际受理及完成','故障/受理不明/人工处理/全局告警通知','任务通知去重与SSE重连','任务通知不进入AI历史且零额外请求','紧凑任务卡、目录与确认自适应排列及插画保留','顶部精简与工作人员凭据缺失提示','配置缺口提前提示与零发单','受理后等待回调','完成','拒绝','故障与现场释放','反馈丢失零重发','跨浏览器锁','独立进程重启','GPT建议界面（可控响应）','GPT错误保留输入','迟到AI不覆盖改选/数量/已确认发单','新体验隔离旧回复/错误并保留任务','跨浏览器任务变化保护','设备时钟快慢1小时仍正确提醒','等待提醒与重连保持占用','执行中人工入口不取消','目录默认展开与手动折叠','分类'],realOpenAICall:false,artifacts:output};
  writeFileSync(join(output,'api.log'),api.logs);
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{
  releaseReceipt?.();
  for(const t of callbacks)clearTimeout(t);await browser?.close();for(const p of [...children])await stop(p);
  if(robot)await new Promise(r=>robot.close(r));
 }
})().catch(e=>{console.error(e);console.error('Artifacts retained at '+output);process.exitCode=1;});
