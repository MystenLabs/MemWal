/**
 * Playwright global setup.
 *
 * Runs once before any test (after the webServer is spawned). Responsible for:
 *   1. Applying Drizzle migrations so chat/user tables exist.
 *   2. Failing fast with a clear error if POSTGRES_URL is missing in CI.
 *   3. Warming the routes the suite exercises so no test races Turbopack's lazy
 *      cold compile against the navigationTimeout on CI runners.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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

  await warmRoutes();
}

const jar = new Map<string, string>();

function storeCookies(response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const separator = pair.indexOf("=");

    if (separator > 0) {
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

/**
 * Fetch a route the way a browser reaches it: following redirects and keeping
 * the cookies they set.
 *
 * Unauthenticated requests are bounced to /api/auth/guest by the proxy, so a
 * single non-following request never renders the route it names and compiles
 * nothing. Redirects are followed as GET, matching how the proxy sends a
 * would-be POST through the guest handshake first.
 */
async function fetchFollowing(
  url: string,
  init: { method?: string; body?: string } = {}
): Promise<Response> {
  let target = url;
  let method = init.method ?? "GET";
  let body = init.body;

  for (let hop = 0; hop < 5; hop++) {
    const response: Response = await fetch(target, {
      method,
      body,
      headers: jar.size > 0 ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {},
      redirect: "manual",
      // Matches the webServer budget. A 2-vCPU runner compiles slower than a
      // dev laptop, where `/` alone took 39s from a cleared .next.
      signal: AbortSignal.timeout(120_000),
    });

    storeCookies(response);
    const location = response.headers.get("location");

    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }

    target = new URL(location, target).toString();
    method = "GET";
    body = undefined;
  }

  throw new Error(`Too many redirects while warming ${url}`);
}

/**
 * Prime Turbopack's per-route compile cache before the first test runs.
 *
 * Routes compile lazily on first hit, and on a cold cache that first hit costs
 * seconds to tens of seconds. Warming `/` alone was not enough: sending a
 * message still paid for `/api/chat` and `/chat/[id]` mid-test, overrunning both
 * the 30s navigationTimeout and the 60s test timeout. Retries hid it, since by
 * the second attempt the routes were warm.
 *
 * Each request is shaped to compile its route without writing anything: an
 * unparseable chat body is rejected before it reaches the database, and a random
 * chat id belongs to nobody. Failures are not fatal — a slow first test beats a
 * suite that cannot start.
 */
async function warmRoutes(): Promise<void> {
  const port = process.env.PORT ?? "3001";
  const base = `http://localhost:${port}`;
  const routes: [string, { method?: string; body?: string }?][] = [
    ["/"],
    ["/login"],
    ["/register"],
    ["/api/history?limit=1"],
    ["/api/chat", { method: "POST", body: "{}" }],
    [`/api/document?id=${randomUUID()}`],
    [`/chat/${randomUUID()}`],
  ];

  for (const [path, init] of routes) {
    const started = Date.now();
    try {
      const response = await fetchFollowing(`${base}${path}`, init);
      console.log(
        `[playwright] Warmed ${path} in ${Date.now() - started}ms (status ${response.status})`
      );
    } catch (err) {
      console.warn(`[playwright] Warming ${path} failed, continuing:`, err);
    }
  }
}
