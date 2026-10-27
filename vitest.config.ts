import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Controlled tests must not load local supplier credentials from environment files.
export default defineConfig({ envDir: false, test: {
  // 固定回归样本独立于实际默认清单；真实启动入口另行验证默认的 10 种物品。
  env: { BOOTH_CATALOG_PATH: resolve("scripts/fixtures/booth-catalog.json") },
  exclude: [...configDefaults.exclude, "**/.tmp/**", "**/.scratch/**", "**/.pnpm-store/**"],
} });
