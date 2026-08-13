import assert from "node:assert/strict";
import test from "node:test";
import { isSameOriginRequest } from "./request-security";

test("Researcher state-changing auth requests require an exact Origin", () => {
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: { origin: "https://researcher.example" },
      })
    ),
    true
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key", {
        headers: { origin: "https://attacker.example" },
      })
    ),
    false
  );
  assert.equal(
    isSameOriginRequest(
      new Request("https://researcher.example/api/auth/key")
    ),
    false
  );
});
