import { isIP } from "node:net";
import { createClient } from "redis";

import { isProductionEnvironment, isTestEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

const REDIS_CONNECT_TIMEOUT_MS = 1000;
const REDIS_MAX_RECONNECT_ATTEMPTS = 2;

export const GUEST_AUTH_RATE_LIMIT_PER_IP = 5;
export const GUEST_AUTH_RATE_LIMIT_GLOBAL = 60;
export const GUEST_AUTH_RATE_LIMIT_TTL_SECONDS = 15 * 60;

const GUEST_AUTH_RATE_LIMIT_LUA = `
local ip_key       = KEYS[1]
local global_key   = KEYS[2]
local ip_limit     = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local ttl          = tonumber(ARGV[3])
local consume      = tonumber(ARGV[4])

local ip_count = tonumber(redis.call('GET', ip_key) or '0')
local global_count = tonumber(redis.call('GET', global_key) or '0')
if ip_count >= ip_limit or global_count >= global_limit then
  return 0
end

if consume ~= 1 then
  return 1
end

ip_count = redis.call('INCR', ip_key)
global_count = redis.call('INCR', global_key)
if ip_count == 1 then redis.call('EXPIRE', ip_key, ttl) end
if global_count == 1 then redis.call('EXPIRE', global_key, ttl) end
return 1
`;

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let connectPromise: Promise<void> | null = null;

const memoryGuestCounters = new Map<
  string,
  { count: number; expiresAt: number }
>();

function ensureRedisClient(): RedisClient | null {
  if (client) {
    return client;
  }

  const url = process.env.REDIS_URL;
  if (!url) {
    return null;
  }

  client = createClient({
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => {
        if (retries >= REDIS_MAX_RECONNECT_ATTEMPTS) {
          return false;
        }
        return Math.min(50 * 2 ** retries, 200);
      },
    },
    url,
  });
  client.on("error", () => undefined);
  return client;
}

function beginConnect(redis: RedisClient): void {
  if (redis.isOpen || connectPromise) {
    return;
  }

  connectPromise = redis.connect().then(
    () => undefined,
    () => {
      client = null;
    }
  );
}

function getClient() {
  const redis = ensureRedisClient();
  if (redis) {
    beginConnect(redis);
  }
  return redis;
}

async function getReadyRedisClient(): Promise<RedisClient | null> {
  const redis = ensureRedisClient();
  if (!redis) {
    return null;
  }

  if (redis.isReady) {
    return redis;
  }

  beginConnect(redis);

  if (connectPromise) {
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  return client?.isReady ? client : null;
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

function takeMemoryGuestSlot(ip: string, consume: boolean): boolean {
  const ttlMs = GUEST_AUTH_RATE_LIMIT_TTL_SECONDS * 1000;
  const ipKey = `guest-auth-rate:ip:${ip}`;
  if (
    memoryCount(ipKey) >= GUEST_AUTH_RATE_LIMIT_PER_IP ||
    memoryCount("guest-auth-rate:global") >= GUEST_AUTH_RATE_LIMIT_GLOBAL
  ) {
    return false;
  }
  if (consume) {
    memoryIncr(ipKey, ttlMs);
    memoryIncr("guest-auth-rate:global", ttlMs);
  }
  return true;
}

/** Test-only: reset the process-local guest limiter and Redis singleton. */
export function resetMemoryGuestAuthRateLimit(): void {
  memoryGuestCounters.clear();
  client = null;
  connectPromise = null;
}

/**
 * Cap unauthenticated guest User inserts. Always on outside Playwright.
 * Production fail-closed on Redis. Dev uses Redis if ready, else process-local
 * counters.
 */
export async function checkGuestAuthRateLimit(
  request: Request,
  options?: { consume?: boolean }
): Promise<void> {
  if (isTestEnvironment) {
    return;
  }

  const consume = options?.consume !== false;
  const ip = getClientIp(request) ?? "unknown";

  const redis = await getReadyRedisClient();
  if (redis) {
    try {
      const result = await redis.eval(GUEST_AUTH_RATE_LIMIT_LUA, {
        arguments: [
          String(GUEST_AUTH_RATE_LIMIT_PER_IP),
          String(GUEST_AUTH_RATE_LIMIT_GLOBAL),
          String(GUEST_AUTH_RATE_LIMIT_TTL_SECONDS),
          consume ? "1" : "0",
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

  if (!takeMemoryGuestSlot(ip, consume)) {
    throw new GuestAuthRateLimitError(429);
  }
}
