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
        const { data, privateKey, owner, epochs = 5 } = req.body;
        if (!data || !privateKey || !owner) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey, owner" });
        }

        // Decode signer
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);

        const blobData = new Uint8Array(Buffer.from(data, "base64"));

        // writeBlobFlow (stateful: encode → register → upload → certify)
        const flow = walrusClient.writeBlobFlow({ blob: blobData });
        await flow.encode();

        const signerAddress = signer.toSuiAddress();
        const registerTx = flow.register({
            epochs,
            owner: signerAddress,
            deletable: true,
        });

        const registerResult = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: registerTx,
        });

        await flow.upload({ digest: registerResult.digest });

        const certifyTx = flow.certify();
        await suiClient.signAndExecuteTransaction({
            signer,
            transaction: certifyTx,
        });

        const blob = await flow.getBlob();
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

const PORT = parseInt(process.env.SIDECAR_PORT || "3002", 10);
app.listen(PORT, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        port: PORT,
        pid: process.pid,
    }));
});
