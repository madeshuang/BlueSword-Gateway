import {expect,it} from "vitest";
import {PcmFrames} from "./frames";
it("发送的PCM严格限制为60秒，轮询晚到和停止尾包不会超量",()=>{
  const received:ArrayBuffer[]=[];const frames=new PcmFrames(data=>received.push(data));
  expect(frames.push(new Uint8Array(1919900))).toBe(false);
  expect(frames.push(new Uint8Array(4096))).toBe(true);
  expect(frames.push(new Uint8Array(4096))).toBe(true);frames.flush();
  expect(received.reduce((sum,data)=>sum+data.byteLength,0)).toBe(1920000);
  expect(received.every(data=>data.byteLength%2===0&&data.byteLength<=6400)).toBe(true);
});
