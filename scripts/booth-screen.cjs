// Browser layout and operation checks; HTTP peers replace external AI/robot services.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync,readFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});
const output=mkdtempSync(join(root,'.tmp','booth-screen-'));
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){for(let n=0;n<150;n++){if(await check())return;await pause(50);}throw Error('Condition timed out');}
async function port(){const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const value=server.address().port;await new Promise(ok=>server.close(ok));return value;}
function launch(args,env,cwd=root){const child=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.logs='';child.stdout.on('data',data=>child.logs+=data);child.stderr.on('data',data=>child.logs+=data);return child;}
async function ready(url,child){await until(async()=>{if(child.exitCode!==null)throw Error(child.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
 let browser,peer,pendingReply,page;const errors=[],passed=[],measurements=[],received=[];
 try{
  let hold=false;
  peer=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   if(req.url==='/v1/responses'){
    res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'可以直接选择物品，再核对数量并确认。'.repeat(20),selection:null,taskStatusQuery:false})}]}]}));return;
   }
   assert.equal(req.url,'/api/task/dispatch');received.push(JSON.parse(body));
   if(hold){pendingReply=res;return;}res.end(JSON.stringify({success:true,data:'received'}));
  });
  await new Promise(ok=>peer.listen(0,'127.0.0.1',ok));
  const apiPort=await port(),apiUrl='http://127.0.0.1:'+apiPort,webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
  const catalog=JSON.parse(readFileSync(join(root,'config/booth-catalog.example.json'),'utf8'));
  const catalogPath=join(output,'catalog.json');writeFileSync(catalogPath,JSON.stringify(catalog));
  const upstream='http://127.0.0.1:'+peer.address().port;
  const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:String(apiPort),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_CATALOG_PATH:catalogPath,BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_API_KEY:'local-fixture',OPENAI_BASE_URL:upstream+'/v1',DEEPSEEK_API_KEY:'',BOOTH_OPERATOR_TOKEN:'screen-check',BOOTH_TASK_REMINDER_MS:'500',BOOTH_SPEECH_ENABLED:'false'});
  await ready(apiUrl+'/api/health',api);
  const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  const context=await browser.newContext({viewport:{width:2560,height:1440},deviceScaleFactor:1.5,reducedMotion:'reduce'});page=await context.newPage();
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(webUrl);await page.getByRole('heading',{name:'请选择物品',exact:true}).last().waitFor();
  const metrics=await page.locator('main').evaluate(el=>{const box=el.getBoundingClientRect();return{viewport:innerWidth,height:innerHeight,contentWidth:box.width,left:box.left,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};});
  measurements.push(metrics);await page.screenshot({path:join(output,'initial-2560.png')});
  // These width/height thresholds guard this layout against returning to the
  // small central block and one-row list; they are not client contract values.
  assert(metrics.contentWidth>=metrics.viewport*.8,'现场宽屏不应仍受小屏内容宽度限制：'+JSON.stringify(metrics));
  assert.equal(metrics.horizontalOverflow,false);passed.push('现场缩放对应视口合理利用宽度');
  const list=page.getByRole('region',{name:'可选物品列表',exact:true});
  const listBox=await list.boundingBox();
  assert(listBox.height>=400,'现场高屏应提供更充分的列表浏览区域，而不是仍限制为一行：'+listBox.height);
  passed.push('大屏列表利用可用高度，保留滚动浏览');
  const order=page.getByRole('region',{name:'取物确认',exact:true});
  async function accessible(control){
   await control.scrollIntoViewIfNeeded();
   const result=await control.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{rect:r.toJSON(),viewport:{width:innerWidth,height:innerHeight},hit:hit?.outerHTML.slice(0,200),accessible:r.width>0&&r.height>0&&r.top>=-1&&r.bottom<=innerHeight+1&&!!hit&&el.contains(hit)};});
   assert(result.accessible,(await control.getAttribute('aria-label')||await control.textContent())+' '+JSON.stringify(result));
  }
  const choose=name=>page.getByRole('button',{name:'选择'+name,exact:true}).click();
  const post=async(path,body={},staff=false)=>{const response=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(staff?{'X-Operator-Token':'screen-check'}:{})},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
  async function selectionLayout(){return page.evaluate(()=>{
   const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{top:r.top+scrollY,bottom:r.bottom+scrollY,height:r.height};};
   return{chat:bounds('.assistant-panel'),order:bounds('.order-panel'),list:bounds('.product-grid')};
  });}
  const empty=await selectionLayout();
  assert(Math.abs(empty.order.bottom-empty.chat.bottom)<=2,'未选择物品时确认区底部与聊天面板对齐');
  await choose('兰剑智能扑克牌');const single=await selectionLayout();
  await page.screenshot({path:join(output,'alignment-single.png'),scale:'css'});
  await order.getByRole('button',{name:'增加数量',exact:true}).click();const sameKind=await selectionLayout();
  await order.getByRole('button',{name:'减少数量',exact:true}).click();await choose('兰剑智能圆珠笔');const twoKinds=await selectionLayout();
  await page.screenshot({path:join(output,'alignment-two-kinds.png'),scale:'css'});
  measurements.push({selectionAlignment:{empty,single,sameKind,twoKinds}});
  assert(Math.abs(single.order.bottom-single.chat.bottom)<=2,'单种物品确认区与聊天面板底部应对齐 '+JSON.stringify(single));
  assert(Math.abs(twoKinds.order.bottom-single.order.bottom)<=2,'增加第二种物品不应向下推动确认区 '+JSON.stringify({single,twoKinds}));
  assert(Math.abs(sameKind.order.bottom-single.order.bottom)<=2,'同种两件保持确认区位置');
  assert(twoKinds.list.height<single.list.height,'第二种物品增加的高度应由列表让出');
  await order.getByRole('button',{name:'移除兰剑智能扑克牌',exact:true}).click();await order.getByRole('button',{name:'移除兰剑智能圆珠笔',exact:true}).click();
  passed.push('未选、一件、同种两件和两种各一件的确认区底部稳定，列表随确认内容伸缩');
  for(const [width,height] of [[2560,1440],[2560,1300],[3840,2160],[1920,1080],[1920,900],[1799,1000],[1440,900],[1024,768],[390,844]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));
   await choose('兰剑智能扑克牌');await choose('兰剑智能圆珠笔');
   const confirm=page.getByRole('button',{name:'确认取物',exact:true});
   const beforeScroll=await confirm.boundingBox();
   await accessible(confirm);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'无横向溢出 '+width);
   const layout=await page.evaluate(()=>{const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,main:box(document.querySelector('main')),list:box(document.querySelector('.product-grid'))};});
   measurements.push({...layout,confirmBeforeScroll:beforeScroll});
   if(width>=1800&&height>=1000){
    assert(layout.main.width>=width*.8,'大屏主体保持充分宽度');
    assert(beforeScroll.y+beforeScroll.height<=height,'两种物品确认按钮在目标大屏正常状态下可见 '+JSON.stringify({width,height,beforeScroll}));
    const aligned=await selectionLayout();
    assert(Math.abs(aligned.order.bottom-aligned.chat.bottom)<=2,'高宽屏确认区底部与聊天面板对齐 '+JSON.stringify({width,height,aligned}));
   }
   await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:join(output,'two-items-'+width+'x'+height+'.png'),scale:'css'});
   await order.getByRole('button',{name:'移除兰剑智能扑克牌',exact:true}).click();await order.getByRole('button',{name:'移除兰剑智能圆珠笔',exact:true}).click();
   // The last product remains reachable even when this window needs list/page scrolling.
   await choose('乐事薯片');await order.getByRole('heading',{name:'乐事薯片',exact:true}).waitFor();await order.getByRole('button',{name:'移除乐事薯片',exact:true}).click();
   passed.push(width+'×'+height+'：双物品确认可操作，末项可浏览，无横向溢出');
  }
  await page.setViewportSize({width:2560,height:1440});await page.evaluate(()=>window.scrollTo(0,0));
  await choose('兰剑智能扑克牌');await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  assert.deepEqual(received.at(-1),{items:[{location:'待配置',item:'playing_card_box',count:1}]});
  await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
  await choose('兰剑智能扑克牌');await order.getByRole('button',{name:'增加数量',exact:true}).click();
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
  assert.deepEqual(received.at(-1),{items:[{location:'待配置',item:'playing_card_box',count:2}]});
  await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
  await post('/api/booth/operator/stock/reset-all',{confirmation:'已核对并补满全部库存'},true);
  await choose('兰剑智能扑克牌');await choose('兰剑智能圆珠笔');hold=true;
  await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.submitting').waitFor();await until(()=>!!pendingReply);
  assert.deepEqual(received.at(-1),{items:[{location:'待配置',item:'pen_box',count:1},{location:'待配置',item:'playing_card_box',count:1}]});
  await order.getByRole('heading',{name:'请选择物品',exact:true}).waitFor();await choose('水杯');
  await order.getByRole('button',{name:'增加数量',exact:true}).click();
  assert.equal(await order.getByRole('button',{name:'请等待当前任务',exact:true}).isDisabled(),true);
  pendingReply.end(JSON.stringify({success:true,data:'received'}));pendingReply=undefined;hold=false;
  await page.locator('.task-panel.executing').waitFor();assert.equal(await order.getByLabel('已选数量').textContent(),'2');
  await order.getByRole('heading',{name:'水杯',exact:true}).waitFor();
  passed.push('三种取物组合保持正确；等待时可改选，迟到接单回复保留新选择');
  const reminder=page.getByRole('alert').filter({hasText:'等待时间较长'});await reminder.waitFor();
  const staff=reminder.getByRole('button',{name:'联系工作人员核对',exact:true});await accessible(staff);await staff.click();
  const dialog=page.getByRole('dialog',{name:'现场异常核对',exact:true});await dialog.waitFor();
  await dialog.getByLabel('工作人员凭据',{exact:true}).fill('screen-check');await dialog.getByLabel('已补货物品',{exact:true}).selectOption('pen_box');
  await dialog.getByLabel('已核对并补满所选物品',{exact:true}).check();const reset=dialog.getByRole('button',{name:'重置所选物品库存',exact:true});await accessible(reset);await reset.click();
  await dialog.getByText('当前剩余 3 份 · 补满后 3 份',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'staff-restock-2560.png'),scale:'css'});
  const close=dialog.getByRole('button',{name:'关闭工作人员入口',exact:true});await accessible(close);await close.click();
  assert.equal((await(await fetch(apiUrl+'/api/booth')).json()).active.status,'executing');
  await post('/api/task/error',{message:'本机布局检查故障'});await page.locator('.task-panel.fault').waitFor();
  await accessible(page.getByRole('region',{name:'当前取物任务',exact:true}));
  await page.screenshot({path:join(output,'fault-2560.png'),scale:'css'});
  passed.push('等待提醒和故障可见，工作人员窗口可滚动操作补货并关闭，补货不结束任务');
  await page.evaluate(()=>{location.hash='operations';});await dialog.waitFor();
  await dialog.getByLabel('工作人员凭据',{exact:true}).fill('screen-check');await dialog.getByLabel('已现场核对机器人停止及物品情况',{exact:true}).check();
  await dialog.getByRole('button',{name:'解除新任务限制',exact:true}).click();await page.locator('.task-panel.resolved').waitFor();await close.click();
  await page.getByRole('button',{name:'开始新体验',exact:true}).click();
  await page.route('**/api/booth/requests',route=>route.abort(),{times:1});
  await choose('水杯');await page.getByRole('button',{name:'确认取物',exact:true}).click();
  await page.locator('.feedback-error').waitFor();const recheck=page.getByRole('button',{name:'核对这次取物',exact:true});await accessible(recheck);
  await page.screenshot({path:join(output,'unknown-request-2560.png'),scale:'css'});
  await recheck.click();await page.locator('.task-panel.executing').waitFor();await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
  passed.push('请求结果未知时保留可用核对入口，核对后恢复任务');
  await page.getByLabel('告诉助手你的需求').fill('这里有什么？');await page.getByRole('button',{name:'发送需求',exact:true}).click();await page.locator('.chat-bubble.assistant').last().waitFor();
  const input=page.getByLabel('告诉助手你的需求');await input.fill('想了解物品\n再核对一下数量\n这是可编辑的多行草稿');await accessible(input);
  await page.screenshot({path:join(output,'long-chat-2560.png'),scale:'css'});
  const expanded=await selectionLayout();
  await page.locator('.catalog-panel summary').click();assert.equal(await list.isVisible(),false);
  const collapsed=await selectionLayout();assert(Math.abs(collapsed.order.bottom-expanded.order.bottom)<=2,'折叠列表不改变确认区底部');
  await page.locator('.catalog-panel summary').click();assert.equal(await list.isVisible(),true);
  assert((await list.boundingBox()).height>0,'再次展开后列表仍有浏览空间');
  passed.push('长聊天和多行输入可用，列表折叠展开保持原操作及确认区底部');
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,'report.json'),JSON.stringify({scope:'本机浏览器与网关；视口模拟不代表现场屏幕或真实机器人验证',passed,measurements,errors},null,2));
  console.log(JSON.stringify({output,passed,measurements},null,2));
 }catch(error){await page?.screenshot({path:join(output,'failure.png'),scale:'css'}).catch(()=>{});writeFileSync(join(output,'failure.txt'),String(error.stack));console.error(error);process.exitCode=1;}
 finally{pendingReply?.destroy();await browser?.close();peer?.closeAllConnections();if(peer?.listening)await new Promise(ok=>peer.close(ok));for(const child of children){writeFileSync(join(output,'process-'+child.pid+'.log'),child.logs);child.kill();}console.log('Artifacts: '+output);}
})();
