import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const VALID_KEY = "01".repeat(32);
const VALID_ACCOUNT_ID = `0x${"02".repeat(32)}`;

test("MemWal.create throws TypeError when accountId is missing or undefined", () => {
    assert.throws(
        () => MemWal.create({ key: VALID_KEY }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: VALID_KEY, accountId: undefined }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );
});

test("MemWal.create throws TypeError when accountId is empty, whitespace-only, or not a string", () => {
    assert.throws(
        () => MemWal.create({ key: VALID_KEY, accountId: "" }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: VALID_KEY, accountId: "   " }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: VALID_KEY, accountId: 12345 }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );
});

test("MemWal.create succeeds when valid accountId is provided", () => {
    const client = MemWal.create({
        key: VALID_KEY,
        accountId: VALID_ACCOUNT_ID,
    });
    assert.ok(client);
});

test("MemWalManual.create throws TypeError when accountId is missing or empty", () => {
    const manualConfigBase = {
        key: VALID_KEY,
        suiPrivateKey: "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0g24m4",
        embeddingApiKey: "test-openai-key",
        packageId: `0x${"03".repeat(32)}`,
        registryId: `0x${"04".repeat(32)}`,
    };

    assert.throws(
        () => MemWalManual.create({ ...manualConfigBase, accountId: undefined }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );

    assert.throws(
        () => MemWalManual.create({ ...manualConfigBase, accountId: "" }),
        (err) => err instanceof TypeError && err.message.includes('"accountId" is required'),
    );
});
