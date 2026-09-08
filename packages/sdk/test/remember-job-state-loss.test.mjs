/**
 * WALM-597 / GH #564 — waitForRememberJob and waitForRememberJobs must not
 * throw away what they observed while polling.
 *
 * "uploaded" is a non-terminal state that already carries the Walrus blob_id.
 * Both wait helpers used to discard every non-terminal observation, so a
 * timeout reported nothing but the job id and the bulk path reported
 * blob_id: "" — indistinguishable from a job that never started.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const VERSION_BODY = {
    apiVersion: "1.0.0",
    relayerVersion: "1.0.0",
    minSupportedSdk: { typescript: "0.0.4" },
};

/**
 * Install a fetch stub. `routes` maps a pathname to a handler receiving the
 * parsed request body (or undefined for GET).
 */
function stubFetch(routes) {
    globalThis.fetch = async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/version") return Response.json(VERSION_BODY);
        const handler = routes[path];
        if (!handler) throw new Error(`unexpected request ${path}`);
        const body = init.body ? JSON.parse(init.body) : undefined;
        return handler(body, init);
    };
}

function makeClient() {
    const client = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    client.buildSealSession = async () => "test-session";
    return client;
}

// pollIntervalMs floors to 100ms inside pollingDelayMs, so the first backoff is
// 75-125ms. A 20ms budget therefore guarantees exactly one poll before the
// deadline, with no dependence on wall-clock jitter.
const ONE_POLL = { pollIntervalMs: 0, timeoutMs: 20 };

// ============================================================
// waitForRememberJob (single)
// ============================================================

test("waitForRememberJob timeout reports the job id and the blob id seen at 'uploaded'", async () => {
    let polls = 0;
    stubFetch({
        "/api/remember/stuck-job": () => {
            polls += 1;
            // Never reaches "done" — the relayer uploaded the blob but the
            // indexing step is still running when the client gives up.
            return Response.json({
                job_id: "stuck-job",
                status: "uploaded",
                blob_id: "blob-uploaded",
            });
        },
    });

    const err = await makeClient()
        .waitForRememberJob("stuck-job", ONE_POLL)
        .then(
            () => assert.fail("expected a timeout"),
            (e) => e,
        );

    assert.equal(polls > 0, true, "should have polled at least once");
    // Backwards compatible: existing callers catch 504 and read .jobId.
    assert.equal(err.status, 504);
    assert.equal(err.jobId, "stuck-job");
    // The new part — the observation is no longer discarded.
    assert.equal(err.lastStatus, "uploaded");
    assert.equal(err.lastBlobId, "blob-uploaded");
    assert.match(err.message, /timed out after 20ms/);
    assert.match(err.message, /last_blob_id=blob-uploaded/);
});

test("waitForRememberJob timeout without any successful poll still reports the job id", async () => {
    stubFetch({
        // 503 is a transient polling status: keep polling, never observe state.
        "/api/remember/never-seen": () => new Response("upstream down", { status: 503 }),
    });

    const err = await makeClient()
        .waitForRememberJob("never-seen", ONE_POLL)
        .then(
            () => assert.fail("expected a timeout"),
            (e) => e,
        );

    assert.equal(err.status, 504);
    assert.equal(err.jobId, "never-seen");
    // Nothing was observed, so these stay undefined rather than lying with "".
    assert.equal(err.lastStatus, undefined);
    assert.equal(err.lastBlobId, undefined);
});

test("waitForRememberJob resolves across the uploaded -> done transition", async () => {
    const seen = [];
    stubFetch({
        "/api/remember/transition-job": () => {
            seen.push("poll");
            if (seen.length === 1) {
                return Response.json({
                    job_id: "transition-job",
                    status: "uploaded",
                    blob_id: "blob-final",
                });
            }
            return Response.json({
                job_id: "transition-job",
                status: "done",
                blob_id: "blob-final",
                owner: "0xowner",
                namespace: "notes",
            });
        },
    });

    const result = await makeClient().waitForRememberJob("transition-job", {
        pollIntervalMs: 0,
        timeoutMs: 5000,
    });

    assert.equal(seen.length >= 2, true, "uploaded must not terminate polling");
    assert.equal(result.blob_id, "blob-final");
    assert.equal(result.job_id, "transition-job");
    assert.equal(result.id, "transition-job");
    assert.equal(result.owner, "0xowner");
    assert.equal(result.namespace, "notes");
});

test("waitForRememberJob errors when the server reports done without a blob_id", async () => {
    stubFetch({
        "/api/remember/empty-blob": () =>
            Response.json({
                job_id: "empty-blob",
                status: "done",
                owner: "0xowner",
                namespace: "default",
            }),
    });

    const err = await makeClient()
        .waitForRememberJob("empty-blob", { pollIntervalMs: 0, timeoutMs: 5000 })
        .then(
            (r) => assert.fail(`expected an error, got blob_id=${JSON.stringify(r.blob_id)}`),
            (e) => e,
        );

    // Used to resolve successfully with blob_id: "" — a silently lost memory.
    assert.equal(err.status, 502);
    assert.equal(err.jobId, "empty-blob");
    assert.match(err.message, /done without a blob_id/);
});

test("waitForRememberJob polls before the first backoff so a finished job returns promptly", async () => {
    stubFetch({
        "/api/remember/fast-job": () =>
            Response.json({
                job_id: "fast-job",
                status: "done",
                blob_id: "blob-fast",
                owner: "0xowner",
                namespace: "default",
            }),
    });

    const started = Date.now();
    const result = await makeClient().waitForRememberJob("fast-job", {
        pollIntervalMs: 0,
        timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.blob_id, "blob-fast");
    // The floor on pollingDelayMs is 100ms * 0.75 jitter = 75ms, so anything
    // under that proves no sleep happened before the first poll.
    assert.equal(elapsed < 75, true, `expected an immediate first poll, waited ${elapsed}ms`);
});

// ============================================================
// waitForRememberJobs (bulk)
// ============================================================

test("waitForRememberJobs timeout keeps the last observed blob id and status", async () => {
    stubFetch({
        "/api/remember/bulk/status": (body) =>
            Response.json({
                results: body.job_ids.map((jobId) => ({
                    job_id: jobId,
                    status: "uploaded",
                    blob_id: "blob-slow",
                })),
            }),
    });

    const bulk = await makeClient().waitForRememberJobs(["slow-job"], ["notes"], ONE_POLL);

    assert.equal(bulk.results.length, 1);
    const [item] = bulk.results;
    // Discriminator is unchanged so existing branching keeps working.
    assert.equal(item.status, "timeout");
    assert.equal(item.id, "slow-job");
    assert.equal(item.namespace, "notes");
    assert.match(item.error, /polling timed out/);
    // Previously "" — the blob id was observed and then thrown away.
    assert.equal(item.blob_id, "blob-slow");
    assert.equal(item.last_status, "uploaded");
});

test("waitForRememberJobs counts a timeout separately from a failure", async () => {
    stubFetch({
        "/api/remember/bulk/status": (body) =>
            Response.json({
                results: body.job_ids.map((jobId) => {
                    if (jobId === "ok-job") {
                        return { job_id: jobId, status: "done", blob_id: "blob-ok" };
                    }
                    if (jobId === "bad-job") {
                        return { job_id: jobId, status: "failed", error: "walrus rejected blob" };
                    }
                    return { job_id: jobId, status: "running" };
                }),
            }),
    });

    const bulk = await makeClient().waitForRememberJobs(
        ["ok-job", "bad-job", "slow-job"],
        [],
        ONE_POLL,
    );

    assert.equal(bulk.total, 3);
    assert.equal(bulk.succeeded, 1);
    // `failed` used to be `total - succeeded`, silently reporting the still
    // running job as a known failure.
    assert.equal(bulk.failed, 1);
    assert.equal(bulk.timedOut, 1);
    assert.equal(bulk.results[1].status, "failed");
    assert.equal(bulk.results[1].error, "walrus rejected blob");
    assert.equal(bulk.results[2].status, "timeout");
    assert.equal(bulk.results[2].last_status, "running");
});

test("waitForRememberJobs marks a done job with no blob_id as failed, not done", async () => {
    stubFetch({
        "/api/remember/bulk/status": (body) =>
            Response.json({
                results: body.job_ids.map((jobId) => ({ job_id: jobId, status: "done" })),
            }),
    });

    const bulk = await makeClient().waitForRememberJobs(["empty-blob"], [], {
        pollIntervalMs: 0,
        timeoutMs: 5000,
    });

    // Used to be counted as a success carrying blob_id: "".
    assert.equal(bulk.results[0].status, "failed");
    assert.equal(bulk.results[0].blob_id, "");
    assert.match(bulk.results[0].error, /done without a blob_id/);
    assert.equal(bulk.succeeded, 0);
    assert.equal(bulk.failed, 1);
    assert.equal(bulk.timedOut, 0);
});

test("waitForRememberJobs fills every slot when the same job id appears twice", async () => {
    stubFetch({
        // Server echoes one entry per requested id, duplicates included.
        "/api/remember/bulk/status": (body) =>
            Response.json({
                results: body.job_ids.map((jobId) => ({
                    job_id: jobId,
                    status: "done",
                    blob_id: `blob-${jobId}`,
                })),
            }),
    });

    const bulk = await makeClient().waitForRememberJobs(
        ["dup", "dup", "other"],
        ["ns-a", "ns-b", "ns-c"],
        { pollIntervalMs: 0, timeoutMs: 5000 },
    );

    // `jobIds.indexOf(jobId)` wrote both "dup" observations into slot 0 and
    // left slot 1 on its pre-seeded timeout entry.
    assert.deepEqual(
        bulk.results.map((r) => r.status),
        ["done", "done", "done"],
    );
    assert.deepEqual(
        bulk.results.map((r) => r.blob_id),
        ["blob-dup", "blob-dup", "blob-other"],
    );
    // Namespaces stay aligned with the caller's input positions.
    assert.deepEqual(
        bulk.results.map((r) => r.namespace),
        ["ns-a", "ns-b", "ns-c"],
    );
    assert.equal(bulk.succeeded, 3);
    assert.equal(bulk.failed, 0);
    assert.equal(bulk.timedOut, 0);
});

test("waitForRememberJobs re-polls a duplicated job id when the server dedupes responses", async () => {
    const requests = [];
    stubFetch({
        "/api/remember/bulk/status": (body) => {
            requests.push(body.job_ids);
            // Deduping server: one entry per distinct id, however many were asked for.
            const distinct = [...new Set(body.job_ids)];
            return Response.json({
                results: distinct.map((jobId) => ({
                    job_id: jobId,
                    status: "done",
                    blob_id: `blob-${jobId}`,
                })),
            });
        },
    });

    const bulk = await makeClient().waitForRememberJobs(["dup", "dup"], [], {
        pollIntervalMs: 0,
        timeoutMs: 5000,
    });

    assert.equal(requests.length >= 2, true, "second slot must be re-polled");
    assert.deepEqual(
        bulk.results.map((r) => r.status),
        ["done", "done"],
    );
    assert.equal(bulk.succeeded, 2);
    assert.equal(bulk.timedOut, 0);
});
