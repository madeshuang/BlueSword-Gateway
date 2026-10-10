import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BoothProduct } from "@bluesword/contracts";

export interface BoothConfig {
  mode: "http" | "simulator"; dispatchUrl: string | undefined; databasePath: string;
  catalogConfirmed: boolean; products: BoothProduct[]; robotTimeoutMs: number;
  openaiKey: string | undefined; openaiModel: string; openaiTimeoutMs: number;
  operatorToken: string | undefined;
}
export function readBoothConfig(): BoothConfig {
  const mode = process.env.BOOTH_ROBOT_MODE ?? "http";
  if (mode !== "http" && mode !== "simulator") throw new Error("BOOTH_ROBOT_MODE 必须为 http 或 simulator");
  const dispatchUrl = process.env.ROBOT_DISPATCH_URL;
  if (dispatchUrl) {
    const url = new URL(dispatchUrl);
    if (mode === "simulator" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("测试对端必须使用回环地址");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("机器人地址必须为无凭据的 HTTP(S) URL");
  }
  const products = JSON.parse(readFileSync(resolve(process.env.BOOTH_CATALOG_PATH ?? "config/booth-catalog.example.json"), "utf8")) as unknown;
  validateCatalog(products);
  return {
    mode, dispatchUrl, products, databasePath: resolve(process.env.BOOTH_DB_PATH ?? ".data/booth.sqlite"),
    catalogConfirmed: process.env.BOOTH_CATALOG_CONFIRMED === "true",
    robotTimeoutMs: positive("ROBOT_TIMEOUT_MS", 8000), openaiTimeoutMs: positive("OPENAI_TIMEOUT_MS", 20000),
    openaiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    operatorToken: process.env.BOOTH_OPERATOR_TOKEN?.trim() || undefined,
  };
}
function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 100 || value > 120000) throw new Error(name + " 必须为 100–120000 毫秒");
  return value;
}
export function validateCatalog(value: unknown): asserts value is BoothProduct[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("目录必须包含物品");
  const ids = new Set<string>();
  for (const p of value) {
    if (!p || typeof p !== "object" ||
      ["id","name","category","subtitle","description","location","color"].some(k => typeof p[k] !== "string" || !p[k].trim()) ||
      !Number.isSafeInteger(p.maxCount) || p.maxCount < 1 || p.maxCount > 100 ||
      !["water","snack","gift","greens"].includes(p.art) || ids.has(p.id)) throw new Error("目录字段缺失、重复或取值不合法");
    if (!/^#[0-9a-f]{6}$/i.test(p.color)) throw new Error("目录 color 必须为六位十六进制色值");
    if (p.imageUrl !== undefined && (typeof p.imageUrl !== "string" || !p.imageUrl.startsWith("/products/") || p.imageUrl.includes(".."))) throw new Error("商品照片须使用 /products/ 下本地素材");
    ids.add(p.id);
  }
}
