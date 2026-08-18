/**
 * Playwright global setup.
 *
 * Runs once before any test (after the webServer is spawned). Responsible for:
 *   1. Applying Drizzle migrations so chat/user tables exist.
 *   2. Failing fast with a clear error if POSTGRES_URL is missing in CI.
 *   3. Clearing the auth rate-limit counters left by a previous run.
 *   4. Warming `/login` and `/` so the suite's first navigations don't race
 *      Turbopack's lazy cold compile against the navigationTimeout on CI.
 */
import { spawnSync } from "node:child_process";
import { createClient } from "redis";

/**
 * The auth limiter allows 10 verify attempts per IP per minute and the suite
 * spends about five. Without this, two runs inside a minute — routine while
 * iterating locally — fail at sign-in with a 429 that looks nothing like the
 * real problem. Only this app's own limiter keys are touched.
 */
async function clearAuthRateLimits(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;

  const client = createClient({ url });
  client.on("error", () => {
    // Handled by the catch below; without a listener node-redis throws.
  });

  try {
    await client.connect();
    const keys = await client.keys("auth-rate-limit:*");
    if (keys.length > 0) {
      await client.del(keys);
      console.log(`[playwright] Cleared ${keys.length} auth rate-limit keys`);
    }
  } catch (err) {
    console.warn("[playwright] Could not clear auth rate limits:", err);
  } finally {
    try {
      client.destroy();
    } catch {
      // already closed
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const url = process.env.POSTGRES_URL;

  if (!url) {
    if (process.env.CI) {
      throw new Error(
        "POSTGRES_URL is required in CI. Start a Postgres service container and export the URL."
      );
    }
    console.warn(
      "[playwright] POSTGRES_URL not set — skipping migrations (local dev only)"
    );
  } else {
    console.log("[playwright] Applying Drizzle migrations...");
    const result = spawnSync("pnpm", ["exec", "tsx", "lib/db/migrate.ts"], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status !== 0) {
      throw new Error(
        `[playwright] Migration failed with exit code ${result.status}`
      );
    }
  }

  await clearAuthRateLimits();

  // Prime Next.js/Turbopack's per-route compile cache. On a cold CI runner
  // the first navigation to a lazily-compiled route can take 15-30s, which
  // flakes tests until retries kick in. Fetching here moves the cost to
  // setup time so the first real navigations hit a warm cache.
  const port = process.env.PORT ?? "3000";
  for (const route of ["/login", "/"]) {
    const target = `http://localhost:${port}${route}`;
    console.log(`[playwright] Warming ${target} ...`);
    try {
      const started = Date.now();
      const res = await fetch(target, {
        redirect: "manual", // `/` 307s to /login pre-auth; we just want the compile
        signal: AbortSignal.timeout(60_000),
      });
      console.log(
        `[playwright] Warm-up done in ${Date.now() - started}ms (status ${res.status})`
      );
    } catch (err) {
      console.warn("[playwright] Warm-up failed, continuing:", err);
    }
  }
}
