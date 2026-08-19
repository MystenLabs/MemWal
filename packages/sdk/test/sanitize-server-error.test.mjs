import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

test("401 without a session points at memwal_login instead of <no message>", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.equal(
        message,
        "Walrus Memory server error (401): Not authenticated. Run memwal_login to connect your Sui wallet."
    );
    assert.doesNotMatch(message, /<no message>/);
});

test("non-401 empty bodies still use the <no message> placeholder", () => {
    const { message } = sanitizeServerError(500, "");
    assert.equal(message, "Walrus Memory server error (500): <no message>");
});
