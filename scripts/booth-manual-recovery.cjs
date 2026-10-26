// Real gateway + actual manual robot tool; browser/HTTP checks, no real robot or AI.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createServer}=require('node:http');
const {mkdirSync,mkdtempSync,readFileSync,writeFileSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=require('playwright');
const root=resolve(__dirname,'..'),webRequire=createRequire(join(root,'apps/web/package.json')),children=[];
mkdirSync(join(root,'.tmp'),{recursive:true});const output=mkdtempSync(join(root,'.tmp','booth-manual-recovery-'));
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){for(let i=0;i<150;i++){if(await check())return;await pause(50);}throw Error('Condition timed out');}
async function port(){const s=createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
function launch(args,env,cwd=root){const p=spawn(process.execPath,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});p.logs='';p.stdout.on('data',v=>p.logs+=v);p.stderr.on('data',v=>p.logs+=v);children.push(p);return p;}
async function ready(url,p){await until(async()=>{if(p.exitCode!==null)throw Error(p.logs);try{return(await fetch(url)).ok;}catch{return false;}});}
(async()=>{
 let browser,page;const errors=[],passed=[];
 try{
  const apiPort=await port(),robotPort=await port(),webPort=await port(),apiUrl='http://127.0.0.1:'+apiPort,toolUrl='http://127.0.0.1:'+robotPort,webUrl='http://127.0.0.1:'+webPort;
  const catalog=JSON.parse(readFileSync(join(root,'scripts/fixtures/booth-catalog.json'),'utf8')).map(p=>({...p,initialStock:10}));
  const catalogPath=join(output,'catalog.json');writeFileSync(catalogPath,JSON.stringify(catalog));
  const env={BOOTH_MANUAL_PORT:String(apiPort),BOOTH_MANUAL_ROBOT_PORT:String(robotPort),BOOTH_MANUAL_DB_PATH:join(output,'state.sqlite'),BOOTH_MANUAL_CATALOG_PATH:catalogPath,BOOTH_MANUAL_CALLBACK_URL:apiUrl,OPENAI_API_KEY:'',DEEPSEEK_API_KEY:''};
  const tool=launch(['--import','tsx','scripts/robot-manual.ts'],env);await ready(toolUrl+'/manual/state',tool);
  const api=launch(['--import','tsx','apps/api/src/booth/index.ts','--manual'],env);await ready(apiUrl+'/api/health',api);
  const web=launch([join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],{VITE_API_TARGET:apiUrl},join(root,'apps/web'));await ready(webUrl,web);
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'}:{})});
  page=await browser.newPage({viewport:{width:1440,height:900}});const toolPage=await browser.newPage();
  for(const p of [page,toolPage])p.on('pageerror',e=>errors.push(e.message));
  await page.goto(webUrl);await toolPage.goto(toolUrl);
  const toolState=async()=>await(await fetch(toolUrl+'/manual/state')).json();
  const snapshot=async()=>await(await fetch(apiUrl+'/api/booth')).json();
  async function selectAndSubmit(){await page.getByRole('button',{name:'选择矿泉水',exact:true}).click();const button=page.getByRole('button',{name:'确认取物',exact:true});await until(()=>button.isEnabled());await button.click();await until(async()=>(await toolState()).phase==='pending');await toolPage.getByText('已收到请求，等待你接受或拒绝任务（120秒内操作）',{exact:true}).waitFor();}
  async function toolClick(label,path){const response=toolPage.waitForResponse(r=>r.url().endsWith('/manual/'+path));await toolPage.getByRole('button',{name:label,exact:true}).click();assert.equal((await response).status(),200,'人工工具按钮应操作当前任务：'+label);}
  for(const phase of ['pending','accepted']){
   await selectAndSubmit();if(phase==='accepted'){await toolClick('接受任务','accept');await page.locator('.task-panel.executing').waitFor();}
   const before=await snapshot(),oldId=before.active.id,callbacksBefore=(await toolState()).records.filter(r=>/\/api\/task\/(finished|error)$/.test(r.request.url)).length;
   await page.evaluate(()=>{location.hash='operations';});await page.getByRole('dialog').waitFor();
   await page.getByLabel('工作人员凭据').fill('manual-local-only');await page.getByRole('checkbox',{name:'已现场核对机器人停止及物品情况',exact:true}).check();
   await page.getByRole('button',{name:'解除新任务限制',exact:true}).click();await page.locator('.task-panel.resolved').waitFor();
   const after=await snapshot();assert.equal(after.active,null);assert.equal(after.tasks.find(t=>t.id===oldId).status,'resolved');assert.deepEqual(after.products,before.products);
   assert.equal((await toolState()).phase,'idle');assert.equal((await toolState()).records.filter(r=>/\/api\/task\/(finished|error)$/.test(r.request.url)).length,callbacksBefore,'解除旧任务不伪造结果通知');
   await toolPage.getByText('等待网关发来任务',{exact:true}).waitFor();
   await page.getByRole('button',{name:'关闭工作人员入口'}).click();
   await selectAndSubmit();await toolClick('接受任务','accept');await page.locator('.task-panel.executing').waitFor();
   await toolClick('发送完成通知','finished');await page.locator('.task-panel.succeeded').waitFor();
   assert.equal((await snapshot()).tasks.find(t=>t.id===oldId).status,'resolved');passed.push(phase+'旧任务解除后，新任务可从实际工具正常接单和完成');
   await page.screenshot({path:join(output,phase+'-recovered.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);writeFileSync(join(output,'report.json'),JSON.stringify({passed,realAiCalls:0,realRobotCalls:0},null,2));console.log(JSON.stringify({output,passed},null,2));
 }catch(e){await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally{await browser?.close();for(const p of children){writeFileSync(join(output,'process-'+p.pid+'.log'),p.logs);if(p.exitCode===null)p.kill();}}
})().catch(e=>{console.error(e);console.error('Artifacts: '+output);process.exitCode=1;});
