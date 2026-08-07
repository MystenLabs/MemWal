import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

function client() {
    return MemWal.create({
        key: new Uint8Array(32).fill(1),
        accountId: "0x1",
        serverUrl: "https://relayer.example",
    });
}

function manualClient() {
    return MemWalManual.create({
        key: new Uint8Array(32).fill(1),
        walletSigner: {
            address: "0x2",
            signAndExecuteTransaction: async () => ({ digest: "0xtx" }),
            signPersonalMessage: async () => ({ signature: "sig" }),
        },
        suiClient: {},
        embeddingApiKey: "test",
        packageId: `0x${"33".repeat(32)}`,
        accountId: "0x1",
        registryId: "0xregistry",
        sealServerConfigs: [{ objectId: "0xserver", weight: 1 }],
    });
}

function baseResponse(overrides = {}) {
    return {
        restored: 3,
        skipped: 7,
        total: 10,
        namespace: "demo",
        owner: "0xowner",
        ...overrides,
    };
}

test("MemWal.restore() preserves truncated=true from the relayer response", async () => {
    const memwal = client();
    memwal.signedRequest = async () => baseResponse({ truncated: true });

    const result = await memwal.restore("demo");

    assert.equal(result.truncated, true);
});

test("MemWal.restore() defaults truncated to false when an older relayer omits it", async () => {
    const memwal = client();
    const raw = baseResponse();
    delete raw.truncated;
    memwal.signedRequest = async () => raw;

    const result = await memwal.restore("demo");

    assert.equal(result.truncated, false);
});

test("MemWalManual.restore() preserves truncated=true from the relayer response", async () => {
    const manual = manualClient();
    manual.signedRequest = async () => baseResponse({ truncated: true });

    const result = await manual.restore("demo");

    assert.equal(result.truncated, true);
});

test("MemWalManual.restore() defaults truncated to false when an older relayer omits it", async () => {
    const manual = manualClient();
    const raw = baseResponse();
    delete raw.truncated;
    manual.signedRequest = async () => raw;

    const result = await manual.restore("demo");

    assert.equal(result.truncated, false);
});
