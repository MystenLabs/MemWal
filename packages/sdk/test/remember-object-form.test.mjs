import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("rememberAndWait rejects an object instead of sending it as text", async () => {
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        return new Response("");
    };
    const client = MemWal.create({
        key: "11".repeat(32),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
    await assert.rejects(
        () => client.rememberAndWait({ text: "object form probe", namespace: "ns" }),
        (err) => err instanceof TypeError && /expects text as a string/.test(err.message),
    );
    assert.equal(called, false);
});
