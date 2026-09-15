import assert from "node:assert/strict";
import test from "node:test";

import { MemWal, RememberJobTimeoutError } from "../dist/index.js";

const originalFetch = globalThis.fetch;
const TIMEOUT_MS = 1;
const POLL = { pollIntervalMs: 0, timeoutMs: TIMEOUT_MS };

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function pendingRememberFetch() {
    return async (url, init = {}) => {
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
        if (path === "/api/remember/slow-job") {
            return Response.json({ job_id: "slow-job", status: "pending" });
        }
        if (path === "/api/remember/bulk/status" && init.method === "POST") {
            return Response.json({
                results: [{ job_id: "slow-job", status: "pending" }],
            });
        }
        throw new Error(`unexpected request ${path}`);
    };
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

test("waitForRememberJob throws RememberJobTimeoutError; waitForRememberJobs returns timeout", async () => {
    globalThis.fetch = pendingRememberFetch();
    const memwal = client();

    await assert.rejects(
        () => memwal.waitForRememberJob("slow-job", POLL),
        (err) => {
            assert.equal(err instanceof RememberJobTimeoutError, true);
            assert.equal(err.name, "RememberJobTimeoutError");
            assert.equal(err.status, 504);
            assert.equal(err.jobId, "slow-job");
            assert.equal(err.timeoutMs, TIMEOUT_MS);
            assert.equal(
                err.message,
                "remember job timed out after 1ms (job_id=slow-job)",
            );
            return true;
        },
    );

    const bulk = await memwal.waitForRememberJobs(["slow-job"], ["default"], POLL);
    assert.equal(bulk.results.length, 1);
    assert.equal(bulk.results[0].status, "timeout");
    assert.equal(bulk.results[0].id, "slow-job");
    assert.equal(bulk.results[0].blob_id, "");
    assert.equal(bulk.results[0].error, "polling timed out after 1ms");
});
