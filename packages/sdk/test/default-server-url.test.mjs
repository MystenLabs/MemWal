import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { MemWalManual } from "../dist/manual.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("MemWal defaults serverUrl to official mainnet relayer URL", async () => {
    let requestedUrl = null;
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return Response.json({ status: "ok" });
    };

    const client = MemWal.create({
        key: "01".repeat(32),
        accountId: `0x${"02".repeat(32)}`,
    });

    await client.health();
    assert.equal(requestedUrl, "https://relayer.memory.walrus.xyz/health");
});

test("MemWalManual defaults serverUrl to official mainnet relayer URL", async () => {
    let requestedUrl = null;
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return Response.json({
            apiVersion: "1.0.0",
            relayerVersion: "1.0.0",
            minSupportedSdk: { typescript: "0.0.4" },
        });
    };

    const manual = MemWalManual.create({
        key: "01".repeat(32),
        suiPrivateKey: "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0g24m4",
        embeddingApiKey: "test-openai-key",
        packageId: `0x${"03".repeat(32)}`,
        registryId: `0x${"04".repeat(32)}`,
        accountId: `0x${"02".repeat(32)}`,
    });

    await manual.compatibility();
    assert.equal(requestedUrl, "https://relayer.memory.walrus.xyz/version");
});
