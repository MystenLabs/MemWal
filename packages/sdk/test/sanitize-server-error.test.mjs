import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

const LOGIN =
    "Walrus Memory isn't signed in. Call the memwal_login tool, then retry.";

test("empty-body 401 points at memwal_login instead of <no message>", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(message, LOGIN);
    assert.doesNotMatch(message, /<no message>/);
});

test("string status \"401\" with an empty body uses the login hint", () => {
    const { message, serverCode } = sanitizeServerError("401", "   ");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(message, LOGIN);
    assert.doesNotMatch(message, /<no message>/);
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
