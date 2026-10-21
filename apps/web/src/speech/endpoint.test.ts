import {expect,it} from "vitest";
import {SpeechEndpoint} from "./endpoint";
it("检测到讲话后才按两秒停顿结束，句中短暂停顿后可继续",()=>{
  const endpoint=new SpeechEndpoint();endpoint.activity(0.9,100);endpoint.activity(0.9,450);
  expect(endpoint.poll(2000)).toBe(null);endpoint.activity(0.8,2100);
  expect(endpoint.poll(4099)).toBe(null);expect(endpoint.poll(4100)).toBe("pause");
});
it("开始后未检测到讲话等待十秒；短促噪声不算有效讲话",()=>{
  const endpoint=new SpeechEndpoint();endpoint.activity(0.9,100);endpoint.activity(0.05,150);
  expect(endpoint.poll(9999)).toBe(null);expect(endpoint.poll(10000)).toBe("no-speech");
});
it("持续的背景讲话也会延后停止，但单轮最长六十秒",()=>{
  const endpoint=new SpeechEndpoint();endpoint.activity(0.9,100);endpoint.activity(0.9,450);endpoint.activity(0.9,59000);
  expect(endpoint.poll(59999)).toBe(null);expect(endpoint.poll(60000)).toBe("limit");
});
