import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

const LOGIN_REQUIRED =
    "Walrus Memory isn't signed in. Call the memwal_login tool, then retry.";

test("empty 401 / no-session is the memwal_login instruction, not <no message>", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(message, LOGIN_REQUIRED);
    assert.equal(serverCode, "UNAUTHENTICATED");
    assert.doesNotMatch(message, /<no message>/);
});

test("string status \"401\" with an empty body also yields the login instruction", () => {
    const { message, serverCode } = sanitizeServerError("401", "");
    assert.equal(message, LOGIN_REQUIRED);
    assert.equal(serverCode, "UNAUTHENTICATED");
});

test("401 error message points to the troubleshooting guide", () => {
    const { message, serverCode } = sanitizeServerError(
        401,
        JSON.stringify({ error: "AUTH_REJECTED", message: "signature rejected" }),
    );
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
        "401 message should point callers at the full AUTH_REJECTED triage table"
    );
});

test("non-401 empty bodies still use the <no message> placeholder", () => {
    const { message } = sanitizeServerError(500, "");
    assert.equal(message, "Walrus Memory server error (500): <no message>");
});
