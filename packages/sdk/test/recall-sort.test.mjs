import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MemWal } from "../dist/memwal.js";

// `sort: "recent"` is the half of WALM-383 that `scoringWeights` cannot do.
// Weights re-rank the rows the vector search already returned; `sort` changes
// how many rows are fetched, which is what lets a newest-but-loosely-worded
// record beat a closer-worded older one.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubRecall(hits = []) {
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
            return Response.json({ results: hits, total: hits.length });
        }
        throw new Error(`unexpected request ${path}`);
    };
    return sent;
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

test("recall forwards sort to the relayer", async () => {
    const sent = stubRecall();

    await client().recall({ query: "current task", sort: "recent" });

    assert.equal(sent.body.sort, "recent");
});

test("recall omits sort entirely when unset", async () => {
    // The relayer defaults to relevance. Sending nothing keeps the request
    // byte-identical for every existing caller.
    const sent = stubRecall();

    await client().recall({ query: "current task" });

    assert.equal("sort" in sent.body, false);
});

test("recall forwards an explicit relevance sort", async () => {
    // Explicitly asking for today's behaviour must still be expressible —
    // a caller may want it pinned rather than inherited from the default.
    const sent = stubRecall();

    await client().recall({ query: "current task", sort: "relevance" });

    assert.equal(sent.body.sort, "relevance");
});

test("sort and scoringWeights can be sent together", async () => {
    // Selection and re-ranking are separate stages server-side, so the two
    // are not mutually exclusive on the wire.
    const sent = stubRecall();

    await client().recall({
        query: "current task",
        sort: "recent",
        scoringWeights: { semantic: 0.5, recency: 0.5 },
    });

    assert.equal(sent.body.sort, "recent");
    assert.equal(sent.body.scoring_weights.recency, 0.5);
});

test("RecallOptions declares sort as a two-value union", () => {
    // A .mjs test cannot catch a missing type; assert on the emitted .d.ts,
    // which is what a TypeScript consumer actually resolves.
    const dts = readFileSync(
        fileURLToPath(new URL("../dist/types.d.ts", import.meta.url)),
        "utf8",
    );

    assert.match(dts, /sort\?: "relevance" \| "recent";/);
});
