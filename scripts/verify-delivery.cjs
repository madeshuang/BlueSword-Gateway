/* 自动验证交付包和本机人工工具；不写入人工通过结论。 */
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve, relative, dirname } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const root=resolve(__dirname,'..');
mkdirSync(join(root,'.tmp'),{recursive:true});
const directory=mkdtempSync(join(root,'.tmp','delivery-check-'));
const quote=value=>"'"+value.replace(/'/g,"''")+"'";
const children=[];
function run(cmd,args,cwd=root){return execFileSync(cmd,args,{cwd,encoding:'utf8',timeout:180000,windowsHide:true,stdio:['ignore','pipe','pipe']});}
function start(args,cwd,env={}) {
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,OPENAI_API_KEY:'',DEEPSEEK_API_KEY:'',...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  children.push(child); let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
  child.getOutput=()=>output;return child;
}
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function wait(base,child,path='/api/health'){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(child.getOutput());try{if((await fetch(base+path,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('启动超时 '+child.getOutput());}
const walk=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]);
async function main(){
  // 首先真正打包，缺少实现时在这个公开命令边界失败。
  const result=JSON.parse(run(process.execPath,['scripts/package-delivery.cjs']));
  const extracted=mkdtempSync(join(require('node:os').tmpdir(),'bluesword-delivery-'));
  run('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(result.zip)}, ${quote(extracted)})`]);
  const workspace=join(extracted,'BlueSword-Gateway');
  const manifest=JSON.parse(readFileSync(join(workspace,'delivery-manifest.json'),'utf8'));
  const files=walk(workspace).map(file=>relative(workspace,file).replaceAll('\\','/'));
  assert(files.includes('apps/web/dist/index.html'));assert(files.includes('scripts/robot-manual.html'));
  assert(!files.some(file=>file.split('/').some(part=>['node_modules','.tmp','.scratch','.data','.git'].includes(part))||(/(^|\/)\.env(\.|$)/.test(file)&&file!=='.env.example')||/\.(sqlite|db|log)$/.test(file)));
  const crypto=require('node:crypto');for(const entry of manifest.files)assert.equal(crypto.createHash('sha256').update(readFileSync(join(workspace,entry.path))).digest('hex'),entry.sha256);
  assert.equal(manifest.files.length,files.length-1);
  for(const file of files.filter(name=>name.endsWith('.md'))) {
    const text=readFileSync(join(workspace,file),'utf8');
    for(const match of text.matchAll(/\]\(([^)]+\.md(?:#[^)]*)?)\)/g)) {
      if(/^https?:/.test(match[1]))continue;
      assert(require('node:fs').existsSync(resolve(workspace,dirname(file),match[1].split('#')[0])),`文档链接不存在：${file} → ${match[1]}`);
    }
  }
  const repacked=JSON.parse(run(process.execPath,['scripts/package-delivery.cjs'],workspace));
  assert.equal(repacked.sourceCommit,manifest.sourceCommit);
  let installation='offline cache';
  try{run('cmd.exe',['/d','/s','/c','pnpm install --frozen-lockfile --offline'],workspace);}catch(error){
    if(!String(error.stdout).includes('ERR_PNPM_NO_OFFLINE'))throw error;
    installation='locked registry install';run('cmd.exe',['/d','/s','/c','pnpm install --frozen-lockfile --fetch-retries=0'],workspace);
  }
  const gatewayPort=await port(),robotPort=await port(),base='http://127.0.0.1:'+gatewayPort,robotBase='http://127.0.0.1:'+robotPort;
  const robot=start(['--import','tsx','scripts/robot-manual.ts'],workspace,{BOOTH_MANUAL_ROBOT_PORT:String(robotPort),BOOTH_MANUAL_CALLBACK_URL:base});
  await wait(robotBase,robot,'/manual/state');
  const gateway=start(['--import','tsx','apps/api/src/booth/index.ts','--serve-web'],workspace,{
    PORT:String(gatewayPort),BOOTH_HOST:'0.0.0.0',BOOTH_ROBOT_MODE:'http',BOOTH_CATALOG_CONFIRMED:'true',
    BOOTH_DB_PATH:join(directory,'verification.sqlite'),BOOTH_CATALOG_PATH:'config/booth-catalog.example.json',
    ROBOT_DISPATCH_URL:robotBase+'/api/task/dispatch',ROBOT_TIMEOUT_MS:'120000',BOOTH_OPERATOR_TOKEN:'delivery-test-only',
  });
  await wait(base,gateway);
  const manualPort=await port();const manualBase='http://127.0.0.1:'+manualPort;
  const manualGateway=start(['--import','tsx','apps/api/src/booth/index.ts','--manual','--serve-web'],workspace,{
    BOOTH_MANUAL_PORT:String(manualPort),BOOTH_MANUAL_ROBOT_PORT:String(robotPort),BOOTH_MANUAL_DB_PATH:join(directory,'manual-mode.sqlite'),
    BOOTH_HOST:'0.0.0.0',BOOTH_ROBOT_MODE:'http',ROBOT_DISPATCH_URL:'http://192.0.2.1:9/not-called',BOOTH_CATALOG_PATH:'not-existing-real-catalog',BOOTH_CATALOG_CONFIRMED:'false',
  });
  await wait(manualBase,manualGateway);const isolated=await(await fetch(manualBase+'/api/booth')).json();
  assert.equal(isolated.mode,'simulator');assert.equal(isolated.dispatch.ready,true);assert.equal(isolated.operator.configured,true);
  const page=await fetch(base);assert.equal(page.status,200);const html=await page.text();
  const asset=html.match(/src="([^"]+\.js)"/)[1];assert.equal((await fetch(base+asset)).status,200);
  const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const state=async()=> (await fetch(robotBase+'/manual/state')).json();
  async function pending(){for(let i=0;i<50;i++){if((await state()).phase==='pending')return;await new Promise(r=>setTimeout(r,100));}throw Error('没有收到取物请求');}
  const snapshot=async()=> (await fetch(base+'/api/booth')).json();
  let responseReady=false;
  const order=post(base+'/api/booth/requests',{productId:'water',count:1,requestId:'delivery-success'}).then(r=>{responseReady=true;return r;});
  await pending();assert.equal(responseReady,false);assert.equal((await post(robotBase+'/manual/finished',{})).status,409);
  assert.equal((await post(robotBase+'/manual/accept',{})).status,200);assert.equal((await order).status,200);
  await new Promise(r=>setTimeout(r,1100));assert.equal((await snapshot()).active.status,'executing');
  assert.equal((await post(robotBase+'/manual/finished',{})).status,200);assert.equal((await snapshot()).tasks.find(t=>t.requestId==='delivery-success').status,'succeeded');
  const rejected=post(base+'/api/booth/requests',{productId:'water',count:1,requestId:'delivery-reject'});await pending();await post(robotBase+'/manual/reject',{});await rejected;
  assert.equal((await snapshot()).tasks.find(t=>t.requestId==='delivery-reject').status,'rejected');assert.equal((await snapshot()).products.find(p=>p.id==='water').availableCount,2);
  const failed=post(base+'/api/booth/requests',{productId:'water',count:1,requestId:'delivery-error'});await pending();await post(robotBase+'/manual/accept',{});await failed;
  assert.equal((await post(robotBase+'/manual/error',{message:'交付检查：人工故障'})).status,200);assert.equal((await snapshot()).active.status,'fault');
  const records=(await state()).records;assert.equal(records.length,5);assert.equal(records[0].request.body,'{"location":"货架1-2层","item":"矿泉水","count":1}');
  assert(records.every(entry=>entry.response?.status===200));assert.equal(records[1].request.url,base+'/api/task/finished');assert.equal(records[4].request.url,base+'/api/task/error');
  // 同一电脑通过非回环局域网地址访问，不等价于异地入站验证。
  const interfaces=require('node:os').networkInterfaces();const addresses=Object.entries(interfaces).filter(([name])=>!/(vmware|vmnet|本地连接\*)/i.test(name)).flatMap(([name,values])=>values.filter(v=>v.family==='IPv4'&&!v.internal).map(v=>({name,address:v.address})));
  const network=[];for(const entry of addresses){const url='http://'+entry.address+':'+gatewayPort;try{assert.equal((await fetch(url+'/api/health',{signal:AbortSignal.timeout(3000)})).status,200);assert.equal((await fetch(url,{signal:AbortSignal.timeout(3000)})).status,200);network.push({...entry,result:'local host reached LAN address',url});}catch{network.push({...entry,result:'unreachable on this host',url});}}
  // 使用可见浏览器按钮再做一单，确保工具不是只有控制接口能操作。
  const { chromium }=require(join(workspace,'node_modules','playwright'));const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
  try{const tool=await browser.newPage();await tool.goto(robotBase);await tool.getByRole('heading',{name:'原始接口记录',exact:true}).waitFor();
    const resolveResponse=await fetch(base+'/api/booth/operator/resolve',{method:'POST',headers:{'Content-Type':'application/json','X-Operator-Token':'delivery-test-only'},body:JSON.stringify({confirmation:'已核对机器人停止'})});assert.equal(resolveResponse.status,200);
    const request=post(base+'/api/booth/requests',{productId:'snack',count:1,requestId:'delivery-browser'});await pending();await tool.getByRole('button',{name:'受理任务',exact:true}).click();await request;
    await tool.getByRole('button',{name:'发送完成通知',exact:true}).click();await tool.getByText('等待网关发来任务',{exact:true}).waitFor();
    assert((await tool.locator('#records').innerText()).includes('/api/task/finished'));await tool.screenshot({path:join(directory,'manual-tool.png'),fullPage:true});
    const web=await browser.newPage();const errors=[];web.on('pageerror',error=>errors.push(error.message));await web.goto(base);await web.getByRole('region',{name:'可选物品列表',exact:true}).waitFor();assert.deepEqual(errors,[]);await web.screenshot({path:join(directory,'gateway.png'),fullPage:true});
  }finally{await browser.close();}
  const report={time:new Date().toISOString(),zip:result.zip,extractedWorkspace:workspace,sourceCommit:manifest.sourceCommit,files:files.length,installation,
    checks:['zip extracted outside Git repository and manifest hashes match','no private runtime files','packaged documentation links resolve','repack without Git preserves source provenance','fresh frozen-lockfile installation','single port web/assets/API startup','manual mode overrides real endpoint and catalog','dispatch accepted only by explicit action','receipt does not complete','finished/error callback raw records','rejection returns reservation','browser control buttons'],network,
    realRobotCalls:0,realAiCalls:0,humanTest:'pending; this report is automated',remoteConnectivity:'not verified'};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({directory,...report},null,2));
}
main().catch(error=>{console.error(error.stack);if(error.stdout)console.error(String(error.stdout));if(error.stderr)console.error(String(error.stderr));process.exitCode=1;}).finally(async()=>{
  for(const child of children.reverse()){if(child.exitCode===null){child.kill();await new Promise(r=>{const timer=setTimeout(r,3000);child.once('exit',()=>{clearTimeout(timer);r();});});}}
});
