import { isIP } from "node:net";

import { isProductionEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";
import { requireSharedRedisClient } from "@/lib/shared-redis";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

export function getClientIp(request: Request): string | undefined {
  const vercelForwarded = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0];
  const realIp = request.headers.get("x-real-ip") ?? undefined;
  // The right-most XFF entry is the value appended by the nearest proxy.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1);

  if (process.env.VERCEL) {
    return validIp(vercelForwarded);
  }

  return validIp(realIp) ?? validIp(forwarded);
}

export async function checkIpRateLimit(ip: string | undefined) {
  if (!isProductionEnvironment || !ip) {
    if (!isProductionEnvironment) {
      return;
    }
    throw new ChatbotError("rate_limit:chat");
  }

  try {
    const redis = await requireSharedRedisClient();
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
    // A shared limiter outage must not silently disable abuse protection.
    throw new ChatbotError("offline:chat");
  }
}

type AuthRateLimitBucket = "challenge" | "verify";

const AUTH_RATE_LIMITS: Record<
  AuthRateLimitBucket,
  { global: number; perIp: number }
> = {
  challenge: { global: 300, perIp: 20 },
  verify: { global: 150, perIp: 10 },
};
const AUTH_RATE_LIMIT_TTL_SECONDS = 60;

const AUTH_RATE_LIMIT_LUA = `
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

export class AuthRateLimitError extends Error {
  readonly status: 429 | 503;

  constructor(status: 429 | 503) {
    super(
      status === 429
        ? "Authentication rate limit exceeded"
        : "Authentication limiter unavailable",
    );
    this.name = "AuthRateLimitError";
    this.status = status;
  }
}

/**
 * Apply a deployment-wide, Redis-backed limiter before public Enoki auth work.
 * Redis failures deny the request; a process-local fallback could be bypassed
 * by spreading requests across replicas.
 */
export async function checkAuthRateLimit(
  request: Request,
  bucket: AuthRateLimitBucket,
) {
  const ip = getClientIp(request) ?? "unknown";
  const limits = AUTH_RATE_LIMITS[bucket];

  try {
    const redis = await requireSharedRedisClient();
    const result = await redis.eval(AUTH_RATE_LIMIT_LUA, {
      arguments: [
        String(limits.perIp),
        String(limits.global),
        String(AUTH_RATE_LIMIT_TTL_SECONDS),
      ],
      keys: [
        `auth-rate-limit:{${bucket}}:ip:${ip}`,
        `auth-rate-limit:{${bucket}}:global`,
      ],
    });

    if (Number(result) !== 1) {
      throw new AuthRateLimitError(429);
    }
  } catch (error) {
    if (error instanceof AuthRateLimitError) {
      throw error;
    }
    throw new AuthRateLimitError(503);
  }
}
