import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

// recall({ maxDistance }) on the real client path (GH #968): hits at or past
// the cutoff are dropped, hits inside it are kept, and omitting the option
// returns every hit the relayer sent, however distant.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

// Stub the relayer so /api/recall returns a fixed set of hits.
function stubRecall(hits) {
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
            return Response.json({ results: hits, total: hits.length });
        }
        throw new Error(`unexpected request ${path}`);
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

// Shaped like the #968 report: one real hit, then filler at >= 0.75.
const hits = [
    { blob_id: "meds", text: "mom takes lisinopril", distance: 0.54 },
    { blob_id: "pharmacy", text: "pharmacy on 5th street", distance: 0.75 },
    { blob_id: "weather", text: "likes rainy days", distance: 0.92 },
];

test("recall with maxDistance keeps hits inside the cutoff and drops the rest", async () => {
    stubRecall(hits);
    const result = await client().recall({ query: "meds", maxDistance: 0.7 });
    assert.deepEqual(result.results.map((h) => h.blob_id), ["meds"]);
    assert.equal(result.total, 1);
});

test("recall with maxDistance drops a hit exactly at the cutoff", async () => {
    stubRecall(hits);
    const result = await client().recall({ query: "meds", maxDistance: 0.75 });
    assert.deepEqual(result.results.map((h) => h.blob_id), ["meds"]);
});

test("recall with maxDistance can return nothing", async () => {
    stubRecall(hits);
    const result = await client().recall({ query: "weather?", maxDistance: 0.5 });
    assert.deepEqual(result.results, []);
    assert.equal(result.total, 0);
});

test("recall without maxDistance returns every hit, including distant ones", async () => {
    stubRecall(hits);
    const result = await client().recall({ query: "meds" });
    assert.deepEqual(result, { results: hits, total: hits.length });
});

test("positional recall(query, { maxDistance }) applies the same cutoff", async () => {
    stubRecall(hits);
    const result = await client().recall("meds", { maxDistance: 0.8 });
    assert.deepEqual(result.results.map((h) => h.blob_id), ["meds", "pharmacy"]);
});
