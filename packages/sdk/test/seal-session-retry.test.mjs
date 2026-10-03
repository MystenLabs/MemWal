import assert from "node:assert/strict";
import test from "node:test";

import { MemWal, sealSessionExpiresAt } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stub(handler) {
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config") {
            return Response.json({ packageId: "0x1", network: "testnet" });
        }
        return handler(path, init);
    };
}

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

function expired() {
    return new Response(
        JSON.stringify({ error: "Session key has expired", code: "SESSION_EXPIRED" }),
        { status: 401, headers: { "content-type": "application/json" } },
    );
}

test("the session cache expires from creationTimeMs, not from when create finished", () => {
    const now = 1_000_000;
    const created = now - 40_000;
    // 5 min TTL, 30s margin. A cache stamped at `now + 4.5min` would outlive
    // creationTimeMs + 5min by 10s after a 40s create.
    assert.equal(sealSessionExpiresAt(created, 5, now), created + 5 * 60_000 - 30_000);
    assert.ok(sealSessionExpiresAt(created, 5, now) < now + 5 * 60_000 - 30_000);
});

test("recall retries once with a fresh session after SESSION_EXPIRED", async () => {
    const sessions = [];
    let recalls = 0;
    stub((path, init) => {
        if (path !== "/api/recall") throw new Error(`unexpected ${path}`);
        sessions.push(init.headers["x-seal-session"]);
        recalls += 1;
        if (recalls === 1) return expired();
        return Response.json({ results: [], total: 0 });
    });

    const memwal = client();
    memwal.sessionCache = { bytes: "stale-session", expiresAt: Date.now() + 60_000 };
    memwal.buildSealSession = async function () {
        if (this.sessionCache?.bytes) return this.sessionCache.bytes;
        this.sessionCache = { bytes: "fresh-session", expiresAt: Date.now() + 60_000 };
        return "fresh-session";
    };

    const result = await memwal.recall("hello");
    assert.equal(result.total, 0);
    assert.deepEqual(sessions, ["stale-session", "fresh-session"]);
});

test("a second SESSION_EXPIRED is returned, not retried forever", async () => {
    let recalls = 0;
    stub((path) => {
        if (path !== "/api/recall") throw new Error(`unexpected ${path}`);
        recalls += 1;
        return expired();
    });

    const memwal = client();
    memwal.buildSealSession = async () => "session";

    await assert.rejects(memwal.recall("hello"), (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.serverCode, "SESSION_EXPIRED");
        return true;
    });
    assert.equal(recalls, 2);
});

test("a session refresh does not outlive the request deadline", async () => {
    let statusCalls = 0;
    let builds = 0;
    stub((path, init) => {
        if (path !== "/api/remember/bulk/status") throw new Error(`unexpected ${path}`);
        statusCalls += 1;
        if (statusCalls === 1) {
            return new Promise((resolve) => setTimeout(() => resolve(expired()), 40));
        }
        return new Promise((_, reject) => {
            const onAbort = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
            };
            if (init.signal?.aborted) onAbort();
            else init.signal?.addEventListener("abort", onAbort, { once: true });
        });
    });

    const memwal = client();
    memwal.buildSealSession = async function (signal) {
        builds += 1;
        if (builds === 1) return "stale-session";
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve("fresh-session"), 5_000);
            const onAbort = () => {
                clearTimeout(timer);
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
        });
    };

    const started = Date.now();
    await assert.rejects(
        memwal.getRememberBulkStatus(["job-a"], { timeoutMs: 300 }),
        (err) => {
            assert.equal(err.name, "MemWalRequestTimeout");
            assert.equal(err.status, 504);
            return true;
        },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_500, `refresh ran for ${elapsed}ms`);
    assert.equal(builds, 2);
    assert.equal(statusCalls, 1);
});

test("a credential 401 is not retried as a session refresh", async () => {
    let recalls = 0;
    stub((path) => {
        if (path !== "/api/recall") throw new Error(`unexpected ${path}`);
        recalls += 1;
        return new Response(JSON.stringify({ error: "auth rejected" }), { status: 401 });
    });

    const memwal = client();
    memwal.buildSealSession = async () => "session";

    await assert.rejects(memwal.recall("hello"), (err) => {
        assert.equal(err.serverCode, "AUTH_REJECTED");
        return true;
    });
    assert.equal(recalls, 1);
});
