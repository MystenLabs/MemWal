import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

const AUTH_REJECTED =
    "401 from relayer: typically wrong private key, key not registered on this account, " +
    "account ID mismatch, or staging/mainnet mismatch. Check .env.local and dashboard credentials. " +
    "Full troubleshooting: https://docs.wal.app/walrus-memory/troubleshooting/overview#401-auth_rejected-errors";

test("empty-body 401 uses AUTH_REJECTED troubleshooting instead of memwal_login", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(message, AUTH_REJECTED);
    assert.doesNotMatch(message, /<no message>/);
    assert.doesNotMatch(message, /memwal_login/);
});

test("string status \"401\" with an empty body uses AUTH_REJECTED troubleshooting", () => {
    const { message, serverCode } = sanitizeServerError("401", "   ");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(message, AUTH_REJECTED);
    assert.doesNotMatch(message, /<no message>/);
    assert.doesNotMatch(message, /memwal_login/);
});

test("non-empty 401 keeps the AUTH_REJECTED troubleshooting URL", () => {
    const { message, serverCode } = sanitizeServerError(401, "auth rejected");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(message, AUTH_REJECTED);
    assert.doesNotMatch(message, /memwal_login/);
});

test("non-401 empty bodies still use the <no message> placeholder", () => {
    const { message } = sanitizeServerError(500, "");
    assert.equal(message, "Walrus Memory server error (500): <no message>");
});

test("localhost sidecar URLs are stripped from error text", () => {
    const { message } = sanitizeServerError(
        500,
        "Sidecar seal/encrypt request failed: error sending request for url (http://localhost:9000/seal/encrypt)",
    );
    assert.doesNotMatch(message, /localhost:9000/);
    assert.match(message, /\[internal\]/);
});
