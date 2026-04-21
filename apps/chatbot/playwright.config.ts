import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

// Match the dev script's actual port (next dev --port 3001).
const PORT = process.env.PORT || "3001";
const baseURL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : 2,
  reporter: isCI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["github"],
        ["list"],
        ["junit", { outputFile: "playwright-report/junit.xml" }],
      ]
    : [["html", { open: "never", outputFolder: "playwright-report" }], ["list"]],

  globalSetup: require.resolve("./tests/playwright/global-setup"),

  use: {
    baseURL,
    trace: "retain-on-failure",
    video: isCI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  timeout: 60_000,
  expect: { timeout: 10_000 },

  projects: [
    {
      name: "e2e",
      testMatch: /e2e\/.*\.test\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "pnpm dev",
    url: `${baseURL}/ping`,
    timeout: 120_000,
    reuseExistingServer: !isCI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Force the mock AI provider (lib/ai/providers.ts → isTestEnvironment path).
      PLAYWRIGHT: "True",
      // Ensure the webServer binds the port baseURL targets.
      PORT,
    },
  },
});
