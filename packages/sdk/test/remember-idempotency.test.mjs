import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("rememberAndWait reuses its generated key and job after polling timeout", async () => {
    const posted = [];
    let jobPolls = 0;
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
            return Response.json({ job_id: "stable-job", status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/stable-job") {
            jobPolls += 1;
            if (jobPolls < 2) return Response.json({ job_id: "stable-job", status: "pending" });
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
