import {describe,expect,it} from "vitest";
import {SpeechDraft} from "./draft";

describe("语音结果进入草稿的公开入口",()=>{
  it("保留已有文字，最终结果只能应用一次",()=>{
    const draft=new SpeechDraft();draft.edit("已有内容");const id=draft.begin();
    expect(draft.complete(id,"两瓶矿泉水")).toBe(true);
    expect(draft.value).toBe("已有内容\n两瓶矿泉水");
    expect(draft.complete(id,"重复结果")).toBe(false);
  });
  it("识别期间修改、清空或发送草稿后，不用旧结果覆盖文字",()=>{
    const draft=new SpeechDraft();draft.edit("旧草稿");const id=draft.begin();draft.edit("新草稿");
    expect(draft.complete(id,"旧结果")).toBe(false);expect(draft.value).toBe("新草稿");
    const next=draft.begin();draft.edit("");expect(draft.complete(next,"迟到结果")).toBe(false);
  });
  it("取消后重新开始，只允许新一轮的结果进入草稿",()=>{
    const draft=new SpeechDraft(),old=draft.begin();draft.cancel();const current=draft.begin();
    expect(draft.complete(old,"取消的结果")).toBe(false);
    expect(draft.complete(current,"本轮结果")).toBe(true);expect(draft.value).toBe("本轮结果");
  });
  it("长结果不能突破聊天输入上限，也不截断原文误导用户",()=>{
    const draft=new SpeechDraft();draft.edit("已有内容");
    expect(draft.complete(draft.begin(),"长".repeat(2000))).toBe(false);expect(draft.value).toBe("已有内容");
  });
});
