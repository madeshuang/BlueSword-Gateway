import {afterEach,expect,it} from "vitest";
import {ApplicationStorage} from "../storage.js";
import {Diagnostics} from "./diagnostics.js";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
let storage:ApplicationStorage|undefined;
afterEach(()=>storage?.close());
it("语音记录只导出识别信息，原文与用户发送文字分别保留",()=>{
  storage=new ApplicationStorage(":memory:");const records=new Diagnostics(storage,"simulator");
  const receipt=records.startSpeech("ali","qwen-audio-3.1-asr-flash-message");
  records.finishSpeech(receipt.id,{status:"success",text:"两瓶水",readyMs:100,endToFinalMs:200});
  records.updateSpeech(receipt.id,receipt.token,{applied:true,endToDraftMs:230});
  records.linkSent([{id:receipt.id,token:receipt.token}],"两瓶矿泉水");
  expect(records.listSpeech()[0]).toMatchObject({text:"两瓶水",sentText:"两瓶矿泉水",applied:true,mode:"simulator"});
  expect(JSON.stringify(records.listSpeech())).not.toContain(receipt.token);
  expect(()=>records.updateSpeech(receipt.id,"wrong",{applied:false})).toThrow();
});
it("每类只保留最近200条，重开记录模块仍可读取，并将未完成识别标为中断",()=>{
  storage=new ApplicationStorage(":memory:");const records=new Diagnostics(storage,"http");
  for(let i=0;i<205;i++)records.startSpeech("ali","model");
  expect(records.listSpeech()).toHaveLength(200);
  const reopened=new Diagnostics(storage,"http");expect(reopened.listSpeech()).toHaveLength(200);
  expect(reopened.listSpeech().every(record=>record.status==="error"&&record.error?.includes("重启"))).toBe(true);
});
it("发送请求先于回填计时回报到达时，仍保留实际发送文字；取消不能被迟到结果改成成功",()=>{
  storage=new ApplicationStorage(":memory:");const records=new Diagnostics(storage,"http"),receipt=records.startSpeech("ali","model");
  records.finishSpeech(receipt.id,{status:"success",text:"两瓶水"});records.linkSent([receipt],"一瓶水");
  expect(records.listSpeech()[0]?.sentText).toBe("一瓶水");
  const cancelled=records.startSpeech("ali","model");records.finishSpeech(cancelled.id,{status:"cancelled"});records.finishSpeech(cancelled.id,{status:"success",text:"迟到结果"});
  expect(records.listSpeech()[0]?.status).toBe("cancelled");
});
it("关闭数据库后重启保留已完成记录，并将未读完的通信正文标成中断",()=>{
  const directory=mkdtempSync(join(tmpdir(),"speech-restart-")),file=join(directory,"records.sqlite");
  try{
    storage=new ApplicationStorage(file);let records=new Diagnostics(storage,"http");const receipt=records.startSpeech("ali","model");records.finishSpeech(receipt.id,{status:"success",text:"一份蔬菜礼盒"});
    records.saveWire({id:"pending-wire",createdAt:new Date().toISOString(),direction:"gateway-to-robot",request:{url:"http://localhost/api/task/dispatch",method:"POST",headers:{},headersScope:"fixture",body:"{}"},response:{status:500,headers:{},headersScope:"fixture",body:"",bodyState:"pending"}});
    storage.close();storage=new ApplicationStorage(file);records=new Diagnostics(storage,"http");
    expect(records.listSpeech()[0]).toMatchObject({id:receipt.id,text:"一份蔬菜礼盒",status:"success"});
    expect(records.listWire()[0]).toMatchObject({response:{bodyState:"failed"},error:"服务重启前未完成正文采集"});
  }finally{storage?.close();storage=undefined;rmSync(directory,{recursive:true,force:true});}
});
