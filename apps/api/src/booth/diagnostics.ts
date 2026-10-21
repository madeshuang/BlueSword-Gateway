import {createHash,randomBytes,randomUUID} from "node:crypto";
import type {SpeechProvider,SpeechReceipt,SpeechRecord,WireRecord} from "@bluesword/contracts";
import type {ApplicationStorage} from "../storage.js";

type StoredSpeech=SpeechRecord & {tokenHash:string};
const digest=(token:string)=>createHash("sha256").update(token).digest("hex");
/** 两类运行记录共用有界存储，不保存音频或访问凭据。 */
export class Diagnostics {
  constructor(private storage:ApplicationStorage,private mode:"http"|"simulator") {
    storage.db.exec("CREATE TABLE IF NOT EXISTS booth_diagnostics (seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT UNIQUE NOT NULL,value TEXT NOT NULL)");
    for(const row of this.entries<StoredSpeech>("speech"))if(row.status==="starting")this.finishSpeech(row.id,{status:"error",error:"服务已重启，识别未完成"});
    for(const row of this.entries<WireRecord>("wire"))if(row.response?.bodyState==="pending")this.save("wire",row.id,{...row,response:{...row.response,bodyState:"failed"},error:"服务重启前未完成正文采集"});
  }
  private entries<T>(kind:string):T[]{
    return this.storage.db.prepare("SELECT value FROM booth_diagnostics WHERE kind=? ORDER BY seq DESC").all(kind).map(row=>JSON.parse(row.value as string) as T);
  }
  private get<T>(id:string):T|undefined {
    const row=this.storage.db.prepare("SELECT value FROM booth_diagnostics WHERE id=?").get(id);
    return row?JSON.parse(row.value as string) as T:undefined;
  }
  private save(kind:string,id:string,value:unknown):void {
    this.storage.db.prepare("INSERT INTO booth_diagnostics(kind,id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(kind,id,JSON.stringify(value));
    this.storage.db.prepare("DELETE FROM booth_diagnostics WHERE kind=? AND seq NOT IN (SELECT seq FROM booth_diagnostics WHERE kind=? ORDER BY seq DESC LIMIT 200)").run(kind,kind);
  }
  startSpeech(provider:SpeechProvider,model:string):SpeechReceipt {
    const id=randomUUID(),token=randomBytes(32).toString("hex");
    this.save("speech",id,{id,createdAt:new Date().toISOString(),mode:this.mode,provider,model,status:"starting",text:"",tokenHash:digest(token)} satisfies StoredSpeech);
    return {id,token};
  }
  finishSpeech(id:string,result:Partial<Pick<SpeechRecord,"status"|"text"|"error"|"readyMs"|"endToFinalMs"|"stopReason">>):void {
    const row=this.get<StoredSpeech>(id);if(row&&!(row.status==="cancelled"&&result.status!=="cancelled"))this.save("speech",id,{...row,...result});
  }
  updateSpeech(id:string,token:string,update:Pick<SpeechRecord,"applied"|"endToDraftMs">):void {
    const row=this.authorizeSpeech(id,token);
    if(update.endToDraftMs!==undefined&&(!Number.isFinite(update.endToDraftMs)||update.endToDraftMs<0||update.endToDraftMs>600000))throw new Error("等待时间不合法");
    this.save("speech",id,{...row,...update});
  }
  authorizeSpeech(id:string,token:string):StoredSpeech {
    const row=this.get<StoredSpeech>(id);if(!row||typeof token!=="string"||digest(token)!==row.tokenHash)throw new Error("识别记录凭据无效或记录已过期");return row;
  }
  linkSent(receipts:SpeechReceipt[],sentText:string):void {
    for(const receipt of receipts){const row=this.get<StoredSpeech>(receipt.id);if(!row||row.tokenHash!==digest(receipt.token)||row.status!=="success"||row.sentAt)continue;
      this.save("speech",row.id,{...row,applied:true,sentText,sentAt:new Date().toISOString()});}
  }
  listSpeech():SpeechRecord[]{return this.entries<StoredSpeech>("speech").map(({tokenHash:_,...record})=>record);}
  saveWire(record:Omit<WireRecord,"mode">):void {this.save("wire",record.id,{...record,mode:this.mode});}
  listWire():WireRecord[]{return this.entries<WireRecord>("wire");}
}
