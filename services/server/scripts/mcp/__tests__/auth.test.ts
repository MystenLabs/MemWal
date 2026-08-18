import assert from "node:assert/strict";
import test from "node:test";

import { McpAuthError, resolveAuth } from "../auth.js";

const TOKEN = "test-sidecar-token-0123456789";
const DELEGATE_KEY = "a".repeat(64);
const ACCOUNT_ID = `0x${"b".repeat(64)}`;
const SERVER_URL = "http://relayer.invalid";

function mcpHeaders(overrides: Record<string, string | undefined> = {}): Headers {
    const base: Record<string, string | undefined> = {
        authorization: `Bearer ${DELEGATE_KEY}`,
        "x-memwal-account-id": ACCOUNT_ID,
        "x-memwal-internal-sidecar-token": TOKEN,
        ...overrides,
    };
    const h = new Headers();
    for (const [k, v] of Object.entries(base)) {
        if (v !== undefined) h.set(k, v);
    }
    return h;
}

test("resolveAuth rejects a caller that cannot prove it is the relayer", async () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;

    await assert.rejects(
        () => resolveAuth(mcpHeaders({ "x-memwal-internal-sidecar-token": undefined }), SERVER_URL),
        (err: unknown) => {
            assert.ok(err instanceof McpAuthError, `expected McpAuthError, got ${err}`);
            assert.equal(err.status, 401);
            return true;
        }
    );
});

test("resolveAuth reads the OAuth scope once the origin is verified", async () => {
    process.env.SIDECAR_AUTH_TOKEN = TOKEN;

    const { session } = await resolveAuth(
        mcpHeaders({ "x-memwal-internal-oauth-scope": "memwal:read" }),
        SERVER_URL
    );

    assert.equal(session.oauthScope, "memwal:read");
});
