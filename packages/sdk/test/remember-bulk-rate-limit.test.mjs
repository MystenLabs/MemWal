import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const refused = () =>
    Response.json({ error: "rate limited", retry_after_seconds: 30 }, { status: 429 });

function relayer(routes) {
    return async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config") return Response.json({ packageId: "0x1", network: "testnet" });
        const handler = routes[path];
        if (!handler) throw new Error(`unexpected request ${path}`);
        return handler(init);
    };
}

function client() {
    const c = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    c.buildSealSession = async () => "test-session";
    return c;
}

const ids = Array.from({ length: 12 }, (_, i) => `job-${i}`);

// GH #967: 12 items accepted, then every status read (and the confirming
// probe) is rate-limited. This must not resolve as a result.
test("over-budget bulk does not report success for zero stored memories", async () => {
    globalThis.fetch = relayer({
        "/api/remember/bulk": () =>
            Response.json({ job_ids: ids, total: 12, status: "running" }, { status: 202 }),
        "/api/remember/bulk/status": refused,
    });
    const items = ids.map((_, i) => ({ text: `fact ${i}` }));
    await assert.rejects(
        client().rememberBulkAndWait(items, { pollIntervalMs: 0, timeoutMs: 300 }),
        (err) => {
            assert.equal(err.name, "MemWalRateLimited");
            assert.equal(err.status, 429);
            assert.deepEqual(err.jobIds, ids);
            assert.match(err.message, /none of its 12 writes could be confirmed/);
            return true;
        },
    );
});

test("a refused wait settles from the confirming read when that one gets through", async () => {
    const start = Date.now();
    globalThis.fetch = relayer({
        "/api/remember/bulk/status": () => {
            // Refused for the whole wait (retry-after 0, so polls keep coming);
            // the read after the deadline is the probe, and it answers but
            // omits job-c. Time-based, not count-based: jitter varies the count.
            if (Date.now() - start < 250) {
                return Response.json(
                    { error: "rate limited", retry_after_seconds: 0 },
                    { status: 429 },
                );
            }
            return Response.json({
                results: [
                    { job_id: "job-a", status: "done", blob_id: "blob-a" },
                    { job_id: "job-b", status: "failed", error: "walrus upload failed" },
                ],
            });
        },
    });
    const out = await client().waitForRememberJobs(["job-a", "job-b", "job-c"], [], {
        pollIntervalMs: 0,
        timeoutMs: 250,
    });
    assert.deepEqual(
        out.results.map((r) => r.status),
        ["done", "failed", "timeout"],
    );
    assert.equal(out.succeeded, 1);
    // The probe DID get through; it just left job-c out, so saying no read
    // got through would be false.
    assert.match(out.results[2].error, /not in the relayer's status answer/);
});

test("a partly settled batch is returned, not thrown, even if the last reads are refused", async () => {
    let reads = 0;
    globalThis.fetch = relayer({
        "/api/remember/bulk/status": () => {
            reads += 1;
            if (reads === 1) {
                return Response.json({
                    results: [
                        { job_id: "job-a", status: "done", blob_id: "blob-a" },
                        { job_id: "job-b", status: "running", error: "still retrying this upload" },
                    ],
                });
            }
            return refused();
        },
    });
    const out = await client().waitForRememberJobs(["job-a", "job-b"], [], {
        pollIntervalMs: 0,
        timeoutMs: 300,
    });
    assert.deepEqual(
        out.results.map((r) => r.status),
        ["done", "timeout"],
    );
    assert.match(out.results[1].error, /still running after 300ms: still retrying this upload/);
});

test("a stalled confirming read cannot hold the wait for the full request deadline", async () => {
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config") return Response.json({ packageId: "0x1", network: "testnet" });
        if (path !== "/api/remember/bulk/status") throw new Error(`unexpected request ${path}`);
        // Every poll is refused; the probe after the deadline never answers
        // until the SDK gives up on it.
        if (Date.now() - start < 300) {
            return Response.json({ error: "rate limited", retry_after_seconds: 0 }, { status: 429 });
        }
        return new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
    };
    const start = Date.now();
    const out = await client().waitForRememberJobs(["job-a"], [], { pollIntervalMs: 0, timeoutMs: 300 });
    const elapsed = Date.now() - start;
    assert.equal(out.results[0].status, "timeout");
    assert.ok(elapsed < 8_000, `wait took ${elapsed}ms; the probe must not use the 30s request deadline`);
});
