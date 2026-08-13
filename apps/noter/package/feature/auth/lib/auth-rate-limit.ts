import "server-only";

import { isIP } from "node:net";
import { requireSharedRedisClient } from "@/shared/lib/shared-redis";

const AUTH_RATE_LIMIT_TTL_SECONDS = 60;
const AUTH_RATE_LIMIT_PER_IP = 10;
const AUTH_RATE_LIMIT_GLOBAL = 150;

const AUTH_RATE_LIMIT_LUA = `
local ip_key = KEYS[1]
local global_key = KEYS[2]
local ip_limit = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local ip_count = tonumber(redis.call('GET', ip_key) or '0')
local global_count = tonumber(redis.call('GET', global_key) or '0')
if ip_count >= ip_limit or global_count >= global_limit then return 0 end
ip_count = redis.call('INCR', ip_key)
global_count = redis.call('INCR', global_key)
if ip_count == 1 then redis.call('EXPIRE', ip_key, ttl) end
if global_count == 1 then redis.call('EXPIRE', global_key, ttl) end
return 1
`;

export class AuthRateLimitError extends Error {
  constructor(readonly code: "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE") {
    super(
      code === "TOO_MANY_REQUESTS"
        ? "Too many authentication requests"
        : "Authentication limiter unavailable"
    );
    this.name = "AuthRateLimitError";
  }
}

function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

function clientIp(request: Request): string | undefined {
  const vercelForwarded = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0];
  if (process.env.VERCEL) return validIp(vercelForwarded);
  return (
    validIp(request.headers.get("x-real-ip") ?? undefined) ??
    validIp(request.headers.get("x-forwarded-for")?.split(",").at(-1))
  );
}

/** Limit public auth work before any gRPC/account verification call. */
export async function checkPublicAuthRateLimit(request: Request): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  try {
    const redis = await requireSharedRedisClient();
    const ip = clientIp(request) ?? "unknown";
    const result = await redis.eval(AUTH_RATE_LIMIT_LUA, {
      arguments: [
        String(AUTH_RATE_LIMIT_PER_IP),
        String(AUTH_RATE_LIMIT_GLOBAL),
        String(AUTH_RATE_LIMIT_TTL_SECONDS),
      ],
      keys: [
        `noter-auth-rate:{noter-auth}:ip:${ip}`,
        "noter-auth-rate:{noter-auth}:global",
      ],
    });
    if (Number(result) !== 1) {
      throw new AuthRateLimitError("TOO_MANY_REQUESTS");
    }
  } catch (error) {
    if (error instanceof AuthRateLimitError) throw error;
    throw new AuthRateLimitError("SERVICE_UNAVAILABLE");
  }
}
