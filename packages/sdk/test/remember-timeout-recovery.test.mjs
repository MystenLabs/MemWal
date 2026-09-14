/**
 * WALM-595 / GH #658.
 *
 * `rememberAndWait()` threw a bare `Error` when its poll budget expired during
 * relayer congestion, even though the relayer had already accepted the job. The
 * caller could not tell "the write may still land" from "the write failed", and
 * the idempotency key the SDK had generated never left the process — so the
 * obvious retry minted, and paid for, a second blob.
 *
 * The timeout now carries both handles: the job id to poll, and the key to
 * replay under.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { isRememberJobTimeoutError } from "../dist/utils.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const JOB_ID = "9b921ab2-e9a3-490d-8180-136fd98cfc2a";
const BLOB_ID = "6EPcpE73RpswQqMc52Flp47qm2TcGr_zdBaQZJKMNTE";

/**
 * A relayer that accepts the write and then leaves the job `running` until
 * `settleAfter` polls have gone by — the congestion shape from GH #658.
 *
 * Records every POST /api/remember body so a test can prove no second write was
 * submitted, and that a replay carried the original key.
 */
function stubCongestedRelayer({ settleAfter = Infinity } = {}) {
    const calls = { posts: [], polls: 0 };
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
        if (path === "/api/remember" && init.method === "POST") {
            calls.posts.push(JSON.parse(init.body));
            // The relayer collapses a replay onto the original job, so every
            // accept under the same key names the same job id.
            return Response.json({ job_id: JOB_ID, status: "pending" }, { status: 202 });
        }
        if (path === `/api/remember/${JOB_ID}`) {
            calls.polls += 1;
            if (calls.polls <= settleAfter) {
                return Response.json({ job_id: JOB_ID, status: "running" });
            }
            return Response.json({
                job_id: JOB_ID,
                status: "done",
                blob_id: BLOB_ID,
                owner: "0x1",
                namespace: "drops",
            });
        }
        throw new Error(`unexpected request ${path}`);
    };
    return calls;
}

function makeClient() {
    const client = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
        namespace: "drops",
    });
    client.buildSealSession = async () => "test-session";
    return client;
}

/** Reject and return the error, so assertions read top-to-bottom. */
async function rejection(promise) {
    return promise.then(
        () => assert.fail("expected a rejection"),
        (err) => err,
    );
}

test("a congestion timeout is an unknown outcome carrying both recovery handles", async () => {
    stubCongestedRelayer();

    const err = await rejection(
        makeClient().rememberAndWait("wallet drop #42", undefined, {
            pollIntervalMs: 0,
            timeoutMs: 1,
        }),
    );

    assert.ok(isRememberJobTimeoutError(err), "callers must be able to detect this without duck-typing");
    assert.equal(err.name, "MemWalRememberJobTimeoutError");
    assert.equal(err.status, 504);
    assert.equal(err.jobId, JOB_ID);
    assert.equal(err.namespace, "drops");
    assert.match(err.idempotencyKey, /^[0-9a-f-]{36}$/);
    // The message has to point at recovery: this is what a caller sees in logs.
    assert.match(err.message, /poll waitForRememberJob/);
    assert.match(err.message, /mints a second blob/);
    // The key belongs in the message too: after a restart the log line may be
    // all a caller still has.
    assert.ok(err.message.includes(err.idempotencyKey));
});

test("the job id settles the write with no second remember", async () => {
    // AC: "timeout after accept does not require a second remember to recover".
    const calls = stubCongestedRelayer({ settleAfter: 1 });
    const client = makeClient();

    const err = await rejection(
        client.rememberAndWait("wallet drop #42", undefined, { pollIntervalMs: 0, timeoutMs: 1 }),
    );
    assert.ok(isRememberJobTimeoutError(err));

    const settled = await client.waitForRememberJob(err.jobId, {
        pollIntervalMs: 0,
        timeoutMs: 5_000,
    });

    assert.equal(settled.blob_id, BLOB_ID);
    assert.equal(calls.posts.length, 1, "recovery by polling must not submit another write");
});

test("replaying under the returned key reuses the original job", async () => {
    // AC: "retry with the same idempotency key does not mint a second blob".
    // The replay is deliberately driven through a *fresh* client, the way a
    // restarted service would: the in-memory key map is gone, and only the key
    // read off the error keeps the write idempotent.
    const calls = stubCongestedRelayer({ settleAfter: 1 });

    const err = await rejection(
        makeClient().rememberAndWait("wallet drop #42", undefined, {
            pollIntervalMs: 0,
            timeoutMs: 1,
        }),
    );

    const replayed = await makeClient().rememberAndWait("wallet drop #42", err.namespace, {
        pollIntervalMs: 0,
        timeoutMs: 5_000,
        idempotencyKey: err.idempotencyKey,
    });

    assert.equal(replayed.job_id, JOB_ID);
    assert.equal(replayed.blob_id, BLOB_ID);
    assert.equal(calls.posts.length, 2);
    assert.equal(calls.posts[1].idempotency_key, err.idempotencyKey);
    // One distinct key across both attempts is what stops the duplicate mint.
    assert.equal(new Set(calls.posts.map((p) => p.idempotency_key)).size, 1);
});

test("a fresh client without the key would submit a different write", async () => {
    // The regression this guards: losing the key is exactly the duplicate-mint
    // path, which is why the error has to carry it.
    const calls = stubCongestedRelayer({ settleAfter: 1 });

    await rejection(
        makeClient().rememberAndWait("wallet drop #42", undefined, {
            pollIntervalMs: 0,
            timeoutMs: 1,
        }),
    );
    await makeClient().rememberAndWait("wallet drop #42", "drops", {
        pollIntervalMs: 0,
        timeoutMs: 5_000,
    });

    assert.equal(new Set(calls.posts.map((p) => p.idempotency_key)).size, 2);
});

test("rememberAsync hands back the key alongside the job id", async () => {
    stubCongestedRelayer();

    const accepted = await makeClient().rememberAsync("wallet drop #42");

    assert.equal(accepted.job_id, JOB_ID);
    assert.match(accepted.idempotency_key, /^[0-9a-f-]{36}$/);
});

test("an explicit idempotencyKey is echoed back, not replaced", async () => {
    const calls = stubCongestedRelayer();

    const err = await rejection(
        makeClient().rememberAndWait("wallet drop #42", undefined, {
            pollIntervalMs: 0,
            timeoutMs: 1,
            idempotencyKey: "caller-owned-key",
        }),
    );

    assert.equal(err.idempotencyKey, "caller-owned-key");
    assert.equal(calls.posts[0].idempotency_key, "caller-owned-key");
});

test("isRememberTimeoutError does not fire on a genuine failure", async () => {
    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        if (path === "/api/config") return Response.json({ packageId: "0x1", network: "testnet" });
        if (path === "/api/remember") {
            return Response.json({ job_id: JOB_ID, status: "pending" }, { status: 202 });
        }
        return Response.json({ job_id: JOB_ID, status: "failed", error: "walrus rejected blob" });
    };

    const err = await rejection(
        makeClient().rememberAndWait("wallet drop #42", undefined, {
            pollIntervalMs: 0,
            timeoutMs: 5_000,
        }),
    );

    assert.equal(isRememberJobTimeoutError(err), false, "a failed job is a known outcome");
    assert.equal(err.status, 500);
});

test("waitForRememberJob called directly reports no key it never saw", async () => {
    stubCongestedRelayer();

    const err = await rejection(
        makeClient().waitForRememberJob(JOB_ID, { pollIntervalMs: 0, timeoutMs: 1 }),
    );

    assert.ok(isRememberJobTimeoutError(err));
    assert.equal(err.jobId, JOB_ID);
    assert.equal(err.idempotencyKey, undefined);
});
