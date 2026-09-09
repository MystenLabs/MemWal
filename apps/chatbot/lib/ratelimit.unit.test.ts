import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limiterEnv = vi.hoisted(() => ({
  production: false,
  test: false,
}));

const redisHarness = vi.hoisted(() => {
  const harness = {
    isReady: false,
    isOpen: false,
    evalResult: 1 as unknown,
    evalError: null as Error | null,
    connect: vi.fn(async () => undefined),
    eval: vi.fn(async () => {
      if (harness.evalError) {
        throw harness.evalError;
      }
      return harness.evalResult;
    }),
  };
  return harness;
});

vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...actual,
    get isProductionEnvironment() {
      return limiterEnv.production;
    },
    get isTestEnvironment() {
      return limiterEnv.test;
    },
  };
});

vi.mock("redis", () => ({
  createClient: () => ({
    get isReady() {
      return redisHarness.isReady;
    },
    get isOpen() {
      return redisHarness.isOpen;
    },
    on: vi.fn(),
    connect: redisHarness.connect,
    eval: redisHarness.eval,
  }),
}));

import {
  checkGuestAuthRateLimit,
  checkIpRateLimit,
  GUEST_AUTH_RATE_LIMIT_PER_IP,
  GuestAuthRateLimitError,
  guestAuthLimitFromError,
  getClientIp,
  resetMemoryGuestAuthRateLimit,
} from "@/lib/ratelimit";

function requestWithHeaders(headers?: HeadersInit): Request {
  return new Request("http://127.0.0.1:3001/api/auth/guest?redirectUrl=/", {
    headers,
  });
}

const guestRouteSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../app/(auth)/api/auth/guest/route.ts"
  ),
  "utf8"
);

const authSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../app/(auth)/auth.ts"),
  "utf8"
);

describe("getClientIp", () => {
  it("prefers x-real-ip over x-forwarded-for", () => {
    expect(
      getClientIp(
        requestWithHeaders({
          "x-real-ip": "203.0.113.10",
          "x-forwarded-for": "198.51.100.1, 203.0.113.10",
        })
      )
    ).toBe("203.0.113.10");
  });

  it("uses the right-most x-forwarded-for hop", () => {
    expect(
      getClientIp(
        requestWithHeaders({
          "x-forwarded-for": "198.51.100.1, 203.0.113.8",
        })
      )
    ).toBe("203.0.113.8");
  });

  it("ignores invalid IP values", () => {
    expect(
      getClientIp(
        requestWithHeaders({
          "x-real-ip": "not-an-ip",
          "x-forwarded-for": "also-bad",
        })
      )
    ).toBeUndefined();
  });

  it("uses x-vercel-forwarded-for on Vercel", () => {
    const previous = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      expect(
        getClientIp(
          requestWithHeaders({
            "x-vercel-forwarded-for": "203.0.113.9, 198.51.100.2",
            "x-real-ip": "203.0.113.10",
          })
        )
      ).toBe("203.0.113.9");
    } finally {
      process.env.VERCEL = previous ?? "";
    }
  });
});

describe("checkGuestAuthRateLimit", () => {
  const previousRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    limiterEnv.production = false;
    limiterEnv.test = false;
    redisHarness.isReady = false;
    redisHarness.isOpen = false;
    redisHarness.evalResult = 1;
    redisHarness.evalError = null;
    redisHarness.connect.mockClear();
    redisHarness.connect.mockImplementation(async () => undefined);
    redisHarness.eval.mockClear();
    delete process.env.REDIS_URL;
    resetMemoryGuestAuthRateLimit();
  });

  afterEach(() => {
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
    limiterEnv.production = false;
    limiterEnv.test = false;
  });

  it("allows a small per-IP budget then returns 429", async () => {
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP; i++) {
      await expect(checkGuestAuthRateLimit(request)).resolves.toBeUndefined();
    }

    await expect(checkGuestAuthRateLimit(request)).rejects.toEqual(
      expect.objectContaining({
        name: "GuestAuthRateLimitError",
        status: 429,
      })
    );
  });

  it("tracks IPs independently", async () => {
    const first = requestWithHeaders({ "x-real-ip": "203.0.113.1" });
    const second = requestWithHeaders({ "x-real-ip": "203.0.113.2" });

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP; i++) {
      await expect(checkGuestAuthRateLimit(first)).resolves.toBeUndefined();
    }

    await expect(checkGuestAuthRateLimit(second)).resolves.toBeUndefined();
    await expect(checkGuestAuthRateLimit(first)).rejects.toBeInstanceOf(
      GuestAuthRateLimitError
    );
  });

  it("buckets missing IPs together as unknown", async () => {
    const request = requestWithHeaders();

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP; i++) {
      await expect(checkGuestAuthRateLimit(request)).resolves.toBeUndefined();
    }

    await expect(checkGuestAuthRateLimit(request)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("does not consume the budget when peeking", async () => {
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP; i++) {
      await expect(
        checkGuestAuthRateLimit(request, { consume: false })
      ).resolves.toBeUndefined();
    }

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP; i++) {
      await expect(checkGuestAuthRateLimit(request)).resolves.toBeUndefined();
    }

    await expect(
      checkGuestAuthRateLimit(request, { consume: false })
    ).rejects.toMatchObject({ status: 429 });
  });

  it("skips the limiter in Playwright", async () => {
    limiterEnv.test = true;
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    for (let i = 0; i < GUEST_AUTH_RATE_LIMIT_PER_IP + 2; i++) {
      await expect(checkGuestAuthRateLimit(request)).resolves.toBeUndefined();
    }
  });

  it("returns 503 in production when Redis is missing", async () => {
    limiterEnv.production = true;
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    await expect(checkGuestAuthRateLimit(request)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("returns 503 in production when Redis never becomes ready", async () => {
    limiterEnv.production = true;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    await expect(checkGuestAuthRateLimit(request)).rejects.toMatchObject({
      status: 503,
    });
    expect(redisHarness.connect).toHaveBeenCalled();
  });

  it("waits for Redis connect before consuming a slot", async () => {
    limiterEnv.production = true;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisHarness.connect.mockImplementation(async () => {
      redisHarness.isOpen = true;
      redisHarness.isReady = true;
    });
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    await expect(checkGuestAuthRateLimit(request)).resolves.toBeUndefined();
    expect(redisHarness.eval).toHaveBeenCalled();
  });

  it("returns 429 when Redis eval denies the slot", async () => {
    limiterEnv.production = true;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisHarness.isReady = true;
    redisHarness.isOpen = true;
    redisHarness.evalResult = 0;
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    await expect(checkGuestAuthRateLimit(request)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("returns 503 in production when Redis eval fails", async () => {
    limiterEnv.production = true;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisHarness.isReady = true;
    redisHarness.isOpen = true;
    redisHarness.evalError = new Error("eval failed");
    const request = requestWithHeaders({ "x-real-ip": "203.0.113.10" });

    await expect(checkGuestAuthRateLimit(request)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("reconnects after chat traffic left a settled connectPromise", async () => {
    limiterEnv.production = true;
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisHarness.connect.mockImplementation(async () => {
      redisHarness.isOpen = true;
      redisHarness.isReady = true;
    });

    await checkIpRateLimit("203.0.113.10");
    expect(redisHarness.connect).toHaveBeenCalled();

    redisHarness.isOpen = false;
    redisHarness.isReady = false;
    redisHarness.connect.mockClear();
    redisHarness.connect.mockImplementation(async () => {
      redisHarness.isOpen = true;
      redisHarness.isReady = true;
    });

    await expect(
      checkGuestAuthRateLimit(
        requestWithHeaders({ "x-real-ip": "203.0.113.10" })
      )
    ).resolves.toBeUndefined();
    expect(redisHarness.connect).toHaveBeenCalled();
    expect(redisHarness.eval).toHaveBeenCalled();
  });
});

describe("guest auth call sites", () => {
  it("peeks on GET before signIn and consumes in authorize before createGuestUser", () => {
    expect(guestRouteSource).toContain("checkGuestAuthRateLimit");
    expect(guestRouteSource).toContain("consume: false");
    expect(guestRouteSource.indexOf("checkGuestAuthRateLimit")).toBeLessThan(
      guestRouteSource.indexOf('signIn("guest"')
    );
    expect(guestRouteSource).toContain("guestAuthLimitFromError");

    expect(authSource).toContain("checkGuestAuthRateLimit");
    expect(authSource).toContain("CredentialsSignin");
    expect(authSource.indexOf("checkGuestAuthRateLimit")).toBeLessThan(
      authSource.indexOf("createGuestUser()")
    );
  });
});

describe("guestAuthLimitFromError", () => {
  it("unwraps Auth.js CredentialsSignin codes and CallbackRouteError cause", () => {
    expect(
      guestAuthLimitFromError(
        Object.assign(new Error("CredentialsSignin"), {
          code: "too_many_requests",
        })
      )
    ).toMatchObject({ status: 429 });
    expect(
      guestAuthLimitFromError(
        Object.assign(new Error("CallbackRouteError"), {
          cause: { err: new GuestAuthRateLimitError(503) },
        })
      )
    ).toMatchObject({ status: 503 });
    expect(guestAuthLimitFromError(new Error("unrelated"))).toBeNull();
  });
});
