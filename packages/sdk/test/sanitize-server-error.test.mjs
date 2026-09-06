import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

test("empty-body 401 triages SDK/headless auth instead of memwal_login", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.doesNotMatch(message, /<no message>/);
    assert.doesNotMatch(message, /Call the memwal_login tool, then retry/);
    assert.match(message, /MemWal\.create\(\{ key, accountId \}\)/);
    assert.match(message, /MEMWAL_PRIVATE_KEY/);
    assert.match(message, /registered delegate/);
    assert.match(message, /memwal_login is only the MCP browser sign-in/);
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
    );
});

test("string status \"401\" with an empty body uses the same SDK triage", () => {
    const { message, serverCode } = sanitizeServerError("401", "   ");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.doesNotMatch(message, /Call the memwal_login tool, then retry/);
    assert.match(message, /MemWal\.create\(\{ key, accountId \}\)/);
});

test("non-empty 401 keeps the AUTH_REJECTED troubleshooting URL", () => {
    const { message, serverCode } = sanitizeServerError(401, "auth rejected");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
    );
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
