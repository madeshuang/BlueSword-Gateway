import { readBoothConfig } from "./config.js";
import { createBoothApplication } from "./server.js";

if (process.argv.includes("--simulator")) {
  process.env.BOOTH_ROBOT_MODE = "simulator";
  process.env.BOOTH_DB_PATH = process.env.BOOTH_DEMO_DB_PATH ?? ".data/booth-demo.sqlite";
  process.env.BOOTH_CATALOG_PATH = process.env.BOOTH_DEMO_CATALOG_PATH ?? "config/booth-catalog.example.json";
  process.env.ROBOT_DISPATCH_URL = "http://127.0.0.1:4200/api/task/dispatch";
}
const app = createBoothApplication(readBoothConfig());
const port = Number(process.env.PORT ?? 4100);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("PORT 不合法");
const host = process.env.BOOTH_HOST ?? "127.0.0.1";
await app.listen(port, host);
console.log("BlueSword-Gateway API: http://" + host + ":" + port);
let stopping = false;
const shutdown = async () => { if (stopping) return; stopping = true; await app.close(); };
process.once("SIGINT",()=>void shutdown());
process.once("SIGTERM",()=>void shutdown());
