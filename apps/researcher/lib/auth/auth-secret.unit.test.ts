import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { SignJWT, jwtVerify } from "jose";
import { getAuthSecret, getAuthSecretKey } from "./auth-secret";

// Regression tests for issue #777: session.ts and proxy.ts signed and verified
// session cookies with the raw AUTH_SECRET value, while enoki-challenge.ts in the
// same folder already required at least 32 characters for that same variable.

const THIRTY_TWO = "0123456789012345678901234567890a";

function withSecret<T>(value: string | undefined, body: () => T): T {
  const previous = process.env.AUTH_SECRET;

  if (value === undefined) {
    Reflect.deleteProperty(process.env, "AUTH_SECRET");
  } else {
    process.env.AUTH_SECRET = value;
  }

  try {
    return body();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "AUTH_SECRET");
    } else {
      process.env.AUTH_SECRET = previous;
    }
  }
}

test("getAuthSecret rejects a missing secret", () => {
  withSecret(undefined, () => {
    assert.throws(getAuthSecret, /at least 32 characters/);
  });
});

test("getAuthSecret rejects an empty secret", () => {
  // .env.example ships AUTH_SECRET= with no value, so this is the shape a
  // copied config actually has.
  withSecret("", () => {
    assert.throws(getAuthSecret, /at least 32 characters/);
  });
});

test("getAuthSecret rejects a secret one character short", () => {
  withSecret("0123456789012345678901234567890", () => {
    assert.throws(getAuthSecret, /at least 32 characters/);
  });
});

test("getAuthSecret rejects the short placeholder from the report", () => {
  withSecret("short", () => {
    assert.throws(getAuthSecret, /at least 32 characters/);
  });
});

test("getAuthSecret accepts a secret at the minimum length", () => {
  withSecret(THIRTY_TWO, () => {
    assert.equal(getAuthSecret().length, 32);
    assert.equal(getAuthSecret(), THIRTY_TWO);
  });
});

test("getAuthSecretKey encodes the validated secret", () => {
  withSecret(THIRTY_TWO, () => {
    assert.deepEqual(getAuthSecretKey(), new TextEncoder().encode(THIRTY_TWO));
  });
});

test("getAuthSecretKey refuses the empty key that an unset secret used to produce", async () => {
  // Why the guard exists at all: encoding an absent value yields zero bytes, and
  // jose will sign and verify HS256 with that key. A deployment missing the
  // variable therefore issued and accepted cookies signed with a key anyone can
  // reproduce, so forging a session for any user id needed no secret.
  const emptyKey = new TextEncoder().encode(process.env.AUTH_SECRET_UNSET);
  assert.equal(emptyKey.length, 0);

  const forged = await new SignJWT({ userId: "victim" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(emptyKey);
  const { payload } = await jwtVerify(forged, emptyKey);
  assert.equal(payload.userId, "victim");

  withSecret(undefined, () => {
    assert.throws(getAuthSecretKey, /at least 32 characters/);
  });
});

// The guard only helps where it is wired in. These modules cannot be imported
// here (next/headers, the db client), so their source is what pins the call
// sites: reintroducing a raw read fails a test rather than passing quietly.
for (const path of ["lib/auth/session.ts", "proxy.ts"]) {
  test(`${path} reads the secret through the guard`, () => {
    const source = readFileSync(resolve(path), "utf8");

    assert.match(source, /getAuthSecretKey\(\)/);
    assert.doesNotMatch(source, /process\.env\.AUTH_SECRET/);
  });
}

test("enoki-challenge.ts shares the one guard rather than its own copy", () => {
  const source = readFileSync(resolve("lib/auth/enoki-challenge.ts"), "utf8");

  assert.match(source, /getAuthSecretKey\(\)/);
  assert.doesNotMatch(source, /process\.env\.AUTH_SECRET/);
});

test("the guard stays lazy so a build-time placeholder cannot break the image", () => {
  // The Dockerfile builder stage sets a 22-character AUTH_SECRET so `next build`
  // can prerender. Validating at module scope would fail the build instead of a
  // request, so no module may compute the key while being imported.
  for (const path of ["lib/auth/session.ts", "proxy.ts"]) {
    const source = readFileSync(resolve(path), "utf8");
    const moduleScopeCall = /^const \w+ = getAuthSecretKey\(\)/m;

    assert.doesNotMatch(source, moduleScopeCall);
  }
});
