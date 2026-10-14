// Browser/HTTP boundary only: controlled AI responses, no database or robot service.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdtempSync,mkdirSync,readFileSync,writeFileSync}=require('node:fs');
const {resolve,join,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json'));
mkdirSync(join(root,'.tmp'),{recursive:true});
const output=mkdtempSync(join(root,'.tmp','booth-chat-interaction-'));
const products=JSON.parse(readFileSync(join(root,'config/booth-catalog.example.json'),'utf8'));
const snapshot={products,tasks:[],active:null,waiting:null,alert:null,mode:'simulator',catalogConfirmed:false,
  dispatch:{ready:false,reason:null},operator:{configured:false},ai:{provider:'OpenAI',model:'browser-fixture',configured:true}};
const streams=new Set(),requests=[],errors=[],passed=[];
const api=createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/api/booth/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});streams.add(res);
    res.write('data: '+JSON.stringify(snapshot)+'\n\n');res.on('close',()=>streams.delete(res));return;
  }
  if(req.method==='GET'&&req.url==='/api/booth'){
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(snapshot));
  }
  errors.push('Unexpected API request: '+req.method+' '+req.url);res.writeHead(404);res.end();
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function until(check){for(let i=0;i<100;i++){if(await check())return;await pause(50);}throw new Error('Browser condition timed out');}
async function presentation(page){return page.evaluate(()=>{
  const style=el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,color:s.color,opacity:s.opacity,filter:s.filter};};
  return {sections:['.booth-shell','.assistant-panel','.chat-messages','.chat-composer'].map(selector=>({selector,...style(document.querySelector(selector))})),
    send:style(document.querySelector('.chat-composer button')),inputDisabled:document.querySelector('.chat-composer input').disabled,
    bootScreens:document.querySelectorAll('.boot-screen').length,modals:document.querySelectorAll('.modal-backdrop').length};
});}
(async()=>{
  let web,browser;
  try{
    await new Promise(r=>api.listen(0,'127.0.0.1',r));const apiUrl='http://127.0.0.1:'+api.address().port,webPort=await freePort(),webUrl='http://127.0.0.1:'+webPort;
    web=spawn(process.execPath,[join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],
      {cwd:join(root,'apps/web'),env:{...process.env,VITE_API_TARGET:apiUrl},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let logs='';web.stdout.on('data',d=>logs+=d);web.stderr.on('data',d=>logs+=d);
    await until(async()=>{if(web.exitCode!==null)throw new Error(logs);try{return (await fetch(webUrl)).ok;}catch{return false;}});
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.url().endsWith('/api/booth/chat'))requests.push(r.postDataJSON());});
    await page.goto(webUrl);const input=page.getByRole('textbox',{name:'告诉助手你的需求'}),send=page.getByRole('button',{name:'发送需求',exact:true});
    await input.waitFor();await until(()=>input.isEnabled());
    async function heldChat(action,reply='可控回复',status=200){
      let release,arrived,finished,completed,routeStarted=false;const held=new Promise(r=>release=r),started=new Promise(r=>arrived=r),done=new Promise(r=>finished=r);
      const routeHandler=async route=>{routeStarted=true;completed=page.waitForResponse(r=>r.url().endsWith('/api/booth/chat'));arrived();try{await held;await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{reply,selection:null}:{data:reply})});}finally{finished();}};
      await page.route('**/api/booth/chat',routeHandler);
      try{
        await action(started,()=>release());
      }finally{release();if(routeStarted){await done;await completed;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}await page.unroute('**/api/booth/chat',routeHandler);}
    }
    let readyStyle,waitingStyle;
    // Hold the HTTP response: input must be cleared before any AI answer exists.
    await heldChat(async started=>{
      await input.fill('你是谁');readyStyle=await presentation(page);await send.click();await started;
      assert.equal(await input.inputValue(),'','发送后应立即清空输入，而非等待回复');
      assert.equal(await send.isDisabled(),true,'等待期间阻止重复发送');
      assert.equal(await page.getByText('正在回复你',{exact:true}).isVisible(),true,'保留清楚的等待反馈');
      assert.equal(await page.locator('.chat-bubble.user').last().innerText(),'你是谁');
      waitingStyle=await presentation(page);assert.deepEqual(waitingStyle.sections,readyStyle.sections,'等待期间不改变页面和对话组件颜色、透明度或滤镜');
      assert.equal(readyStyle.send.opacity,'1');assert.equal(waitingStyle.send.opacity,'0.48','按钮沿用正常禁用透明度');
      assert.equal(waitingStyle.bootScreens,0);assert.equal(waitingStyle.modals,0);
      await page.screenshot({path:join(output,'waiting-success.png'),fullPage:true});
    },'成功回复');
    await page.getByText('成功回复',{exact:true}).waitFor();assert.equal(await input.inputValue(),'');passed.push('立即清空与请求成功');
    await heldChat(async started=>{
      await input.fill('  请帮我看看  ');await send.click();await started;assert.equal(await input.inputValue(),'');
    },'测试失败：请重试',503);
    await page.getByRole('alert').filter({hasText:'测试失败：请重试'}).waitFor();
    assert.equal(await input.inputValue(),'  请帮我看看  ','失败时恢复原始输入，包括用户原来的空格');passed.push('请求失败恢复原始输入');
    await heldChat(async started=>{
      await input.fill('失败前的输入');await send.click();await started;
      assert.equal(await input.isEnabled(),true,'等待回复时可编辑下一条草稿');
      await input.fill('这是新的未发送草稿');
    },'测试失败：保留新草稿',503);
    await page.getByRole('alert').filter({hasText:'测试失败：保留新草稿'}).waitFor();
    assert.equal(await input.inputValue(),'这是新的未发送草稿','失败恢复不得覆盖用户新输入');passed.push('失败不覆盖新草稿');
    const prompts=page.locator('.quick-prompts button'),beforeQuick= requests.length;
    for(const draft of ['已有未发送草稿','   ']){
      await input.fill(draft);
      for(const prompt of await prompts.all())assert.equal(await prompt.isDisabled(),true,'已有草稿时快捷提问应暂时禁用');
      assert.equal(await input.inputValue(),draft);assert.equal(requests.length,beforeQuick);
    }
    await input.fill('');await until(()=>prompts.first().isEnabled());
    await heldChat(async started=>{
      await page.getByRole('button',{name:'这里有什么？',exact:true}).click();await started;
      assert.equal(requests.at(-1).messages.at(-1).content,'这里有什么？');
      await input.fill('快捷提问等待期间的新草稿');
    },'快捷提问成功');
    await page.getByText('快捷提问成功',{exact:true}).waitFor();
    assert.equal(await input.inputValue(),'快捷提问等待期间的新草稿');passed.push('快捷提问草稿保护及成功后保留新草稿');
    await heldChat(async started=>{
      await input.fill('普通提问');await send.click();await started;await input.fill('普通回复期间的新草稿');
    },'普通提问成功');
    await page.getByText('普通提问成功',{exact:true}).waitFor();assert.equal(await input.inputValue(),'普通回复期间的新草稿');passed.push('普通成功响应不清空新草稿');
    await input.fill('');
    await heldChat(async started=>{
      await page.getByRole('button',{name:'我想要一瓶水',exact:true}).click();await started;
    },'快捷提问失败',503);
    await page.getByRole('alert').filter({hasText:'快捷提问失败'}).waitFor();assert.equal(await input.inputValue(),'我想要一瓶水');passed.push('快捷提问失败恢复本次问题');
    await heldChat(async started=>{
      await input.fill('不应恢复的旧输入');await send.click();await started;await input.fill('临时新草稿');await input.fill('');
    },'主动清空后失败',503);
    await page.getByRole('alert').filter({hasText:'主动清空后失败'}).waitFor();assert.equal(await input.inputValue(),'','用户编辑后主动清空也不得恢复旧输入');passed.push('尊重用户主动清空');
    await heldChat(async started=>{
      await input.fill('上一轮体验的输入');await send.click();await started;
      await page.getByRole('button',{name:'开始新体验',exact:true}).click();await input.fill('新体验的草稿');
    },'旧体验迟到错误',503);
    await until(()=>page.locator('.chat-thinking').count().then(n=>n===0));assert.equal(await input.inputValue(),'新体验的草稿');
    assert.equal(await page.locator('.chat-error').count(),0);passed.push('新体验隔离迟到错误');
    await page.screenshot({path:join(output,'preserved-draft.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    writeFileSync(join(output,'report.json'),JSON.stringify({passed,chatRequests:requests.length,realAiCalls:0,robotCalls:0,readyStyle,waitingStyle},null,2));
    console.log(JSON.stringify({passed,output,realAiCalls:0,robotCalls:0}));
  }finally{
    await browser?.close();for(const stream of streams)stream.end();await new Promise(r=>api.close(r));
    if(web&&web.exitCode===null){const stopped=once(web,'exit');web.kill();await stopped;}
  }
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
