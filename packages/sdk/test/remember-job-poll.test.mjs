import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client() {
    const memwal = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    memwal.buildSealSession = async () => "test-session";
    return memwal;
}

function rateLimit() {
    return new Response(
        JSON.stringify({ error: "Rate limit exceeded", retry_after_seconds: 600 }),
        {
            status: 429,
            headers: {
                "content-type": "application/json",
                "retry-after": "600",
            },
        },
    );
}

function stub(pathHandler) {
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
        return pathHandler(path, init);
    };
}

test("a remember wait that only sees 429 names the rate limit on timeout", async () => {
    stub((path) => {
        if (path === "/api/remember/job-1") return rateLimit();
        throw new Error(`unexpected request ${path}`);
    });

    const started = Date.now();
    await assert.rejects(
        client().waitForRememberJob("job-1", { pollIntervalMs: 1, timeoutMs: 400 }),
        /remember job timed out after 400ms \(job_id=job-1\); wait hit a rate limit \(429\)/,
    );
    assert.ok(Date.now() - started < 3_000, "a 600s Retry-After must stay inside the wait budget");
});

test("a bulk remember wait that only sees 429 names the rate limit on timeout", async () => {
    stub((path) => {
        if (path === "/api/remember/bulk/status") return rateLimit();
        throw new Error(`unexpected request ${path}`);
    });

    const settled = await client().waitForRememberJobs(["job-1"], ["default"], {
        pollIntervalMs: 1,
        timeoutMs: 400,
    });

    assert.equal(settled.results[0].status, "timeout");
    assert.match(
        settled.results[0].error,
        /polling timed out after 400ms; wait hit a rate limit \(429\)/,
    );
});
