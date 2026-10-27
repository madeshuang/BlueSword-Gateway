import type { BoothAdvice, BoothChatMessage, BoothSelectionItem, BoothStockProduct } from "@bluesword/contracts";
import { explicitSingleSelection } from "./advice.js";

export type SelectionDecision = {kind: "add" | "replace" | "keep"; candidate: BoothSelectionItem[]};
const names = (items: BoothSelectionItem[], products: BoothStockProduct[]) => items.map(item=>`${products.find(p=>p.id===item.productId)!.name} × ${item.count}`).join("、");

/** Only bind a bare quantity to the immediately preceding, unambiguous quantity question. */
export function quantityFollowUp(messages: BoothChatMessage[], products: BoothStockProduct[]): BoothAdvice | null {
  const input = messages.at(-1)?.content.trim() ?? "";
  const quantity = /^(?:要|来)?\s*(\d+|[一二两三四五六七八九十])\s*(件|份|个|盒|瓶|包|副|支|筒|桶)[。！!\s]*$/.exec(input);
  if (!quantity) return null;
  const previous = messages.at(-2);
  if (previous?.role !== "assistant" || !/(?:几|多少)\s*(?:件|份|个|盒|瓶|包|副|支|筒|桶)/.test(previous.content)) return null;
  let candidates = products.filter(product => previous.content.includes(product.name));
  if (!candidates.length) {
    // Reuse the same catalog-name matcher as add/remove. Only the immediately
    // preceding user choice, echoed by the quantity question, can supply a short name.
    const choice = messages.at(-3);
    if (choice?.role === "user") {
      const name = choice.content.trim().replace(/[。！!？?\s]+$/g, "").replace(/吧$/, "").trim();
      if (previous.content.includes(name)) candidates = matchingProducts(name,products);
    }
  }
  // A deterministic fallback lacking context must not override the model's context handling.
  if (!candidates.length) return null;
  if (candidates.length > 1) return {reply:"你想取哪一种物品？请告诉我物品名称和数量。",selection:null};
  const count = Number(quantity[1]) || ({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[quantity[1]!] ?? 0);
  if (!Number.isSafeInteger(count) || count < 1) return {reply:"请告诉我需要的物品数量；如果不取了，可以在清单中移除。",selection:null};
  if ((quantity[2] === "筒" || quantity[2] === "桶") && candidates[0]!.id !== "shuttlecock_tube") return {reply:"请确认物品名称和数量，避免把包装数量记错。",selection:null};
  return checked([{productId:candidates[0]!.id,count}], products);
}

export function reconcileSelectionReply(advice: BoothAdvice, products: BoothStockProduct[]): BoothAdvice {
  // Do not interpret arbitrary prose as an executable selection.
  const claimsSelected = /(?:已(?:经)?(?:为你|帮你|给你)?\s*(?:选|加|添加|加入|记下)|(?:帮你|为你)(?:选好|选中|加上))/.test(advice.reply);
  if (!claimsSelected || advice.clarification) return advice;
  if (advice.selection) return checked(advice.selection, products);
  return {reply:"刚才没能更新清单，原来的选择已保留。你可以重试，或点“调整选择”。",selection:null};
}
function checked(items: BoothSelectionItem[], products: BoothStockProduct[]): BoothAdvice {
  if(items.reduce((sum,item)=>sum+item.count,0)>2)return {reply:"本单最多两件，请调整清单后再确认。",selection:null};
  for(const item of items){
    const product=products.find(p=>p.id===item.productId)!;
    if(item.count>product.maxCount || item.count>product.availableCount)return {reply:`${product.name}当前可取数量不足，请调整清单。`,selection:null};
  }
  return {reply:`已记下：${names(items,products)}，共 ${items.reduce((sum,item)=>sum+item.count,0)} 件。`,selection:items};
}
function merge(current: BoothSelectionItem[], candidate: BoothSelectionItem[]) {
  const items=current.map(item=>({...item}));
  for(const item of candidate){const old=items.find(p=>p.productId===item.productId);if(old)old.count+=item.count;else items.push({...item});}
  return items;
}

/** One decision point for explicit edits and potentially destructive model suggestions. */
export function resolveSelectionChange(input: string, current: BoothSelectionItem[], advice: BoothAdvice | null, products: BoothStockProduct[], blocked: boolean, decision?: SelectionDecision): BoothAdvice | null {
  if(decision){
    if(blocked)return {reply:"当前任务已提交，暂不能修改清单。请等待本单结束。",selection:null};
    return checked(decision.kind==="keep"?current:decision.kind==="replace"?decision.candidate:merge(current,decision.candidate),products);
  }
  const removal = explicitRemoval(input,current,products,blocked);
  if (removal) return removal;
  const addition=explicitAddition(input,current,products,blocked);
  if(addition)return addition;
  const replacement=/^(?:请|麻烦)?\s*(?:换成|改成|只取|只要)\s*(.+)$/.exec(input.trim());
  const explicit=replacement?explicitSingleSelection("来"+replacement[1],products):null;
  const proposal=explicit??advice;
  if(!proposal?.selection)return proposal;
  if(blocked)return {reply:"当前任务已提交，暂不能修改清单。请等待本单结束。",selection:null};
  if(replacement || !current.length)return proposal;
  const dropsExisting=current.some(item=>!proposal.selection!.some(p=>p.productId===item.productId&&p.count>=item.count));
  if(!dropsExisting)return proposal;
  const candidate=proposal.selection;
  const combined=checked(merge(current,candidate),products);
  return {
    reply:combined.selection
      ?`你已选${names(current,products)}。${names(candidate,products)}是追加到原清单，还是替换原清单？`
      :`你已选${names(current,products)}。当前不能合并这两份清单，要改取${names(candidate,products)}，还是保留原清单？`,
    selection:null,
    clarification:{candidate,choices:[
      ...(combined.selection?[{kind:"add" as const,label:`一起取，共 ${combined.selection.reduce((sum,item)=>sum+item.count,0)} 件`}]:[]),
      {kind:"replace",label:`改取${names(candidate,products)}`},
      {kind:"keep",label:"保留原清单"},
    ]},
  };
}

/** Merge only explicit additions with the UI's unsubmitted selection, never chat history. */
function explicitAddition(content: string, current: BoothSelectionItem[], products: BoothStockProduct[], blocked: boolean): BoothAdvice | null {
  const match=/^(?:请|麻烦)?\s*(?:再来|再拿|再取|再加|加上|再要)\s*(.+)$/.exec(content.trim());
  if(!match)return null;
  let addition=explicitSingleSelection("来"+match[1],products);
  if (!addition) {
    const short = /^(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*(件|份|个|盒|瓶|包|副|支|筒|桶)?\s*(.+?)[。！!\s]*$/.exec(match[1]!);
    if (!short) return null;
    const candidates = matchingProducts(short[3]!.trim(),products);
    const selected = candidates.filter(p=>current.some(item=>item.productId===p.id));
    const target = selected.length===1 ? selected : candidates;
    if (target.length>1) return {reply:"有多种物品符合这个名称，请说一下要追加哪一种。",selection:null};
    if (target.length!==1) return null;
    if (!/^(1|2|一|二|两)$/.test(short[1]!)) return {reply:"每单最多两件，请调整追加数量。",selection:null};
    addition=explicitSingleSelection(`来${short[1]}${short[2]??"件"}${target[0]!.name}`,products);
  }
  if(!addition?.selection)return null;
  if(blocked)return {reply:"当前取物任务已提交，不能中途追加。请等本单结束，或联系工作人员核对后，再确认下一单。每单仍最多两件。",selection:null};
  return checked(merge(current,addition.selection),products);
}

/** Match full names first, then meaningful suffixes such as 薯片/酸奶; never fuzzy text. */
function matchingProducts(name:string,products:BoothStockProduct[]):BoothStockProduct[] {
  const exact=products.filter(p=>p.name===name || p.id===name);
  if (exact.length) return exact;
  return name.length>=2 ? products.filter(p=>p.name.endsWith(name)) : [];
}

function explicitRemoval(input:string,current:BoothSelectionItem[],products:BoothStockProduct[],blocked:boolean):BoothAdvice|null {
  const match=/^(?:请|麻烦)?\s*(?:不要|去掉|移除|删掉)\s*(.+?)(?:了)?[。！!\s]*$/.exec(input.trim());
  if (!match) return null;
  const candidates=matchingProducts(match[1]!.trim(),products);
  if (!candidates.length) return null;
  if (blocked) return {reply:"当前任务已提交，暂不能修改清单。请等待本单结束。",selection:null};
  const selected=candidates.filter(p=>current.some(item=>item.productId===p.id));
  if (!selected.length) return {reply:"当前清单里没有这件物品，原来的选择已保留。",selection:null};
  if (selected.length>1) return {reply:"清单里有多种物品符合这个名称，请说一下要移除哪一种。",selection:null};
  const remaining=current.filter(item=>item.productId!==selected[0]!.id);
  return {reply:`已去掉${selected[0]!.name}，${remaining.length?`保留${names(remaining,products)}`:"当前清单已清空"}。`,selection:remaining};
}

