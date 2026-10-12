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

test("waitForRememberJob clamps sleep to deadline and resolves when job finishes before budget (#1081)", async () => {
    const start = Date.now();
    const doneAfterMs = 250;
    let pollCount = 0;

    stub((path) => {
        if (path === "/api/remember/job-1") {
            pollCount++;
            const elapsed = Date.now() - start;
            if (elapsed >= doneAfterMs) {
                return Response.json({
                    job_id: "job-1",
                    status: "done",
                    blob_id: "blob-1081",
                    owner: "0x1",
                    namespace: "default",
                });
            }
            return Response.json({
                job_id: "job-1",
                status: "running",
            });
        }
        throw new Error(`unexpected request ${path}`);
    });

    // pollIntervalMs is larger than timeoutMs, so unclamped backoff would sleep past the deadline
    const result = await client().waitForRememberJob("job-1", {
        pollIntervalMs: 800,
        timeoutMs: 400,
    });

    assert.equal(result.blob_id, "blob-1081");
    assert.ok(pollCount >= 2, "must poll at t=0 and at/near boundary");
    const totalElapsed = Date.now() - start;
    assert.ok(totalElapsed < 1500, `wait overran budget: ${totalElapsed}ms`);
});

test("waitForRememberJob does not sleep past deadline on perpetual running job (#1081)", async () => {
    const start = Date.now();

    stub((path) => {
        if (path === "/api/remember/job-running") {
            return Response.json({
                job_id: "job-running",
                status: "running",
            });
        }
        throw new Error(`unexpected request ${path}`);
    });

    // pollIntervalMs (2000ms) is much larger than timeoutMs (300ms)
    await assert.rejects(
        client().waitForRememberJob("job-running", {
            pollIntervalMs: 2000,
            timeoutMs: 300,
        }),
        /remember job timed out after 300ms \(job_id=job-running\)/,
    );

    const totalElapsed = Date.now() - start;
    assert.ok(totalElapsed < 1200, `wait slept past deadline: ${totalElapsed}ms`);
});

test("waitForRememberJobs bulk clamps sleep to deadline and resolves job finishing before budget (#1081)", async () => {
    const start = Date.now();
    const doneAfterMs = 250;

    stub((path) => {
        if (path === "/api/remember/bulk/status") {
            const elapsed = Date.now() - start;
            const status = elapsed >= doneAfterMs ? "done" : "running";
            return Response.json({
                results: [
                    {
                        job_id: "job-bulk-1",
                        status,
                        blob_id: status === "done" ? "blob-bulk-1" : undefined,
                    },
                ],
            });
        }
        throw new Error(`unexpected request ${path}`);
    });

    const settled = await client().waitForRememberJobs(["job-bulk-1"], ["default"], {
        pollIntervalMs: 800,
        timeoutMs: 400,
    });

    assert.equal(settled.results[0].status, "done");
    assert.equal(settled.results[0].blob_id, "blob-bulk-1");
    const totalElapsed = Date.now() - start;
    assert.ok(totalElapsed < 1500, `bulk wait overran budget: ${totalElapsed}ms`);
});
