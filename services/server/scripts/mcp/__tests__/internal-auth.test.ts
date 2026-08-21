import assert from "node:assert/strict";
import test from "node:test";

import { verifyInternalOrigin } from "../internal-auth.js";

const TOKEN = "test-sidecar-token-0123456789";

function headersWith(token?: string): Headers {
    const h = new Headers();
    if (token !== undefined) h.set("x-memwal-internal-sidecar-token", token);
    return h;
}

test("verifyInternalOrigin accepts a request carrying the configured sidecar token", () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;

    assert.equal(verifyInternalOrigin(headersWith(TOKEN)), true);
});

test("verifyInternalOrigin rejects a request with no sidecar token header", () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;

    assert.equal(verifyInternalOrigin(headersWith(undefined)), false);
});

test("verifyInternalOrigin rejects a wrong token of the same length", () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;
    const wrong = "X".repeat(TOKEN.length);

    assert.equal(wrong.length, TOKEN.length);
    assert.equal(verifyInternalOrigin(headersWith(wrong)), false);
});

test("verifyInternalOrigin rejects a token that is a prefix of the real one", () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;

    assert.equal(verifyInternalOrigin(headersWith(TOKEN.slice(0, -1))), false);
});

test("verifyInternalOrigin rejects everything when SIDECAR_AUTH_TOKEN is unset", () => {
    delete process.env.SIDECAR_AUTH_TOKEN;

    assert.equal(verifyInternalOrigin(headersWith(TOKEN)), false);
    assert.equal(verifyInternalOrigin(headersWith("")), false);
});
