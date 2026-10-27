import {expect,it} from "vitest";
import type {BoothChatMessage,BoothStockProduct} from "@bluesword/contracts";
import {quantityFollowUp,resolveSelectionChange,reconcileSelectionReply} from "./selection-change.js";
import {readBoothConfig} from "./config.js";

const products:BoothStockProduct[]=[{...readBoothConfig().products[0]!,name:"矿泉水",availableCount:1}];
const messages=(input:string,question="矿泉水需要几份？"):BoothChatMessage[]=>[{role:"assistant",content:question},{role:"user",content:input}];
it("截图回归：打火机吧、打火机要取几件、一份直接承接简称",()=>{
  const catalog=[{...products[0]!,id:"lighter",name:"USB防风打火机"}];
  const conversation:BoothChatMessage[]=[
    {role:"user",content:"打火机吧"},
    {role:"assistant",content:"打火机要取几件？每单最多两件。"},
    {role:"user",content:"一份"},
  ];
  expect(quantityFollowUp(conversation,catalog)?.selection).toEqual([{productId:"lighter",count:1}]);
  expect(quantityFollowUp(conversation,[...catalog,{...catalog[0]!,id:"other",name:"另一款打火机"}])?.selection).toBeNull();
  expect(quantityFollowUp([{role:"assistant",content:"它要取几件？"},{role:"user",content:"一份"}],catalog)).toBeNull();
});
const snacks:BoothStockProduct[]=[{...products[0]!,id:"chips",name:"乐事薯片",availableCount:3,maxCount:2},{...products[0]!,id:"yogurt",name:"安慕希酸奶",availableCount:3,maxCount:2}];
it("简称追加与明确删除直接更新当前清单",()=>{
  const chips={productId:"chips",count:1},yogurt={productId:"yogurt",count:1};
  expect(resolveSelectionChange("再来一份薯片",[chips],null,snacks,false)?.selection).toEqual([{...chips,count:2}]);
  expect(resolveSelectionChange("不要酸奶了",[chips,yogurt],null,snacks,false)?.selection).toEqual([chips]);
  expect(resolveSelectionChange("不要薯片了",[chips],null,snacks,false)?.selection).toEqual([]);
  expect(resolveSelectionChange("不要酸奶了",[chips],null,snacks,false)?.selection).toBeNull();
  expect(resolveSelectionChange("再来一份薯片",[chips,yogurt],null,snacks,false)?.selection).toBeNull();
  expect(resolveSelectionChange("不要酸奶了",[chips,yogurt],null,snacks,true)?.selection).toBeNull();
});
it("有多个简称候选或只是讨论时不猜选品",()=>{
  const many=[...snacks,{...snacks[0]!,id:"chips2",name:"另一种薯片"}];
  expect(resolveSelectionChange("再来一份薯片",[],null,many,false)?.selection).toBeNull();
  for(const input of ["不要酸奶了吗？","不要酸奶了换成薯片","再来一份薯片可以吗？"]) {
    expect(resolveSelectionChange(input,[{productId:"yogurt",count:1}],null,snacks,false)).toBeNull();
  }
  expect(resolveSelectionChange("再来一份薯片",[{productId:"chips",count:1}],null,snacks.map(p=>({...p,availableCount:1})),false)?.selection).toBeNull();
});
it("承接数量仍检查最新库存和活动任务",()=>{
  expect(quantityFollowUp(messages("0份"),products)?.selection).toBeNull();
  expect(quantityFollowUp(messages("两份"),products)?.selection).toBeNull();
  const candidate=quantityFollowUp(messages("一份"),products);
  expect(candidate?.selection).toHaveLength(1);
  expect(resolveSelectionChange("一份",[],candidate,products,true)?.selection).toBeNull();
  expect(quantityFollowUp(messages("一份"),products.map(p=>({...p,availableCount:0})))?.selection).toBeNull();
});
it("不从闲聊、否定、进度问题或较早的数量问题推导选择",()=>{
  for(const input of ["不要一份","一份够吗？","还有什么？","取好了吗？"]) expect(quantityFollowUp(messages(input),products)).toBeNull();
  expect(quantityFollowUp([...messages("先等等"),{role:"assistant",content:"好的。"},{role:"user",content:"一份"}],products)).toBeNull();
  expect(quantityFollowUp(messages("一份","你好。"),products)).toBeNull();
});
it("正常问答原样保留，成功措辞必须有有效清单",()=>{
  const normal={reply:"矿泉水还有一瓶，需要几份？",selection:null};
  expect(reconcileSelectionReply(normal,products)).toEqual(normal);
  expect(reconcileSelectionReply({reply:"已为你选好矿泉水。",selection:null},products).reply).not.toContain("已为你选好");
  expect(reconcileSelectionReply({reply:"已选两瓶。",selection:[{productId:products[0]!.id,count:2}]},products).selection).toBeNull();
});
