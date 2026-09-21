import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

// A recall that runs out of time used to abort here with nothing to say why:
// "This operation was aborted", or later "request timed out after 15000ms".
// Only the relayer knows which step was stuck, and it can only answer before
// the caller gives up if it knows when that is. So recall sends its deadline,
// and the relayer answers a 504 naming the stage just short of it (WALM-396).

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubRecall(answer) {
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
            return answer();
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

test("recall tells the relayer how long it will wait", async () => {
    const sent = stubRecall(() => Response.json({ results: [], total: 0 }));

    await client().recall({ query: "current task" });

    // A second under the 15s the request is aborted at. The relayer counts its
    // own margin from arrival, so without this gap a slow connect would leave
    // the 504 landing after the abort it is meant to beat.
    assert.equal(sent.body.deadline_ms, 14_000);
});

test("a relayer recall timeout reaches the caller with its code and stage", async () => {
    const body = {
        error: "Recall timed out after 14001ms during walrus_download",
        message: "Recall timed out after 14001ms during walrus_download",
        code: "RECALL_TIMEOUT",
        stage: "walrus_download",
        elapsed_ms: 14001,
    };
    stubRecall(() => Response.json(body, { status: 504 }));

    await assert.rejects(client().recall({ query: "current task" }), (err) => {
        assert.equal(err.status, 504);
        assert.equal(err.serverCode, "RECALL_TIMEOUT");
        assert.match(err.message, /walrus_download/);
        // The MCP sidecar reads the stage off the raw body.
        assert.equal(JSON.parse(err.cause).stage, "walrus_download");
        return true;
    });
});
