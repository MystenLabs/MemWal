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
// ============================================================
// Environment-driven network config
// ============================================================

const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";

// SEAL key server object IDs (comma-separated via env var)
const SEAL_KEY_SERVERS = (process.env.SEAL_KEY_SERVERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

if (SEAL_KEY_SERVERS.length === 0) {
    console.error("[sidecar] WARNING: SEAL_KEY_SERVERS env var is empty — SEAL encrypt/decrypt will fail");
}

// Walrus package ID (for on-chain Move calls: metadata, blob type queries)
const WALRUS_PACKAGE_ID = process.env.WALRUS_PACKAGE_ID || (
    SUI_NETWORK === "testnet"
        ? "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"
        : "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77"
);

const WALRUS_UPLOAD_RELAY_URL = process.env.WALRUS_UPLOAD_RELAY_URL || (
    SUI_NETWORK === "testnet"
        ? "https://upload-relay.testnet.walrus.space"
        : "https://upload-relay.mainnet.walrus.space"
);

const DEFAULT_WALRUS_EPOCHS = SUI_NETWORK === "testnet" ? 50 : 3;

const suiClient = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(SUI_NETWORK),
    network: SUI_NETWORK,
});

const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_KEY_SERVERS.map((id) => ({
        objectId: id,
        weight: 1,
    })),
    verifyKeyServers: false,
});

const walrusClient = new WalrusClient({
    network: SUI_NETWORK,
    suiClient: suiClient as any,
    uploadRelay: {
        host: WALRUS_UPLOAD_RELAY_URL,
        sendTip: { max: 10_000_000 },
    },
});

const COIN_WITH_BALANCE_INTENT = "CoinWithBalance";
const GAS_INTENT_TYPE = "gas";
const SUI_TYPE = "0x2::sui::SUI";
type TxIntentCommand = {
    $kind?: string;
    $Intent?: {
        name?: string;
        data?: { type?: string };
    };
};
type TxDataWithCommands = { commands: TxIntentCommand[] };
type UploadRelayTipConfigResponse = {
    send_tip?: {
        address?: string;
    };
};

/**
 * Rewrite CoinWithBalance "gas" intents to explicit SUI coin type so Enoki
 * sponsorship can build the transaction (Enoki rejects GasCoin tx arguments).
 */
function patchGasCoinIntents(tx: Transaction): void {
    tx.addSerializationPlugin(async (transactionData: TxDataWithCommands, _buildOptions, next) => {
        let patched = 0;
        for (const command of transactionData.commands) {
            if (
                command.$kind === "$Intent" &&
                command.$Intent?.name === COIN_WITH_BALANCE_INTENT &&
                command.$Intent?.data?.type === GAS_INTENT_TYPE
            ) {
                command.$Intent.data.type = SUI_TYPE;
                patched += 1;
            }
        }

        if (patched > 0) {
            console.log(`[patch] converted ${patched} CoinWithBalance intent(s) from GasCoin -> sender SUI coins`);
        }

        await next();
    });
}

const ENOKI_API_BASE_URL = "https://api.enoki.mystenlabs.com/v1";
const enokiApiKey = process.env.ENOKI_API_KEY;
const enokiNetwork = (process.env.ENOKI_NETWORK || process.env.SUI_NETWORK || "mainnet") as
    | "mainnet"
    | "testnet"
    | "devnet";
const ENOKI_FALLBACK_TO_DIRECT_SIGN = (() => {
    const raw = (process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN || "true").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
})();

type EnokiDataWrapper<T> = { data: T };
type EnokiSponsorResponse = { bytes: string; digest: string };
type EnokiExecuteResponse = { digest: string };
const signerUploadQueues = new Map<string, Promise<void>>();
let uploadRelayTipAddressCache: string | null | undefined = undefined;

function dedupeAddresses(addresses: (string | null | undefined)[]): string[] {
    return [...new Set(addresses.filter((addr): addr is string => typeof addr === "string" && addr.length > 0))];
}

async function getUploadRelayTipAddress(): Promise<string | null> {
    if (uploadRelayTipAddressCache !== undefined) {
        return uploadRelayTipAddressCache;
    }

    try {
        const resp = await fetch(`${WALRUS_UPLOAD_RELAY_URL}/v1/tip-config`);
        if (!resp.ok) {
            throw new Error(`tip-config request failed (${resp.status})`);
        }

        const json = await resp.json() as UploadRelayTipConfigResponse;
        const address = json.send_tip?.address;
        if (typeof address === "string" && address.startsWith("0x")) {
            uploadRelayTipAddressCache = address;
            return address;
        }

        uploadRelayTipAddressCache = null;
        return null;
    } catch (err: any) {
        console.warn(`[upload-relay] could not load tip-config: ${err.message || err}`);
        // Don't cache transient failures; retry on next request.
        return null;
    }
}

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

async function executeWithEnokiSponsor(tx: Transaction, signer: Ed25519Keypair, allowedAddresses?: string[]): Promise<string> {
    if (!enokiApiKey) {
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }

    try {
        const txKindBytes = await tx.build({
            client: suiClient as any,
            onlyTransactionKind: true,
        });

        const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
            network: enokiNetwork,
            transactionBlockKindBytes: Buffer.from(txKindBytes).toString("base64"),
            sender: signer.toSuiAddress(),
            ...(allowedAddresses?.length ? { allowedAddresses } : {}),
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
    } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (!ENOKI_FALLBACK_TO_DIRECT_SIGN) {
            console.error(`[enoki-sponsor] sponsor failed and fallback disabled: ${errMsg}`);
            throw err;
        }

        console.warn(`[enoki-sponsor] sponsor failed, falling back to direct signing: ${errMsg}`);
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }
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

// CORS — allow frontend (any origin) to call sponsor endpoints
app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

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
        const { data, privateKey, packageId, accountId } = req.body;
        if (!data || !privateKey || !packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: data, privateKey, packageId, accountId" });
        }

        // Decode delegate keypair — supports both bech32 (suiprivkey1...) and raw hex
        let keypair: Ed25519Keypair;
        if (privateKey.startsWith("suiprivkey")) {
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            keypair = Ed25519Keypair.fromSecretKey(secretKey);
        } else {
            // Raw hex private key (32 bytes = 64 hex chars)
            const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
            keypair = Ed25519Keypair.fromSecretKey(keyBytes);
        }
        const signerAddress = keypair.getPublicKey().toSuiAddress();

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
            address: signerAddress,
            packageId,
            ttlMin: 30,
            signer: keypair,
            suiClient: suiClient as any,
        });

        // Build seal_approve PTB — pass MemWalAccount (owned object) instead of AccountRegistry
        const tx = new Transaction();
        tx.moveCall({
            target: `${packageId}::account::seal_approve`,
            arguments: [
                tx.pure("vector<u8>", idBytes),
                tx.object(accountId),
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
// POST /seal/decrypt-batch
// Decrypt multiple SEAL-encrypted blobs with a single SessionKey.
// Avoids "Not enough shares" errors when decrypting many blobs at once.
// ============================================================
app.post("/seal/decrypt-batch", async (req, res) => {
    try {
        const { items, privateKey, packageId, accountId } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required field: items (array of base64 encrypted data)" });
        }
        if (!privateKey || !packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: privateKey, packageId, accountId" });
        }

        // Decode delegate keypair
        let keypair: Ed25519Keypair;
        if (privateKey.startsWith("suiprivkey")) {
            const { secretKey } = decodeSuiPrivateKey(privateKey);
            keypair = Ed25519Keypair.fromSecretKey(secretKey);
        } else {
            const keyBytes = Uint8Array.from(privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
            keypair = Ed25519Keypair.fromSecretKey(keyBytes);
        }
        const signerAddress = keypair.getPublicKey().toSuiAddress();

        // Parse all encrypted objects and collect unique SEAL IDs
        const parsedItems: { index: number; encryptedData: Uint8Array; fullId: string }[] = [];
        const errors: { index: number; error: string }[] = [];

        for (let i = 0; i < items.length; i++) {
            try {
                const encryptedData = new Uint8Array(Buffer.from(items[i], "base64"));
                const parsed = EncryptedObject.parse(encryptedData);
                parsedItems.push({ index: i, encryptedData, fullId: parsed.id });
            } catch (err: any) {
                errors.push({ index: i, error: `parse failed: ${err.message}` });
            }
        }

        if (parsedItems.length === 0) {
            return res.json({ results: [], errors });
        }

        // Collect all unique IDs
        const allIds = [...new Set(parsedItems.map(p => p.fullId))];

        // Create ONE SessionKey
        const sessionKey = await SessionKey.create({
            address: signerAddress,
            packageId,
            ttlMin: 30,
            signer: keypair,
            suiClient: suiClient as any,
        });

        // Build ONE PTB with seal_approve for ALL IDs
        const tx = new Transaction();
        for (const id of allIds) {
            const idBytes = Array.from(
                Uint8Array.from(id.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
            );
            tx.moveCall({
                target: `${packageId}::account::seal_approve`,
                arguments: [
                    tx.pure("vector<u8>", idBytes),
                    tx.object(accountId),
                ],
            });
        }
        const txBytes = await tx.build({ client: suiClient as any, onlyTransactionKind: true });

        // ONE fetchKeys call for ALL IDs
        await sealClient.fetchKeys({
            ids: allIds,
            txBytes,
            sessionKey,
            threshold: 1,
        });

        // Decrypt each blob using the shared sessionKey
        const results: { index: number; decryptedData: string }[] = [];

        for (const item of parsedItems) {
            try {
                const decrypted = await sealClient.decrypt({
                    data: item.encryptedData,
                    sessionKey,
                    txBytes,
                });
                results.push({
                    index: item.index,
                    decryptedData: Buffer.from(decrypted).toString("base64"),
                });
            } catch (err: any) {
                errors.push({ index: item.index, error: `decrypt failed: ${err.message}` });
            }
        }

        console.log(`[seal/decrypt-batch] ${results.length}/${items.length} decrypted ok, ${errors.length} errors`);
        res.json({ results, errors });
    } catch (err: any) {
        console.error(`[seal/decrypt-batch] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /walrus/upload
// ============================================================
app.post("/walrus/upload", async (req, res) => {
    try {
        const {
            data,
            privateKey,
            owner,
            namespace,
            packageId,
            epochs = DEFAULT_WALRUS_EPOCHS,
        } = req.body;
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
                // Server owns the blob initially (needed for certify step)
                owner: signerAddress,
                deletable: true,
                // Store namespace + owner as on-chain metadata (queryable for restore)
                attributes: {
                    ...(namespace ? { memwal_namespace: namespace } : {}),
                    ...(owner ? { memwal_owner: owner } : {}),
                    ...(packageId ? { memwal_package_id: packageId } : {}),
                },
            });

            // Patch: convert GasCoin intents → sender's SUI coins.
            // Enoki rejects GasCoin as tx argument, but relay requires the tip.
            // After patching, signer pays tip from own SUI; Enoki sponsors gas.
            patchGasCoinIntents(registerTx);
            const tipRecipient = await getUploadRelayTipAddress();
            const registerAllowedAddresses = dedupeAddresses([signerAddress, tipRecipient]);
            const registerDigest = await executeWithEnokiSponsor(registerTx, signer, registerAllowedAddresses);
            await suiClient.waitForTransaction({ digest: registerDigest });

            await flow.upload({ digest: registerDigest });

            const certifyTx = flow.certify();
            // Wait until certify tx is confirmed before returning this upload.
            const certifyDigest = await executeWithEnokiSponsor(certifyTx, signer);
            await suiClient.waitForTransaction({ digest: certifyDigest });

            return flow.getBlob();
        });

        // Extract objectId — handle both { id: "0x..." } and { id: { id: "0x..." } }
        let blobObjectId: string | null = null;
        const rawId = (blob.blobObject as any)?.id;
        if (typeof rawId === 'string') {
            blobObjectId = rawId;
        } else if (rawId && typeof rawId === 'object' && typeof rawId.id === 'string') {
            blobObjectId = rawId.id;
        }

        // Walrus package for on-chain Move calls (from env-driven WALRUS_PACKAGE_ID)
        const WALRUS_PKG = WALRUS_PACKAGE_ID;

        // Set on-chain metadata + transfer blob to user in a single transaction
        if (owner && owner !== signerAddress && blobObjectId) {
            try {
                const metaTx = new Transaction();
                const blobArg = metaTx.object(blobObjectId);

                // Set memwal_namespace metadata on-chain
                metaTx.moveCall({
                    target: `${WALRUS_PKG}::blob::insert_or_update_metadata_pair`,
                    arguments: [
                        blobArg,
                        metaTx.pure.string("memwal_namespace"),
                        metaTx.pure.string(namespace || "default"),
                    ],
                    typeArguments: [],
                });

                // Set memwal_owner
                metaTx.moveCall({
                    target: `${WALRUS_PKG}::blob::insert_or_update_metadata_pair`,
                    arguments: [
                        blobArg,
                        metaTx.pure.string("memwal_owner"),
                        metaTx.pure.string(owner),
                    ],
                    typeArguments: [],
                });

                // Set memwal_package_id
                if (packageId) {
                    metaTx.moveCall({
                        target: `${WALRUS_PKG}::blob::insert_or_update_metadata_pair`,
                        arguments: [
                            blobArg,
                            metaTx.pure.string("memwal_package_id"),
                            metaTx.pure.string(packageId),
                        ],
                        typeArguments: [],
                    });
                }

                // Transfer blob to user
                metaTx.transferObjects([blobArg], owner);

                const metaDigest = await executeWithEnokiSponsor(metaTx, signer, dedupeAddresses([signerAddress, owner]));
                await suiClient.waitForTransaction({ digest: metaDigest });
                console.log(`[walrus/upload] metadata set + transferred blob ${blobObjectId} to ${owner} (ns=${namespace})`);
            } catch (metaErr: any) {
                // Non-fatal: blob is uploaded but metadata/transfer failed
                console.error(`[walrus/upload] metadata+transfer failed: ${metaErr.message}`);
            }
        }

        res.json({
            blobId: blob.blobId,
            objectId: blobObjectId,
        });
    } catch (err: any) {
        console.error(`[walrus/upload] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /walrus/query-blobs
// Query user's Walrus Blob objects from Sui chain, filter by namespace
// ============================================================

/**
 * Fetch a dynamic field with retry + exponential backoff on 429 rate limit errors.
 */
async function getDynamicFieldWithRetry(
    parentId: string,
    fieldName: { type: string; value: number[] },
    maxRetries = 4,
): Promise<any> {
    let lastErr: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await suiClient.getDynamicFieldObject({
                parentId,
                name: fieldName,
            });
        } catch (err: any) {
            lastErr = err;
            const msg = String(err?.message || err);
            // Retry on 429 (rate limit) or 503 (service unavailable)
            const isRetryable = msg.includes("429") || msg.includes("503") || msg.includes("rate");
            if (!isRetryable || attempt === maxRetries - 1) throw err;
            const delayMs = 250 * Math.pow(2, attempt); // 250ms, 500ms, 1000ms, 2000ms
            console.warn(`[query-blobs] getDynamicField 429/503 for ${parentId}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

/**
 * Run async tasks with a bounded concurrency limit.
 * Avoids overwhelming Sui RPC with too many parallel calls (→ 429).
 */
async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (true) {
            const i = index++;
            if (i >= items.length) break;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

app.post("/walrus/query-blobs", async (req, res) => {
    try {
        const { owner, namespace, packageId } = req.body;
        if (!owner) {
            return res.status(400).json({ error: "Missing required field: owner" });
        }

        // Walrus Blob type (derived from env-driven WALRUS_PACKAGE_ID)
        const WALRUS_BLOB_TYPE = `${WALRUS_PACKAGE_ID}::blob::Blob`;

        // Step 1: Collect all raw blob objects (paginated, each page = 1 RPC call)
        type RawBlobObj = { objectId: string; rawBlobId: string | number | null };
        const rawObjs: RawBlobObj[] = [];
        let cursor: string | null | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
            const result = await suiClient.getOwnedObjects({
                owner,
                filter: { StructType: WALRUS_BLOB_TYPE },
                options: { showContent: true },
                cursor: cursor ?? undefined,
                limit: 50,
            });

            for (const obj of result.data) {
                if (!obj.data?.content || obj.data.content.dataType !== "moveObject") continue;
                const fields = (obj.data.content as any).fields;
                if (!fields) continue;
                const rawBlobId = fields.blob_id ?? fields.blobId ?? null;
                rawObjs.push({ objectId: obj.data.objectId, rawBlobId });
            }

            hasMore = result.hasNextPage;
            cursor = result.nextCursor;
        }

        console.log(`[query-blobs] found ${rawObjs.length} raw blob objects for owner=${owner}`);

        // Step 2: Fetch metadata for each blob with bounded concurrency (5 at a time)
        // to avoid overwhelming Sui RPC and hitting 429 rate limits.
        const METADATA_FIELD_NAME = {
            type: "vector<u8>",
            value: [109, 101, 116, 97, 100, 97, 116, 97], // b"metadata"
        };

        type BlobMeta = {
            objectId: string;
            rawBlobId: string | number | null;
            blobNamespace: string;
            blobOwner: string;
            blobPackageId: string;
        };

        const metas: BlobMeta[] = await mapConcurrent(rawObjs, 5, async (obj) => {
            let blobNamespace = "default";
            let blobOwner = "";
            let blobPackageId = "";

            try {
                const dynField = await getDynamicFieldWithRetry(obj.objectId, METADATA_FIELD_NAME);

                if (dynField.data?.content && dynField.data.content.dataType === "moveObject") {
                    const dynFields = (dynField.data.content as any).fields;
                    // Path: fields.value.fields.metadata.fields.contents[]
                    const contents = dynFields?.value?.fields?.metadata?.fields?.contents;
                    if (Array.isArray(contents)) {
                        for (const entry of contents) {
                            const key = entry?.fields?.key;
                            const value = entry?.fields?.value;
                            if (key === "memwal_namespace") blobNamespace = value;
                            if (key === "memwal_owner") blobOwner = value;
                            if (key === "memwal_package_id") blobPackageId = value;
                        }
                    }
                }
            } catch {
                // No dynamic field = no metadata = use defaults
            }

            return { ...obj, blobNamespace, blobOwner, blobPackageId };
        });

        // Step 3: Filter + convert blob IDs
        const blobs: { blobId: string; objectId: string; namespace: string; packageId: string }[] = [];

        for (const meta of metas) {
            // Filter by namespace if specified
            if (namespace && meta.blobNamespace !== namespace) continue;
            // Filter by packageId if specified
            if (packageId && meta.blobPackageId !== packageId) continue;

            if (meta.rawBlobId) {
                // blob_id from chain is a big integer (U256) — convert to base64url (little-endian!)
                let blobIdStr = String(meta.rawBlobId);
                if (/^\d+$/.test(blobIdStr) && blobIdStr.length > 20) {
                    try {
                        const bigInt = BigInt(blobIdStr);
                        const hex = bigInt.toString(16).padStart(64, '0');
                        // Convert hex to bytes (big-endian), then REVERSE to little-endian
                        const bytesBE = hex.match(/.{2}/g)!.map(b => parseInt(b, 16));
                        const bytesLE = new Uint8Array(bytesBE.reverse());
                        blobIdStr = Buffer.from(bytesLE).toString('base64url');
                    } catch {
                        // Keep as-is if conversion fails
                    }
                }
                blobs.push({ blobId: blobIdStr, objectId: meta.objectId, namespace: meta.blobNamespace, packageId: meta.blobPackageId });
            }
        }

        console.log(`[query-blobs] returning ${blobs.length} blobs (filtered from ${rawObjs.length}) for owner=${owner} ns=${namespace || '*'}`);
        res.json({ blobs, total: blobs.length });
    } catch (err: any) {
        console.error(`[walrus/query-blobs] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /sponsor — Create Enoki-sponsored transaction for frontend
// Frontend sends TransactionKind bytes + sender → returns sponsored { bytes, digest }
// ============================================================
app.post("/sponsor", async (req, res) => {
    try {
        const { transactionBlockKindBytes, sender } = req.body;
        if (!transactionBlockKindBytes || !sender) {
            return res.status(400).json({ error: "Missing required fields: transactionBlockKindBytes, sender" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        console.log(`[sponsor] creating sponsored tx for sender=${sender}`);
        const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
            network: enokiNetwork,
            transactionBlockKindBytes,
            sender,
        });

        console.log(`[sponsor] sponsored tx created, digest=${sponsored.digest}`);
        res.json(sponsored); // { bytes, digest }
    } catch (err: any) {
        console.error(`[sponsor] error: ${err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// ============================================================
// POST /sponsor/execute — Execute signed sponsored transaction
// Frontend sends { digest, signature } after user wallet signs → returns { digest }
// ============================================================
app.post("/sponsor/execute", async (req, res) => {
    try {
        const { digest, signature } = req.body;
        if (!digest || !signature) {
            return res.status(400).json({ error: "Missing required fields: digest, signature" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        console.log(`[sponsor/execute] executing sponsored tx digest=${digest}`);
        const executed = await callEnoki<EnokiExecuteResponse>(
            `/transaction-blocks/sponsor/${digest}`,
            { digest, signature }
        );

        console.log(`[sponsor/execute] tx executed, final digest=${executed.digest}`);
        res.json(executed); // { digest }
    } catch (err: any) {
        console.error(`[sponsor/execute] error: ${err.message || err}`);
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
