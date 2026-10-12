import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalMock } from "../dist/mock.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubRelayer({ onStatus = () => ({ status: "done", blob_id: "blob-1" }), posted = [] } = {}) {
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
            posted.push({ body, at: Date.now() });
            const job_ids = body.items.map((_, i) => `job-${i + 1}`);
            return Response.json({ job_ids, total: job_ids.length, status: "pending" }, { status: 202 });
        }
        if (path === "/api/remember/bulk/status" && init.method === "POST") {
            const body = JSON.parse(init.body);
            const results = body.job_ids.map((job_id) => ({
                job_id,
                ...onStatus(job_id),
            }));
            return Response.json({ results });
        }
        throw new Error(`unexpected request ${path}`);
    };
    return { posted };
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

test("rememberBulkAsync derives stable idempotency key for identical items across client instances", async () => {
    const posted = [];
    stubRelayer({ posted });

    const items = [
        { text: "first fact to remember" },
        { text: "second fact to remember", namespace: "custom" },
    ];

    await newClient().rememberBulkAsync(items);
    await newClient().rememberBulkAsync(items);

    assert.equal(posted.length, 2);
    assert.ok(posted[0].body.idempotency_key, "idempotency_key should be generated");
    assert.equal(posted[0].body.idempotency_key, posted[1].body.idempotency_key);
});

test("different bulk items or namespaces generate different derived keys", async () => {
    const posted = [];
    stubRelayer({ posted });

    const client = newClient();
    await client.rememberBulkAsync([{ text: "fact A" }]);
    await client.rememberBulkAsync([{ text: "fact B" }]);
    await client.rememberBulkAsync([{ text: "fact A", namespace: "other" }]);

    const keys = posted.map((p) => p.body.idempotency_key);
    assert.equal(new Set(keys).size, 3, "distinct item sets must generate distinct idempotency keys");
});

test("explicit idempotencyKey in rememberBulkAsync and rememberBulk is passed to relayer", async () => {
    const posted = [];
    stubRelayer({ posted });

    const client = newClient();
    await client.rememberBulkAsync([{ text: "fact 1" }], { idempotencyKey: "caller-bulk-key-1" });
    await client.rememberBulk([{ text: "fact 2" }], { idempotencyKey: "caller-bulk-key-2" });

    assert.equal(posted.length, 2);
    assert.equal(posted[0].body.idempotency_key, "caller-bulk-key-1");
    assert.equal(posted[1].body.idempotency_key, "caller-bulk-key-2");
});

test("rememberBulkAndWait forwards idempotencyKey option to rememberBulkAsync", async () => {
    const posted = [];
    stubRelayer({ posted });

    const client = newClient();
    const result = await client.rememberBulkAndWait(
        [{ text: "fact 1" }, { text: "fact 2" }],
        { idempotencyKey: "custom-wait-key", pollIntervalMs: 0, timeoutMs: 1000 },
    );

    assert.equal(result.succeeded, 2);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.idempotency_key, "custom-wait-key");
});

test("MemWalMock supports idempotencyKey in rememberBulk, rememberBulkAsync, and rememberBulkAndWait", async () => {
    const mock = MemWalMock.create();

    const items = [
        { text: "mock fact 1" },
        { text: "mock fact 2" },
    ];

    const first = await mock.rememberBulk(items, { idempotencyKey: "mock-key-1" });
    const second = await mock.rememberBulk(items, { idempotencyKey: "mock-key-1" });

    assert.deepEqual(first.job_ids, second.job_ids, "repeated call with same idempotencyKey should return same job_ids");

    // Attempting same key with different text should throw
    await assert.rejects(
        () => mock.rememberBulk([{ text: "different fact" }], { idempotencyKey: "mock-key-1" }),
        /idempotency_key was already used for a request with different content/,
    );

    // rememberBulkAndWait with idempotencyKey
    const waitResult = await mock.rememberBulkAndWait(items, { idempotencyKey: "mock-key-1" });
    assert.equal(waitResult.succeeded, 2);
    assert.deepEqual(waitResult.results.map((r) => r.id), first.job_ids);
});

test("MemWalMock derives stable idempotency key for identical items when idempotencyKey is omitted", async () => {
    const mock = MemWalMock.create();
    const items = [
        { text: "auto derived fact 1" },
        { text: "auto derived fact 2" },
    ];
    const first = await mock.rememberBulk(items);
    const second = await mock.rememberBulk(items);

    assert.deepEqual(first.job_ids, second.job_ids);
    const recall = await mock.recall({ query: "derived", limit: 10 });
    assert.equal(recall.total, 2);
});

test("MemWalMock validates caller bulk idempotencyKey and allows valid keys up to 255 bytes", async () => {
    const mock = MemWalMock.create();
    const items = [{ text: "fact 1" }, { text: "fact 2" }];

    // Empty key should reject
    await assert.rejects(
        () => mock.rememberBulk(items, { idempotencyKey: "" }),
        /idempotency_key cannot be empty/,
    );

    // 250-byte key should succeed on mock (matching relayer) despite derived item key being >255 bytes
    const validLongKey = "k".repeat(250);
    const result = await mock.rememberBulk(items, { idempotencyKey: validLongKey });
    assert.equal(result.job_ids.length, 2);

    // > 255-byte key should reject
    await assert.rejects(
        () => mock.rememberBulk(items, { idempotencyKey: "k".repeat(256) }),
        /idempotency_key exceeds maximum length of 255 bytes/,
    );
});

