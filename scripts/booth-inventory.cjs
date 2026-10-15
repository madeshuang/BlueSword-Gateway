// User-approved browser/HTTP seams; real local gateway/SQLite and controlled peers.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-inventory-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<150;i++){if(await check())return;await pause(50);}throw new Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(p);p.logs='';p.stdout.on('data',d=>p.logs+=d);p.stderr.on('data',d=>p.logs+=d);return p;}
async function ready(url,process){await until(async()=>{if(process.exitCode!==null)throw new Error(process.logs);try{return (await fetch(url)).ok;}catch{return false;}});}
(async()=>{
  let browser,peer;let robotCalls=0;const errors=[],passed=[];
  try{
    peer=createServer(async(req,res)=>{
      let text='';for await(const c of req)text+=c;
      let response;
      if(req.url==='/v1/responses') response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'请确认两瓶水',selection:{productId:'water',count:2},taskStatusQuery:false})}]}]};
      else {assert.equal(req.url,'/api/task/dispatch');assert.deepEqual(Object.keys(JSON.parse(text)).sort(),['count','item','location']);robotCalls++;response={success:true,data:'received'};}
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));
    });await new Promise(r=>peer.listen(0,'127.0.0.1',r));
    const upstream='http://127.0.0.1:'+peer.address().port,apiUrl='http://127.0.0.1:'+await port(),webPort=await port(),webUrl='http://127.0.0.1:'+webPort;
    const api=launch(['--import','tsx','apps/api/src/booth/index.ts'],{PORT:apiUrl.split(':').at(-1),BOOTH_DB_PATH:join(output,'state.sqlite'),BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:upstream+'/api/task/dispatch',BOOTH_CATALOG_CONFIRMED:'true',BOOTH_AI_PROVIDER:'openai',OPENAI_BASE_URL:upstream+'/v1',OPENAI_API_KEY:'local-fixture',DEEPSEEK_API_KEY:'',BOOTH_OPERATOR_TOKEN:'local-stock-operator'});
    await ready(apiUrl+'/api/health',api);
    const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
    browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(webUrl);await page.locator('.task-panel.idle').waitFor();
    async function post(path,body={}){const response=await fetch(apiUrl+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}
    await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();
    await page.getByRole('button',{name:'增加数量',exact:true}).click();
    await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
    await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
    assert.equal(await page.getByRole('button',{name:'增加数量',exact:true}).isDisabled(),true,'剩一瓶时不能增加到两瓶以上');
    assert.equal(await page.getByRole('button',{name:'确认取物',exact:true}).isDisabled(),true,'保留原数量但禁止提交已超量的选择');
    await page.getByRole('button',{name:'减少数量',exact:true}).click();
    assert.equal(await page.getByLabel('已选数量').textContent(),'1');
    assert.equal(await page.getByRole('button',{name:'增加数量',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 1 份',{exact:true}).waitFor();
    const stockBounds=await page.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 1 份',{exact:true}).boundingBox(),catalogBounds=await page.getByRole('region',{name:'可选物品列表',exact:true}).boundingBox();
    assert(stockBounds.y+stockBounds.height<=catalogBounds.y+catalogBounds.height,'库存提示应直接可见，无需滚动目录');
    assert(await page.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 1 份',{exact:true}).evaluate(el=>{
      const b=el.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return hit===el||el.contains(hit);
    }),'库存数字不能被插画遮挡');
    passed.push('取两瓶后剩一瓶，手动选择和确认受剩余数量限制');
    await page.getByRole('button',{name:'选择小面包',exact:true}).click();
    await page.getByLabel('告诉助手你的需求').fill('我想取两瓶水');await page.getByRole('button',{name:'发送需求',exact:true}).click();
    await page.locator('.chat-bubble.assistant').filter({hasText:'只剩 1'}).waitFor();
    await page.getByRole('region',{name:'取物确认',exact:true}).getByRole('heading',{name:'小面包',exact:true}).waitFor();
    assert.equal(robotCalls,1,'超量聊天不发单，也不把数量偷偷改小后选择');
    passed.push('聊天超量正常解释剩余数量，保留手动选择且不发单');
    const other=await context.newPage();other.on('pageerror',e=>errors.push(e.message));await other.goto(webUrl);
    await other.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 1 份',{exact:true}).waitFor();
    await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();await page.getByRole('button',{name:'确认取物',exact:true}).click();await page.locator('.task-panel.executing').waitFor();
    await post('/api/task/finished');await page.locator('.task-panel.succeeded').waitFor();
    assert.equal(await page.getByRole('button',{name:'选择矿泉水',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'物品已取完',exact:true}).isDisabled(),true);
    await page.getByLabel('告诉助手你的需求').fill('再给我一瓶水');await page.getByRole('button',{name:'发送需求',exact:true}).click();
    await page.locator('.chat-bubble.assistant').filter({hasText:'矿泉水已取完'}).waitFor();
    passed.push('售罄物品不可选择或确认，聊天说明已取完');
    await page.screenshot({path:join(output,'desktop-empty-stock.png'),fullPage:true});
    await page.goto(webUrl+'/#operations');const dialog=page.getByRole('dialog');await dialog.waitFor();
    const refill=dialog.getByRole('button',{name:'重置所选物品库存',exact:true});
    await refill.waitFor({timeout:2000});assert.equal(await refill.isDisabled(),true);
    await dialog.getByLabel('已补货物品',{exact:true}).selectOption('water');
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('incorrect');
    await dialog.getByLabel('已核对并补满所选物品',{exact:true}).check();await refill.click();
    await dialog.getByRole('alert').filter({hasText:'工作人员凭据不正确'}).waitFor();
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('local-stock-operator');await refill.click();
    await other.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 3 份',{exact:true}).waitFor();
    assert.equal(await other.getByRole('button',{name:'选择矿泉水',exact:true}).isEnabled(),true);
    await dialog.getByText('当前剩余 3 份 · 补满后 3 份',{exact:true}).waitFor();
    await until(async()=>!(await dialog.getByLabel('已核对并补满所选物品',{exact:true}).isChecked()));
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('local-stock-operator');
    await dialog.getByLabel('已核对并补满所选物品',{exact:true}).check();
    await other.getByRole('button',{name:'选择矿泉水',exact:true}).click();await other.getByRole('button',{name:'确认取物',exact:true}).click();
    await dialog.getByText('请先核对并处理当前任务或告警，再补货重置。',{exact:true}).waitFor();
    await post('/api/task/finished');await dialog.getByText('当前剩余 2 份 · 补满后 3 份',{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('已核对并补满所选物品',{exact:true}).isChecked(),false,'取物使库存变化后撤销旧补货确认');
    assert.equal(await refill.isDisabled(),true,'必须重新核对补货，旧确认不能自动恢复可用');
    await dialog.getByLabel('已核对并补满所选物品',{exact:true}).check();await refill.click();
    await dialog.getByText('当前剩余 3 份 · 补满后 3 份',{exact:true}).waitFor();
    await until(async()=>!(await dialog.getByLabel('已核对并补满所选物品',{exact:true}).isChecked()));
    await page.screenshot({path:join(output,'desktop-staff-refill.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await refill.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'narrow-staff-refill.png'),fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
    passed.push('工作人员补货重置需要凭据和确认，SSE同步恢复其他页面可选数量');
    await page.setViewportSize({width:1440,height:900});
    await post('/api/booth/requests',{requestId:'bulk-ui-water',productId:'water',count:1});await post('/api/task/finished');
    await post('/api/booth/requests',{requestId:'bulk-ui-snack',productId:'snack',count:1});await post('/api/task/finished');
    await dialog.getByLabel('已补货物品',{exact:true}).selectOption({label:'全部物品'}, {timeout:2000});
    await dialog.getByText('矿泉水：当前剩余 2 份 · 补满后 3 份',{exact:true}).waitFor();
    await dialog.getByText('小面包：当前剩余 2 份 · 补满后 3 份',{exact:true}).waitFor();
    const refillAll=dialog.getByRole('button',{name:'重置全部物品库存',exact:true}),confirmAll=dialog.getByLabel('已核对并补满全部物品',{exact:true});
    assert.equal(await refillAll.isDisabled(),true);
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('local-stock-operator');
    assert.equal(await refillAll.isDisabled(),true,'全量重置须独立确认');
    await confirmAll.check();assert.equal(await refillAll.isEnabled(),true);
    await post('/api/booth/requests',{requestId:'bulk-ui-interrupt',productId:'gift',count:1});
    await dialog.getByText('请先核对并处理当前任务或告警，再补货重置。',{exact:true}).waitFor();
    await post('/api/task/finished');
    await dialog.getByText('纪念品：当前剩余 1 份 · 补满后 2 份',{exact:true}).waitFor();
    assert.equal(await confirmAll.isChecked(),false,'任一物品数量变化或任务开始都撤销全量确认');
    assert.equal(await refillAll.isDisabled(),true);
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('incorrect');await confirmAll.check();await refillAll.click();
    await dialog.getByRole('alert').filter({hasText:'工作人员凭据不正确'}).waitFor();
    await dialog.getByText('矿泉水：当前剩余 2 份 · 补满后 3 份',{exact:true}).waitFor();
    await dialog.getByText('小面包：当前剩余 2 份 · 补满后 3 份',{exact:true}).waitFor();
    await dialog.getByLabel('工作人员凭据',{exact:true}).fill('local-stock-operator');await refillAll.click();
    await other.getByRole('button',{name:'选择矿泉水',exact:true}).getByText('剩余 3 份',{exact:true}).waitFor();
    await other.getByRole('button',{name:'选择小面包',exact:true}).getByText('剩余 3 份',{exact:true}).waitFor();
    await other.getByRole('button',{name:'选择纪念品',exact:true}).getByText('剩余 2 份',{exact:true}).waitFor();
    await until(async()=>!(await confirmAll.isChecked()));
    assert.equal(await dialog.getByLabel('工作人员凭据',{exact:true}).inputValue(),'');
    assert.equal(await refillAll.isDisabled(),true);
    await page.screenshot({path:join(output,'desktop-staff-refill-all.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await refillAll.scrollIntoViewIfNeeded();
    await page.screenshot({path:join(output,'narrow-staff-refill-all.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    passed.push('全部补货独立确认、过期确认撤销、错误凭据不改库存及跨页面同步');
    assert.deepEqual(errors,[]);
    writeFileSync(join(output,'report.json'),JSON.stringify({passed,robotCalls,realAiCalls:0,realRobotCalls:0},null,2));console.log(JSON.stringify({output,passed,realAiCalls:0,realRobotCalls:0}));
  }finally{
    await browser?.close();for(const p of children){if(p.exitCode===null){const done=once(p,'exit');p.kill();await done;}}
    if(peer)await new Promise(r=>peer.close(r));
  }
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
