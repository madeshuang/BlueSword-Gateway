// Browser/HTTP regression: real gateway and SQLite, controlled local robot replies.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {resolve,join,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-order-feedback-'));
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){for(let n=0;n<150;n++){if(await check())return;await pause(40);}throw Error('Condition timed out');}
async function port(){const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const value=server.address().port;await new Promise(ok=>server.close(ok));return value;}
function launch(args,env,cwd=root){const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.logs='';child.stdout.on('data',data=>child.logs+=data);child.stderr.on('data',data=>child.logs+=data);return child;}
async function ready(url,child){await until(async()=>{if(child.exitCode!==null)throw Error(child.logs);try{return(await fetch(url)).ok;}catch{return false;}});}
(async()=>{
 let browser,peer,pendingReply;const passed=[],errors=[],received=[];
 try{
  peer=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;assert.equal(req.url,'/api/task/dispatch');received.push(JSON.parse(body));pendingReply=res;});
  await new Promise(ok=>peer.listen(0,'127.0.0.1',ok));
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  for(const mode of ['http','simulator']){
   const apiUrl='http://127.0.0.1:'+await port(),webUrl='http://127.0.0.1:'+await port();
   const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:apiUrl.split(':').at(-1),BOOTH_ROBOT_MODE:mode,ROBOT_DISPATCH_URL:'http://127.0.0.1:'+peer.address().port+'/api/task/dispatch',BOOTH_DB_PATH:join(output,mode+'.sqlite'),BOOTH_CATALOG_PATH:join(root,'config/booth-catalog.example.json'),BOOTH_CATALOG_CONFIRMED:'true',BOOTH_OPERATOR_TOKEN:'feedback-staff',ROBOT_TIMEOUT_MS:'5000',BOOTH_TASK_REMINDER_MS:'500',OPENAI_API_KEY:'',DEEPSEEK_API_KEY:'',BOOTH_AI_PROVIDER:'openai'});
   await ready(apiUrl+'/api/health',api);
   const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',webUrl.split(':').at(-1),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
   const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{
    const onmessage=Object.getOwnPropertyDescriptor(EventSource.prototype,'onmessage');let delayed;
    Object.defineProperty(EventSource.prototype,'onmessage',{...onmessage,set(handler){onmessage.set.call(this,event=>{if(window.holdTaskEvents)delayed=()=>handler.call(this,event);else handler.call(this,event);});}});
    window.releaseTaskEvents=()=>{window.holdTaskEvents=false;delayed?.();delayed=undefined;};
   });
   const post=async(path,body={})=>{const response=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
   await page.goto(webUrl);await page.locator('.task-panel.idle').waitFor();
   const order=page.getByRole('region',{name:'取物确认',exact:true});
   await page.getByRole('button',{name:'选择兰剑智能扑克牌',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();
   await page.locator('.task-panel.submitting').waitFor();await until(()=>!!pendingReply);
   await order.getByRole('heading',{name:'请选择物品',exact:true}).waitFor();
   await page.getByRole('button',{name:'选择兰剑智能圆珠笔',exact:true}).click();
   await order.getByRole('heading',{name:'兰剑智能圆珠笔',exact:true}).waitFor();
   assert.equal(await order.getByRole('button',{name:'请等待当前任务',exact:true}).isDisabled(),true);
   await order.getByRole('button',{name:'增加数量',exact:true}).click();assert.equal(await order.getByLabel('已选数量').textContent(),'2');
   pendingReply.end(JSON.stringify({success:true,data:'received'}));pendingReply=undefined;
   await page.locator('.task-panel.executing').waitFor();await page.waitForTimeout(80);
   await order.getByRole('heading',{name:'兰剑智能圆珠笔',exact:true}).waitFor();
   assert.equal(await order.getByLabel('已选数量').textContent(),'2','迟到接单回复不能清除后来选择');
   await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
   assert.equal(await order.getByRole('button',{name:'确认取物',exact:true}).isEnabled(),true);
   assert.equal(received.at(-1).items[0].item,'playing_card_box');
   passed.push(mode+'：任务建立后清空原选择，等待时可改选但不能提交，接单后保留新选择');
   await page.getByRole('button',{name:'开始新体验',exact:true}).click();
   await page.getByRole('button',{name:'选择水杯',exact:true}).click();await order.getByRole('button',{name:'增加数量',exact:true}).click();
   await page.getByRole('button',{name:'选择兰剑智能打火机',exact:true}).click();
   await page.locator('.feedback-error').filter({hasText:'每单最多两件'}).waitFor();
   await order.getByRole('button',{name:'减少数量',exact:true}).click();
   await until(async()=>await page.locator('.feedback-error').count()===0);
   passed.push(mode+'：减少数量后清除已经失效的两件上限提示');
   await page.getByRole('button',{name:'开始新体验',exact:true}).click();
   await page.getByRole('button',{name:'选择兰剑智能扑克牌',exact:true}).click();
   const beforeRejected=received.length;
   await page.route('**/api/booth/requests',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({data:'扑克牌当前可取数量不足，请重新选择。'})}),{times:1});
   await page.getByRole('button',{name:'确认取物',exact:true}).click();
   await page.locator('.feedback-error').filter({hasText:'扑克牌当前可取数量不足'}).waitFor();
   await page.getByRole('button',{name:'移除兰剑智能扑克牌',exact:true}).click();
   assert.equal(await page.locator('.feedback-error').count(),0,'明确未提交的数量错误应在重新选择时清除');
   assert.equal(received.length,beforeRejected,'明确拒绝提交后没有机器人请求');
   passed.push(mode+'：明确未提交时可以重新选择，旧数量错误随改选消失');
   await page.getByRole('button',{name:'开始新体验',exact:true}).click();
   let dropped=false;
   await page.route('**/api/booth/requests',async route=>{await route.fetch();await route.abort();dropped=true;});
   await page.getByRole('button',{name:'选择兰剑智能打火机',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();
   await page.locator('.task-panel.submitting').waitFor();await until(()=>!!pendingReply);
   await page.getByRole('button',{name:'选择水杯',exact:true}).click();
   pendingReply.end(JSON.stringify({success:true,data:'received'}));pendingReply=undefined;
   await page.locator('.task-panel.executing').waitFor();await until(()=>dropped);await page.waitForTimeout(80);
   assert.equal(await page.locator('.feedback-error').count(),0,'状态已确认后，迟到的网页请求失败不能重新显示未知请求提示');
   await order.getByRole('heading',{name:'水杯',exact:true}).waitFor();
   await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();await page.unroute('**/api/booth/requests');
   passed.push(mode+'：先收到任务状态再丢失网页回复，不显示旧错误或清除新选择');
   await page.getByRole('button',{name:'开始新体验',exact:true}).click();
   await page.evaluate(()=>window.holdTaskEvents=true);await page.route('**/api/booth',route=>route.abort());
   await page.getByRole('button',{name:'选择打气筒',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await until(()=>!!pendingReply);
   pendingReply.end(JSON.stringify({success:true,data:'received'}));pendingReply=undefined;
   await page.locator('.feedback-error').filter({hasText:'取物请求已提交，但暂时无法更新页面状态'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'开始新体验',exact:true}).isDisabled(),true,'状态未知时不能通过开始新体验绕过提交限制');
   assert.equal(await page.getByRole('button',{name:'核对这次取物',exact:true}).count(),0);
   await page.getByRole('button',{name:'选择水杯',exact:true}).click();
   assert.equal(await order.locator('.primary-button').isDisabled(),true,'任务已提交但状态未同步时不能提交下一单');
   await page.unroute('**/api/booth');await page.evaluate(()=>window.releaseTaskEvents());await page.locator('.task-panel.executing').waitFor();
   await until(async()=>await page.locator('.feedback-error').count()===0);await order.getByRole('heading',{name:'水杯',exact:true}).waitFor();
   await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
   passed.push(mode+'：发单成功但刷新失败时准确提示，状态恢复后清除提示且保留新选择');
   await page.getByRole('button',{name:'开始新体验',exact:true}).click();
   let missedRequest;
   await page.route('**/api/booth/requests',async route=>{missedRequest={body:route.request().postDataJSON(),token:route.request().headers()['x-booth-experience']};await route.abort();});
   await page.getByRole('button',{name:'选择兰剑智能扑克牌',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();
   await page.locator('.feedback-error').filter({hasText:'尚未收到取物确认的反馈'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'核对这次取物',exact:true}).isEnabled(),true,'未知请求仍保留核对入口');
   await page.unroute('**/api/booth/requests');
   const recovered=fetch(apiUrl+'/api/booth/requests',{method:'POST',headers:{'Content-Type':'application/json','X-Booth-Experience':missedRequest.token},body:JSON.stringify(missedRequest.body)});
   await page.locator('.task-panel.submitting').waitFor();await until(()=>!!pendingReply);
   pendingReply.end(JSON.stringify({success:true,data:'received'}));pendingReply=undefined;
   await recovered;await page.locator('.task-panel.executing').waitFor();
   await until(async()=>await page.locator('.feedback-error').count()===0);
   await order.getByRole('heading',{name:'请选择物品',exact:true}).waitFor();
   await page.getByRole('alert').filter({hasText:'等待时间较长'}).waitFor();
   await post('/api/task/error',{message:'本机故障检查'});await page.locator('.task-panel.fault').waitFor();
   await page.getByText('这次取物需要工作人员协助，是否结束尚未确认',{exact:false}).first().waitFor();
   passed.push(mode+'：未知请求可核对，接单后旧红字消失，等待提醒与真实故障仍正常显示');
   await context.close();
  }
  assert.deepEqual(errors,[]);writeFileSync(join(output,'report.json'),JSON.stringify({scope:'两种配置模式的本机网页及HTTP检查，不证明真实设备动作',passed,errors},null,2));console.log(JSON.stringify({output,passed},null,2));
 }catch(error){writeFileSync(join(output,'failure.txt'),String(error.stack));console.error(error);process.exitCode=1;}
 finally{pendingReply?.destroy();await browser?.close();peer?.closeAllConnections();await new Promise(ok=>peer?.close(ok)??ok());for(const child of children){writeFileSync(join(output,'process-'+child.pid+'.log'),child.logs);child.kill();}console.log('Artifacts: '+output);}
})();
