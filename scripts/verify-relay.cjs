const {spawnSync} = require('node:child_process');
const {resolve} = require('node:path');
process.chdir(resolve(__dirname,'..'));
const ignored=spawnSync('git',['check-ignore','--quiet','--','.env.relay'],{stdio:'ignore',windowsHide:true});
if(ignored.status!==0){console.error('.env.relay 必须被 Git 忽略；未执行真实调用');process.exit(1);}
const env={};
for(const [name,value] of Object.entries(process.env)) {
 if(!/^(OPENAI_|DEEPSEEK_)/i.test(name)&&name.toUpperCase()!=='NODE_OPTIONS') env[name]=value;
}
const preflight=spawnSync(process.execPath,['--env-file=.env.relay','--input-type=module','-e',`
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
const configured=parseEnv(readFileSync('.env.relay','utf8'));
const names=['OPENAI_BASE_URL','OPENAI_MODEL','OPENAI_API_KEY'];
const present=names.every(name=>typeof configured[name]==='string'&&configured[name].trim().length>0);
const fileValuesEffective=present&&names.every(name=>process.env[name]===configured[name]);
let endpointSafe=false;
if(present){try{const url=new URL(configured.OPENAI_BASE_URL.trim());endpointSafe=url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.hostname.replace(/[.]+$/,'')!=='api.openai.com';}catch{}}
const modelSafe=present&&/^[a-zA-Z0-9._:/-]{1,128}$/.test(configured.OPENAI_MODEL.trim())&&!configured.OPENAI_MODEL.includes(configured.OPENAI_API_KEY.trim());
console.log(JSON.stringify({event:'relay_preflight',necessaryConfigPresent:present,fileValuesEffective,endpointSafe,modelSafe}));
if(!(present&&fileValuesEffective&&endpointSafe&&modelSafe))process.exitCode=1;
`],{env,stdio:'inherit',windowsHide:true});
if(preflight.status!==0)process.exit(preflight.status??1);
const child=spawnSync(process.execPath,['--env-file=.env.relay','--import','tsx','scripts/verify-ai.ts','--provider','openai',...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true});
process.exitCode=child.status??1;
