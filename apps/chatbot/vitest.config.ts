import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Unit-test config for apps/chatbot. Scoped to *.unit.test.ts so it does not
// collide with the Playwright E2E suite (tests/playwright/**, run via
// `pnpm test:e2e`). Run with `pnpm test:unit`.
export default defineConfig({
  test: {
    include: ["**/*.unit.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
