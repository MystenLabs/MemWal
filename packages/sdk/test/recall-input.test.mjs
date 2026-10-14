import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function client() {
    return MemWal.create({
        key: "11".repeat(32),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

test("recall rejects a blank query, a bad limit, and a non-finite weight before signing", async () => {
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        return new Response("");
    };

    await assert.rejects(() => client().recall({ query: "" }), {
        name: "Error",
        message: "query cannot be empty",
    });
    await assert.rejects(() => client().recall({ query: "coffee", limit: NaN }), {
        name: "TypeError",
        message: "limit must be a positive integer, got NaN",
    });
    await assert.rejects(() => client().recall({ query: "coffee", limit: -3 }), {
        name: "TypeError",
        message: "limit must be a positive integer, got -3",
    });
    await assert.rejects(
        () => client().recall({ query: "coffee", scoringWeights: { semantic: NaN } }),
        {
            name: "Error",
            message: "scoringWeights.semantic must be a finite number",
        },
    );
    assert.equal(called, false);
});
