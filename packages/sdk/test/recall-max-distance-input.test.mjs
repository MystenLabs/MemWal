import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalMock } from "../dist/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("NaN or a negative maxDistance is rejected instead of looking empty", async () => {
    const mock = MemWalMock.create();
    await mock.remember("User likes coffee");
    const message = "maxDistance must be a non-negative finite number";
    await assert.rejects(() => mock.recall({ query: "coffee", maxDistance: NaN }), {
        name: "Error",
        message,
    });
    await assert.rejects(() => mock.recall({ query: "coffee", maxDistance: -1 }), {
        name: "Error",
        message,
    });
    const kept = await mock.recall({ query: "coffee", maxDistance: 0.9 });
    assert.equal(kept.results.length > 0, true);

    let called = false;
    globalThis.fetch = async () => {
        called = true;
        return new Response("");
    };
    const real = MemWal.create({
        key: "11".repeat(32),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    await assert.rejects(() => real.recall({ query: "coffee", maxDistance: NaN }), {
        name: "Error",
        message,
    });
    await assert.rejects(() => real.recall({ query: "coffee", maxDistance: -1 }), {
        name: "Error",
        message,
    });
    assert.equal(called, false);
});
