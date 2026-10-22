export type SpeechProvider = "ali" | "tencent";
export interface SpeechRecord {
  id:string;createdAt:string;mode:"http"|"simulator";provider:SpeechProvider;model:string;
  status:"starting"|"success"|"empty"|"error"|"cancelled";
  text:string;error?:string;readyMs?:number;endToFinalMs?:number;endToDraftMs?:number;
  stopReason?:string;applied?:boolean;sentText?:string;sentAt?:string;
}
export interface SpeechReceipt {id:string;token:string}
export interface WireMessage {url:string;method:string;headers:Record<string,unknown>;headersScope:string;body:string;truncated?:boolean}
export interface WireRecord {
  id:string;createdAt:string;mode:"http"|"simulator";direction:"gateway-to-robot"|"robot-to-gateway";
  request:WireMessage;response?:{status:number;headers:Record<string,unknown>;headersScope:string;body:string;bodyState?:"pending"|"complete"|"failed";truncated?:boolean};
  error?:string;durationMs?:number;
}
