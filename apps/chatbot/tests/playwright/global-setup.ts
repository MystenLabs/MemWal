/**
 * Playwright global setup.
 *
 * Runs once before any test. Responsible for:
 *   1. Applying Drizzle migrations so chat/user tables exist.
 *   2. Failing fast with a clear error if POSTGRES_URL is missing in CI.
 */
import { spawnSync } from "node:child_process";

export default async function globalSetup(): Promise<void> {
  const url = process.env.POSTGRES_URL;

  if (!url) {
    if (process.env.CI) {
      throw new Error(
        "POSTGRES_URL is required in CI. Start a Postgres service container and export the URL."
      );
    }
    console.warn("[playwright] POSTGRES_URL not set — skipping migrations (local dev only)");
    return;
  }

  console.log("[playwright] Applying Drizzle migrations...");
  const result = spawnSync("pnpm", ["exec", "tsx", "lib/db/migrate.ts"], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`[playwright] Migration failed with exit code ${result.status}`);
  }
}
