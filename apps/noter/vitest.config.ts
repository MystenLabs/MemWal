import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Unit-test config for apps/noter. Scoped to *.unit.test.ts. Run with
// `pnpm test:unit`. Aliases mirror tsconfig paths so tests can import via
// @/shared and @/feature.
export default defineConfig({
  test: {
    include: ["**/*.unit.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@/shared": resolve(__dirname, "./package/shared"),
      "@/feature": resolve(__dirname, "./package/feature"),
      "@": resolve(__dirname, "."),
    },
  },
});
