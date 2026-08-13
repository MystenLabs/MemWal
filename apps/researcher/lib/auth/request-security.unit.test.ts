import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "./request-security";

test("Researcher state-changing auth requests require an exact Origin", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: {
          origin: "https://researcher.example",
          host: "researcher.example",
        },
      })
    ),
    true
  );
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

test("matches against Host/X-Forwarded-Host, not request.url's own host — behind a reverse proxy request.url reflects the internal host, not the public one the Origin header names", () => {
  // Same shape as the production bug: the app's internal request.url host
  // ("internal.railway.internal") differs from the public origin the
  // browser sent, but the Origin still matches what the proxy forwarded as
  // Host/X-Forwarded-Host, so the request must be accepted.
  assert.equal(
    isSameOriginRequest(
      new Request("http://internal.railway.internal:8080/api/auth/key", {
        headers: {
          origin: "https://researcher-demo-staging.memory.walrus.xyz",
          host: "researcher-demo-staging.memory.walrus.xyz",
        },
      })
    ),
    true
  );
});

test("X-Forwarded-Host takes precedence over Host when a proxy sets both", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://internal.example/api/auth/key", {
        headers: {
          origin: "https://researcher.example",
          host: "internal.example",
          "x-forwarded-host": "researcher.example",
        },
      })
    ),
    true
  );
});
