// 按场景启动人工练习或正式网关；配置统一取项目 .env。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {parseEnv} = require('node:util');
const {spawnSync,spawn} = require('node:child_process');
class LaunchError extends Error {}
const root = path.resolve(__dirname,'..');

async function checkPort(port, host = '127.0.0.1') {
  const server = net.createServer();
  await new Promise((ok,fail)=>{
    server.once('error',()=>fail(new LaunchError(`端口 ${port} 已被占用或不能监听。请在原终端停止旧服务后重试；脚本不会结束已有进程。`)));
    server.listen(port,host,()=>server.close(ok));
  });
}

async function main() {
  process.chdir(root);
  const [major,minor] = process.versions.node.split('.').map(Number);
  if(major<24 || (major===24 && minor<13))throw new LaunchError('需要 Node.js 24.13.0 或更高版本。');
  const gateway = process.argv.includes('--gateway');
  const configFile = '.env';
  if(!fs.existsSync(configFile))throw new LaunchError('缺少 .env。请先复制 .env.example，再按联调指南配置。');
  const settings = parseEnv(fs.readFileSync(configFile,'utf8'));
  for(const name of Object.keys(process.env)) {
    if(/^(OPENAI_|DEEPSEEK_|BOOTH_|ROBOT_|PORT$)/.test(name))delete process.env[name];
  }
  Object.assign(process.env,settings);
  const provider = settings.BOOTH_AI_PROVIDER?.trim() || 'openai';
  process.env.BOOTH_AI_PROVIDER = provider;
  if(!['openai','deepseek'].includes(provider))throw new LaunchError('.env 中 BOOTH_AI_PROVIDER 必须为 openai 或 deepseek。');
  const keyName = provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENAI_API_KEY';
  for(const file of ['node_modules/typescript/bin/tsc','apps/web/node_modules/vite/bin/vite.js','node_modules/tsx/package.json']) {
    if(!fs.existsSync(file))throw new LaunchError('依赖未安装完整。请先在项目目录执行 pnpm.cmd install --frozen-lockfile，再双击启动。');
  }
  const port = gateway ? Number(process.env.PORT ?? 4100) : 4101;
  const host = gateway ? process.env.BOOTH_HOST ?? '127.0.0.1' : '127.0.0.1';
  if(!Number.isSafeInteger(port) || port<1 || port>65535)throw new LaunchError('.env 中 PORT 必须为 1–65535 的整数。');
  await checkPort(port,host);
  if(!gateway)await checkPort(4201);
  console.log(`配置文件：${configFile}；AI 供应商：${provider}${settings[keyName]?.trim() ? '；密钥已配置（尚不代表真实调用成功）' : ''}。`);
  if(process.argv.includes('--check')){console.log('配置、依赖、端口检查通过；未启动服务或调用 AI。');return;}
  console.log('正在检查类型并构建最新网页，请稍候……');
  for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['apps/web/node_modules/vite/bin/vite.js','build','apps/web']]) {
    const result = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
    if(result.error || result.status!==0)throw new LaunchError('构建失败，未启动服务。请查看上方构建错误。');
  }
  const {tsImport} = await import('tsx/esm/api');
  let robot;
  if(!gateway) {
    // 人工练习固定使用独立端口、目录和数据库，不改写 .env。
    process.env.BOOTH_MANUAL_PORT='4101';
    process.env.BOOTH_MANUAL_ROBOT_PORT='4201';
    process.env.BOOTH_MANUAL_DB_PATH=path.join(root,'.data','booth-manual.sqlite');
    process.argv.push('--manual');
    const {createManualRobot} = await tsImport('./robot-manual.ts',__filename);
    robot = createManualRobot('http://127.0.0.1:4101');
    await robot.listen(4201);
  }
  process.argv.push('--serve-web');
  let closing;
  const stopRobot = ()=>closing ??= robot?.close() ?? Promise.resolve();
  try {await tsImport('../apps/api/src/booth/index.ts',__filename);}
  catch {await stopRobot();throw new LaunchError('网关启动失败。请检查物品目录、数据库和端口配置。');}
  const input = require('node:readline').createInterface({input:process.stdin,output:process.stdout});
  const stop = ()=>{input.close();process.stdin.pause();process.stdin.unref?.();void stopRobot();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  input.on('line',line=>{if(line.trim().toLowerCase()==='q')process.emit('SIGINT');});
  const browserHost = host==='0.0.0.0' ? '127.0.0.1' : host==='::' ? '[::1]' : host.includes(':') ? '['+host+']' : host;
  const base = 'http://'+browserHost+':'+port;
  console.log('\n启动成功。主页面：'+base+'/');
  if(gateway) {
    console.log('正式网关按 .env 中的机器人地址和数据库运行。');
    console.log('工作人员：'+base+'/#operations');
  } else {
    console.log('人工机器人工具：http://127.0.0.1:4201/');
    console.log('取物由你在4201点击“接受任务”和“发送完成通知”，不会自动完成。');
    console.log('工作人员：'+base+'/#operations；本机练习凭据：manual-local-only');
  }
  console.log('保持本窗口开启。输入 q 后回车，或按 Ctrl+C，停止本次服务。\n');
  if(process.platform==='win32' && !process.argv.includes('--no-browser')) {
    for(const url of gateway ? [base+'/'] : [base+'/','http://127.0.0.1:4201/']) {
      const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true});
      opener.on('error',()=>console.log('无法自动打开浏览器，请手动打开上面的地址。'));opener.unref();
    }
  }
}
main().catch(error=>{
  // 仅输出可控的启动说明，不打印配置内容或环境变量。
  console.error(error instanceof LaunchError ? error.message : '启动未完成。请检查上方提示及 .env 配置。');process.exitCode=1;
});
