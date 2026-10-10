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
(async()=>{
 let browser,robot;const callbacks=new Set();let mode='success',requests=[],apiUrl='';
 try{
  const apiPort=await port(),webPort=await port(),robotPort=await port();apiUrl='http://127.0.0.1:'+apiPort;const webUrl='http://127.0.0.1:'+webPort;
  robot=createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    assert.equal(req.url,'/api/task/dispatch');assert.equal(req.method,'POST');
    const command=JSON.parse(body);assert.deepEqual(Object.keys(command).sort(),['count','item','location']);requests.push(command);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:1,data:mode==='rejected'?'测试拒绝':'received',success:mode!=='rejected'}));
    if(mode==='success'||mode==='error'){const selected=mode;const t=setTimeout(async()=>{
      callbacks.delete(t);await fetch(apiUrl+(selected==='error'?'/api/task/error':'/api/task/finished'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selected==='error'?{message:'测试故障：机械臂无法自动恢复'}:{result:'success'})}).catch(()=>{});
    },1600);callbacks.add(t);}
  });await new Promise(r=>robot.listen(robotPort,'127.0.0.1',r));
  const env={PORT:String(apiPort),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:'http://127.0.0.1:'+robotPort+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',OPENAI_API_KEY:'',BOOTH_OPERATOR_TOKEN:'browser-test-operator'};
  let api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(webUrl);await page.getByText('服务已连接',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'告诉助手你的需求'}).isDisabled(),true);
  await page.screenshot({path:join(output,'desktop-initial.png'),fullPage:true});
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
  await page.getByRole('button',{name:'增加数量',exact:true}).click();
  assert.equal(await page.getByLabel('已选数量').innerText(),'2');
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  assert.equal(requests[0].count,2);
  await page.locator('.task-panel.succeeded').waitFor();await page.screenshot({path:join(output,'desktop-success.png'),fullPage:true});

  mode='rejected';await page.getByRole('button',{name:'选择纪念品',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.rejected').waitFor();
  mode='error';await page.getByRole('button',{name:'选择小面包',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.fault').waitFor();
  await page.screenshot({path:join(output,'desktop-fault.png'),fullPage:true});
  await page.getByRole('link',{name:'工作人员入口'}).click();await page.getByLabel('工作人员凭据').fill('browser-test-operator');await page.getByRole('checkbox').check();await page.getByRole('button',{name:'解除本地占用'}).click();await page.locator('.task-panel.resolved').waitFor();await page.getByRole('button',{name:'关闭工作人员入口'}).click();

  mode='silent';const before=requests.length;
  await page.route('**/api/booth/requests',async route=>{await route.fetch();await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({data:'测试：反馈丢失'})});},{times:1});
  await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  await page.getByRole('alert').filter({hasText:'反馈丢失'}).waitFor();assert.equal(requests.length,before+1);
  const otherContext=await browser.newContext(),other=await otherContext.newPage();await other.goto(webUrl);await other.locator('.task-panel.executing').waitFor();
  await other.getByRole('button',{name:'选择纪念品',exact:true}).click();assert.equal(await other.getByRole('button',{name:'请等待当前任务',exact:true}).isDisabled(),true);
  await otherContext.close();
  const taskId=(await (await fetch(apiUrl+'/api/booth')).json()).active.id;
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  await page.getByText('服务已连接',{exact:true}).waitFor();await page.reload();await page.locator('.task-panel.executing').waitFor();assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).active.id,taskId);assert.equal(requests.length,before+1);
  await fetch(apiUrl+'/api/task/finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({result:'success'})});await page.locator('.task-panel.succeeded').waitFor();

  // Browser only fixture: no request is sent to OpenAI; this checks recommendation UX, not model quality.
  await stop(api);api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{...env,OPENAI_API_KEY:'browser-fixture-not-a-real-key'});await ready(apiUrl+'/api/health',api);
  await page.route('**/api/booth/chat',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({reply:'已为你选择两瓶矿泉水，请在取物栏确认。',selection:{productId:'water',count:2}})}));
  await page.reload();const input=page.getByRole('textbox',{name:'告诉助手你的需求'});await until(()=>input.isEnabled());
  await input.fill('帮我选两瓶水');await page.getByRole('button',{name:'发送需求'}).click();await page.getByText('已为你选择两瓶矿泉水，请在取物栏确认。',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('已选数量').innerText(),'2');assert.equal(requests.length,before+1);
  await page.unroute('**/api/booth/chat');await page.route('**/api/booth/chat',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({data:'测试：助手暂不可用'})}));
  await input.fill('再帮我看看');await page.getByRole('button',{name:'发送需求'}).click();await page.getByRole('alert').filter({hasText:'助手暂不可用'}).waitFor();assert.equal(await input.inputValue(),'再帮我看看');

  for(const [width,height] of [[1440,1000],[1024,768],[768,1024],[390,844],[320,568]]){
    await page.setViewportSize({width,height});await page.screenshot({path:join(output,'viewport-'+width+'x'+height+'.png'),fullPage:true});
    const metrics=await page.evaluate(()=>({width:document.documentElement.scrollWidth,cardCount:document.querySelectorAll('.product-card').length}));
    assert(metrics.width<=width,'Horizontal overflow '+JSON.stringify({width,metrics}));assert.equal(metrics.cardCount,4);
  }
  await page.getByRole('button',{name:'饮品',exact:true}).click();assert.equal(await page.locator('.product-card').count(),1);await page.getByRole('button',{name:'全部',exact:true}).click();
  assert.deepEqual(errors,[]);
  const report={passed:true,robotRequests:requests.length,viewports:5,flows:['受理后等待回调','完成','拒绝','故障与现场释放','反馈丢失零重发','跨浏览器锁','独立进程重启','GPT建议界面（可控响应）','GPT错误保留输入','分类'],realOpenAICall:false,artifacts:output};
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{
  for(const t of callbacks)clearTimeout(t);await browser?.close();for(const p of [...children])await stop(p);
  if(robot)await new Promise(r=>robot.close(r));
 }
})().catch(e=>{console.error(e);console.error('Artifacts retained at '+output);process.exitCode=1;});
