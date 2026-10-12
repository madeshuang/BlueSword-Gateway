import { defineConfig } from "vitest/config";

// Controlled tests must not load local supplier credentials from environment files.
export default defineConfig({ envDir: false });
