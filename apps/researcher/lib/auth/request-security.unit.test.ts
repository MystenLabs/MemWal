import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "./request-security";

test("accepts an exact HTTPS Origin and Host", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("http://internal.railway.internal:8080/api/auth/key", {
        headers: {
          origin: "https://researcher.example",
          host: "researcher.example",
        },
      })
    ),
    true
  );
});

test("fails closed for missing or mismatched origin headers", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: {
          origin: "https://attacker.example",
          host: "researcher.example",
        },
      })
    ),
    false
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: { host: "researcher.example" },
      })
    ),
    false
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: { origin: "https://researcher.example" },
      })
    ),
    false
  );
});

test("ignores a spoofed X-Forwarded-Host", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: {
          origin: "https://attacker.example",
          host: "researcher.example",
          "x-forwarded-host": "attacker.example",
        },
      })
    ),
    false
  );
});

test("rejects HTTP origins outside loopback", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: {
          origin: "http://researcher.example",
          host: "researcher.example",
        },
      })
    ),
    false
  );
  assert.equal(
    isSameOriginRequest(
      new Request("http://localhost:3000/api/auth/key", {
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
        },
      })
    ),
    true
  );
});
