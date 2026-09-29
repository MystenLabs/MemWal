import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const walletKey = new Ed25519Keypair();
process.env.SERVER_SUI_PRIVATE_KEYS = walletKey.getSecretKey();
process.env.SIDECAR_AUTH_TOKEN = "batch-test-token";
process.env.SIDECAR_ROUTE_MODE = "full";
process.env.SUI_NETWORK = "testnet";
process.env.SUI_GRPC_URL = "https://batch.testnet.example";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;
// Minimum allowed acquire timeout keeps the slot-timeout test fast.
process.env.WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = "1000";
process.env.WALRUS_UPLOAD_MAX_CONCURRENCY = "2";
process.env.WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = "2";
// This test exercises the migration-only legacy fence path deliberately.
process.env.SIDECAR_ENABLE_LEGACY_SEAL_ABI = "true";

const { acquireWalrusUploadSlots } = await import("../sidecar/concurrency.js");
const { createSidecarApp } = await import("../sidecar/app.js");

async function listen(): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve) => {
        const server = createSidecarApp().listen(0, "127.0.0.1", () => {
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
        });
    });
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

test("set-metadata-batch respects configured address-balance wallet lanes", async () => {
    const releaseHeldSlot1 = await acquireWalrusUploadSlots(0, "test-hold-1");
    const releaseHeldSlot2 = await acquireWalrusUploadSlots(0, "test-hold-2");
    const { server, baseUrl } = await listen();
    try {
        const response = await fetch(`${baseUrl}/walrus/set-metadata-batch`, {
            method: "POST",
            headers: {
                authorization: "Bearer batch-test-token",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                blobs: [{ blobObjectId: "0x1" }],
                owner: `0x${"1".repeat(64)}`,
                keyIndex: 0,
                sealAbi: "v1",
            }),
        });
        // The third request must queue on the same limiter as the durable
        // routes once both configured wallet lanes are occupied.
        assert.equal(response.status, 503);
        const body = (await response.json()) as any;
        assert.match(body.error, /timed out waiting for wallet 0 upload slot/);
        assert.ok(body.traceId);
    } finally {
        releaseHeldSlot1();
        releaseHeldSlot2();
        await close(server);
    }
});
