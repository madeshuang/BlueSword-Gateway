// Browser checks against the real gateway/SQLite and a local robot HTTP peer.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-integration-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<150;i++){if(await check())return;await pause(50);}throw new Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.logs='';p.stdout.on('data',d=>p.logs+=d);p.stderr.on('data',d=>p.logs+=d);return p;}
async function ready(url,process){await until(async()=>{if(process.exitCode!==null)throw new Error(process.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
 let browser,peer,pendingRobot,pendingAi;const errors=[],passed=[],received=[];
 try{
  let hold=false,holdAi=false;
  peer=createServer(async(req,res)=>{
   let body='';for await(const c of req)body+=c;
   if(req.url==='/v1/responses'){
    const reply={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'请核对扑克牌和圆珠笔各一件。',selection:[{productId:'playing_card_box',count:1},{productId:'pen_box',count:1}],taskStatusQuery:false})}]}]};
    if(holdAi){pendingAi=()=>res.end(JSON.stringify(reply));return;}res.end(JSON.stringify(reply));return;
   }
   assert.equal(req.url,'/api/task/dispatch');received.push(JSON.parse(body));
   if(hold){pendingRobot=res;return;}res.end(JSON.stringify({success:true,data:'received'}));
  });await new Promise(r=>peer.listen(0,'127.0.0.1',r));
  const upstream='http://127.0.0.1:'+peer.address().port,apiPort=await port(),apiUrl='http://127.0.0.1:'+apiPort,webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
  const ids=['lighter_box','playing_card_box','pen_box','bottle','table_tennis_ball_box','shuttlecock_tube','air_pump','aoliao','anmuxi','haoliyou','shupian'];
  const names=['打火机','扑克牌','圆珠笔','水杯','乒乓球','羽毛球','打气筒','奥利奥','安慕希','好丽友','薯片'];
  const products=ids.map((id,i)=>({id,name:names[i],category:'现场物品',subtitle:names[i],description:names[i],art:id,color:'#edf5ef',location:'练习架'+(i+1),initialStock:3,maxCount:3}));
  const catalog=join(output,'products.json');writeFileSync(catalog,JSON.stringify(products));
  const env={PORT:String(apiPort),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_CATALOG_PATH:catalog,BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_BASE_URL:upstream+'/v1',OPENAI_API_KEY:'local-fixture',DEEPSEEK_API_KEY:'',BOOTH_OPERATOR_TOKEN:'integration-staff',ROBOT_TIMEOUT_MS:'20000'};
  const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],env);await ready(apiUrl+'/api/health',api);
  const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  const post=async(path,body={},staff=false)=>{const r=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(staff?{'X-Operator-Token':'integration-staff'}:{})},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  await page.goto(webUrl);await page.locator('.task-panel.idle').waitFor();
  const order=page.getByRole('region',{name:'取物确认',exact:true});
  for(const name of names){
   const card=page.getByRole('button',{name:'选择'+name,exact:true});await card.click();
   assert(await card.locator('svg.product-art').isVisible());assert(await order.locator('svg.product-art').isVisible());
   await order.getByRole('button',{name:'移除'+name,exact:true}).click();
  }
  passed.push('11种物品的列表和确认区插图均显示');
  await page.getByRole('button',{name:'选择扑克牌',exact:true}).click();await page.getByRole('button',{name:'选择圆珠笔',exact:true}).click();
  await order.getByRole('heading',{name:'扑克牌',exact:true}).waitFor();await order.getByRole('heading',{name:'圆珠笔',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'增加数量',exact:true}).first().isDisabled(),true);
  await page.screenshot({path:join(output,'two-items-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  assert.deepEqual(received[0],{items:[{location:'练习架3',item:'pen_box',count:1},{location:'练习架2',item:'playing_card_box',count:1}]});
  assert.match(await page.locator('.task-panel h3').textContent(),/扑克牌/);assert.match(await page.locator('.task-panel h3').textContent(),/圆珠笔/);
  await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
  passed.push('两种各一件整单下发，完成通知后才显示完成');
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  await page.getByRole('button',{name:'选择扑克牌',exact:true}).click();await page.getByRole('button',{name:'增加数量',exact:true}).click();
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  assert.deepEqual(received[1],{items:[{location:'练习架2',item:'playing_card_box',count:2}]});await post('/api/task/finished');
  passed.push('同种两件合并为一项且上限为两件');
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  await page.getByRole('button',{name:'选择圆珠笔',exact:true}).click();hold=true;
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.submitting').waitFor();await until(()=>!!pendingRobot);
  await page.evaluate(()=>{location.hash='operations';});const dialog=page.getByRole('dialog');await dialog.waitFor();
  await dialog.getByLabel('工作人员凭据',{exact:true}).fill('integration-staff');await dialog.getByLabel('已补货物品',{exact:true}).selectOption('pen_box');
  await dialog.getByLabel('已核对并补满所选物品',{exact:true}).check();await dialog.getByRole('button',{name:'重置所选物品库存',exact:true}).click();
  await dialog.getByText('当前剩余 3 份 · 补满后 3 份',{exact:true}).waitFor();
  pendingRobot.end(JSON.stringify({success:false,data:'本机拒绝'}));pendingRobot=undefined;hold=false;
  await dialog.getByRole('button',{name:'关闭工作人员入口',exact:true}).click();await page.locator('.task-panel.rejected').waitFor();
  assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).products.find(p=>p.id==='pen_box').availableCount,3);
  passed.push('接单回复未返回时页面仍能补货，迟到拒绝不多退库存');
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  await post('/api/booth/operator/stock/reset-all',{confirmation:'已核对并补满全部库存'},true);
  await page.getByLabel('告诉助手你的需求').fill('扑克牌和圆珠笔各一件');await page.getByRole('button',{name:'发送需求',exact:true}).click();
  await order.getByRole('heading',{name:'扑克牌',exact:true}).waitFor();await order.getByRole('heading',{name:'圆珠笔',exact:true}).waitFor();assert.equal(received.length,3);
  passed.push('AI两项建议出现在确认区，确认前不发单');
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();holdAi=true;
  await page.getByLabel('告诉助手你的需求').fill('扑克牌和圆珠笔各一件');await page.getByRole('button',{name:'发送需求',exact:true}).click();await until(()=>!!pendingAi);
  await page.getByRole('button',{name:'选择水杯',exact:true}).click();pendingAi();pendingAi=undefined;
  await page.locator('.chat-bubble.assistant').last().waitFor();await order.getByRole('heading',{name:'水杯',exact:true}).waitFor();assert.equal(await order.getByRole('heading').count(),1);
  passed.push('迟到AI回复保留后来的手动选择');
  holdAi=false;await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  await page.getByRole('button',{name:'选择扑克牌',exact:true}).click();await page.getByRole('button',{name:'选择圆珠笔',exact:true}).click();
  await post('/api/booth/requests',{requestId:'browser-drain-pen-2',items:[{productId:'pen_box',count:2}]});await post('/api/task/finished');
  await post('/api/booth/requests',{requestId:'browser-drain-pen-1',items:[{productId:'pen_box',count:1}]});await post('/api/task/finished');
  await order.getByRole('status').filter({hasText:'请重新确认'}).waitFor();assert.equal(await order.locator('.primary-button').isDisabled(),true);
  const beforeShortage=received.length;
  const rejected=await fetch(apiUrl+'/api/booth/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'browser-late-shortage',items:[{productId:'playing_card_box',count:1},{productId:'pen_box',count:1}]})});assert.equal(rejected.status,409);
  assert.equal(received.length,beforeShortage);assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).products.find(p=>p.id==='playing_card_box').availableCount,3);
  passed.push('确认前一种缺货时禁用整单，旧请求也不能单独扣另一种库存');
  await post('/api/booth/operator/stock/reset-all',{confirmation:'已核对并补满全部库存'},true);
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();await page.getByRole('button',{name:'选择水杯',exact:true}).click();
  await page.route('**/api/booth/requests',async route=>{await route.fetch();await route.abort();});
  const beforeLost=received.length;await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  await page.reload();await page.locator('.task-panel.executing').waitFor();assert.equal(received.length,beforeLost+1);
  assert.equal((await (await fetch(apiUrl+'/api/booth')).json()).products.find(p=>p.id==='bottle').availableCount,2);
  await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();await page.unroute('**/api/booth/requests');
  passed.push('网页回复丢失后刷新恢复原任务，机器人只收到一次请求');
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();await page.getByRole('button',{name:'选择水杯',exact:true}).click();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,'mobile-confirm.png'),fullPage:true});
  assert.deepEqual(errors,[]);writeFileSync(join(output,'report.json'),JSON.stringify({scope:'本机浏览器、真实网关/SQLite、受控AI与机器人HTTP；不是真实设备验证',passed,received,errors},null,2));console.log(JSON.stringify({output,passed},null,2));
 }catch(e){writeFileSync(join(output,'failure.txt'),String(e.stack));console.error(e);process.exitCode=1;}
 finally{pendingRobot?.destroy();pendingAi?.();await browser?.close();peer?.closeAllConnections();await new Promise(r=>peer?.close(r)??r());for(const child of children){writeFileSync(join(output,'process-'+child.pid+'.log'),child.logs);child.kill();}console.log('Artifacts: '+output);}
})();
