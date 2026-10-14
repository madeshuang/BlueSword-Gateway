// Browser/HTTP boundary only: controlled AI responses, no database or robot service.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {randomBytes,randomUUID}=require('node:crypto');
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
  if(req.method==='POST'&&req.url==='/api/booth/experiences'){
    req.resume();res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({id:randomUUID(),token:randomBytes(32).toString('hex')}));
  }
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
    send:style(document.querySelector('.chat-composer button')),inputDisabled:document.querySelector('.chat-composer textarea').disabled,
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
    const emptyHeight=(await input.boundingBox()).height;
    await input.fill('第一行\n第二行\n第三行');
    assert((await input.boundingBox()).height>emptyHeight,'多行草稿应自动增高');
    await input.fill(Array.from({length:30},(_,i)=>'第'+(i+1)+'行：长文本输入检查').join('\n'));
    const capped=await input.evaluate(el=>({height:el.getBoundingClientRect().height,overflow:getComputedStyle(el).overflowY,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}));
    assert(capped.height<=120&&capped.scrollHeight>capped.clientHeight,'长草稿应限制高度并保留内部滚动');
    assert.equal(capped.overflow,'auto');
    await input.focus();await page.keyboard.press('Control+End');
    assert(await input.evaluate(el=>el.scrollTop>0),'输入框内应能滚动到末尾');
    await page.screenshot({path:join(output,'desktop-long-draft.png'),fullPage:true});
    await input.fill('短消息');assert.equal((await input.boundingBox()).height,emptyHeight,'删短后应收回高度');
    await input.fill('');
    async function heldChat(action,reply='可控回复',status=200){
      let release,arrived,finished,completed,routeStarted=false;const held=new Promise(r=>release=r),started=new Promise(r=>arrived=r),done=new Promise(r=>finished=r);
      const routeHandler=async route=>{routeStarted=true;completed=page.waitForResponse(r=>r.url().endsWith('/api/booth/chat'));arrived();try{await held;await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{reply,selection:null}:{data:reply})});}finally{finished();}};
      await page.route('**/api/booth/chat',routeHandler);
      try{
        await action(started,()=>release());
      }finally{release();if(routeStarted){await done;await completed;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}await page.unroute('**/api/booth/chat',routeHandler);}
    }
    await heldChat(async started=>{
      await input.fill('第一行');await input.press('Shift+Enter');await input.pressSequentially('第二行');
      assert.equal(await input.inputValue(),'第一行\n第二行');
      const before=requests.length;await input.press('Enter');await started;
      assert.equal(requests.length,before+1);assert.equal(requests.at(-1).messages.at(-1).content,'第一行\n第二行');
      assert.equal(await input.inputValue(),'');assert.equal((await input.boundingBox()).height,emptyHeight);
    },'键盘发送成功');
    await page.getByText('键盘发送成功',{exact:true}).waitFor();passed.push('Shift+Enter换行与Enter发送');
    await input.fill('中文候选词');const beforeComposition=requests.length;
    await input.dispatchEvent('compositionstart',{data:'中文'});
    await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
    await input.press('Enter');
    assert.equal(requests.length,beforeComposition,'组合输入期间Enter不得发送');
    await input.dispatchEvent('compositionend',{data:'中文候选词'});
    await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229});
    assert.equal(requests.length,beforeComposition,'候选确认的229键码不得误发送');
    await heldChat(async started=>{await input.press('Enter');await started;},'中文提交成功');
    await page.getByText('中文提交成功',{exact:true}).waitFor();passed.push('中文组合事件和候选确认保护');
    for(const reducedMotion of ['no-preference','reduce']){
      await page.emulateMedia({reducedMotion});
      await heldChat(async started=>{
        await input.fill('等待反馈检查');await send.click();await started;
        assert.equal(await send.isDisabled(),true);assert.equal(await input.isEnabled(),true);
        await page.getByText('正在回复你',{exact:true}).waitFor();
        if(reducedMotion==='reduce'){
          assert.equal(await page.locator('.chat-send-waiting').isVisible(),true,'减少动态效果时应显示文字等待提示');
          assert.equal(await page.locator('.chat-send-spinner').isVisible(),false,'减少动态效果时不能留下静止转圈图标');
        }else{
          const spinner=page.locator('.chat-composer button .spin');
          assert.equal(await spinner.isVisible(),true);
          const before=await spinner.evaluate(el=>getComputedStyle(el).transform);await pause(100);
          assert.notEqual(await spinner.evaluate(el=>getComputedStyle(el).transform),before,'正常动画模式转圈应持续变化');
        }
        const beforeDraft=requests.length;await input.fill('等待期间的下一条草稿');await input.press('Enter');
        assert.equal(requests.length,beforeDraft,'等待期间Enter不得重复发送');
        assert.equal(await input.inputValue(),'等待期间的下一条草稿');
        await page.screenshot({path:join(output,'waiting-'+reducedMotion+'.png'),fullPage:true});
        await page.locator('.assistant-panel').screenshot({path:join(output,'waiting-panel-'+reducedMotion+'.png')});
      },'等待反馈检查完成');
      await page.getByText('等待反馈检查完成',{exact:true}).last().waitFor();
    }
    await page.emulateMedia({reducedMotion:'no-preference'});await input.fill('');
    await input.fill('自然换行检查。'.repeat(10));
    const wideDraftHeight=(await input.boundingBox()).height;
    await page.setViewportSize({width:390,height:844});
    await until(async()=>(await input.boundingBox()).height>wideDraftHeight);
    assert.equal(await input.inputValue(),'自然换行检查。'.repeat(10),'窗口缩窄应重新计算高度并保留草稿');
    await input.fill('');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:width===390?844:900});
      const shellHeight=(await page.locator('.assistant-panel').boundingBox()).height;
      await input.fill('这是需要自然换行的长草稿。'.repeat(50));
      assert((await input.boundingBox()).height<=120);assert((await input.boundingBox()).height>emptyHeight);
      assert.equal((await page.locator('.assistant-panel').boundingBox()).height,shellHeight);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await input.evaluate(el=>{el.scrollTop=0;});
      await page.screenshot({path:join(output,'long-draft-'+width+'.png'),fullPage:true});
      await page.locator('.assistant-panel').screenshot({path:join(output,'long-draft-panel-'+width+'.png')});
    }
    passed.push('自动增高、上限滚动、窄屏换行及两种等待反馈');
    await page.setViewportSize({width:1440,height:900});await input.fill('');
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
      await input.fill('  请帮我看看\n第二行需求  ');await send.click();await started;assert.equal(await input.inputValue(),'');
    },'测试失败：请重试',503);
    await page.getByRole('alert').filter({hasText:'测试失败：请重试'}).waitFor();
    assert.equal(await input.inputValue(),'  请帮我看看\n第二行需求  ','失败时恢复原始输入，包括用户原来的空格和换行');
    assert((await input.boundingBox()).height>emptyHeight,'恢复多行输入后也应自动增高');passed.push('请求失败恢复原始输入');
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
