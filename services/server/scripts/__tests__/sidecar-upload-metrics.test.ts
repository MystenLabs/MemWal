import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
process.env.SERVER_SUI_PRIVATE_KEYS = new Ed25519Keypair().getSecretKey();
process.env.SIDECAR_AUTH_TOKEN = "upload-metrics-test-token";
process.env.SUI_NETWORK = "testnet";
process.env.SUI_GRPC_URL = "https://upload-metrics.testnet.example";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;
process.env.WALRUS_UPLOAD_MAX_CONCURRENCY = "4";
process.env.WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = "1";
process.env.WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = "30000";

const { getWalrusClient, suiClient } = await import("../sidecar/clients.js");
let dependencyCalls = 0;
(suiClient.ledgerService as any).getServiceInfo = async () => {
    dependencyCalls += 1;
    throw new Error("upload metrics must not call Sui");
};
(getWalrusClient() as any).getBlobType = async () => {
    dependencyCalls += 1;
    throw new Error("upload metrics must not call Walrus");
};
const { acquireWalrusUploadSlots } = await import("../sidecar/concurrency.js");
const { createSidecarApp } = await import("../sidecar/app.js");

async function listen(mode: "full" | "writer"): Promise<{ server: Server; baseUrl: string }> {
    return new Promise((resolve) => {
        const server = createSidecarApp(mode).listen(0, "127.0.0.1", () => {
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

for (const mode of ["full", "writer"] as const) {
    test(`${mode} mode: /metrics/uploads reports live queue counters without a token`, async () => {
        const { server, baseUrl } = await listen(mode);
        // Wallet 0 has one slot: the first upload runs, the second waits in the queue.
        const releaseRunning = await acquireWalrusUploadSlots(0, "running-upload");
        const queuedUpload = acquireWalrusUploadSlots(0, "queued-upload");
        try {
            const res = await fetch(`${baseUrl}/metrics/uploads`);
            assert.equal(res.status, 200);
            assert.deepEqual(await res.json(), {
                activeWalrusUploads: 1,
                queuedWalrusUploads: 1,
                walrusUploadLimits: {
                    globalCapacity: 4,
                    perWalletCapacity: 1,
                    acquireTimeoutMs: 30000,
                },
            });
            assert.equal(dependencyCalls, 0);
        } finally {
            releaseRunning();
            (await queuedUpload)();
            await close(server);
        }
    });
}
