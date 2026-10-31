import {expect,it} from 'vitest';
import {applyIntent,explicitIntent} from './conversation-intent.js';
import {readBoothConfig} from './config.js';
const p={...readBoothConfig().products[0]!,id:'shuttlecock_tube',name:'羽毛球',availableCount:3,maxCount:2};
it('库存查询与追加只用当前事实，不继承旧单数量',()=>{
 const history=[{role:'user' as const,content:'两桶羽毛球'},{role:'assistant' as const,content:'已取好两桶'}];
 for(const text of ['再给我拿一桶羽毛球。','麻烦再给我拿一桶。']){
 const intent=explicitIntent([...history,{role:'user',content:text}],[],[p])!;
 expect(applyIntent(intent,[],[p],false).selection).toEqual([{productId:p.id,count:1}]);
 expect(applyIntent(intent,[{productId:p.id,count:1}],[p],false).selection).toEqual([{productId:p.id,count:2}]);
 }
 const query=explicitIntent([...history,{role:'user',content:'还剩几桶羽毛球？'}],[],[p])!;
 expect(applyIntent(query,[],[{...p,availableCount:2}],true)).toEqual({reply:'羽毛球还剩 2 筒。',selection:null});
 expect(applyIntent({kind:'add',items:[{productId:p.id,count:3}]},[],[p],false).selection).toBeNull();
});
it('问句否定不变更，改量保留其他物品，空清单不猜物品',()=>{
 for(const content of ['不要再给我拿一桶','再给我拿一桶可以吗？'])expect(explicitIntent([{role:'user',content}],[],[p])).toBeNull();
 expect(explicitIntent([{role:'user',content:'麻烦再给我拿一桶。'}],[],[p])).toBeNull();
 expect(explicitIntent([{role:'user',content:'改成一桶吧'}],[{productId:p.id,count:2}],[p])?.kind).toBe('set');
 const other={...p,id:'other',name:'其他物品'};
 expect(explicitIntent([{role:'user',content:'再给我拿一份羽毛球'}],[{productId:other.id,count:1}],[other])).toBeNull();
 expect(applyIntent({kind:'remove',items:[{productId:p.id,count:1}]},[{productId:p.id,count:1}],[p],false)).toEqual({reply:'当前清单已清空。',selection:[]});
 expect(applyIntent({kind:'set',items:[{productId:p.id,count:1}]},[{productId:p.id,count:2},{productId:'other',count:1}],[p,other],false).selection).toEqual([{productId:p.id,count:1},{productId:'other',count:1}]);
});
it('截图问句只检查数量，确认一桶不追加；新增物品仍保留歧义确认',()=>{
 const current=[{productId:p.id,count:1}];
 for(const content of ['能再加一桶吗。','我的意思是能来两桶羽毛球吗？']){
  const intent=explicitIntent([{role:'user',content}],current,[p])!;
  const rejected=applyIntent(intent,current,[{...p,availableCount:1}],false);
  expect(rejected.selection).toBeNull();expect(rejected.reply).toContain('只剩 1');
  expect(rejected.reply).not.toContain('没能更新');
  const accepted=applyIntent(intent,current,[p],false);
  expect(accepted.selection).toBeNull();expect(accepted.reply).toContain('可以');
 }
 for(const content of ['行，就来一桶羽毛球吧。','那我就来一桶羽毛球。']){
  const intent=explicitIntent([{role:'user',content}],current,[p])!;
  expect(intent.kind).toBe('set');
  expect(applyIntent(intent,current,[{...p,availableCount:1}],false).selection).toEqual(current);
 }
 const other={...p,id:'other',name:'其他物品'};
 const intent=explicitIntent([{role:'user',content:'来一份其他物品'}],current,[p,other])!;
 expect(applyIntent(intent,current,[p,other],false).clarification?.choices.map(c=>c.kind)).toEqual(['add','replace','keep']);
 expect(current).toEqual([{productId:p.id,count:1}]);
});
import {afterEach} from 'vitest';
import {createBoothApplication} from './server.js';
let app:ReturnType<typeof createBoothApplication>|undefined;
afterEach(async()=>{await app?.close();app=undefined;});
it.each(['openai','deepseek'] as const)('%s意图经真实HTTP解析，补货和旧单不改变本轮数量',async provider=>{
 let value:unknown={kind:'add',items:[{productId:p.id,count:1}]};
 let during:()=>void=()=>{};
 app=createBoothApplication({...readBoothConfig(),databasePath:':memory:',products:[{...p,initialStock:3}],mode:'http',catalogConfirmed:true,dispatchUrl:'http://fixture/task',openaiKey:'fixture',deepseekKey:'fixture',aiProvider:provider},{transport:async()=>Response.json({success:true}),assistantTransport:async()=>{
 during();
 const output=JSON.stringify({reply:'错误库存和错误总数不应出现在页面',selection:null,taskStatusQuery:false,intent:value});
 return Response.json(provider==='openai'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:output}]}]}:{choices:[{finish_reason:'stop',message:{content:output}}]});
 }});
 const base='http://127.0.0.1:'+await app.listen(0);
 const ask=async(content:string,currentSelection:{productId:string;count:number}[]=[])=>{
 const r=await fetch(base+'/api/booth/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}],currentSelection})});
 return {status:r.status,body:await r.json()};
 };
 await app.service.dispatch([{productId:p.id,count:1}],'intent-order-one');app.service.finished();
 value={kind:'stock',items:[{productId:p.id,count:1}]};
 expect((await ask('羽毛球的库存告诉我一下')).body).toEqual({reply:'羽毛球还剩 2 筒。',selection:null});
 await app.service.dispatch([{productId:p.id,count:2}],'intent-order-two');app.service.finished();
 during=()=>{app!.service.resetStock(p.id,'已核对并补满库存');during=()=>{};};
 expect((await ask('羽毛球库存情况如何')).body.reply).toBe('羽毛球还剩 3 筒。');
 value={kind:'add',items:[{productId:p.id,count:1}]};
 expect((await ask('帮忙再安排一桶羽毛球吧')).body.selection).toEqual([{productId:p.id,count:1}]);
 expect((await ask('帮忙再安排一桶羽毛球吧',[{productId:p.id,count:1}])).body.selection).toEqual([{productId:p.id,count:2}]);
 value={kind:'add',items:[{productId:p.id,count:2}]};
 expect((await ask('帮忙再安排一桶羽毛球吧')).body.selection).toBeNull();
 value={kind:'choose',items:[{productId:'missing',count:1}]};
 expect((await ask('帮忙选一下')).status).toBe(502);
 expect(app.service.products()[0]!.availableCount).toBe(3);
});
it.each(['openai','deepseek'] as const)('%s问句经模型意图检查最新库存，纯问答不再匹配成功措辞；旧协议拒收',async provider=>{
 let output:Record<string,unknown>={reply:'你已选了一筒，是否再加需要核对库存。',selection:null,taskStatusQuery:false,intent:null};
 app=createBoothApplication({...readBoothConfig(),databasePath:':memory:',products:[{...p,initialStock:1}],mode:'http',catalogConfirmed:true,openaiKey:'fixture',deepseekKey:'fixture',aiProvider:provider},{assistantTransport:async()=>{
  const text=JSON.stringify(output);
  return Response.json(provider==='openai'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}:{choices:[{finish_reason:'stop',message:{content:text}}]});
 }});
 const base='http://127.0.0.1:'+await app.listen(0);
 const current=[{productId:p.id,count:1}];
 const ask=async(content:string)=>{
  const response=await fetch(base+'/api/booth/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content}],currentSelection:current})});
  return {status:response.status,body:await response.json()};
 };
 expect((await ask('我们刚才说到哪儿了？')).body).toEqual({reply:output.reply,selection:null});
 for(const [kind,text] of [['check_add','现在这份还能额外添一桶吗？'],['check_set','我想问总共拿两桶羽毛球可不可以？']] as const){
  output={...output,intent:{kind,items:[{productId:p.id,count:kind==='check_add'?1:2}]}};
  const result=await ask(text);expect(result.status).toBe(200);
  expect(result.body.selection).toBeNull();expect(result.body.reply).toContain('只剩 1');
 }
 // Replenishment while the draft is unchanged must immediately change feasibility.
 app.service.resetStock(p.id,'已核对并补满库存');
 output={...output,intent:{kind:'check_set',items:[{productId:p.id,count:1}]}};
 expect((await ask('我想问总共拿一桶羽毛球可不可以？')).body).toEqual({reply:'可以取羽毛球 1 筒。',selection:null});
 output={...output,intent:{kind:'set',items:current}};
 expect((await ask('嗯，那就确定只拿一桶羽毛球好了。')).body.selection).toEqual(current);
 delete output.intent;
 expect((await ask('帮忙看看')).status).toBe(502);
 expect(app.service.snapshot().tasks).toEqual([]);
 expect(app.service.products()[0]!.availableCount).toBe(1);
});
