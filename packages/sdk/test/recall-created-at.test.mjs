import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

// WALM-383: a caller implementing "newest wins" needs the write-time of each
// memory as a structured field, and needs to be able to ask the relayer's
// composite ranker for a recency-weighted order in the first place. Both were
// unreachable from `recall()` — the ranker existed server-side but only the
// manual (bring-your-own-embedding) paths ever sent `scoring_weights`.

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** Stub the relayer, recording the body of the /api/recall POST. */
function stubRecall(hits) {
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

// ── created_at passthrough ───────────────────────────────────

test("recall surfaces the relayer's created_at on each memory", async () => {
    stubRecall([
        {
            blob_id: "blob-new",
            text: "checkpoint: shipped the ranker",
            distance: 0.4,
            created_at: "2026-07-06T12:00:00Z",
        },
    ]);

    const result = await client().recall({ query: "checkpoint" });

    assert.equal(result.results[0].created_at, "2026-07-06T12:00:00Z");
});

test("recall lets a caller order by created_at when distance disagrees", async () => {
    // The exact failure from the ticket: the newest record is the WORSE
    // semantic match, so it arrives last. A newest-wins caller must still be
    // able to pick it out.
    stubRecall([
        {
            blob_id: "blob-old",
            text: "current task checkpoint goal status",
            distance: 0.1,
            created_at: "2026-07-01T00:00:00Z",
        },
        {
            blob_id: "blob-new",
            text: "wrapped up the migration yesterday",
            distance: 0.5,
            created_at: "2026-07-06T00:00:00Z",
        },
    ]);

    const { results } = await client().recall({ query: "current task checkpoint goal status" });
    const newest = [...results].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0];

    assert.equal(newest.blob_id, "blob-new");
});

test("recall tolerates a relayer that omits created_at", async () => {
    // Older relayers won't send the field. It must come back undefined rather
    // than throwing, so the SDK stays forward/backward compatible.
    stubRecall([{ blob_id: "blob-1", text: "no timestamp here", distance: 0.2 }]);

    const { results } = await client().recall({ query: "anything" });

    assert.equal(results[0].created_at, undefined);
    assert.equal(results[0].blob_id, "blob-1");
});

// ── scoringWeights reach the relayer ─────────────────────────

test("recall sends scoringWeights as snake_case scoring_weights", async () => {
    const sent = stubRecall([]);

    await client().recall({
        query: "checkpoint",
        scoringWeights: { semantic: 0.3, recency: 0.7, recencyHalfLifeDays: 30 },
    });

    // `importance` was not supplied, so it is absent from the wire object
    // rather than sent as null — the relayer's `#[serde(default)]` then
    // supplies its own default instead of being handed one by the client.
    assert.deepEqual(sent.body.scoring_weights, {
        semantic: 0.3,
        recency: 0.7,
        recency_half_life_days: 30,
    });
});

test("recall omits scoring_weights entirely when no weights are given", async () => {
    // Default-weighted recalls must stay byte-identical on the wire, so the
    // relayer keeps short-circuiting to the plain pgvector cosine order.
    const sent = stubRecall([]);

    await client().recall({ query: "checkpoint" });

    assert.equal("scoring_weights" in sent.body, false);
});

test("positional recall(query, limit, namespace) still omits scoring_weights", async () => {
    const sent = stubRecall([]);

    await client().recall("checkpoint", 5, "profile");

    assert.equal("scoring_weights" in sent.body, false);
    assert.equal(sent.body.limit, 5);
    assert.equal(sent.body.namespace, "profile");
});
