/**
 * Playwright global setup.
 *
 * Runs once before any test (after the webServer is spawned). Responsible for:
 *   1. Applying Drizzle migrations so note/user/session tables exist.
 *   2. Failing fast with a clear error if DATABASE_URL is missing in CI.
 *   3. Warming the `/` route so the first `page.goto("/")` in the suite
 *      doesn't race Turbopack's lazy cold compile against navigationTimeout.
 *
 * Note: migrations run via `tsx package/shared/lib/db/migrate.ts` — the same
 * entrypoint the Docker image uses — rather than `pnpm db:push`. drizzle-kit
 * 0.31.x rejects the pinned drizzle-orm 0.45.2 ("requires newer version of
 * drizzle-orm"), so every `db:*` script currently fails.
 */
import { spawnSync } from "node:child_process";

const MIGRATE_ENTRYPOINT = "package/shared/lib/db/migrate.ts";

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL;

  if (!url) {
    if (process.env.CI) {
      throw new Error(
        "DATABASE_URL is required in CI. Start a Postgres service container and export the URL.",
      );
    }
    console.warn(
      "[playwright] DATABASE_URL not set — skipping migrations (local dev only). " +
        "Start the local database with: cd apps/noter && docker compose up -d",
    );
  } else {
    console.log("[playwright] Applying Drizzle migrations...");
    const result = spawnSync("pnpm", ["exec", "tsx", MIGRATE_ENTRYPOINT], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      throw new Error(`[playwright] Migration failed with exit code ${result.status}`);
    }
  }

  // Prime Next.js/Turbopack's per-route compile cache for `/`. On a cold runner
  // the first `page.goto("/")` can take 15-30s (routes compile lazily on first
  // hit), which exceeds navigationTimeout and flakes tests until retries kick
  // in. Fetching here moves that cost into setup.
  const port = process.env.PORT || "3002";
  try {
    await fetch(`http://localhost:${port}/`);
    console.log("[playwright] Warmed / route");
  } catch {
    console.warn("[playwright] Could not warm / route — continuing anyway");
  }
}
