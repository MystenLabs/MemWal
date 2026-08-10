import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const writerKey = new Ed25519Keypair();
process.env.SERVER_SUI_PRIVATE_KEYS = writerKey.getSecretKey();
process.env.SIDECAR_AUTH_TOKEN = "writer-test-token";
process.env.SIDECAR_ROUTE_MODE = "writer";
process.env.SUI_NETWORK = "testnet";
process.env.SUI_GRPC_URL = "https://writer.testnet.example";
process.env.WALRUS_PACKAGE_ID = `0x${"a".repeat(64)}`;
// The legacy-fence assertions below model a dedicated migration writer.
process.env.SIDECAR_ENABLE_LEGACY_SEAL_ABI = "true";

const { getWalrusClient, suiClient } = await import("../sidecar/clients.js");
const { DURABLE_UPLOAD_PROTOCOL_VERSION, WALRUS_UPLOAD_MAX_CONCURRENCY, WALRUS_UPLOAD_PER_WALLET_CONCURRENCY } =
    await import("../sidecar/config.js");
const testnetChainId = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";
const walCoinType = `0x${"c".repeat(64)}::wal::WAL`;
let reportedChainId = testnetChainId;
let reportedBlobType = `0x${"b".repeat(64)}::blob::Blob`;
let serviceInfoCalls = 0;
let balanceLookupFails = false;
(suiClient.ledgerService as any).getServiceInfo = async () => {
    serviceInfoCalls += 1;
    return {
        response: { chainId: reportedChainId, chain: "diagnostic-label" },
    } as any;
};
(getWalrusClient() as any).getBlobType = async () => reportedBlobType;
(suiClient.movePackageService as any).getFunction = async () => ({
    response: {
        function: {
            parameters: [
                {},
                {
                    body: {
                        typeParameterInstantiation: [{ typeName: walCoinType }],
                    },
                },
            ],
        },
    },
});
(suiClient.stateService as any).listBalances = async () => {
    if (balanceLookupFails) throw new Error("balance RPC unavailable");
    return {
        response: {
            balances: [
                {
                    coinType: `0x${"0".repeat(63)}2::sui::SUI`,
                    balance: 1_230_000_000n,
                    addressBalance: 1_200_000_000n,
                    coinBalance: 30_000_000n,
                },
                {
                    coinType: walCoinType,
                    balance: 4_560_000_000n,
                    addressBalance: 4_500_000_000n,
                    coinBalance: 60_000_000n,
                },
                {
                    coinType: `0x${"d".repeat(64)}::wal::WAL`,
                    balance: 9_999_000_000n,
                },
            ],
        },
    };
};
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

test("writer mode exposes only durable writer and observability routes", async () => {
    const { server, baseUrl } = await listen();
    const headers = {
        authorization: "Bearer writer-test-token",
        "content-type": "application/json",
    };
    try {
        assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
        assert.equal(serviceInfoCalls, 0, "liveness must not call dependencies");
        assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
        reportedBlobType = `${process.env.WALRUS_PACKAGE_ID}::blob::Blob`;
        reportedChainId = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
        assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
        reportedChainId = testnetChainId;
        const ready = await fetch(`${baseUrl}/ready`);
        assert.equal(ready.status, 200);
        const readyBody = await ready.json();
        assert.equal(readyBody.suiNetwork, "testnet");
        assert.equal(readyBody.uploadProtocolVersion, DURABLE_UPLOAD_PROTOCOL_VERSION);
        assert.equal(readyBody.durableUploadDirectSign, true);
        assert.equal(readyBody.durableUploadAddressBalance, true);
        assert.deepEqual(readyBody.uploadExecutionIdentity, {
            chainIdentifier: testnetChainId,
            walrusPackageId: `0x${"a".repeat(64)}`,
        });
        assert.deepEqual(readyBody.sealCommitteeIdentity, {
            servers: [
                {
                    objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
                    weight: 1,
                },
                {
                    objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
                    weight: 1,
                },
            ],
            threshold: 2,
        });
        assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
        assert.equal(serviceInfoCalls, 3, "successful execution identity should be cached");
        const walletMetricsResponse = await fetch(`${baseUrl}/metrics/wallet`);
        assert.equal(walletMetricsResponse.status, 200);
        const walletMetrics = (await walletMetricsResponse.json()) as Record<string, unknown>;
        const uploadLimits = walletMetrics.walrusUploadLimits as Record<string, unknown>;
        assert.equal(walletMetrics.activeWalrusUploads, 0);
        assert.equal(walletMetrics.queuedWalrusUploads, 0);
        assert.equal(walletMetrics.walletSuiBalanceMist, "1230000000");
        assert.equal(walletMetrics.walletSuiAddressBalanceMist, "1200000000");
        assert.equal(walletMetrics.walletSuiCoinBalanceMist, "30000000");
        assert.equal(walletMetrics.walletSuiAddressFundedCount, 1);
        assert.equal(walletMetrics.walletWalBalanceFrost, "4560000000");
        assert.equal(walletMetrics.walletWalAddressBalanceFrost, "4500000000");
        assert.equal(walletMetrics.walletWalCoinBalanceFrost, "60000000");
        assert.equal(walletMetrics.walletWalAddressFundedCount, 1);
        assert.equal(walletMetrics.perWallet, undefined);
        assert.equal((await fetch(`${baseUrl}/internal/wallet-balances`)).status, 401);
        const internalWalletsResponse = await fetch(`${baseUrl}/internal/wallet-balances`, {
            headers,
        });
        assert.equal(internalWalletsResponse.status, 200);
        assert.deepEqual(await internalWalletsResponse.json(), {
            perWallet: [
                {
                    address: writerKey.toSuiAddress(),
                    suiMist: "1230000000",
                    walFrost: "4560000000",
                },
            ],
        });
        assert.equal(uploadLimits.globalCapacity, WALRUS_UPLOAD_MAX_CONCURRENCY);
        assert.equal(uploadLimits.perWalletCapacity, WALRUS_UPLOAD_PER_WALLET_CONCURRENCY);
        balanceLookupFails = true;
        const degradedMetrics = (await (await fetch(`${baseUrl}/metrics/wallet`)).json()) as any;
        assert.equal(degradedMetrics.activeWalrusUploads, 0);
        assert.equal(degradedMetrics.walletSuiBalanceMist, undefined);
        assert.equal(degradedMetrics.walletWalBalanceFrost, undefined);
        assert.equal(degradedMetrics.perWallet, undefined);
        assert.equal(
            (await fetch(`${baseUrl}/internal/wallet-balances`, { headers })).status,
            503,
        );
        balanceLookupFails = false;
        assert.equal(
            (
                await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers,
            body: "{}",
                })
            ).status,
            400
        );
        assert.equal(
            (
                await fetch(`${baseUrl}/walrus/upload-step`, {
            method: "POST",
            headers,
            body: "{}",
                })
            ).status,
            404
        );
        assert.equal(
            (
                await fetch(`${baseUrl}/walrus/set-metadata`, {
            method: "POST",
            headers,
            body: "{}",
                })
            ).status,
            400
        );
        const legacyMetadata = await fetch(`${baseUrl}/walrus/set-metadata`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                blobObjectId: "0x1",
                owner: `0x${"1".repeat(64)}`,
                keyIndex: 0,
            }),
        });
        assert.equal(legacyMetadata.status, 400);
        assert.match((await legacyMetadata.json()).error, /Missing required durable fields: jobId, walletAddress/);

        for (const path of [
            "/walrus/upload",
            "/walrus/set-metadata-batch",
            "/walrus/query-blobs",
            "/seal/encrypt",
            "/sponsor",
            "/sponsor/execute",
        ]) {
            assert.equal(
                (
                    await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers,
                body: "{}",
                    })
                ).status,
                404,
                path
            );
        }
        assert.equal((await fetch(`${baseUrl}/mcp/sse`, { headers })).status, 404);
    } finally {
        await close(server);
    }
});

test("durable upload route rejects epochs outside its journal contract", async () => {
    const { server, baseUrl } = await listen();
    try {
        const response = await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers: {
                authorization: "Bearer writer-test-token",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                data: Buffer.from("ciphertext").toString("base64"),
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                epochs: 16,
                resumeStep: {
                    step: "encoded",
                    blobId: "blob-id",
                    rootHash: "root-hash",
                    unencodedSize: 10,
                },
            }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /expected an integer from 1 to 15/);
    } finally {
        await close(server);
    }
});

test("durable upload route rejects a malformed resumeStep as a 400 validation error", async () => {
    const { server, baseUrl } = await listen();
    try {
        const response = await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers: {
                authorization: "Bearer writer-test-token",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                data: Buffer.from("ciphertext").toString("base64"),
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                resumeStep: { step: "bogus", blobId: "blob-id" },
            }),
        });
        // Malformed journal input is a caller bug, not an ambiguous durable
        // phase — it must not surface as a protocol-ambiguous 500.
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /Invalid resumeStep\.step: bogus/);
    } finally {
        await close(server);
    }
});

test("durable upload route quarantines a certified Blob id mismatch", async () => {
    const getObject = (suiClient as any).getObject;
    (suiClient as any).getObject = async () => ({
        object: { json: { blob_id: "different-blob" } },
    });
    const { server, baseUrl } = await listen();
    try {
        const response = await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers: {
                authorization: "Bearer writer-test-token",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                data: Buffer.from("ciphertext").toString("base64"),
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadExecutionIdentity: {
                    chainIdentifier: testnetChainId,
                    walrusPackageId: process.env.WALRUS_PACKAGE_ID,
                },
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                resumeStep: {
                    step: "registered",
                    blobId: "expected-blob",
                    blobObjectId: `0x${"1".repeat(64)}`,
                    txDigest: "registration-digest",
                },
            }),
        });
        assert.equal(response.status, 422);
        assert.equal((await response.json()).code, "DURABLE_SIDE_EFFECT_VERIFY_FAILED");
    } finally {
        (suiClient as any).getObject = getObject;
        await close(server);
    }
});

test("durable upload route rejects a mismatched protocol before dependency calls", async () => {
    const { server, baseUrl } = await listen();
    try {
        const callsBefore = serviceInfoCalls;
        const response = await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers: {
                authorization: "Bearer writer-test-token",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                data: Buffer.from("ciphertext").toString("base64"),
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION - 1,
                resumeStep: {
                    step: "encoded",
                    blobId: "blob-id",
                    rootHash: "root-hash",
                    unencodedSize: 10,
                },
            }),
        });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.code, "UPLOAD_PROTOCOL_VERSION_MISMATCH");
        assert.equal(body.expectedUploadProtocolVersion, DURABLE_UPLOAD_PROTOCOL_VERSION);
        assert.equal(serviceInfoCalls, callsBefore);
    } finally {
        await close(server);
    }
});

test("durable writer routes reject a drifted execution identity before submission", async () => {
    reportedChainId = testnetChainId;
    reportedBlobType = `${process.env.WALRUS_PACKAGE_ID}::blob::Blob`;
    const { server, baseUrl } = await listen();
    const headers = {
        authorization: "Bearer writer-test-token",
        "content-type": "application/json",
    };
    const uploadExecutionIdentity = {
        chainIdentifier: "wrong-chain",
        walrusPackageId: process.env.WALRUS_PACKAGE_ID,
    };
    try {
        const upload = await fetch(`${baseUrl}/walrus/upload-step-v3`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                data: Buffer.from("ciphertext").toString("base64"),
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadExecutionIdentity,
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                resumeStep: {
                    step: "encoded",
                    blobId: "blob-id",
                    rootHash: "root-hash",
                    unencodedSize: 10,
                },
            }),
        });
        assert.equal(upload.status, 503);
        const uploadBody = (await upload.json()) as any;
        assert.equal(uploadBody.code, "NO_SIDE_EFFECT");
        assert.equal(uploadBody.causeCode, "SHARED_SERVICE_UNAVAILABLE");

        const metadata = await fetch(`${baseUrl}/walrus/set-metadata`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                blobObjectId: "0x1",
                owner: `0x${"1".repeat(64)}`,
                keyIndex: 0,
                jobId: "legacy-entry-id",
                walletAddress: writerKey.toSuiAddress(),
                uploadExecutionIdentity,
                sealAbi: "v1",
            }),
        });
        assert.equal(metadata.status, 503);
        const metadataBody = (await metadata.json()) as any;
        assert.equal(metadataBody.code, "NO_SIDE_EFFECT");
        assert.equal(metadataBody.causeCode, "SHARED_SERVICE_UNAVAILABLE");
    } finally {
        await close(server);
    }
});
