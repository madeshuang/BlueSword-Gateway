// 单进程启动本机人工练习。AI 配置只取项目 .env，避免旧终端变量覆盖。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {parseEnv} = require('node:util');
const {spawnSync,spawn} = require('node:child_process');
class LaunchError extends Error {}
const root = path.resolve(__dirname,'..');

async function checkPort(port) {
  const server = net.createServer();
  await new Promise((ok,fail)=>{
    server.once('error',()=>fail(new LaunchError(`端口 ${port} 已被占用或不能监听。请在原终端停止旧服务后重试；脚本不会结束已有进程。`)));
    server.listen(port,'127.0.0.1',()=>server.close(ok));
  });
}

async function main() {
  process.chdir(root);
  const [major,minor] = process.versions.node.split('.').map(Number);
  if(major<24 || (major===24 && minor<13))throw new LaunchError('需要 Node.js 24.13.0 或更高版本。');
  const relay = process.argv.includes('--relay');
  const configFile = relay ? '.env.relay' : '.env';
  if(!fs.existsSync(configFile))throw new LaunchError(`缺少 ${configFile}。请复制 .env.example 并填写对应供应商配置。`);
  const settings = parseEnv(fs.readFileSync(configFile,'utf8'));
  for(const name of Object.keys(process.env)) {
    if(/^(OPENAI_|DEEPSEEK_|BOOTH_AI_PROVIDER$)/.test(name))delete process.env[name];
  }
  Object.assign(process.env,settings);
  const provider = relay ? 'openai' : process.argv.includes('--deepseek') ? 'deepseek' : settings.BOOTH_AI_PROVIDER?.trim() || 'openai';
  process.env.BOOTH_AI_PROVIDER = provider;
  if(!['openai','deepseek'].includes(provider))throw new LaunchError('.env 中 BOOTH_AI_PROVIDER 必须为 openai 或 deepseek。');
  const keyName = provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENAI_API_KEY';
  if(!settings[keyName]?.trim())throw new LaunchError(`${configFile} 选择了 ${provider}，但未填写 ${keyName}。请核对供应商，不会自动切换或使用旧终端密钥。`);
  if(relay && (!settings.OPENAI_MODEL?.trim() || !settings.OPENAI_BASE_URL?.trim()))throw new LaunchError('.env.relay 需要填写 OPENAI_BASE_URL、OPENAI_MODEL 和 OPENAI_API_KEY。');
  if(relay) {
    let url;try{url=new URL(settings.OPENAI_BASE_URL);}catch{throw new LaunchError('.env.relay 的 OPENAI_BASE_URL 不是有效地址。');}
    if(url.protocol!=='https:' || url.origin==='https://api.openai.com' || url.username || url.password || url.search || url.hash)throw new LaunchError('GPT中转入口的 OPENAI_BASE_URL 必须是无凭据、无查询参数的中转 HTTPS API 基址。');
  }
  for(const file of ['node_modules/typescript/bin/tsc','apps/web/node_modules/vite/bin/vite.js','node_modules/tsx/package.json']) {
    if(!fs.existsSync(file))throw new LaunchError('依赖未安装完整。请先在项目目录执行 pnpm.cmd install --frozen-lockfile，再双击启动。');
  }
  for(const port of [4101,4201])await checkPort(port);
  console.log(`AI 供应商：${provider}；配置文件：${configFile}；密钥已配置（尚不代表真实调用成功）。`);
  if(process.argv.includes('--check')){console.log('配置、依赖、端口检查通过；未启动服务或调用 AI。');return;}
  console.log('正在检查类型并构建最新网页，请稍候……');
  for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['apps/web/node_modules/vite/bin/vite.js','build','apps/web']]) {
    const result = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
    if(result.error || result.status!==0)throw new LaunchError('构建失败，未启动服务。请查看上方构建错误。');
  }
  // 固定同一主页面和人工对端；不启动 Vite，不触碰正式数据库及机器人。
  process.env.BOOTH_MANUAL_PORT='4101';
  process.env.BOOTH_MANUAL_ROBOT_PORT='4201';
  process.env.BOOTH_MANUAL_DB_PATH=path.join(root,'.data','booth-manual.sqlite');
  process.argv.push('--manual','--serve-web');
  const {tsImport} = await import('tsx/esm/api');
  const {createManualRobot} = await tsImport('./robot-manual.ts',__filename);
  const robot = createManualRobot('http://127.0.0.1:4101');
  await robot.listen(4201);
  let closing;
  const stopRobot = ()=>closing ??= robot.close();
  try {await tsImport('../apps/api/src/booth/index.ts',__filename);}
  catch {await stopRobot();throw new LaunchError('网关启动失败。请检查物品目录、数据库和端口配置。');}
  const input = require('node:readline').createInterface({input:process.stdin,output:process.stdout});
  const stop = ()=>{input.close();process.stdin.pause();process.stdin.unref?.();void stopRobot();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  input.on('line',line=>{if(line.trim().toLowerCase()==='q')process.emit('SIGINT');});
  console.log('\n启动成功。主页面：http://127.0.0.1:4101/');
  console.log('人工机器人工具：http://127.0.0.1:4201/');
  console.log('AI 使用真实模型；取物由你在4201点击受理和完成，不会自动完成。');
  console.log('工作人员：http://127.0.0.1:4101/#operations；本机练习凭据：manual-local-only');
  console.log('保持本窗口开启。输入 q 后回车，或按 Ctrl+C，关闭本次两个服务。不要再启动5173。\n');
  if(process.platform==='win32' && !process.argv.includes('--no-browser')) {
    for(const url of ['http://127.0.0.1:4101/','http://127.0.0.1:4201/']) {
      const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true});
      opener.on('error',()=>console.log('无法自动打开浏览器，请手动打开上面的地址。'));opener.unref();
    }
  }
}
main().catch(error=>{
  // 仅输出可控的启动说明，不打印配置内容或环境变量。
  console.error(error instanceof LaunchError ? error.message : '启动未完成。请检查上方提示及 .env 配置。');process.exitCode=1;
});
