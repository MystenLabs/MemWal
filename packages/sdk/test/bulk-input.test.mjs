import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalMock } from "../dist/index.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("a null bulk item is a named validation error, not a TypeError", async () => {
    const mock = MemWalMock.create();
    await assert.rejects(() => mock.rememberBulkAsync([null]), {
        name: "Error",
        message: "items[0].text cannot be empty",
    });

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
    await assert.rejects(() => real.rememberBulkAsync([null]), {
        name: "Error",
        message: "items[0].text cannot be empty",
    });
    assert.equal(called, false);
});

test("getRememberBulkStatus rejects a non-array before reading it", async () => {
    const mock = MemWalMock.create();
    await assert.rejects(() => mock.getRememberBulkStatus("not-an-array"), {
        name: "Error",
        message: "getRememberBulkStatus: jobIds must be an array",
    });
    await assert.rejects(() => mock.getRememberBulkStatus(null), {
        name: "Error",
        message: "getRememberBulkStatus: jobIds must be an array",
    });

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
    await assert.rejects(() => real.getRememberBulkStatus("not-an-array"), {
        name: "Error",
        message: "getRememberBulkStatus: jobIds must be an array",
    });
    assert.equal(called, false);
});
