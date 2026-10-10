import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

// GH #1038: recall(query, options, namespace) type-checks, but the options
// object used to replace the whole call and drop the namespace argument.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubRecall() {
    const sent = {};
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
        if (path === "/api/recall" && init.method === "POST") {
            sent.body = JSON.parse(init.body);
            return Response.json({ results: [], total: 0 });
        }
        throw new Error(`unexpected request ${path}`);
    };
    return sent;
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

test("recall(query, options, namespace) sends the positional namespace", async () => {
    const sent = stubRecall();
    await client().recall("q", { limit: 5 }, "profile");
    assert.equal(sent.body.namespace, "profile");
    assert.equal(sent.body.limit, 5);
});

test("recall(query, options, namespace) keeps an explicit options.namespace", async () => {
    const sent = stubRecall();
    await client().recall("q", { limit: 5, namespace: "from-options" }, "profile");
    assert.equal(sent.body.namespace, "from-options");
});

test("recall(query, limit, namespace) still sends the positional namespace", async () => {
    const sent = stubRecall();
    await client().recall("q", 5, "profile");
    assert.equal(sent.body.namespace, "profile");
    assert.equal(sent.body.limit, 5);
});
