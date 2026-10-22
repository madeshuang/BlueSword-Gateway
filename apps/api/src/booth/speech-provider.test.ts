import {afterEach,expect,it} from "vitest";
import WebSocket,{WebSocketServer} from "ws";
import {openRecognizer,type SpeechConfig} from "./speech-provider.js";
let server:WebSocketServer|undefined;
afterEach(async()=>{for(const socket of server?.clients??[])socket.terminate();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());});
const config=(provider:"ali"|"tencent"):SpeechConfig=>({enabled:true,provider,aliKey:"fixture-key",aliWorkspace:undefined,tencentAppId:"1234",tencentSecretId:"fixture-id",tencentSecretKey:"fixture-secret"});
it.each(["ali","tencent"] as const)("%s通过真实WebSocket协议聚合最终句子，临时文字不能混入最终结果",async provider=>{
  server=new WebSocketServer({port:0,host:"127.0.0.1"});await new Promise<void>(r=>server!.once("listening",r));
  const packets:unknown[]=[];server.on("connection",ws=>{
    if(provider==="tencent")ws.send(JSON.stringify({code:0}));
    ws.on("message",(raw,binary)=>{if(binary)return;const packet=JSON.parse(raw.toString());packets.push(packet);
      if(packet.header?.action==="run-task")ws.send(JSON.stringify({header:{event:"task-started"}}));
      if(packet.header?.action==="finish-task"||packet.type==="end"){
        if(provider==="ali"){
          ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"临时错误",sentence_end:false}}}}));
          ws.send(JSON.stringify({payload:{output:{sentence:{sentence_id:0,text:"不要矿泉水",sentence_end:true}}}}));
          ws.send(JSON.stringify({header:{event:"task-finished"}}));
        }else{
          ws.send(JSON.stringify({result:{index:0,voice_text_str:"临时错误",slice_type:1}}));
          ws.send(JSON.stringify({result:{index:0,voice_text_str:"不要矿泉水",slice_type:2}}));
          ws.send(JSON.stringify({final:1}));
        }
      }
    });
  });
  const previews:string[]=[];
  const stream=await openRecognizer(config(provider),text=>previews.push(text),new AbortController().signal,()=>new WebSocket("ws://127.0.0.1:"+(server!.address() as {port:number}).port));
  stream.push(Buffer.alloc(6400));expect((await stream.finish()).text).toBe("不要矿泉水");
  expect(previews).toContain("临时错误");
  if(provider==="ali")expect(packets[0]).toMatchObject({payload:{model:"qwen-audio-3.1-asr-flash-message",parameters:{disfluency_removal_enabled:false}}});
});
