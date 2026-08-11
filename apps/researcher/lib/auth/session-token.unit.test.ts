import assert from "node:assert/strict";
import test from "node:test";
import { decodeJwt, jwtVerify } from "jose";
import { SESSION_MAX_AGE_SECONDS, signSessionIdentity } from "./session-token";

const secret = new TextEncoder().encode("unit-test-auth-secret");

test("Researcher session tokens contain identity only, never delegate credentials", async () => {
  const token = await signSessionIdentity(
    {
      userId: "user-1",
      publicKey: "public-key",
      accountId: "0xaccount",
    },
    secret
  );
  const claims = decodeJwt(token);

  assert.equal(claims.userId, "user-1");
  assert.equal(claims.publicKey, "public-key");
  assert.equal(claims.accountId, "0xaccount");
  assert.equal("privateKey" in claims, false);
  assert.equal("delegatePrivateKey" in claims, false);

  const verified = await jwtVerify(token, secret);
  assert.ok(
    Number(verified.payload.exp) - Math.floor(Date.now() / 1000) <=
      SESSION_MAX_AGE_SECONDS
  );
});
