import { isIP } from "node:net";
import { createClient } from "redis";

import { isProductionEnvironment, isTestEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

export const GUEST_AUTH_RATE_LIMIT_PER_IP = 5;
export const GUEST_AUTH_RATE_LIMIT_GLOBAL = 60;
export const GUEST_AUTH_RATE_LIMIT_TTL_SECONDS = 15 * 60;

const GUEST_AUTH_RATE_LIMIT_LUA = `
local ip_key       = KEYS[1]
local global_key   = KEYS[2]
local ip_limit     = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local ttl          = tonumber(ARGV[3])

local ip_count = tonumber(redis.call('GET', ip_key) or '0')
local global_count = tonumber(redis.call('GET', global_key) or '0')
if ip_count >= ip_limit or global_count >= global_limit then
  return 0
end

ip_count = redis.call('INCR', ip_key)
global_count = redis.call('INCR', global_key)
if ip_count == 1 then redis.call('EXPIRE', ip_key, ttl) end
if global_count == 1 then redis.call('EXPIRE', global_key, ttl) end
return 1
`;

let client: ReturnType<typeof createClient> | null = null;

const memoryGuestCounters = new Map<
  string,
  { count: number; expiresAt: number }
>();

function getClient() {
  if (!client && process.env.REDIS_URL) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
    client.connect().catch(() => {
      client = null;
    });
  }
  return client;
}

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

/** Client IP for abuse controls. Missing/invalid headers share the `unknown` bucket. */
export function getClientIp(request: Request): string | undefined {
  const vercelForwarded = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0];
  const realIp = request.headers.get("x-real-ip") ?? undefined;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1);

  if (process.env.VERCEL) {
    return validIp(vercelForwarded);
  }

  return validIp(realIp) ?? validIp(forwarded);
}

export async function checkIpRateLimit(ip: string | undefined) {
  if (!isProductionEnvironment || !ip) {
    return;
  }

  const redis = getClient();
  if (!redis?.isReady) {
    return;
  }

  try {
    const key = `ip-rate-limit:${ip}`;
    const [count] = await redis
      .multi()
      .incr(key)
      .expire(key, TTL_SECONDS, "NX")
      .exec();

    if (typeof count === "number" && count > MAX_MESSAGES) {
      throw new ChatbotError("rate_limit:chat");
    }
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
  }
}

export class GuestAuthRateLimitError extends Error {
  readonly status: 429 | 503;

  constructor(status: 429 | 503) {
    super(
      status === 429
        ? "Too many guest logins"
        : "Guest login limiter unavailable"
    );
    this.name = "GuestAuthRateLimitError";
    this.status = status;
  }
}

function memoryCount(key: string): number {
  const current = memoryGuestCounters.get(key);
  if (!current || current.expiresAt <= Date.now()) {
    return 0;
  }
  return current.count;
}

function memoryIncr(key: string, ttlMs: number): void {
  const now = Date.now();
  const current = memoryGuestCounters.get(key);
  if (!current || current.expiresAt <= now) {
    memoryGuestCounters.set(key, { count: 1, expiresAt: now + ttlMs });
    return;
  }
  current.count += 1;
}

function consumeMemoryGuestSlot(ip: string): boolean {
  const ttlMs = GUEST_AUTH_RATE_LIMIT_TTL_SECONDS * 1000;
  const ipKey = `guest-auth-rate:ip:${ip}`;
  if (
    memoryCount(ipKey) >= GUEST_AUTH_RATE_LIMIT_PER_IP ||
    memoryCount("guest-auth-rate:global") >= GUEST_AUTH_RATE_LIMIT_GLOBAL
  ) {
    return false;
  }
  memoryIncr(ipKey, ttlMs);
  memoryIncr("guest-auth-rate:global", ttlMs);
  return true;
}

/** Test-only: reset the process-local guest limiter. */
export function resetMemoryGuestAuthRateLimit(): void {
  memoryGuestCounters.clear();
}

/**
 * Cap unauthenticated guest User inserts. Always on outside Playwright:
 * the chat IP limiter is production-only and a no-op without Redis, which
 * is how five local curls each created a row.
 *
 * Production requires Redis (fail closed). Local/dev uses Redis when ready,
 * otherwise a process-local counter so `next dev` is still throttled.
 */
export async function checkGuestAuthRateLimit(request: Request): Promise<void> {
  if (isTestEnvironment) {
    return;
  }

  const ip = getClientIp(request) ?? "unknown";

  const redis = getClient();
  if (redis?.isReady) {
    try {
      const result = await redis.eval(GUEST_AUTH_RATE_LIMIT_LUA, {
        arguments: [
          String(GUEST_AUTH_RATE_LIMIT_PER_IP),
          String(GUEST_AUTH_RATE_LIMIT_GLOBAL),
          String(GUEST_AUTH_RATE_LIMIT_TTL_SECONDS),
        ],
        keys: [
          `guest-auth-rate:{guest}:ip:${ip}`,
          "guest-auth-rate:{guest}:global",
        ],
      });
      if (Number(result) !== 1) {
        throw new GuestAuthRateLimitError(429);
      }
      return;
    } catch (error) {
      if (error instanceof GuestAuthRateLimitError) {
        throw error;
      }
      if (isProductionEnvironment) {
        throw new GuestAuthRateLimitError(503);
      }
    }
  }

  if (isProductionEnvironment) {
    throw new GuestAuthRateLimitError(503);
  }

  if (!consumeMemoryGuestSlot(ip)) {
    throw new GuestAuthRateLimitError(429);
  }
}
