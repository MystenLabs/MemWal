import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Stub a job whose first status read is rate-limited, and record when each
 * read arrived so the test can measure the gap the SDK actually waited. */
function rateLimitedJob({ header, body }) {
    const polledAt = [];
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
        if (path === "/api/remember" && init.method === "POST") {
            return Response.json({ job_id: "limited-job", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/limited-job") {
            polledAt.push(Date.now());
            if (polledAt.length === 1) {
                return new Response(JSON.stringify(body), {
                    status: 429,
                    headers: {
                        "content-type": "application/json",
                        ...(header ? { "retry-after": header } : {}),
                    },
                });
            }
            return Response.json({
                job_id: "limited-job",
                status: "done",
                blob_id: "blob-1",
                owner: "0x1",
                namespace: "default",
            });
        }
        throw new Error(`unexpected request ${path}`);
    };
    return polledAt;
}

function client() {
    const memwal = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    memwal.buildSealSession = async () => "test-session";
    return memwal;
}

// The rate limiter counts our own status reads, so re-polling on the 1.5s→10s
// curve after a `retry_after_seconds: 60` re-trips it every attempt and the
// loop starves itself — the job reads as "still uploading" for as long as the
// caller waits, including long after it has failed. `pollIntervalMs: 1` makes
// the unfixed behaviour ~1ms, so the wait being ≥ the stated backoff is
// unambiguous.
test("a rate-limited status poll waits the retry-after from the body", async () => {
    const polledAt = rateLimitedJob({
        body: { error: "Rate limit exceeded", retry_after_seconds: 0.5 },
    });

    const result = await client().rememberAndWait("fact", undefined, {
        pollIntervalMs: 1,
        timeoutMs: 10_000,
    });

    assert.equal(result.blob_id, "blob-1");
    assert.equal(polledAt.length, 2);
    assert.ok(
        polledAt[1] - polledAt[0] >= 450,
        `expected to honour the 500ms backoff, waited ${polledAt[1] - polledAt[0]}ms`,
    );
});

test("a rate-limited status poll waits the Retry-After header", async () => {
    const polledAt = rateLimitedJob({
        header: "1",
        body: { error: "Rate limit exceeded" },
    });

    const result = await client().rememberAndWait("fact", undefined, {
        pollIntervalMs: 1,
        timeoutMs: 10_000,
    });

    assert.equal(result.blob_id, "blob-1");
    assert.ok(
        polledAt[1] - polledAt[0] >= 950,
        `expected to honour the 1s backoff, waited ${polledAt[1] - polledAt[0]}ms`,
    );
});

test("a retry-after longer than the remaining budget is clamped to it", async () => {
    // Honouring a 10-minute backoff must not turn a 1s wait into a 10-minute
    // one. The budget still buys a final read at its own boundary — that read
    // is free and may be the answer — but nothing beyond it.
    const polledAt = [];
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
        if (path === "/api/remember" && init.method === "POST") {
            return Response.json({ job_id: "slow-job", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/slow-job") {
            polledAt.push(Date.now());
            if (polledAt.length === 1) {
                return new Response(
                    JSON.stringify({ error: "Rate limit exceeded", retry_after_seconds: 600 }),
                    { status: 429, headers: { "content-type": "application/json" } },
                );
            }
            return Response.json({ job_id: "slow-job", status: "pending" });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const startedAt = Date.now();
    await assert.rejects(
        client().rememberAndWait("fact", undefined, { pollIntervalMs: 1, timeoutMs: 800 }),
        /timed out/,
    );
    assert.ok(
        Date.now() - startedAt < 3_000,
        `a 600s retry-after must be clamped to the caller's own timeout, took ${Date.now() - startedAt}ms`,
    );
});
