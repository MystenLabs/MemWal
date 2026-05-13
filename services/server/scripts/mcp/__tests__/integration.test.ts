/**
 * MCP integration test — exercises the actual mounted Express routes via real
 * HTTP. Verifies the three blocker-fixes end-to-end:
 *
 *   1. Per-IP burst rate-limit returns 429 BEFORE a long-lived transport is
 *      allocated.
 *   2. The streamable HTTP `mcp-session-id` is bound to the bearer that
 *      opened it — reusing the id under a different bearer returns 403.
 *   3. The relayer's `x-forwarded-for` is honored — separate IPs get
 *      independent rate-limit buckets.
 *
 * Runs the express app on an ephemeral loopback port. No external services
 * are touched — `MemWal.create()` is pure, `createMcpServer()` is in-memory,
 * and tools are never invoked because we only drive the initialize handshake.
 *
 * IMPORTANT: env vars MUST be set BEFORE importing `mountMcpRoutes` because
 * the rate limiter is constructed at module-load time.
 */
process.env.MCP_MAX_TOTAL_SESSIONS = "100";
process.env.MCP_MAX_SESSIONS_PER_IP = "100";
// Tight burst cap so the test can trip it in 3 calls.
process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN = "2";

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { mountMcpRoutes } from "../index.js";

// ---- helpers --------------------------------------------------------------

function hex(bytes: number): string {
    return randomBytes(bytes).toString("hex");
}

/** Synthesize a valid-shape delegate key + accountId pair. */
function fakeCreds(): { bearer: string; accountId: string } {
    return {
        bearer: hex(32), // 64 hex chars
        accountId: "0x" + hex(32), // 0x + 64 hex
    };
}

let server: Server;
let baseUrl: string;

before(async () => {
    const app = express();
    mountMcpRoutes(app, { relayerUrl: "http://localhost:1" });
    await new Promise<void>((resolve) => {
        server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function initializeBody(id: number) {
    return JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "memwal-test", version: "0.0.1" },
        },
    });
}

function mcpHeaders(opts: {
    bearer: string;
    accountId: string;
    xff: string;
    sessionId?: string;
}): Record<string, string> {
    const h: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${opts.bearer}`,
        "x-memwal-account-id": opts.accountId,
        "x-forwarded-for": opts.xff,
    };
    if (opts.sessionId) h["mcp-session-id"] = opts.sessionId;
    return h;
}

async function postInit(opts: {
    bearer: string;
    accountId: string;
    xff: string;
    sessionId?: string;
    id?: number;
}): Promise<{ status: number; sessionId: string | null; bodyText: string }> {
    const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders(opts),
        body: initializeBody(opts.id ?? 1),
    });
    return {
        status: res.status,
        sessionId: res.headers.get("mcp-session-id"),
        bodyText: await res.text(),
    };
}

// ---- tests ----------------------------------------------------------------

test("POST /mcp initialize creates a session and returns mcp-session-id", async () => {
    const creds = fakeCreds();
    const r = await postInit({ ...creds, xff: "192.0.2.10" });

    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.bodyText}`);
    assert.ok(r.sessionId, "mcp-session-id header must be set on initialize response");
});

test("burst cap denies third initialize from same IP within window", async () => {
    // Use a fresh IP to isolate from other tests.
    const xff = "192.0.2.20";

    const a = await postInit({ ...fakeCreds(), xff });
    assert.equal(a.status, 200, `1st should succeed, got ${a.status}`);

    const b = await postInit({ ...fakeCreds(), xff });
    assert.equal(b.status, 200, `2nd should succeed, got ${b.status}`);

    // Third hits the burst cap (MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN=2).
    const c = await postInit({ ...fakeCreds(), xff });
    assert.equal(c.status, 429, `3rd should be rate-limited, got ${c.status}`);
    const json = JSON.parse(c.bodyText);
    assert.equal(json.error.code, -32000);
    assert.match(json.error.message, /ip_burst_cap/);
});

test("separate XFF IPs get independent rate-limit buckets", async () => {
    // Saturate IP A's burst.
    const aXff = "192.0.2.30";
    await postInit({ ...fakeCreds(), xff: aXff });
    await postInit({ ...fakeCreds(), xff: aXff });
    const aDenied = await postInit({ ...fakeCreds(), xff: aXff });
    assert.equal(aDenied.status, 429);

    // IP B is fresh — must succeed.
    const bOk = await postInit({ ...fakeCreds(), xff: "192.0.2.31" });
    assert.equal(bOk.status, 200, `IP B should be unaffected, got ${bOk.status}`);
});

test("reusing mcp-session-id under a different bearer returns 403", async () => {
    // Fresh IP so we don't collide with earlier burst counters.
    const xff = "192.0.2.40";

    // Open a session as caller A.
    const credsA = fakeCreds();
    const opened = await postInit({ ...credsA, xff });
    assert.equal(opened.status, 200);
    const sid = opened.sessionId;
    assert.ok(sid);

    // Caller B (different bearer + accountId) tries to drive A's session.
    const credsB = fakeCreds();
    const stolen = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders({ ...credsB, xff, sessionId: sid! }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });

    assert.equal(stolen.status, 403, `expected 403, got ${stolen.status}`);
    const json = await stolen.json();
    assert.equal((json as any).error.code, -32603);
    assert.match((json as any).error.message, /does not match authenticated caller/);
});

test("reusing mcp-session-id under SAME bearer is accepted (sanity check)", async () => {
    const xff = "192.0.2.50";
    const creds = fakeCreds();

    const opened = await postInit({ ...creds, xff });
    assert.equal(opened.status, 200);
    const sid = opened.sessionId;
    assert.ok(sid);

    // Same caller, same session-id — must NOT be a 403. (The SDK may return
    // 200 or 202 depending on the request; the only thing we're proving is
    // that the auth-binding check did NOT reject the request.)
    const reuse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders({ ...creds, xff, sessionId: sid! }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });

    assert.notEqual(reuse.status, 403, `same-caller reuse must not 403, got ${reuse.status}`);
});

test("malformed bearer returns 401, not 429 — auth still runs after rate-limit on streamable", async () => {
    // streamable's order is: auth → method check → rate-limit. Wrong bearer
    // shape must surface as 401 with www-authenticate, not as a rate-limit
    // refusal. (Use a fresh IP.)
    const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: "Bearer not-a-hex-key",
            "x-memwal-account-id": "0x" + "a".repeat(64),
            "x-forwarded-for": "192.0.2.60",
        },
        body: initializeBody(1),
    });

    assert.equal(res.status, 401);
    assert.ok(res.headers.get("www-authenticate"));
});
