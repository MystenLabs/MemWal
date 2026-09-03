import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getToken } from "next-auth/jwt";
import { describe, expect, it } from "vitest";
import { getSessionToken } from "@/lib/session-token";

function requestWithBearer(value: string): Request {
  return new Request("http://127.0.0.1:3001/api/chat", {
    headers: { Authorization: `Bearer ${value}` },
  });
}

describe("getSessionToken", () => {
  it("returns null for a malformed Bearer value instead of throwing", async () => {
    const request = requestWithBearer("%%");

    await expect(
      getToken({ req: request, secret: "unit-test-secret-not-for-production" })
    ).rejects.toBeInstanceOf(URIError);

    await expect(getSessionToken(request)).resolves.toBeNull();
  });

  it("returns null when there is no session cookie or Bearer header", async () => {
    await expect(
      getSessionToken(new Request("http://127.0.0.1:3001/api/chat"))
    ).resolves.toBeNull();
  });
});

describe("malformed Bearer call sites", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("proxy and guest route read the session through the wrapper", () => {
    const proxy = readFileSync(join(here, "../proxy.ts"), "utf8");
    const guest = readFileSync(
      join(here, "../app/(auth)/api/auth/guest/route.ts"),
      "utf8"
    );

    expect(proxy).toContain("getSessionToken");
    expect(proxy).not.toContain("getToken(");
    expect(guest).toContain("getSessionToken");
    expect(guest).not.toContain("getToken(");
  });
});
