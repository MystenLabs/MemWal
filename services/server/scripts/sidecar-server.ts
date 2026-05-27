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

import express, { Request, Response, NextFunction } from "express";
import { timingSafeEqual, randomUUID } from "crypto";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";
import { WalrusClient } from "@mysten/walrus";
import { mountMcpRoutes, shutdownMcpSessions } from "./mcp/index.js";
import { getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "./seal-config.js";

// ============================================================
// Shared clients (initialized once at boot — the whole point!)
// ============================================================
// ============================================================
// Environment-driven network config
// ============================================================

const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";

const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);

if (SEAL_SERVER_CONFIGS.length === 0) {
    console.error(
        "[sidecar] WARNING: SEAL_SERVER_CONFIGS/SEAL_KEY_SERVERS env vars are empty and no network default exists — SEAL encrypt/decrypt will fail",
    );
}

// Server Sui Private Keys for Walrus uploads
const SERVER_SUI_PRIVATE_KEYS = (process.env.SERVER_SUI_PRIVATE_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

if (SERVER_SUI_PRIVATE_KEYS.length === 0 && process.env.SERVER_SUI_PRIVATE_KEY) {
    SERVER_SUI_PRIVATE_KEYS.push(process.env.SERVER_SUI_PRIVATE_KEY.trim());
}

if (SERVER_SUI_PRIVATE_KEYS.length === 0) {
    console.error("[sidecar] WARNING: SERVER_SUI_PRIVATE_KEYS env var is empty — Walrus uploads will fail");
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
    serverConfigs: SEAL_SERVER_CONFIGS,
    verifyKeyServers: true,
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
    const raw = (process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN || "false").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
})();

type EnokiDataWrapper<T> = { data: T };
type EnokiSponsorResponse = { bytes: string; digest: string };
type EnokiExecuteResponse = { digest: string };
type WalletTransactionOptions = {
    patchGasCoinIntentsForSponsor?: boolean;
};

// MEM-35: in-memory counters surfaced via /metrics/wallet.
// Per Will Bradley (Mysten, 2026-05-12 Slack): Sui no longer permanently
// locks coin objects on equivocation, so the original multi-wallet routing
// is unnecessary. We use a single wallet concurrently and rely on Apalis
// retries for transient Sui/RPC/coin-selection races.
//
// `walletLockErrorsTotal` should stay at 0 under load and is the canary
// for re-evaluating the simplification if the Sui guarantee changes.
const sidecarMetrics = {
    walletSubmittedTotal: 0,
    walletLockErrorsTotal: 0,
    walletPermanentFailuresTotal: 0,
};

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

function transactionForSponsor(tx: Transaction, options: WalletTransactionOptions): Transaction {
    if (!options.patchGasCoinIntentsForSponsor) {
        return tx;
    }

    const sponsorTx = Transaction.from(tx);
    patchGasCoinIntents(sponsorTx);
    return sponsorTx;
}

async function executeWithEnokiSponsor(
    tx: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
    options: WalletTransactionOptions = {},
): Promise<string> {
    if (!enokiApiKey) {
        if (!ENOKI_FALLBACK_TO_DIRECT_SIGN) {
            throw new Error("ENOKI_API_KEY is not configured and ENOKI_FALLBACK_TO_DIRECT_SIGN=false");
        }

        console.warn("[enoki-sponsor] ENOKI_API_KEY not configured, falling back to direct signing");
        const direct = await suiClient.signAndExecuteTransaction({
            signer,
            transaction: tx,
        });
        return direct.digest;
    }

    try {
        const sponsorTx = transactionForSponsor(tx, options);
        const txKindBytes = await sponsorTx.build({
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

        // LOW-15: Defense-in-depth — encode digest before path interpolation.
        const encodedSponsoredDigest = encodeURIComponent(sponsored.digest);
        const executed = await callEnoki<EnokiExecuteResponse>(
            `/transaction-blocks/sponsor/${encodedSponsoredDigest}`,
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
 * Submit a Sui transaction via the Enoki sponsor path (or direct sign as
 * fallback). Wraps `executeWithEnokiSponsor` with metrics + lock-error
 * detection for the validation canary.
 */
async function submitWalletTransaction(
    tx: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
    options: WalletTransactionOptions = {},
): Promise<string> {
    try {
        const digest = await executeWithEnokiSponsor(tx, signer, allowedAddresses, options);
        sidecarMetrics.walletSubmittedTotal += 1;
        return digest;
    } catch (err: any) {
        const msg = err?.message || String(err);
        if (/objectlocked|locked at version|object is locked/i.test(msg)) {
            sidecarMetrics.walletLockErrorsTotal += 1;
            console.error(`[wallet] coin-object lock error: ${msg}`);
        } else if (/moveabort|move abort/i.test(msg)) {
            sidecarMetrics.walletPermanentFailuresTotal += 1;
        }
        throw err;
    }
}

// ============================================================
// Express app
// ============================================================

const app = express();
// HIGH-13 / ENG-1407: JSON body limits are per-route. A global app.use(json())
// would parse and reject oversize bodies before any per-route json() ran
// (Express middleware fires in declaration order; whichever json() consumes
// the body first wins). We declare named limits and apply them explicitly
// on each route instead.
const JSON_LIMIT_METADATA = "256kb"; // walrus/query-blobs, sponsor, sponsor/execute
const JSON_LIMIT_SEAL_ENCRYPT = "2mb"; // matches PROTECTED_BODY_LIMIT_BYTES (auth cap)
const JSON_LIMIT_SEAL_DECRYPT = "2mb"; // single encrypted blob, same size class as encrypt
const JSON_LIMIT_SEAL_DECRYPT_BATCH = "8mb"; // up to 25 × ~320 KiB items
const JSON_LIMIT_WALRUS_UPLOAD = "10mb"; // base64-encoded encrypted blob

// CORS — sidecar is called only by the co-located Rust server, never by browsers.
// Remove all CORS headers so no cross-origin access is granted.
app.use((_req: Request, res: Response, next: NextFunction) => {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Methods");
    res.removeHeader("Access-Control-Allow-Headers");
    if (_req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

// Health check — placed before auth middleware so it is always reachable.
app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
});

// MCP routes — `/mcp/sse` + `/mcp/messages`. Mounted BEFORE the shared-secret
// middleware: MCP traffic is forwarded by the Rust relayer with the end-user's
// own delegate-key Bearer token in `Authorization`, NOT the sidecar's shared
// secret. The MCP layer does its own auth (parse delegate key + account id
// from request headers). These routes are reachable only from the relayer
// over localhost — same trust boundary as the rest of the sidecar.
mountMcpRoutes(app, {
    relayerUrl: process.env.MEMWAL_RELAYER_URL ?? "http://localhost:3001",
});

// Wallet-execution metrics (MEM-35 observability). Placed before auth so
// operators / scrapers don't need a token.
//
// `walletLockErrorsTotal` is the canary for the simplification: it should
// stay at 0 because Sui no longer permanently locks coin objects on
// equivocation. If it ever climbs, the original multi-wallet rationale
// would need re-evaluating.
//
// Values are integer counters that monotonically increase; clients compute
// deltas.
app.get("/metrics/wallet", (_req: Request, res: Response) => {
    res.json({
        ...sidecarMetrics,
        enokiEnabled: !!enokiApiKey,
        suiNetwork: SUI_NETWORK,
    });
});

// Shared-secret authentication — protects all routes registered after this point.
// Set SIDECAR_AUTH_TOKEN in the environment; callers must send it as Authorization: Bearer <token>.
// Sidecar refuses to start if SIDECAR_AUTH_TOKEN is not set.
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN;
if (!SIDECAR_AUTH_TOKEN) {
    console.error("[sidecar] FATAL: SIDECAR_AUTH_TOKEN not set. Refusing to start without auth.");
    process.exit(1);
}

app.use((req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const secretBuf = Buffer.from(SIDECAR_AUTH_TOKEN!);
    const providedBuf = Buffer.from(typeof token === "string" ? token : "");
    // timingSafeEqual prevents timing side-channel attacks on the token comparison.
    // Buffers must be same length — if lengths differ it's already a mismatch.
    const valid = providedBuf.length === secretBuf.length &&
        timingSafeEqual(providedBuf, secretBuf);
    if (!valid) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
});

// ============================================================
// POST /seal/encrypt
// ============================================================
// ENG-1407: receives the full plaintext for SEAL encryption. Must accept up
// to PROTECTED_BODY_LIMIT_BYTES (1.5 MiB) of plaintext plus base64 + JSON
// framing overhead.
app.post("/seal/encrypt", express.json({ limit: JSON_LIMIT_SEAL_ENCRYPT }), async (req, res) => {
    try {
        const { data, owner, packageId } = req.body;
        if (!data || !owner || !packageId) {
            return res.status(400).json({ error: "Missing required fields: data, owner, packageId" });
        }

        const plaintext = Buffer.from(data, "base64");
        const result = await sealClient.encrypt({
            threshold: SEAL_THRESHOLD,
            packageId,
            id: owner,
            data: new Uint8Array(plaintext),
        });

        const encryptedBase64 = Buffer.from(result.encryptedObject).toString("base64");
        res.json({ encryptedData: encryptedBase64 });
    } catch (err: any) {
        const traceId = randomUUID();
        console.error(`[seal/encrypt] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

/**
 * ENG-1697: Resolve a SEAL SessionKey from the request headers.
 *
 * Preferred path: `x-seal-session` contains a base64-encoded
 * `ExportedSessionKey` (built by the SDK on the client). We import it and
 * skip touching any private-key material.
 *
 * Legacy path: `x-delegate-key` contains the raw delegate private key
 * (hex or suiprivkey bech32). We reconstruct the keypair and build the
 * SessionKey here — same behavior as before the migration. This path
 * will be removed at EOL once all SDK clients emit `x-seal-session`.
 *
 * Returns `null` when neither header is present so the caller can emit a
 * 400 with a clear error message.
 */
async function resolveSessionKey(
    req: express.Request,
    packageId: string,
): Promise<SessionKey | null> {
    const sessionHeader = req.headers["x-seal-session"] as string | undefined;
    if (sessionHeader) {
        const exportedJson = Buffer.from(sessionHeader, "base64").toString("utf8");
        const exported = JSON.parse(exportedJson);
        return SessionKey.import(exported, suiClient as any);
    }

    const privateKey = req.headers["x-delegate-key"] as string | undefined;
    if (!privateKey) return null;

    let keypair: Ed25519Keypair;
    if (privateKey.startsWith("suiprivkey")) {
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
        // LOW-12: Validate hex format before parsing to prevent injection
        if (!/^[0-9a-fA-F]+$/.test(privateKey) || privateKey.length !== 64) {
            throw new Error("privateKey must be 64-char hex string or suiprivkey bech32");
        }
        const keyBytes = Uint8Array.from(
            privateKey.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)),
        );
        keypair = Ed25519Keypair.fromSecretKey(keyBytes);
    }
    return await SessionKey.create({
        address: keypair.getPublicKey().toSuiAddress(),
        packageId,
        ttlMin: 5,
        signer: keypair,
        suiClient: suiClient as any,
    });
}

// ============================================================
// POST /seal/decrypt
// ============================================================
app.post("/seal/decrypt", express.json({ limit: JSON_LIMIT_SEAL_DECRYPT }), async (req, res) => {
    try {
        const { data, packageId, accountId } = req.body;
        if (!data || !packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: data, packageId, accountId" });
        }

        // ENG-1697: resolve credential (x-seal-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
            });
        }

        // Parse encrypted object to get key ID
        const encryptedData = new Uint8Array(Buffer.from(data, "base64"));
        const parsed = EncryptedObject.parse(encryptedData);
        const fullId = parsed.id;

        // Convert hex ID to byte array for PTB
        const idBytes = Array.from(
            Uint8Array.from(fullId.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)))
        );

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
            threshold: SEAL_THRESHOLD,
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
        const traceId = randomUUID();
        console.error(`[seal/decrypt] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

// ============================================================
// POST /seal/decrypt-batch
// Decrypt multiple SEAL-encrypted blobs with a single SessionKey.
// Avoids "Not enough shares" errors when decrypting many blobs at once.
// ============================================================
// HIGH-13: batch body can be large (up to 25 × ~320 KiB max-item = ~8 MB).
app.post("/seal/decrypt-batch", express.json({ limit: JSON_LIMIT_SEAL_DECRYPT_BATCH }), async (req, res) => {
    try {
        const { items, packageId, accountId } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Missing required field: items (array of base64 encrypted data)" });
        }
        // HIGH-13 / MED-13: Cap items. 25 × max-item body = ~8 MB (matches the
        // per-route body limit above). Tightened from 50 to 25 so worst-case
        // in-memory allocation stays bounded even at the new limit.
        if (items.length > 25) {
            return res.status(400).json({ error: "items array exceeds maximum of 25 elements" });
        }
        if (!packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: packageId, accountId" });
        }

        // ENG-1697: resolve credential (x-seal-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
            });
        }

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
            threshold: SEAL_THRESHOLD,
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
        const traceId = randomUUID();
        console.error(`[seal/decrypt-batch] [${traceId}] error:`, err);
        res.status(500).json({ error: "Internal server error", traceId });
    }
});

// ============================================================
// POST /walrus/upload
// ============================================================

type MetadataTransferBlob = {
    blobObjectId: string;
    namespace?: string;
};

function extractBlobObjectId(blob: any): string | null {
    const rawId = blob?.blobObject?.id;
    if (typeof rawId === "string") {
        return rawId;
    }
    if (rawId && typeof rawId === "object" && typeof rawId.id === "string") {
        return rawId.id;
    }
    return null;
}

async function setMetadataAndTransferBlobs(
    signer: Ed25519Keypair,
    blobs: MetadataTransferBlob[],
    owner: string,
    packageId?: string,
    agentId?: string,
): Promise<string> {
    if (blobs.length === 0) {
        throw new Error("No blobs to transfer");
    }

    const signerAddress = signer.toSuiAddress();
    const metaTx = new Transaction();
    const blobArgs = [];

    for (const blob of blobs) {
        const blobArg = metaTx.object(blob.blobObjectId);
        blobArgs.push(blobArg);

        metaTx.moveCall({
            target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
            arguments: [
                blobArg,
                metaTx.pure.string("memwal_namespace"),
                metaTx.pure.string(blob.namespace || "default"),
            ],
            typeArguments: [],
        });

        metaTx.moveCall({
            target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
            arguments: [
                blobArg,
                metaTx.pure.string("memwal_owner"),
                metaTx.pure.string(owner),
            ],
            typeArguments: [],
        });

        if (packageId) {
            metaTx.moveCall({
                target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                arguments: [
                    blobArg,
                    metaTx.pure.string("memwal_package_id"),
                    metaTx.pure.string(packageId),
                ],
                typeArguments: [],
            });
        }

        if (agentId) {
            metaTx.moveCall({
                target: `${WALRUS_PACKAGE_ID}::blob::insert_or_update_metadata_pair`,
                arguments: [
                    blobArg,
                    metaTx.pure.string("memwal_agent_id"),
                    metaTx.pure.string(agentId),
                ],
                typeArguments: [],
            });
        }
    }

    metaTx.transferObjects(blobArgs, owner);
    const digest = await submitWalletTransaction(
        metaTx,
        signer,
        dedupeAddresses([signerAddress, owner]),
    );
    await suiClient.waitForTransaction({ digest });
    return digest;
}

// HIGH-13: /walrus/upload receives a base64-encoded SEAL ciphertext which can
// be up to ~87 KiB per 64 KiB plaintext (SEAL overhead + base64 ≈ 1.37×).
// 10 MB sits well above any realistic single-memory upload size.
app.post("/walrus/upload", express.json({ limit: JSON_LIMIT_WALRUS_UPLOAD }), async (req, res) => {
    try {
        const {
            data,
            keyIndex,
            owner,
            namespace,
            packageId,
            agentId,
            deferTransfer = false,
            epochs: rawEpochs = DEFAULT_WALRUS_EPOCHS,
        } = req.body;
        // LOW-17: Cap epochs at 5 to prevent accidental large storage purchases
        const epochs = Math.min(Number(rawEpochs) || DEFAULT_WALRUS_EPOCHS, 5);

        if (!data || keyIndex === undefined) {
            return res.status(400).json({ error: "Missing required fields: data, keyIndex" });
        }

        const privateKey = SERVER_SUI_PRIVATE_KEYS[keyIndex];
        if (!privateKey) {
            return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
        }

        // LOW-16: Validate packageId resembles a Sui address to prevent injection
        if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
            return res.status(400).json({ error: "Invalid packageId format" });
        }

        // MED-11: Validate owner address format
        if (owner && !/^0x[0-9a-fA-F]{64}$/.test(owner)) {
            return res.status(400).json({ error: "Invalid owner address format" });
        }

        // Decode signer
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);

        const signerAddress = signer.toSuiAddress();
        const blobData = new Uint8Array(Buffer.from(data, "base64"));

        // writeBlobFlow is intentionally not serialized by signer. Current Sui
        // no longer permanently locks coin objects for concurrent submissions;
        // transient gas/RPC races are retried by the Apalis wallet job layer.
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

        // Enoki rejects GasCoin tx arguments, but direct signing needs them for
        // normal gas selection. Patch only the cloned sponsor transaction.
        const tipRecipient = await getUploadRelayTipAddress();
        const registerAllowedAddresses = dedupeAddresses([signerAddress, tipRecipient]);
        const registerDigest = await submitWalletTransaction(
            registerTx,
            signer,
            registerAllowedAddresses,
            { patchGasCoinIntentsForSponsor: true },
        );
        await suiClient.waitForTransaction({ digest: registerDigest });

        await flow.upload({ digest: registerDigest });

        const certifyTx = flow.certify();
        const certifyDigest = await submitWalletTransaction(certifyTx, signer);
        await suiClient.waitForTransaction({ digest: certifyDigest });

        const blob = await flow.getBlob();

        const blobObjectId = extractBlobObjectId(blob);

        // Set on-chain metadata + transfer blob to user in a single transaction
        if (!deferTransfer && owner && owner !== signerAddress && blobObjectId) {
            try {
                await setMetadataAndTransferBlobs(
                    signer,
                    [{ blobObjectId, namespace }],
                    owner,
                    packageId,
                    agentId,
                );
                console.log(`[walrus/upload] metadata set + transferred blob ${blobObjectId} to owner (ns=${namespace})`);
            } catch (metaErr: any) {
                // LOW-14: Previously the metadata-set + transfer failure was swallowed
                // and /walrus/upload returned 200 with the blob_id, leaving the blob
                // owned by the server wallet and the client unable to observe the
                // failure. We still can't delete the blob from Walrus (no delete
                // primitive after certify), so at minimum we log loudly AND return
                // 500 so the caller can react (retry / mark stored-but-not-owned).
                console.error(
                    `[walrus/upload] metadata+transfer FAILED for blob_object=${blobObjectId} ` +
                    `ns=${namespace || "default"}: ${metaErr?.message || metaErr}`
                );
                return res.status(500).json({
                    error: "Blob uploaded but metadata/transfer to owner failed",
                    blobId: blob.blobId,
                    objectId: blobObjectId,
                    transferStatus: "failed",
                });
            }
        }

        res.json({
            blobId: blob.blobId,
            objectId: blobObjectId,
            transferStatus: deferTransfer ? "deferred" : "ok",
        });
    } catch (err: any) {
        const traceId = randomUUID();
        const message = err?.message || String(err);
        console.error(`[walrus/upload] [${traceId}] error:`, err);
        res.status(500).json({ error: message, traceId });
    }
});

// ============================================================
// POST /walrus/set-metadata-batch
// ============================================================
app.post("/walrus/set-metadata-batch", express.json({ limit: "1mb" }), async (req, res) => {
    try {
        const { blobs, owner, packageId, agentId, keyIndex } = req.body;
        if (!Array.isArray(blobs) || blobs.length === 0 || !owner || keyIndex === undefined) {
            return res.status(400).json({ error: "Missing required fields: blobs, owner, keyIndex" });
        }
        if (blobs.length > 20) {
            return res.status(400).json({ error: "Too many blobs in batch" });
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(owner)) {
            return res.status(400).json({ error: "Invalid owner address format" });
        }
        if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
            return res.status(400).json({ error: "Invalid packageId format" });
        }

        const privateKey = SERVER_SUI_PRIVATE_KEYS[keyIndex];
        if (!privateKey) {
            return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
        }

        const normalized: MetadataTransferBlob[] = blobs.map((blob: any, idx: number) => {
            const blobObjectId = blob?.blobObjectId;
            if (typeof blobObjectId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(blobObjectId)) {
                throw new Error(`Invalid blobs[${idx}].blobObjectId`);
            }
            const namespace = typeof blob?.namespace === "string" && blob.namespace.length > 0
                ? blob.namespace
                : "default";
            return { blobObjectId, namespace };
        });

        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);
        const digest = await setMetadataAndTransferBlobs(signer, normalized, owner, packageId, agentId);
        console.log(`[walrus/set-metadata-batch] transferred ${normalized.length} blobs to owner`);
        res.json({ transferred: normalized.length, digest });
    } catch (err: any) {
        const traceId = randomUUID();
        const message = err?.message || String(err);
        console.error(`[walrus/set-metadata-batch] [${traceId}] error:`, err);
        res.status(500).json({ error: message, traceId });
    }
});

// Legacy single-blob endpoint kept for older queued jobs.
app.post("/walrus/set-metadata", express.json({ limit: "128kb" }), async (req, res) => {
    try {
        const { blobObjectId, owner, namespace, packageId, agentId, keyIndex } = req.body;
        if (!blobObjectId || !owner || keyIndex === undefined) {
            return res.status(400).json({ error: "Missing required fields: blobObjectId, owner, keyIndex" });
        }
        req.body.blobs = [{ blobObjectId, namespace: namespace || "default" }];

        const privateKey = SERVER_SUI_PRIVATE_KEYS[keyIndex];
        if (!privateKey) {
            return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
        }
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);
        const digest = await setMetadataAndTransferBlobs(
            signer,
            [{ blobObjectId, namespace: namespace || "default" }],
            owner,
            packageId,
            agentId,
        );
        res.json({ transferred: 1, digest });
    } catch (err: any) {
        const traceId = randomUUID();
        const message = err?.message || String(err);
        console.error(`[walrus/set-metadata] [${traceId}] error:`, err);
        res.status(500).json({ error: message, traceId });
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

app.post("/walrus/query-blobs", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
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
            blobAgentId: string;
        };

        const metas: BlobMeta[] = await mapConcurrent(rawObjs, 5, async (obj) => {
            let blobNamespace = "default";
            let blobOwner = "";
            let blobPackageId = "";
            let blobAgentId = "";

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
                            if (key === "memwal_agent_id") blobAgentId = value;
                        }
                    }
                }
            } catch {
                // No dynamic field = no metadata = use defaults
            }

            return { ...obj, blobNamespace, blobOwner, blobPackageId, blobAgentId };
        });

        // Step 3: Filter + convert blob IDs
        const blobs: { blobId: string; objectId: string; namespace: string; packageId: string; agentId: string }[] = [];

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
                blobs.push({ blobId: blobIdStr, objectId: meta.objectId, namespace: meta.blobNamespace, packageId: meta.blobPackageId, agentId: meta.blobAgentId });
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
app.post("/sponsor", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
    try {
        const { transactionBlockKindBytes, sender } = req.body;
        if (!transactionBlockKindBytes || !sender) {
            return res.status(400).json({ error: "Missing required fields: transactionBlockKindBytes, sender" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        // LOW-18: Redact full sender address (PII / deanonymisation) — log only
        // a short prefix for correlation. Never log the full digest here either.
        const senderPrefix = typeof sender === "string" ? sender.slice(0, 10) : "unknown";
        console.log(`[sponsor] creating sponsored tx for sender=${senderPrefix}...`);
        const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
            network: enokiNetwork,
            transactionBlockKindBytes,
            sender,
        });

        console.log(`[sponsor] sponsored tx created (digest_len=${sponsored.digest.length})`);
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
app.post("/sponsor/execute", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
    try {
        const { digest, signature } = req.body;
        if (!digest || !signature) {
            return res.status(400).json({ error: "Missing required fields: digest, signature" });
        }
        if (!enokiApiKey) {
            return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
        }

        // LOW-15: Percent-encode digest before path interpolation. The digest is
        // attacker-controlled when the sidecar is reached directly (no auth,
        // S1 in audit) or via the Rust proxy which validates base58 but the
        // sidecar must not rely on that. encodeURIComponent neutralises any
        // path traversal (`..`), query injection (`?`), or fragment (`#`)
        // payloads in the digest segment.
        const encodedDigest = encodeURIComponent(digest);
        const executed = await callEnoki<EnokiExecuteResponse>(
            `/transaction-blocks/sponsor/${encodedDigest}`,
            { digest, signature }
        );

        // LOW-18: Redact digest from console logs — it's a high-cardinality
        // value that ties log lines to individual user transactions. Log only
        // a length indicator for diagnostics.
        console.log(`[sponsor/execute] executed sponsored tx (digest_len=${digest.length})`);
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
const HOST = process.env.SIDECAR_HOST || "127.0.0.1";
const server = app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
        event: "sidecar_ready",
        host: HOST,
        port: PORT,
        pid: process.pid,
    }));
});

// Graceful shutdown — close MCP transports first so SSE clients disconnect
// cleanly, then close the HTTP server.
async function gracefulShutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({ event: "sidecar_shutdown_begin", signal }));
    try {
        await shutdownMcpSessions();
    } catch (err: any) {
        console.error(`[sidecar] mcp shutdown error: ${err?.message || err}`);
    }
    server.close((err) => {
        if (err) {
            console.error(`[sidecar] http close error: ${err.message}`);
            process.exit(1);
        }
        console.log(JSON.stringify({ event: "sidecar_shutdown_complete" }));
        process.exit(0);
    });
    setTimeout(() => {
        console.error("[sidecar] forced exit after 5s");
        process.exit(1);
    }, 5_000).unref();
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
