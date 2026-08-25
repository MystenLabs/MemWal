import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

// Later files never override earlier ones, matching Next's own precedence.
config({ path: ".env.local" });
config({ path: ".env" });

// Match the dev script's default port (next dev, no --port flag).
const PORT = process.env.PORT || "3000";
const baseURL = `http://localhost:${PORT}`;

const isCI = !!process.env.CI;

export const STORAGE_STATE_USER_A = path.join(
  __dirname,
  "tests/playwright/.auth/user-a.json"
);

// A second identity for cross-account tests. Signed in once by the setup
// project rather than per-test: the auth limiter allows only 10 verify
// attempts per IP per minute, which retries would otherwise exhaust.
export const STORAGE_STATE_USER_B = path.join(
  __dirname,
  "tests/playwright/.auth/user-b.json"
);

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
    // globalSetup also warms key routes to make first-nav fast.
    navigationTimeout: 30_000,
  },

  timeout: 60_000,
  expect: { timeout: 10_000 },

  projects: [
    {
      // Signs in through the real login form once and saves the session
      // cookie; every e2e spec starts from that storage state.
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "e2e",
      testMatch: /e2e\/.*\.test\.ts$/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE_USER_A,
      },
    },
  ],

  webServer: {
    command: "pnpm dev",
    url: `${baseURL}/ping`,
    timeout: 120_000,
    // Locally this drives whatever `pnpm dev` is already up, which without
    // PLAYWRIGHT in its env runs no mocks at all. Reuse stays on for the fast
    // iteration loop against a `PLAYWRIGHT=True pnpm dev`; global-setup.ts
    // reads the seam header from /ping and refuses any other server.
    reuseExistingServer: !isCI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Force every mock seam (lib/constants.ts → isTestEnvironment):
      // AI models, the delegate-account binding check, and the Walrus client.
      PLAYWRIGHT: "True",
      // Ensure the webServer binds the port baseURL targets.
      PORT,
      // The session JWT is minted and verified inside this one process, so
      // any non-empty secret works when the environment doesn't provide one.
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? "playwright-e2e-secret-not-for-production",
      // The binding mock fabricates the MemWalAccount type from this id; it
      // only has to be non-empty and stable for the run.
      NEXT_PUBLIC_MEMWAL_PACKAGE_ID:
        process.env.NEXT_PUBLIC_MEMWAL_PACKAGE_ID ?? `0x${"ee".repeat(32)}`,
      // The auth rate limiter is fail-closed (503 without Redis); default to
      // the conventional local instance when the environment doesn't say.
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    },
  },
});
