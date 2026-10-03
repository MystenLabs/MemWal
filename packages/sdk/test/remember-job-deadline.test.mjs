import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
});

function client() {
    const memwal = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
        requestTimeoutMs: 10_000,
    });
    memwal.buildSealSession = async () => "test-session";
    return memwal;
}

/** Job is `running` until `doneAtMs` after `t0`, then `done`. Each poll waits
 * `handlerDelayMs` so a 1ms budget cannot succeed by accident. */
function stubJob({ doneAtMs, handlerDelayMs = 30, onPoll }) {
    const t0 = Date.now();
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
        if (path === "/api/remember/job-1") {
            onPoll?.(Date.now() - t0);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, handlerDelayMs);
                init.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    const err = new Error("This operation was aborted");
                    err.name = "AbortError";
                    reject(err);
                }, { once: true });
            });
            const done = Date.now() - t0 >= doneAtMs;
            return Response.json({
                job_id: "job-1",
                owner: "0x1",
                namespace: "default",
                ...(done
                    ? { status: "done", blob_id: "blob-1" }
                    : { status: "running" }),
            });
        }
        if (path === "/api/remember/bulk/status") {
            onPoll?.(Date.now() - t0);
            const done = Date.now() - t0 >= doneAtMs;
            const ids = JSON.parse(init.body).job_ids;
            return Response.json({
                results: ids.map((job_id) => ({
                    job_id,
                    ...(done
                        ? { status: "done", blob_id: "blob-1" }
                        : { status: "running" }),
                })),
            });
        }
        throw new Error(`unexpected ${path}`);
    };
    return t0;
}

test("a job that finishes inside the budget is not reported as a timeout", async () => {
    Math.random = () => 0.5;
    const polls = [];
    const timeoutMs = 350;
    const t0 = stubJob({ doneAtMs: 300, onPoll: (at) => polls.push(at) });

    const result = await client().waitForRememberJob("job-1", {
        timeoutMs,
        pollIntervalMs: 200,
    });

    assert.equal(result.blob_id, "blob-1");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < timeoutMs + 80, `wait returned ${elapsed - timeoutMs}ms past timeoutMs`);
    assert.ok(polls.length >= 2, "the job was still running on the first poll");
});

test("an already finished job is polled immediately", async () => {
    Math.random = () => 0.5;
    const t0 = stubJob({ doneAtMs: 0, handlerDelayMs: 0 });

    const result = await client().waitForRememberJob("job-1", {
        timeoutMs: 50,
        pollIntervalMs: 1500,
    });

    assert.equal(result.blob_id, "blob-1");
    assert.ok(Date.now() - t0 < 200);
});

test("a bulk wait also observes a job that finishes inside the budget", async () => {
    Math.random = () => 0.5;
    const timeoutMs = 350;
    const t0 = stubJob({ doneAtMs: 300 });

    const result = await client().waitForRememberJobs(["job-1"], ["default"], {
        timeoutMs,
        pollIntervalMs: 200,
    });

    assert.equal(result.results[0].status, "done");
    assert.equal(result.results[0].blob_id, "blob-1");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < timeoutMs + 80, `bulk wait returned ${elapsed - timeoutMs}ms past timeoutMs`);
});
