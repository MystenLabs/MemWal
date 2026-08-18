import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.local" });

// package.json's dev script hard-codes `next dev --port 3002` — the `--port`
// CLI flag wins over any PORT env var, so this can't be env-derived without
// going stale the moment .env.local's PORT is repurposed for something else
// (e.g. manually running noter on 5173 to match Enoki's registered OAuth
// origin, which is what broke this once already).
const PORT = "3002";
const baseURL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/playwright",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 2,
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
    // 30s to tolerate cold Next.js/Turbopack compile on 2-vCPU CI runners;
    // globalSetup also warms `/` to make first-nav fast on the happy path.
    navigationTimeout: 30_000,
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
    // `/api/memory/health` answers 503 when Walrus Memory is unconfigured, which
    // Playwright would read as "server not up" — gate on the landing page instead.
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !isCI,
    stdout: "pipe",
    stderr: "pipe",
    // Flips lib/constants.ts's isTestEnvironment, which gates
    // delegate-account.ts onto the fixture mock instead of a live gRPC read.
    env: { PORT, PLAYWRIGHT: "True" },
  },
});
