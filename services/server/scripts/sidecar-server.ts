/**
 * SEAL + Walrus HTTP Sidecar Server
 *
 * Long-lived Express server that wraps SEAL encrypt/decrypt and Walrus upload.
 * Started once at server boot — eliminates ~1-2s Node.js cold-start per call.
 *
 * Endpoints:
 *   POST /seal/encrypt   → { data, owner, packageId } → { encryptedData }
 *   POST /seal/decrypt   → { data, privateKey, packageId, registryId } → { decryptedData }
 *   POST /walrus/upload  → { data, privateKey, owner, epochs } → { blobId, objectId }
 *   GET  /health         → { status: "ok" }
 */

import express from "express";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";
import { WalrusClient } from "@mysten/walrus";

// ============================================================
// Shared clients (initialized once at boot — the whole point!)
// ============================================================

const TESTNET_KEY_SERVERS = [
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
];

const suiClient = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
});

const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: TESTNET_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

const walrusClient = new WalrusClient({
    network: "testnet",
    suiClient: suiClient as any,
    uploadRelay: {
        host: "https://upload-relay.testnet.walrus.space",
        sendTip: { max: 10_000_000 },
    },
});

const ENOKI_API_BASE_URL = "https://api.enoki.mystenlabs.com/v1";
const enokiApiKey = process.env.ENOKI_API_KEY;
const enokiNetwork = (process.env.ENOKI_NETWORK || process.env.SUI_NETWORK || "testnet") as
    | "mainnet"
    | "testnet"
    | "devnet";

type EnokiDataWrapper<T> = { data: T };
type EnokiSponsorResponse = { bytes: string; digest: string };
type EnokiExecuteResponse = { digest: string };
const signerUploadQueues = new Map<string, Promise<void>>();

async function callEnoki<T>(path: string, payload: unknown): Promise<T> {
    if (!enokiApiKey) {
        throw new Error("ENOKI_API_KEY is not configured");
    }

    const resp = await fetch(`${ENOKI_API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${enokiApiKey}`,
        },
        body: JSON.stringify(payload),
    });

    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`Enoki API error (${resp.status}): ${text}`);
    }

    const parsed = JSON.parse(text) as EnokiDataWrapper<T>;
    return parsed.data;
}

async function executeWithEnokiSponsor(tx: Transaction, signer: Ed25519Keypair): Promise<string> {
    if (!enokiApiKey) {
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }

    const txKindBytes = await tx.build({
        client: suiClient as any,
        onlyTransactionKind: true,
    });

    const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
        network: enokiNetwork,
        transactionBlockKindBytes: Buffer.from(txKindBytes).toString("base64"),
        sender: signer.toSuiAddress(),
    });

    const signature = await signer.signTransaction(
        new Uint8Array(Buffer.from(sponsored.bytes, "base64"))
    );

    const executed = await callEnoki<EnokiExecuteResponse>(
        `/transaction-blocks/sponsor/${sponsored.digest}`,
        {
            digest: sponsored.digest,
            signature: signature.signature,
        }
    );

    return executed.digest;
}

/**
 * Queue tasks by signer to avoid coin-object lock conflicts when multiple
 * Walrus uploads are triggered concurrently for the same signing key.
 */
async function runExclusiveBySigner<T>(signerAddress: string, task: () => Promise<T>): Promise<T> {
    const previous = signerUploadQueues.get(signerAddress) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.then(() => current);
    signerUploadQueues.set(signerAddress, queued);

    await previous;
    try {
        return await task();
    } finally {
        release();
        // Cleanup queue map entry once this task is done and no newer task replaced it.
        if (signerUploadQueues.get(signerAddress) === queued) {
            signerUploadQueues.delete(signerAddress);
        }
    }
}

// ============================================================
// Express app
// ============================================================

const app = express();
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});

// ============================================================
// POST /seal/encrypt
// ============================================================
app.post("/seal/encrypt", async (req, res) => {
    try {
        const { data, owner, packageId } = req.body;
        if (!data || !owner || !packageId) {
            return res.status(400).json({ error: "Missing required fields: data, owner, packageId" });
        }

        const plaintext = Buffer.from(data, "base64");
        const result = await sealClient.encrypt({
            threshold: 1,
            packageId,
            id: owner,
            data: new Uint8Array(plaintext),
        });

        const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
        res.json({ encryptedData: encryptedBase64 });
    } catch (err: any) {
        console.error(`[seal/encrypt] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /seal/decrypt
// ============================================================
app.post("/seal/decrypt", async (req, res) => {
    try {
        const { data, privateKey, packageId, registryId } = req.body;
        if (!data || !privateKey || !packageId || !registryId) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey, packageId, registryId" });
        }

        // Decode admin wallet
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const adminAddress = keypair.getPublicKey().toSuiAddress();

        // Parse encrypted object to get key ID
        const encryptedData = new Uint8Array(Buffer.from(data, "base64"));
        const parsed = EncryptedObject.parse(encryptedData);
        const fullId = parsed.id;

        // Convert hex ID to byte array for PTB
        const idBytes = Array.from(
            Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
        );

        // Create session key
        const sessionKey = await SessionKey.create({
            address: adminAddress,
            packageId,
            ttlMin: 30,
            signer: keypair,
            suiClient: suiClient as any,
        });

        // Build seal_approve PTB
        const tx = new Transaction();
        tx.moveCall({
            target: `${packageId}::account::seal_approve`,
            arguments: [
                tx.pure("vector<u8>", idBytes),
                tx.object(registryId),
            ],
        });
        const txBytes = await tx.build({ client: suiClient as any, onlyTransactionKind: true });

        // Fetch keys from key servers
        await sealClient.fetchKeys({
            ids: [fullId],
            txBytes,
            sessionKey,
            threshold: 1,
        });

        // Decrypt locally
        const decrypted = await sealClient.decrypt({
            data: encryptedData,
            sessionKey,
            txBytes,
        });

        const decryptedBase64 = Buffer.from(decrypted).toString("base64");
        res.json({ decryptedData: decryptedBase64 });
    } catch (err: any) {
        console.error(`[seal/decrypt] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /walrus/upload
// ============================================================
app.post("/walrus/upload", async (req, res) => {
    try {
        const { data, privateKey, owner: _ownerIgnored, epochs = 5 } = req.body;
        if (!data || !privateKey) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey" });
        }

        // Decode signer
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);

        const signerAddress = signer.toSuiAddress();
        const blob = await runExclusiveBySigner(signerAddress, async () => {
            const blobData = new Uint8Array(Buffer.from(data, "base64"));

            // writeBlobFlow (stateful: encode → register → upload → certify)
            const flow = walrusClient.writeBlobFlow({ blob: blobData });
            await flow.encode();

            const registerTx = flow.register({
                epochs,
                // Force owner = signer to avoid required-signature mismatch
                // when client owner and server signing key differ.
                owner: signerAddress,
                deletable: true,
            });

            // Wait until register tx is confirmed before starting upload/certify.
            const registerDigest = await executeWithEnokiSponsor(registerTx, signer);
            await suiClient.waitForTransaction({
                digest: registerDigest,
            });

            await flow.upload({ digest: registerDigest });

            const certifyTx = flow.certify();
            // Wait until certify tx is confirmed before returning this upload.
            const certifyDigest = await executeWithEnokiSponsor(certifyTx, signer);
            await suiClient.waitForTransaction({
                digest: certifyDigest,
            });

            return flow.getBlob();
        });

        res.json({
            blobId: blob.blobId,
            objectId: (blob.blobObject as any)?.id ?? null,
        });
    } catch (err: any) {
        console.error(`[walrus/upload] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// Start server
// ============================================================

const PORT = parseInt(process.env.SIDECAR_PORT || "9000", 10);
app.listen(PORT, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        port: PORT,
        pid: process.pid,
    }));
});
