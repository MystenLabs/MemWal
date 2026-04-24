/**
 * Playwright global setup.
 *
 * Runs once before any test (after the webServer is spawned). Responsible for:
 *   1. Applying Drizzle migrations so chat/user tables exist.
 *   2. Failing fast with a clear error if POSTGRES_URL is missing in CI.
 *   3. Warming the `/` route so the first `page.goto("/")` in the suite
 *      doesn't race Turbopack's lazy cold compile against the 15s
 *      navigationTimeout on CI runners.
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

  // Prime Next.js/Turbopack's per-route compile cache for `/`. On a cold
  // CI runner the first `page.goto("/")` can take 15-30s (the route is
  // compiled lazily on first hit), which exceeds the default 15s
  // navigationTimeout and flakes tests until retries kick in. Fetching
  // here moves the cost to setup time so the first real test navigation
  // hits a warm cache.
  const port = process.env.PORT ?? "3001";
  const target = `http://localhost:${port}/`;
  console.log(`[playwright] Warming ${target} ...`);
  try {
    const started = Date.now();
    const res = await fetch(target, {
      redirect: "manual", // `/` may 307 to /api/auth/guest; we just want the compile
      signal: AbortSignal.timeout(60_000),
    });
    console.log(`[playwright] Warm-up done in ${Date.now() - started}ms (status ${res.status})`);
  } catch (err) {
    console.warn("[playwright] Warm-up failed, continuing:", err);
  }
}
