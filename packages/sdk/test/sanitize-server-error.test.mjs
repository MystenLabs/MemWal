import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError, UNAUTHENTICATED_LOGIN_MESSAGE } from "../dist/utils.js";

const LOGIN_HINT = "Not authenticated. Run memwal_login to connect your Sui wallet.";

test("empty 401 points at memwal_login and keeps AUTH_REJECTED triage", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(UNAUTHENTICATED_LOGIN_MESSAGE, LOGIN_HINT);
    assert.equal(
        message.startsWith(`Walrus Memory server error (401): ${LOGIN_HINT}`),
        true,
        "empty 401 should use the Walrus Memory prefix plus the memwal_login hint",
    );
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
        "401 message should still point callers at the AUTH_REJECTED triage table",
    );
});

test("string status 401 does not fall through to <no message>", () => {
    const { message, serverCode } = sanitizeServerError(/** @type {any} */ ("401"), "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.match(message, /memwal_login/);
    assert.doesNotMatch(message, /<no message>/);
});

test("non-empty 401 keeps the AUTH_REJECTED key-mismatch copy", () => {
    const { message, serverCode } = sanitizeServerError(401, '{"code":"AUTH_REJECTED"}');
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
        "401 message should point callers at the full AUTH_REJECTED triage table",
    );
    assert.match(message, /wrong private key/);
});
