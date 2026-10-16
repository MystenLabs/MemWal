import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const ACCOUNT = "0x1";

test("MemWal.create rejects a missing or wrong-length delegate key", () => {
    assert.throws(
        () => MemWal.create({ accountId: ACCOUNT }),
        /Ed25519 seed must be exactly 32 bytes, got undefined/,
    );
    assert.throws(
        () => MemWal.create({ key: "ab".repeat(40), accountId: ACCOUNT }),
        /Ed25519 seed must be exactly 32 bytes, got 40/,
    );
    assert.throws(
        () => MemWal.create({ key: new Uint8Array(31), accountId: ACCOUNT }),
        /Ed25519 seed must be exactly 32 bytes, got 31/,
    );
    assert.ok(MemWal.create({ key: "11".repeat(32), accountId: ACCOUNT }));
});

test("MemWalManual.create rejects a wrong-length delegate key", () => {
    const base = {
        walletSigner: { address: "0x2", signPersonalMessage: async () => ({ signature: "aa" }) },
        embeddingApiKey: "test-openai-key",
        packageId: "0x1",
        registryId: "0x2",
        accountId: "0x3",
    };
    assert.throws(
        () => MemWalManual.create({ ...base, key: "ab".repeat(40) }),
        /Ed25519 seed must be exactly 32 bytes, got 40/,
    );
    assert.ok(MemWalManual.create({ ...base, key: new Uint8Array(32) }));
});
