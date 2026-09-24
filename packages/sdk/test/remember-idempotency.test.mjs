import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("rememberAndWait reuses its generated key and job after polling timeout", async () => {
    const posted = [];
    let rememberPosts = 0;
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
            posted.push(JSON.parse(init.body));
            rememberPosts += 1;
            return Response.json({ job_id: "stable-job", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/stable-job") {
            if (rememberPosts < 2) return Response.json({ job_id: "stable-job", status: "pending" });
            return Response.json({
                job_id: "stable-job",
                status: "done",
                blob_id: "blob-1",
                owner: "0x1",
                namespace: "default",
            });
        }
        throw new Error(`unexpected request ${path}`);
    };

    const client = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    client.buildSealSession = async () => "test-session";

    await assert.rejects(
        client.rememberAndWait("same memory", undefined, { pollIntervalMs: 0, timeoutMs: 1 }),
        /timed out/,
    );
    const result = await client.rememberAndWait("same memory", undefined, {
        pollIntervalMs: 0,
        timeoutMs: 100,
    });

    assert.equal(result.job_id, "stable-job");
    assert.equal(posted.length, 2);
    assert.equal(posted[0].idempotency_key, posted[1].idempotency_key);
});

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

const RETRYING =
    "Temporary capacity limit on Walrus Memory infrastructure; the hosted relayer is still retrying this upload.";

test("a timed-out wait reports the job's last status and the relayer's message", async () => {
    globalThis.fetch = relayer({
        "/api/remember/slow-job": () =>
            Response.json({ job_id: "slow-job", status: "running", error: RETRYING }),
    });
    await assert.rejects(
        client().waitForRememberJob("slow-job", { pollIntervalMs: 0, timeoutMs: 300 }),
        (err) => {
            assert.equal(err.name, "MemWalRememberJobTimeout");
            assert.equal(err.status, 504);
            assert.equal(err.jobId, "slow-job");
            assert.equal(err.lastStatus, "running");
            assert.match(err.serverError, /still retrying/);
            assert.match(err.message, /^remember job timed out after 300ms/);
            assert.match(err.message, /last status: running/);
            return true;
        },
    );
});

test("a timed-out wait whose every poll was refused says the state is unknown", async () => {
    globalThis.fetch = relayer({
        "/api/remember/hidden-job": () =>
            Response.json({ error: "rate limited", retry_after_seconds: 0 }, { status: 429 }),
    });
    await assert.rejects(
        client().waitForRememberJob("hidden-job", { pollIntervalMs: 0, timeoutMs: 300 }),
        (err) => {
            assert.equal(err.status, 504);
            assert.equal(err.lastStatus, undefined);
            assert.match(err.message, /no status read got through \(last poll: HTTP 429\)/);
            return true;
        },
    );
});

// GH #966: a retry after a terminal failure must reach the relayer under the
// same key, which restarts the same job instead of minting a second paid one.
test("rememberAndWait retried after a terminal failure restarts the same job under the same key", async () => {
    const posted = [];
    let phase = "first";
    globalThis.fetch = relayer({
        "/api/remember": (init) => {
            posted.push(JSON.parse(init.body));
            return Response.json({ job_id: "job-966", status: "pending" }, { status: 202 });
        },
        "/api/remember/job-966": () =>
            phase === "first"
                ? Response.json({ job_id: "job-966", status: "failed", error: "walrus upload failed" })
                : Response.json({
                      job_id: "job-966",
                      status: "done",
                      blob_id: "blob-966",
                      owner: "0x1",
                      namespace: "default",
                  }),
    });
    const c = client();
    await assert.rejects(
        c.rememberAndWait("fact", undefined, { pollIntervalMs: 0, timeoutMs: 1_000 }),
        /failed/,
    );
    phase = "second";
    const result = await c.rememberAndWait("fact", undefined, { pollIntervalMs: 0, timeoutMs: 1_000 });
    assert.equal(result.job_id, "job-966");
    assert.equal(result.blob_id, "blob-966");
    assert.equal(posted.length, 2);
    assert.equal(posted[0].idempotency_key, posted[1].idempotency_key);
});
