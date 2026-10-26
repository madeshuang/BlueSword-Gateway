import { readBoothConfig } from "./config.js";
import { createBoothApplication } from "./server.js";
import { resolve } from "node:path";

if (process.argv.includes("--simulator")) {
  process.env.BOOTH_ROBOT_MODE = "simulator";
  process.env.BOOTH_DB_PATH = process.env.BOOTH_DEMO_DB_PATH ?? ".data/booth-demo.sqlite";
  process.env.BOOTH_CATALOG_PATH = process.env.BOOTH_DEMO_CATALOG_PATH ?? "config/booth-catalog.example.json";
  process.env.ROBOT_DISPATCH_URL = "http://127.0.0.1:4200/api/task/dispatch";
}
if (process.argv.includes("--manual")) {
  // 覆盖正式环境中的机器人地址和数据库，人工练习不会触碰真实任务。
  process.env.PORT = process.env.BOOTH_MANUAL_PORT ?? "4101";
  process.env.BOOTH_HOST = "127.0.0.1";
  process.env.BOOTH_ROBOT_MODE = "simulator";
  process.env.BOOTH_DB_PATH = process.env.BOOTH_MANUAL_DB_PATH ?? ".data/booth-manual.sqlite";
  process.env.BOOTH_CATALOG_PATH = process.env.BOOTH_MANUAL_CATALOG_PATH?.trim() || "config/booth-catalog.example.json";
  process.env.BOOTH_CATALOG_CONFIRMED = "true";
  process.env.ROBOT_DISPATCH_URL = "http://127.0.0.1:" + (process.env.BOOTH_MANUAL_ROBOT_PORT ?? "4201") + "/api/task/dispatch";
  process.env.ROBOT_TIMEOUT_MS = "120000";
  process.env.BOOTH_OPERATOR_TOKEN = "manual-local-only";
}
const port = Number(process.env.PORT ?? 4100);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("PORT 不合法");
const host = process.env.BOOTH_HOST ?? "127.0.0.1";
const app = createBoothApplication(readBoothConfig(), process.argv.includes("--serve-web") ? {webDirectory:resolve("apps/web/dist")} : {});
await app.listen(port, host);
console.log("BlueSword-Gateway API: http://" + host + ":" + port);
let stopping = false;
const shutdown = async () => { if (stopping) return; stopping = true; await app.close(); };
process.once("SIGINT",()=>void shutdown());
process.once("SIGTERM",()=>void shutdown());
