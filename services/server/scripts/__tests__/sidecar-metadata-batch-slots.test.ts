import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { Server } from "node:http";
import type { Socket } from "node:net";

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const walletKey = new Ed25519Keypair();
process.env.SERVER_SUI_PRIVATE_KEYS = walletKey.getSecretKey();
process.env.SIDECAR_AUTH_TOKEN = "batch-test-token";
process.env.SIDECAR_ROUTE_MODE = "full";
process.env.SUI_NETWORK = "testnet";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;
process.env.WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = "1000";
process.env.WALRUS_UPLOAD_MAX_CONCURRENCY = "2";
process.env.WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = "2";
// Direct-sign so the handler reaches the chain client. The blackhole below
// then holds that call open; a fast local rejection would release any slot
// before the probe could see it.
process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN = "true";
process.env.SIDECAR_ENABLE_LEGACY_SEAL_ABI = "true";

const hungSockets = new Set<Socket>();
const blackhole = net.createServer((socket) => {
    hungSockets.add(socket);
    socket.on("close", () => hungSockets.delete(socket));
    socket.on("error", () => {});
});
const blackholePort = await new Promise<number>((resolve) => {
    blackhole.listen(0, "127.0.0.1", () => {
        const address = blackhole.address();
        assert.ok(address && typeof address !== "string");
        resolve(address.port);
    });
});
process.env.SUI_GRPC_URL = `http://127.0.0.1:${blackholePort}`;

const { acquireWalrusUploadSlots } = await import("../sidecar/concurrency.js");
const { createSidecarApp } = await import("../sidecar/app.js");

function dropHungSockets(): void {
    for (const socket of hungSockets) socket.destroy();
    hungSockets.clear();
}

test.after(() => new Promise<void>((resolve) => {
    if (!blackhole.listening) {
        resolve();
        return;
    }
    blackhole.close(() => resolve());
}));

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

async function waitForChainCall(pending: Promise<Response>): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 800) {
        if (hungSockets.size > 0) return;
        const settled = await Promise.race([
            pending.then(() => true, () => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15)),
        ]);
        if (settled) {
            const response = await pending;
            const body = await response.text();
            assert.fail(`metadata returned ${response.status} before the chain call: ${body}`);
        }
    }
    assert.fail("metadata never reached the chain client");
}

test("set-metadata-batch leaves the upload lane free while the transfer is in flight", async () => {
    const releaseHeldSlot = await acquireWalrusUploadSlots(0, "held-upload");
    const { server, baseUrl } = await listen();
    let releaseProbe: (() => void) | undefined;
    const pending = fetch(`${baseUrl}/walrus/set-metadata-batch`, {
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
    try {
        await waitForChainCall(pending);
        const started = performance.now();
        const probeAbort = new AbortController();
        const probe = acquireWalrusUploadSlots(0, "probe", undefined, { signal: probeAbort.signal });
        const probed = await Promise.race([
            probe.then((release) => ({ release }) as const),
            new Promise<"timeout">((resolve) => {
                setTimeout(() => resolve("timeout"), 250);
            }),
        ]);
        if (probed === "timeout") {
            probeAbort.abort();
            await probe.catch(() => undefined);
            assert.fail("metadata held the upload lane");
        }
        releaseProbe = probed.release;
        const elapsed = performance.now() - started;
        assert.ok(elapsed < 200, `upload lane stayed busy for ${elapsed.toFixed(0)}ms`);
    } finally {
        releaseProbe?.();
        releaseHeldSlot();
        dropHungSockets();
        await Promise.race([
            pending.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        server.closeAllConnections();
        await close(server);
    }
});
