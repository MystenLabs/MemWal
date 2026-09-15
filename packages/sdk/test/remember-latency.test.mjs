import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Stub relayer. `onStatus(pollIndex)` decides what each status poll returns. */
function stubRelayer({ onStatus, posted = [] }) {
    let polls = 0;
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
            posted.push({ body: JSON.parse(init.body), at: Date.now() });
            return Response.json({ job_id: "job-1", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/job-1") {
            return Response.json(onStatus(polls++));
        }
        throw new Error(`unexpected request ${path}`);
    };
    return { posted, pollCount: () => polls };
}

function newClient() {
    const client = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    client.buildSealSession = async () => "test-session";
    return client;
}

const DONE = {
    job_id: "job-1",
    status: "done",
    blob_id: "blob-1",
    owner: "0x1",
    namespace: "default",
};

test("a job that is already done resolves without paying a poll delay first", async () => {
    stubRelayer({ onStatus: () => DONE });

    const started = Date.now();
    const result = await newClient().rememberAndWait("already finished");
    const elapsed = Date.now() - started;

    assert.equal(result.blob_id, "blob-1");
    // Sleep-first polling billed this a full base interval (~600ms, and ~1.5s
    // before the interval was lowered) for a result the server had ready.
    assert.ok(elapsed < 250, `expected an immediate first poll, took ${elapsed}ms`);
});

test("poll gaps stay bounded so a finished write is observed promptly", async () => {
    const seenAt = [];
    // Never terminal: let the loop run its full backoff ramp against the clock.
    stubRelayer({
        onStatus: () => {
            seenAt.push(Date.now());
            return { job_id: "job-1", status: "running" };
        },
    });

    await assert.rejects(
        newClient().rememberAndWait("slow write", undefined, { timeoutMs: 9_000 }),
        /timed out/,
    );

    const gaps = seenAt.slice(1).map((t, i) => t - seenAt[i]);
    const worst = Math.max(...gaps);
    // The cap is 2s; jitter can stretch one gap to 2.5s. The old 10s cap put
    // checks at 1.5/3.75/7.1/12.2/19.8/29.8s — a write finishing at 20.5s was
    // not seen until 29.8s, which is most of what a user experienced as a slow
    // remember.
    assert.ok(worst < 2_600, `worst poll gap ${worst}ms exceeds the 2s cap + jitter`);
    // And it must actually be polling, not spinning.
    assert.ok(gaps.length >= 4, `expected a real ramp, saw ${gaps.length} gaps`);
    assert.ok(Math.min(...gaps) > 50, "polling should not busy-loop");
});

test("the same fact reuses one idempotency key across client instances", async () => {
    const posted = [];
    stubRelayer({ onStatus: () => DONE, posted });

    // Two instances = what the MCP sidecar builds when the stdio bridge
    // reconnects a dropped SSE stream. A per-instance random key made the
    // replay look like a new write, so the relayer minted a second paid
    // Walrus blob for a write already in flight.
    await newClient().rememberAndWait("a durable fact");
    await newClient().rememberAndWait("a durable fact");

    assert.equal(posted.length, 2);
    assert.equal(posted[0].body.idempotency_key, posted[1].body.idempotency_key);
});

test("different text and different namespaces get different keys", async () => {
    const posted = [];
    stubRelayer({ onStatus: () => DONE, posted });

    const client = newClient();
    await client.rememberAndWait("fact one");
    await client.rememberAndWait("fact two");
    await client.rememberAndWait("fact one", "other-namespace");

    const keys = posted.map((p) => p.body.idempotency_key);
    assert.equal(new Set(keys).size, 3, "distinct writes must not collapse onto one job");
});

test("an explicit idempotency key still wins", async () => {
    const posted = [];
    stubRelayer({ onStatus: () => DONE, posted });

    await newClient().rememberAndWait("a fact", undefined, { idempotencyKey: "caller-owned" });

    assert.equal(posted[0].body.idempotency_key, "caller-owned");
});
