import type {BoothAdvice,BoothChatMessage,BoothSelectionItem,BoothStockProduct} from '@bluesword/contracts';
import {resolveSelectionChange,checkedSelection} from './selection-change.js';

/** Counts are the user's requested amounts, never model-computed final totals. */
export interface ConversationIntent {
  kind:'choose'|'add'|'set'|'replace'|'remove'|'stock'|'check_add'|'check_set';
  items:BoothSelectionItem[];
}
/** Reject a model's cumulative count when the utterance explicitly gives one amount. */
export function intentMatchesQuantity(intent:ConversationIntent,input:string):boolean {
  if(intent.kind==='stock'||intent.kind==='remove'||intent.items.length!==1)return true;
  const amounts=[...input.matchAll(/(\d+|[一二两三四五六七八九十])\s*(桶|筒|件|份|瓶|个|盒|包|副|支)/g)];
  if(amounts.length!==1)return true;
  const raw=amounts[0]![1]!;
  const count=Number(raw)||({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[raw]??0);
  return count===intent.items[0]!.count&&(!['桶','筒'].includes(amounts[0]![2]!)||intent.items[0]!.productId==='shuttlecock_tube');
}
export function validateIntent(value:unknown,products:{id:string}[]):ConversationIntent {
  const v=value as ConversationIntent;
  if(!v||Object.keys(v).length!==2||!['choose','add','set','replace','remove','stock','check_add','check_set'].includes(v.kind)||!Array.isArray(v.items)||v.items.length<1||v.items.length>2||
    v.items.some(i=>!i||Object.keys(i).length!==2||!products.some(p=>p.id===i.productId)||!Number.isSafeInteger(i.count)||i.count<1)||new Set(v.items.map(i=>i.productId)).size!==v.items.length)throw new Error('Invalid intent');
  return v;
}
/** Current draft is the only arithmetic input. Conversation may identify a product, never a quantity. */
export function applyIntent(intent:ConversationIntent,current:BoothSelectionItem[],products:BoothStockProduct[],blocked:boolean):BoothAdvice {
  if(intent.kind==='stock')return {reply:intent.items.map(i=>{
    const p=products.find(p=>p.id===i.productId)!;
    return `${p.name}${p.availableCount===0?'已取完':`还剩 ${p.availableCount} ${p.id==='shuttlecock_tube'?'筒':'份'}`}。`;
  }).join(''),selection:null};
  if(blocked)return {reply:'当前任务已提交，请等本单结束后再选。',selection:null};
  if(intent.kind==='check_add'||intent.kind==='check_set'){
    const result=applyIntent({...intent,kind:intent.kind==='check_add'?'add':'set'},current,products,false);
    return {reply:result.selection?`可以${intent.kind==='check_add'?'再加':'取'}${intent.items.map(i=>`${products.find(p=>p.id===i.productId)!.name} ${i.count} ${i.productId==='shuttlecock_tube'?'筒':'份'}`).join('、')}。`:result.reply,selection:null};
  }
  if(intent.kind==='choose')return resolveSelectionChange('',current,checkedSelection(intent.items,products),products,false)!;
  if(intent.kind==='replace')return checkedSelection(intent.items,products);
  if(intent.kind==='remove'){
    const remaining=current.filter(i=>!intent.items.some(x=>x.productId===i.productId));
    return remaining.length?checkedSelection(remaining,products):{reply:'当前清单已清空。',selection:[]};
  }
  const next=current.map(i=>({...i}));
  for(const item of intent.items){const old=next.find(i=>i.productId===item.productId);if(old)old.count=intent.kind==='add'?old.count+item.count:item.count;else next.push({...item});}
  return checkedSelection(next,products);
}
function mentioned(input:string,products:BoothStockProduct[]) {
  return products.filter(p=>input.includes(p.name)||(p.id==='shuttlecock_tube'&&input.includes('羽毛球')));
}
export function focusedProduct(messages:BoothChatMessage[],current:BoothSelectionItem[],products:BoothStockProduct[]):BoothStockProduct|null {
  if(current.length===1)return products.find(p=>p.id===current[0]!.productId)??null;
  if(current.length>1)return null;
  for(const message of messages.slice(0,-1).reverse()){
    if(message.role!=='user')continue;
    const candidates=mentioned(message.content,products);
    if(candidates.length)return candidates.length===1?candidates[0]!:null;
  }
  return null;
}
/** Small explicit fast path. Unrecognized language still reaches the interpreter. */
export function explicitIntent(messages:BoothChatMessage[],current:BoothSelectionItem[],products:BoothStockProduct[]):ConversationIntent|null {
  const input=messages.at(-1)!.content.trim().replace(/^(?:我的意思是|行[，,\s]*)/,'').replace(/^(?:那我就|我就)/,'就').replace(/吧[。！!\s]*$/,'');
  const candidates=mentioned(input,products);
  const focus=candidates.length===1?candidates[0]:candidates.length?null:focusedProduct(messages,current,products);
  if(/^(?:请问)?(?:现在|目前)?(?:还剩|还有|剩余)(?:多少|几)(?:桶|筒|件|份|瓶)?(?:.*?)[？?。\s]*$/.test(input)&&focus)
    return {kind:'stock',items:[{productId:focus.id,count:1}]};
  const checking=/^能(?:再加|再拿|再取|来|取|拿)/.test(input)&&/吗[。？?\s]*$/.test(input);
  const statement=checking?input.replace(/^能/,'').replace(/吗[。？?\s]*$/,''):input;
  const set=/^(?:请|麻烦)?\s*(?:改成|改为|只要|就来)\s*/.test(statement);
  const choose=/^(?:请|麻烦)?\s*(?:来|取|拿)\s*/.test(statement);
  const add=/^(?:请|麻烦)?\s*(?:改成|改为|只要|就来|来|取|拿|再给我(?:拿|取|来)|再帮我(?:拿|取)|再来|再拿|再取|再加|再要)\s*(\d+|[一二两三四五六七八九十])\s*(桶|筒|件|份|瓶)\s*(.*?)[。！!\s]*$/.exec(statement);
  if(!add||!focus)return null;
  if(add[3]&&add[3]!==focus.name&&!(focus.id==='shuttlecock_tube'&&add[3]==='羽毛球'))return null;
  if((add[2]==='桶'||add[2]==='筒')&&focus.id!=='shuttlecock_tube')return null;
  const count=Number(add[1])||({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[add[1]!]??0);
  if(count<1)return null;
  return {kind:checking?(choose?'check_set':'check_add'):set?'set':choose?'choose':'add',items:[{productId:focus.id,count}]};
}
