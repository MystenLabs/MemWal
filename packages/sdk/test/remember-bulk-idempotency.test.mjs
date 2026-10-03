import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stub(posted) {
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
        if (path === "/api/remember/bulk" && init.method === "POST") {
            const body = JSON.parse(init.body);
            posted.push(body);
            return Response.json(
                {
                    job_ids: body.items.map((_, i) => `job-${i}`),
                    total: body.items.length,
                    status: "pending",
                },
                { status: 202 },
            );
        }
        throw new Error(`unexpected ${path}`);
    };
}

function client() {
    const memwal = MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
        namespace: "default",
    });
    memwal.buildSealSession = async () => "test-session";
    return memwal;
}

const ITEMS = [
    { text: "The class rep is Ada" },
    { text: "Treasurer approves spending", namespace: "finance" },
];

test("the same bulk items reuse one idempotency key", async () => {
    const posted = [];
    stub(posted);

    await client().rememberBulk(ITEMS);
    await client().rememberBulk(ITEMS);

    assert.equal(posted.length, 2);
    assert.equal(typeof posted[0].idempotency_key, "string");
    assert.ok(posted[0].idempotency_key.length > 0);
    assert.equal(posted[0].idempotency_key, posted[1].idempotency_key);
    assert.equal(posted[0].items.length, 2);
});

test("a bulk accept with the wrong number of job ids keeps the idempotency key", async () => {
    globalThis.fetch = async (url) => {
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
        if (path === "/api/remember/bulk") {
            return Response.json({ job_ids: ["only-one"], total: 1, status: "pending" }, { status: 202 });
        }
        throw new Error(`unexpected ${path}`);
    };

    const memwal = client();
    await assert.rejects(() => memwal.rememberBulk(ITEMS), /job_ids/);
    assert.equal(memwal.pendingRememberKeys.size, 1);
});

test("different items and an explicit key do not collapse together", async () => {
    const posted = [];
    stub(posted);

    const memwal = client();
    await memwal.rememberBulk(ITEMS);
    await memwal.rememberBulk([{ text: "a different fact" }]);
    await memwal.rememberBulkAsync(ITEMS, { idempotencyKey: "caller-owned" });

    assert.notEqual(posted[0].idempotency_key, posted[1].idempotency_key);
    assert.equal(posted[2].idempotency_key, "caller-owned");
});
