import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const VALID_KEY_HEX = "11".repeat(32);
const VALID_KEY_BYTES = new Uint8Array(32).fill(1);
const VALID_ACCOUNT_ID = "0x123";

test("MemWal.create throws TypeError when key is missing or undefined", () => {
    assert.throws(
        () => MemWal.create({ accountId: VALID_ACCOUNT_ID }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: undefined, accountId: VALID_ACCOUNT_ID }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: null, accountId: VALID_ACCOUNT_ID }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );
});

test("MemWal.create throws TypeError when key is not a string or Uint8Array", () => {
    assert.throws(
        () => MemWal.create({ key: 12345, accountId: VALID_ACCOUNT_ID }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );

    assert.throws(
        () => MemWal.create({ key: {}, accountId: VALID_ACCOUNT_ID }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );
});

test("MemWal.create accepts valid hex string and Uint8Array keys", () => {
    const clientHex = MemWal.create({ key: VALID_KEY_HEX, accountId: VALID_ACCOUNT_ID });
    assert.ok(clientHex);

    const clientBytes = MemWal.create({ key: VALID_KEY_BYTES, accountId: VALID_ACCOUNT_ID });
    assert.ok(clientBytes);
});

test("MemWalManual.create throws TypeError when key is missing, undefined, or null", () => {
    const manualConfigBase = {
        suiPrivateKey: "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0g24m4",
        embeddingApiKey: "test-openai-key",
        packageId: "0x1",
        registryId: "0x2",
        accountId: "0x3",
    };

    assert.throws(
        () => MemWalManual.create({ ...manualConfigBase }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );

    assert.throws(
        () => MemWalManual.create({ ...manualConfigBase, key: undefined }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );

    assert.throws(
        () => MemWalManual.create({ ...manualConfigBase, key: null }),
        (err) => err instanceof TypeError && err.message.includes('"key" is required'),
    );
});
