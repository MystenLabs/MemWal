import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeServerError } from "../dist/utils.js";

test("401 error message points to the troubleshooting guide", () => {
    const { message, serverCode } = sanitizeServerError(401, "");
    assert.equal(serverCode, "AUTH_REJECTED");
    assert.match(
        message,
        /docs\.wal\.app\/walrus-memory\/troubleshooting\/overview/,
        "401 message should point callers at the full AUTH_REJECTED triage table"
    );
});
