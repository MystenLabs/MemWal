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

test("MemWal.recall() rejects non-positive or non-integer limit before signing", async () => {
    const memwal = client();
    let requests = 0;
    memwal.signedRequest = async () => {
        requests += 1;
        return { results: [], total: 0 };
    };

    const invalidLimits = [0, -1, 2.5, NaN, -0, "5", null];
    for (const bad of invalidLimits) {
        await assert.rejects(
            () => memwal.recall({ query: "user", limit: bad }),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
        await assert.rejects(
            () => memwal.recall({ query: "user", topK: bad }),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }

    const invalidPositionalLimits = [0, -1, 2.5, NaN, -0];
    for (const bad of invalidPositionalLimits) {
        await assert.rejects(
            () => memwal.recall("user", bad),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }
    assert.equal(requests, 0);
});

test("MemWal.recallManual() rejects non-positive or non-integer limit before signing", async () => {
    const memwal = client();
    let requests = 0;
    memwal.signedRequest = async () => {
        requests += 1;
        return { results: [], total: 0 };
    };

    const invalidLimits = [0, -1, 2.5, NaN, "10", null];
    for (const bad of invalidLimits) {
        await assert.rejects(
            () => memwal.recallManual({ vector: [0.1, 0.2], limit: bad }),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }
    assert.equal(requests, 0);
});

test("MemWal.restore() rejects non-positive or non-integer limit before signing", async () => {
    const memwal = client();
    let requests = 0;
    memwal.signedRequest = async () => {
        requests += 1;
        return { restored: 0, skipped: 0, total: 0, failed: 0, namespace: "demo", owner: "0x1" };
    };

    const invalidLimits = [0, -1, 2.5, NaN, "10", null];
    for (const bad of invalidLimits) {
        await assert.rejects(
            () => memwal.restore("demo", bad),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }
    assert.equal(requests, 0);
});

test("MemWalManual.recallManual() rejects non-positive or non-integer limit before signing", async () => {
    const manual = manualClient();
    let requests = 0;
    manual.signedRequest = async () => {
        requests += 1;
        return { results: [], total: 0 };
    };
    manual.embed = async () => [0.1, 0.2];

    const invalidLimits = [0, -1, 2.5, NaN, "5", null];
    for (const bad of invalidLimits) {
        await assert.rejects(
            () => manual.recallManual("query", { limit: bad }),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }

    const invalidPositionalLimits = [0, -1, 2.5, NaN];
    for (const bad of invalidPositionalLimits) {
        await assert.rejects(
            () => manual.recallManual("query", bad),
            {
                name: "TypeError",
                message: /limit must be a positive integer/,
            },
        );
    }
    assert.equal(requests, 0);
});
