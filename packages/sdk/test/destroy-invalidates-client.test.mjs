import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";

test("a request in flight when destroy() lands is rejected, not signed with a zeroed key", async () => {
    const originalFetch = globalThis.fetch;
    let releaseVersion;
    const versionGate = new Promise((resolve) => {
        releaseVersion = resolve;
    });

    globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        if (path === "/version") {
            await versionGate;
            return Response.json({
                apiVersion: "1.0.0",
                relayerVersion: "1.0.0",
                minSupportedSdk: { typescript: "0.0.4" },
            });
        }
        throw new Error(`a wiped client still signed and sent ${path}`);
    };

    try {
        const client = MemWal.create({
            key: new Uint8Array(32).fill(1),
            accountId: "0x1",
            serverUrl: "https://relayer.example",
        });
        client.buildSealSession = async () => "test-session";

        const pending = client.recall({ query: "anything" });
        await new Promise((resolve) => setImmediate(resolve));
        client.destroy();
        releaseVersion();

        await assert.rejects(pending, /Walrus Memory client was destroyed/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
