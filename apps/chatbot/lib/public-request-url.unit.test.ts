import { describe, expect, it } from "vitest";
import {
  guestReturnPath,
  isSafeRedirectUrl,
  publicRequestUrl,
} from "./public-request-url";

const STAGING_HOST = "chatbot-demo-staging.memory.walrus.xyz";

function bindRequest(path = "/chat/abc", headers?: HeadersInit): Request {
  return new Request(`https://0.0.0.0:3000${path}`, { headers });
}

describe("publicRequestUrl", () => {
  it("uses x-forwarded-host and proto when request.url is a bind address", () => {
    const request = bindRequest("/chat/abc", {
      "x-forwarded-host": STAGING_HOST,
      "x-forwarded-proto": "https",
    });

    const publicUrl = publicRequestUrl(request);
    expect(publicUrl.origin).toBe(`https://${STAGING_HOST}`);
    expect(publicUrl.hostname).not.toBe("0.0.0.0");
    expect(publicUrl.pathname).toBe("/chat/abc");
  });

  it("prefers a non-bind forwarded host over request.url", () => {
    const request = new Request("http://localhost:3000/login", {
      headers: {
        "x-forwarded-host": STAGING_HOST,
        "x-forwarded-proto": "https",
      },
    });

    expect(publicRequestUrl(request).origin).toBe(`https://${STAGING_HOST}`);
  });

  it("falls back to Host when the URL is a bind address", () => {
    const request = bindRequest("/chat/abc", {
      host: STAGING_HOST,
      "x-forwarded-proto": "https",
    });

    expect(publicRequestUrl(request).origin).toBe(`https://${STAGING_HOST}`);
  });
});

describe("guestReturnPath", () => {
  it("returns pathname and search as a relative path", () => {
    const forwarded = {
      "x-forwarded-host": STAGING_HOST,
      "x-forwarded-proto": "https",
    };

    expect(guestReturnPath(bindRequest("/chat/abc", forwarded))).toBe(
      "/chat/abc"
    );
    expect(guestReturnPath(bindRequest("/chat/abc?foo=1", forwarded))).toBe(
      "/chat/abc?foo=1"
    );
  });

  it("rejects protocol-relative pathnames and falls back to /", () => {
    expect(guestReturnPath(bindRequest("//evil.example"))).toBe("/");
  });
});

describe("isSafeRedirectUrl", () => {
  it("allows relative paths", () => {
    const request = bindRequest("/", {
      "x-forwarded-host": STAGING_HOST,
      "x-forwarded-proto": "https",
    });

    expect(isSafeRedirectUrl("/", request)).toBe(true);
    expect(isSafeRedirectUrl("/chat/1", request)).toBe(true);
  });

  it("rejects cross-origin and protocol-relative targets", () => {
    const request = bindRequest("/chat/abc", {
      "x-forwarded-host": STAGING_HOST,
      "x-forwarded-proto": "https",
    });

    expect(isSafeRedirectUrl("https://evil.example", request)).toBe(false);
    expect(isSafeRedirectUrl("//evil.example", request)).toBe(false);
  });

  it("allows same-origin absolute URLs against the public origin", () => {
    const request = bindRequest("/chat/abc", {
      "x-forwarded-host": STAGING_HOST,
      "x-forwarded-proto": "https",
    });

    expect(
      isSafeRedirectUrl(`https://${STAGING_HOST}/chat/abc`, request)
    ).toBe(true);
    expect(isSafeRedirectUrl("https://0.0.0.0:3000/chat/abc", request)).toBe(
      false
    );
  });

  it("does not treat a bind address as a safe absolute redirect target", () => {
    const request = bindRequest("/chat/abc");

    expect(isSafeRedirectUrl("https://0.0.0.0:3000/chat/abc", request)).toBe(
      false
    );
    expect(isSafeRedirectUrl("https://0.0.0.0:3000/", request)).toBe(false);
    expect(isSafeRedirectUrl("/", request)).toBe(true);
  });
});
