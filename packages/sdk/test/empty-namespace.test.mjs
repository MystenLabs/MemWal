import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const KEY = "11".repeat(32);

test("MemWal.create rejects an empty namespace and still defaults when omitted", () => {
    assert.throws(
        () => MemWal.create({ key: KEY, accountId: "0x1", namespace: "" }),
        /namespace cannot be empty/,
    );
    assert.ok(MemWal.create({ key: KEY, accountId: "0x1" }));
});

test("MemWalManual.create rejects an empty namespace and still defaults when omitted", () => {
    const base = {
        key: KEY,
        walletSigner: { address: "0x2", signPersonalMessage: async () => ({ signature: "aa" }) },
        embeddingApiKey: "test-openai-key",
        packageId: "0x1",
        registryId: "0x2",
        accountId: "0x3",
    };
    assert.throws(
        () => MemWalManual.create({ ...base, namespace: "" }),
        /namespace cannot be empty/,
    );
    assert.ok(MemWalManual.create(base));
});
