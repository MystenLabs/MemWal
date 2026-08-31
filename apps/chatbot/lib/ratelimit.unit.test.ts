import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("redis", () => ({
  createClient: () => ({
    isReady: false,
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}));

import {
  checkGuestAuthRateLimit,
  GUEST_AUTH_RATE_LIMIT_PER_IP,
  GuestAuthRateLimitError,
  getClientIp,
  resetMemoryGuestAuthRateLimit,
} from "@/lib/ratelimit";

function requestWithHeaders(headers?: HeadersInit): Request {
  return new Request("http://127.0.0.1:3001/api/auth/guest?redirectUrl=/", {
    headers,
  });
}

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
  beforeEach(() => {
    resetMemoryGuestAuthRateLimit();
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
});

describe("guest auth route", () => {
  it("rate-limits before signIn so createGuestUser is not unconditional", () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../app/(auth)/api/auth/guest/route.ts"
      ),
      "utf8"
    );

    expect(source).toContain("checkGuestAuthRateLimit");
    expect(source.indexOf("checkGuestAuthRateLimit")).toBeLessThan(
      source.indexOf('signIn("guest"')
    );
  });
});
