import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoothConfig } from "./config.js";
import { createBoothApplication } from "./server.js";

it("单端口交付入口提供网页与素材，保留回调协议且不公开工作目录文件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "booth-delivery-"));
  const web = join(directory, "web"); mkdirSync(join(web,"assets"), { recursive:true });
  writeFileSync(join(web,"index.html"), "<!doctype html><title>交付网页</title>");
  writeFileSync(join(web,"assets","app.js"), "console.log('delivery')");
  writeFileSync(join(directory,".env"), "PRIVATE=not-public");
  const app = createBoothApplication({ ...readBoothConfig(), databasePath:join(directory,"state.sqlite"),
    openaiKey:undefined, deepseekKey:undefined }, { webDirectory:web });
  try {
    const base = "http://127.0.0.1:" + await app.listen(0);
    const page = await fetch(base); expect(page.status).toBe(200); expect(await page.text()).toContain("交付网页");
    const asset = await fetch(base+"/assets/app.js"); expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("delivery");
    expect((await fetch(base,{method:"HEAD"})).status).toBe(200);
    for (const path of ["/.env","/state.sqlite","/assets/%2e%2e%2f%2e%2e%2f.env","/api/missing"]) {
      expect((await fetch(base+path)).status).toBe(404);
    }
    for (const [path,body] of [["/api/task/finished",{result:"success"}],["/api/task/error",{message:"测试故障"}]] as const) {
      const response = await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      expect(response.status).toBe(200); expect(await response.json()).toEqual({code:1,data:"OK",success:true});
    }
  } finally { await app.close(); rmSync(directory,{recursive:true,force:true}); }
});
