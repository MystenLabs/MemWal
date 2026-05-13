/**
 * Tests for the MCP rate limiter and client-IP extraction. Uses node:test
 * (built-in since Node 18, stable in 20+) so no extra runtime dependency.
 *
 * Run: `npm test` in services/server/scripts/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";

import {
    McpRateLimiter,
    clientIpFromRequest,
    loadRateLimitConfigFromEnv,
} from "../rateLimit.js";

function fakeReq(opts: {
    xff?: string | string[];
    ip?: string;
}): Request {
    return {
        headers: opts.xff !== undefined ? { "x-forwarded-for": opts.xff } : {},
        ip: opts.ip,
    } as unknown as Request;
}

test("acquire under all caps returns ok", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 10,
        maxSessionsPerIp: 5,
        maxNewSessionsPerIpPerMin: 5,
    });
    assert.deepEqual(rl.acquire("1.1.1.1"), { ok: true });
});

test("per-IP active cap denies once exceeded", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 100,
        maxSessionsPerIp: 2,
        maxNewSessionsPerIpPerMin: 100,
    });
    assert.equal(rl.acquire("1.1.1.1").ok, true);
    assert.equal(rl.acquire("1.1.1.1").ok, true);

    const denied = rl.acquire("1.1.1.1");
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "ip_active_cap");
    assert.ok((denied.retryAfterSeconds ?? 0) > 0);
});

test("global total cap denies once exceeded", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 2,
        maxSessionsPerIp: 100,
        maxNewSessionsPerIpPerMin: 100,
    });
    assert.equal(rl.acquire("1.1.1.1").ok, true);
    assert.equal(rl.acquire("2.2.2.2").ok, true);
    const denied = rl.acquire("3.3.3.3");
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "global_cap");
});

test("per-IP burst cap denies even after slots are released", () => {
    // active cap is high, but burst is 2 → two opens then deny even
    // after release, until the 60s window slides.
    const rl = new McpRateLimiter({
        maxTotalSessions: 100,
        maxSessionsPerIp: 100,
        maxNewSessionsPerIpPerMin: 2,
    });
    rl.acquire("1.1.1.1");
    rl.release("1.1.1.1");
    rl.acquire("1.1.1.1");
    rl.release("1.1.1.1");

    const denied = rl.acquire("1.1.1.1");
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "ip_burst_cap");
    assert.ok((denied.retryAfterSeconds ?? 0) >= 1);
});

test("releasing a slot allows a new acquire on the same IP", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 100,
        maxSessionsPerIp: 1,
        maxNewSessionsPerIpPerMin: 100,
    });
    assert.equal(rl.acquire("1.1.1.1").ok, true);
    assert.equal(rl.acquire("1.1.1.1").ok, false);
    rl.release("1.1.1.1");
    assert.equal(rl.acquire("1.1.1.1").ok, true);
});

test("releaseFn is idempotent and does not over-decrement", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 100,
        maxSessionsPerIp: 100,
        maxNewSessionsPerIpPerMin: 100,
    });
    rl.acquire("1.1.1.1");
    rl.acquire("1.1.1.1");
    assert.equal(rl.stats().totalActive, 2);

    const release = rl.releaseFn("1.1.1.1");
    release();
    release();
    release();
    // Only ONE decrement should have happened.
    assert.equal(rl.stats().totalActive, 1);
});

test("multi-IP independence: one IP saturating does not block others", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 100,
        maxSessionsPerIp: 1,
        maxNewSessionsPerIpPerMin: 1,
    });
    assert.equal(rl.acquire("1.1.1.1").ok, true);
    assert.equal(rl.acquire("1.1.1.1").ok, false);
    assert.equal(rl.acquire("2.2.2.2").ok, true);
    assert.equal(rl.acquire("3.3.3.3").ok, true);
});

test("stats snapshot reflects acquired/released slots", () => {
    const rl = new McpRateLimiter({
        maxTotalSessions: 10,
        maxSessionsPerIp: 10,
        maxNewSessionsPerIpPerMin: 10,
    });
    rl.acquire("1.1.1.1");
    rl.acquire("2.2.2.2");
    assert.equal(rl.stats().totalActive, 2);
    assert.equal(rl.stats().uniqueIps, 2);

    rl.release("1.1.1.1");
    assert.equal(rl.stats().totalActive, 1);
    // Once an IP has zero active AND no opens in the window, it is purged.
    // We don't assert the exact uniqueIps because the burst window keeps
    // the entry alive for 60s — both 1 and 2 are valid, but 2 is what
    // current behavior produces (ip 1.1.1.1 still has an `opens` entry).
});

test("clientIpFromRequest prefers first hop in x-forwarded-for", () => {
    assert.equal(
        clientIpFromRequest(fakeReq({ xff: "203.0.113.5, 10.0.0.1, 127.0.0.1" })),
        "203.0.113.5"
    );
});

test("clientIpFromRequest trims whitespace around the first hop", () => {
    assert.equal(
        clientIpFromRequest(fakeReq({ xff: "  203.0.113.5  , 10.0.0.1" })),
        "203.0.113.5"
    );
});

test("clientIpFromRequest falls back to req.ip when XFF is missing", () => {
    assert.equal(clientIpFromRequest(fakeReq({ ip: "127.0.0.1" })), "127.0.0.1");
});

test("clientIpFromRequest falls back to req.ip when XFF is empty string", () => {
    assert.equal(
        clientIpFromRequest(fakeReq({ xff: "", ip: "127.0.0.1" })),
        "127.0.0.1"
    );
});

test("clientIpFromRequest handles array-valued XFF (rare but legal)", () => {
    assert.equal(
        clientIpFromRequest(fakeReq({ xff: ["203.0.113.5, 10.0.0.1"] })),
        "203.0.113.5"
    );
});

test("clientIpFromRequest returns 'unknown' when nothing is available", () => {
    assert.equal(clientIpFromRequest(fakeReq({})), "unknown");
});

test("loadRateLimitConfigFromEnv applies defaults", () => {
    const before = {
        total: process.env.MCP_MAX_TOTAL_SESSIONS,
        perIp: process.env.MCP_MAX_SESSIONS_PER_IP,
        burst: process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN,
    };
    delete process.env.MCP_MAX_TOTAL_SESSIONS;
    delete process.env.MCP_MAX_SESSIONS_PER_IP;
    delete process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN;
    try {
        const cfg = loadRateLimitConfigFromEnv();
        assert.equal(cfg.maxTotalSessions, 1000);
        assert.equal(cfg.maxSessionsPerIp, 16);
        assert.equal(cfg.maxNewSessionsPerIpPerMin, 30);
    } finally {
        if (before.total !== undefined) process.env.MCP_MAX_TOTAL_SESSIONS = before.total;
        if (before.perIp !== undefined) process.env.MCP_MAX_SESSIONS_PER_IP = before.perIp;
        if (before.burst !== undefined) process.env.MCP_MAX_NEW_SESSIONS_PER_IP_PER_MIN = before.burst;
    }
});

test("loadRateLimitConfigFromEnv honors env overrides and rejects garbage", () => {
    const before = {
        total: process.env.MCP_MAX_TOTAL_SESSIONS,
        perIp: process.env.MCP_MAX_SESSIONS_PER_IP,
    };
    process.env.MCP_MAX_TOTAL_SESSIONS = "42";
    process.env.MCP_MAX_SESSIONS_PER_IP = "not-a-number";
    try {
        const cfg = loadRateLimitConfigFromEnv();
        assert.equal(cfg.maxTotalSessions, 42);
        // Garbage falls back to default.
        assert.equal(cfg.maxSessionsPerIp, 16);
    } finally {
        if (before.total !== undefined) process.env.MCP_MAX_TOTAL_SESSIONS = before.total;
        else delete process.env.MCP_MAX_TOTAL_SESSIONS;
        if (before.perIp !== undefined) process.env.MCP_MAX_SESSIONS_PER_IP = before.perIp;
        else delete process.env.MCP_MAX_SESSIONS_PER_IP;
    }
});
