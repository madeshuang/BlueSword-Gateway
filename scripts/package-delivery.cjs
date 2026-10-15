/* Windows 作者机生成交付包；只复制明确列出的运行源码、素材和必要说明。 */
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
if(process.platform!=='win32')throw Error('交付打包入口在 Windows 作者机运行；运行交付包不受此限制');
if(!fs.existsSync(path.join(root,'apps/web/dist/index.html')))throw Error('请先执行 pnpm build');
fs.mkdirSync(path.join(root,'.tmp','delivery'),{recursive:true});
const date=new Date().toISOString().replace(/[:.]/g,'-');
const output=fs.mkdtempSync(path.join(root,'.tmp','delivery',date+'-'));
const staging=path.join(output,'BlueSword-Gateway');fs.mkdirSync(staging);
const entries=[];
function copy(source,destination=source){
  const file=path.join(root,source);const info=fs.lstatSync(file);
  if(info.isSymbolicLink())throw Error('交付源不得包含链接：'+source);
  if(info.isDirectory()) {for(const entry of fs.readdirSync(file))copy(path.join(source,entry),path.join(destination,entry));return;}
  const normalized=destination.replaceAll('\\','/');
  if(!info.isFile() || normalized.split('/').some(part=>['node_modules','.git','.tmp','.data','.scratch','.cache','.vite'].includes(part)) ||
    (normalized.split('/').some(part=>part.startsWith('.env'))&&normalized!=='.env.example') || /\.(sqlite(?:-wal|-shm)?|db|log|map)$/.test(normalized))throw Error('禁止交付文件：'+source);
  let content=fs.readFileSync(file);
  // 交付说明在源码 docs/ 中，复制到包根 README 时调整同目录文档链接。
  if(source==='docs/delivery-readme.md' && destination==='README.md')content=Buffer.from(content.toString('utf8').replace(/\]\(([^/)]+\.md(?:#[^)]*)?)\)/g,'](docs/$1)'));
  const target=path.join(staging,destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
  const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
  if(sha(fs.readFileSync(target))!==sha(content))throw Error('复制校验失败：'+source);
  entries.push({path:normalized,sha256:sha(content)});
}
for(const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','vitest.config.ts','.env.example',
  'apps/api/package.json','apps/api/src','apps/web/package.json','apps/web/index.html','apps/web/vite.config.ts','apps/web/src','apps/web/dist',
  'packages/contracts/package.json','packages/contracts/src','config/booth-catalog.example.json'])copy(file);
if(fs.existsSync(path.join(root,'apps/web/public')))copy('apps/web/public');
for(const name of ['package.json','robot-simulator.ts','robot-manual.ts','robot-manual.html','robot-manual.test.ts','package-delivery.cjs','verify-delivery.cjs',
  'verify-ai.ts','verify-ai.test.ts','verify-relay.cjs','booth-acceptance.cjs','booth-chat-interaction.cjs','booth-experience.cjs','booth-thinking.cjs','booth-status-reset.cjs','booth-inventory.cjs'])copy('scripts/'+name);
for(const name of ['接口文档.md','机器人团队联调指南.md','booth-inventory.md','booth-thinking-display.md','task-id-proposal.md','manual-interface-test.md'])copy('docs/'+name);
copy('docs/delivery-readme.md','README.md');
// 保留打包入口所需模板，便于现场修改后仍能按相同规则生成下一份包。
copy('docs/delivery-readme.md');
entries.sort((a,b)=>a.path.localeCompare(b.path));
let sourceCommit=null,workingTreeChanges=null,sourceState='交付目录；可能经过编辑，文件哈希见清单';
const previous=path.join(root,'delivery-manifest.json');
if(fs.existsSync(previous)) {
  const origin=JSON.parse(fs.readFileSync(previous,'utf8')).sourceCommit;
  if(typeof origin==='string' && /^[0-9a-f]{40}$/.test(origin))sourceCommit=origin;
}
try {
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  const top=fs.realpathSync(git(['rev-parse','--show-toplevel']));
  // 在作者仓库内的解压目录也不能借用上级仓库的来源和状态。
  if(top.toLowerCase()===fs.realpathSync(root).toLowerCase()) {
    sourceCommit=git(['rev-parse','HEAD']);workingTreeChanges=Boolean(git(['status','--porcelain']));sourceState='当前作者仓库工作区';
  }
} catch { /* 交付机器不需要 Git；沿用原包来源，不猜测工作区是否改过。 */ }
const manifest={createdAt:new Date().toISOString(),sourceCommit,workingTreeChanges,sourceState,
  scope:'运行源码、锁定依赖清单及已构建网页；不含运行时秘密、数据库或依赖安装目录',files:entries};
fs.writeFileSync(path.join(staging,'delivery-manifest.json'),JSON.stringify(manifest,null,2));
const zip=path.join(output,'BlueSword-Gateway-'+date+'.zip');
const quote=value=>"'"+value.replace(/'/g,"''")+"'";
execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(staging)}, ${quote(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $true)`],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000});
console.log(JSON.stringify({zip,staging,files:entries.length,bytes:fs.statSync(zip).size,sourceCommit}));
