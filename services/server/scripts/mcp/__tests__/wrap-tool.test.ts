import assert from "node:assert/strict";
import test from "node:test";

import { MEMWAL_LOGIN_REQUIRED_MESSAGE, wrapTool } from "../tools/util.js";

const LOGIN_REQUIRED =
    "Walrus Memory isn't signed in. Call the memwal_login tool, then retry.";

test("empty 401 / no-session surfaces the exact memwal_login instruction", async () => {
    const handler = wrapTool(async () => {
        const err = new Error("Walrus Memory server error (401): <no message>") as Error & {
            status?: number | string;
        };
        err.status = 401;
        throw err;
    });

    const result = await handler({});
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, LOGIN_REQUIRED);
    assert.equal(result.content[0]?.text, MEMWAL_LOGIN_REQUIRED_MESSAGE);
});

test("string status 401 also surfaces the login instruction", async () => {
    const handler = wrapTool(async () => {
        const err = new Error("Walrus Memory server error (401): <no message>") as Error & {
            status?: number | string;
        };
        err.status = "401";
        throw err;
    });

    const result = await handler({});
    assert.equal(result.content[0]?.text, LOGIN_REQUIRED);
});

test("clock-drift 401 is not rewritten into the login instruction", async () => {
    const clockMsg =
        "Request rejected: signed timestamp is outside the relayer's accepted clock-drift window. " +
        "Synchronize this client's clock (NTP); if the deployment needs a wider tolerance, " +
        "raise AUTH_MAX_CLOCK_DRIFT_SECS on the relayer.";
    const handler = wrapTool(async () => {
        const err = new Error(clockMsg) as Error & { status?: number; serverCode?: string };
        err.status = 401;
        err.serverCode = "ERR_TIMESTAMP_OUT_OF_BOUNDS";
        throw err;
    });

    const result = await handler({});
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /clock-drift window/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /memwal_login/);
});
