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
import { isWalrusPackageVersionMismatch } from "./walrus-error-detection.js";

// ============================================================
// Shared clients (initialized once at boot — the whole point!)
// ============================================================
// ============================================================
// Environment-driven network config
// ============================================================

const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";

const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);
const SEAL_KEY_SERVER_TIMEOUT_MS = parsePositiveIntEnv(
    "SEAL_KEY_SERVER_TIMEOUT_MS",
    25_000,
    1_000,
    120_000,
);

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

const MAX_WALRUS_EPOCHS = 5;
const DEFAULT_WALRUS_EPOCHS = (() => {
    const parsed = Number.parseInt(process.env.WALRUS_STORAGE_EPOCHS || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(parsed, MAX_WALRUS_EPOCHS);
    }
    return SUI_NETWORK === "mainnet" ? 3 : MAX_WALRUS_EPOCHS;
})();
const SUI_RPC_URL = getJsonRpcFullnodeUrl(SUI_NETWORK);

const suiClient = new SuiJsonRpcClient({
    url: SUI_RPC_URL,
    network: SUI_NETWORK,
});

const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_SERVER_CONFIGS,
    verifyKeyServers: true,
    timeout: SEAL_KEY_SERVER_TIMEOUT_MS,
});

function createWalrusClient(): WalrusClient {
    return new WalrusClient({
        network: SUI_NETWORK,
        suiClient: suiClient as any,
        uploadRelay: {
            host: WALRUS_UPLOAD_RELAY_URL,
            sendTip: { max: 10_000_000 },
        },
    });
}

let walrusClient = createWalrusClient();
let walrusClientCreatedAtMs = Date.now();
const sidecarStartedAtMs = Date.now();

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

function clampWalrusEpochs(rawEpochs: unknown): number {
    const parsed = Number(rawEpochs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_WALRUS_EPOCHS;
    }
    return Math.min(Math.floor(parsed), MAX_WALRUS_EPOCHS);
}

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
const WALRUS_CLIENT_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.WALRUS_CLIENT_MAX_AGE_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();
// Mirror of services/server/src/alerts.rs SIDECAR_WALRUS_DEP_VERSION.
// Bump this in lockstep with package.json's @mysten/walrus dep so the
// version-mismatch warn log reports the actual runtime dep.
const WALRUS_DEP_VERSION = "1.1.7";
const UPLOAD_RELAY_TIP_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.UPLOAD_RELAY_TIP_CACHE_TTL_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

type EnokiDataWrapper<T> = { data: T };
type EnokiSponsorResponse = { bytes: string; digest: string };
type EnokiExecuteResponse = { digest: string };

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
let uploadRelayTipAddressCacheLoadedAtMs = 0;
let activeWalrusUploads = 0;

function shortAddress(address: unknown): string | undefined {
    if (typeof address !== "string") return undefined;
    if (address.length <= 18) return address;
    return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

function truncateForLog(value: unknown, max = 500): string {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function parsePositiveIntEnv(
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min) {
        console.warn(`[sidecar] ignoring invalid ${name}=${raw}; using ${fallback}`);
        return fallback;
    }
    return Math.min(parsed, max);
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}

function errorName(err: unknown): string {
    if (err instanceof Error && err.name) return err.name;
    if (typeof err === "object" && err && "name" in err) {
        const name = (err as { name?: unknown }).name;
        if (typeof name === "string" && name.length > 0) return name;
    }
    return "Error";
}

function formattedError(err: unknown): string {
    const name = errorName(err);
    const msg = errorMessage(err);
    return name && name !== "Error" ? `${name}: ${msg}` : msg;
}

function sendSealFailure(
    res: Response,
    operation: string,
    phase: string,
    err: unknown,
    traceId: string = randomUUID(),
) {
    const message = formattedError(err);
    const error = `${operation} failed during ${phase}: ${message} (traceId=${traceId}, timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS})`;
    console.error(`[${operation}] [${traceId}] phase=${phase} timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS} error: ${message}`, err);
    res.status(500).json({
        error,
        traceId,
        phase,
        timeoutMs: SEAL_KEY_SERVER_TIMEOUT_MS,
        errorName: errorName(err),
    });
}

function redactEnokiPath(path: string): string {
    return path.replace(/\/transaction-blocks\/sponsor\/[^/?]+/, "/transaction-blocks/sponsor/<digest>");
}

function summarizeEnokiError(text: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(text) as { errors?: Array<{ code?: string; message?: string }> };
        if (Array.isArray(parsed.errors)) {
            return {
                errors: parsed.errors.map((err) => ({
                    code: err.code,
                    message: truncateForLog(err.message || ""),
                    hasMoveAbort: /moveabort/i.test(err.message || ""),
                    hasBalanceSplit: /balance.*split|split.*balance/i.test(err.message || ""),
                })),
            };
        }
    } catch {
        // Fall through to raw body summary.
    }
    return { body: truncateForLog(text) };
}

function isMoveAbortBalanceSplit(message: string): boolean {
    return /moveabort/i.test(message) && /balance.*split|split.*balance/i.test(message);
}

/**
 * Fetch the Walrus on-chain System object's version (u64 -> decimal string).
 * Reads go through the version-unchecked `inner` accessor so even the
 * stale cached client returns the value it last cached. After
 * refreshWalrusClient(), the recreated client refetches fresh metadata so
 * the returned value reflects the new on-chain version.
 *
 * Safe in the error path: any failure (RPC down, API drift) returns null
 * rather than throwing — we never want diagnostic logging to mask the
 * original error.
 */
async function fetchWalrusSystemVersion(): Promise<string | null> {
    try {
        const sys = await walrusClient.systemObject();
        const version = (sys as any)?.version;
        if (version === undefined || version === null) return null;
        return String(version);
    } catch {
        return null;
    }
}

function clearUploadRelayTipCache(): void {
    uploadRelayTipAddressCache = undefined;
    uploadRelayTipAddressCacheLoadedAtMs = 0;
}

function refreshWalrusClient(reason: string): void {
    try {
        walrusClient.reset();
    } catch (err: any) {
        console.warn(`[walrus/client] reset failed before refresh reason=${reason}: ${err?.message || err}`);
    }
    walrusClient = createWalrusClient();
    walrusClientCreatedAtMs = Date.now();
    clearUploadRelayTipCache();
    console.warn(`[walrus/client] refreshed reason=${reason}`);
}

function refreshWalrusClientIfStale(): void {
    const ageMs = Date.now() - walrusClientCreatedAtMs;
    if (ageMs >= WALRUS_CLIENT_MAX_AGE_MS) {
        refreshWalrusClient(`max_age_${ageMs}ms`);
    }
}

function sidecarStateSnapshot(): Record<string, unknown> {
    const memory = process.memoryUsage();
    const now = Date.now();
    return {
        pid: process.pid,
        uptimeMs: now - sidecarStartedAtMs,
        memory: {
            rssMb: Math.round(memory.rss / 1024 / 1024),
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
            externalMb: Math.round(memory.external / 1024 / 1024),
        },
        activeWalrusUploads,
        walletSubmittedTotal: sidecarMetrics.walletSubmittedTotal,
        walletLockErrorsTotal: sidecarMetrics.walletLockErrorsTotal,
        walletPermanentFailuresTotal: sidecarMetrics.walletPermanentFailuresTotal,
        uploadRelayTipCache:
            uploadRelayTipAddressCache === undefined
                ? "uninitialized"
                : uploadRelayTipAddressCache === null
                    ? "none"
                    : "present",
        uploadRelayTipCacheAgeMs: uploadRelayTipAddressCache === undefined
            ? null
            : now - uploadRelayTipAddressCacheLoadedAtMs,
        walrusClientAgeMs: now - walrusClientCreatedAtMs,
        serverKeyCount: SERVER_SUI_PRIVATE_KEYS.length,
        sealServerCount: SEAL_SERVER_CONFIGS.length,
        sealThreshold: SEAL_THRESHOLD,
        sealKeyServerTimeoutMs: SEAL_KEY_SERVER_TIMEOUT_MS,
        suiNetwork: SUI_NETWORK,
        enokiNetwork,
        enokiEnabled: !!enokiApiKey,
        fallbackToDirectSign: ENOKI_FALLBACK_TO_DIRECT_SIGN,
    };
}

function dedupeAddresses(addresses: (string | null | undefined)[]): string[] {
    return [...new Set(addresses.filter((addr): addr is string => typeof addr === "string" && addr.length > 0))];
}

async function getUploadRelayTipAddress(): Promise<string | null> {
    if (
        uploadRelayTipAddressCache !== undefined &&
        Date.now() - uploadRelayTipAddressCacheLoadedAtMs < UPLOAD_RELAY_TIP_CACHE_TTL_MS
    ) {
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
            uploadRelayTipAddressCacheLoadedAtMs = Date.now();
            return address;
        }

        uploadRelayTipAddressCache = null;
        uploadRelayTipAddressCacheLoadedAtMs = Date.now();
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
        console.error(`[enoki] api_error ${JSON.stringify({
            path: redactEnokiPath(path),
            status: resp.status,
            network: enokiNetwork,
            ...summarizeEnokiError(text),
        })}`);
        throw new Error(`Enoki API error (${resp.status}): ${text}`);
    }

    const parsed = JSON.parse(text) as EnokiDataWrapper<T>;
    return parsed.data;
}

function isSponsoredTransactionExpired(err: unknown): boolean {
    const msg = errorMessage(err);
    return /sponsored transaction has expired/i.test(msg)
        || /"code"\s*:\s*"expired"/i.test(msg);
}

async function executeSponsoredTransactionOnce(
    tx: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
): Promise<string> {
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
}

async function executeWithEnokiSponsor(tx: Transaction, signer: Ed25519Keypair, allowedAddresses?: string[]): Promise<string> {
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

    let sponsorError: unknown;
    try {
        return await executeSponsoredTransactionOnce(tx, signer, allowedAddresses);
    } catch (err: any) {
        if (isSponsoredTransactionExpired(err)) {
            console.warn(`[enoki-sponsor] sponsored tx expired; retrying sponsor/execute once: ${err?.message || err}`);
            try {
                return await executeSponsoredTransactionOnce(tx, signer, allowedAddresses);
            } catch (retryErr: any) {
                sponsorError = retryErr;
            }
        } else {
            sponsorError = err;
        }
    }

    {
        const err = sponsorError;
        const errMsg = errorMessage(err);
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

async function getSuiBalanceMist(owner: string): Promise<string | null> {
    try {
        const balance = await (suiClient as any).getBalance({ owner, coinType: SUI_TYPE });
        return typeof balance?.totalBalance === "string" ? balance.totalBalance : null;
    } catch (err: any) {
        console.warn(`[wallet] balance lookup failed for ${shortAddress(owner)}: ${err?.message || err}`);
        return null;
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
): Promise<string> {
    try {
        const digest = await executeWithEnokiSponsor(tx, signer, allowedAddresses);
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
type RequestWithId = Request & { requestId?: string };

function sanitizeRequestId(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed)) return null;
    return trimmed;
}

function requestIdFor(req: Request): string {
    return (req as RequestWithId).requestId
        ?? sanitizeRequestId(req.headers["x-request-id"])
        ?? randomUUID();
}

function sidecarLog(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
): void {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: "memwal-sidecar",
        event,
        ...fields,
    });
    if (level === "error") {
        console.error(line);
    } else if (level === "warn") {
        console.warn(line);
    } else {
        console.log(line);
    }
}

app.use((req: RequestWithId, res: Response, next: NextFunction) => {
    const requestId = sanitizeRequestId(req.headers["x-request-id"])
        ?? sanitizeRequestId(req.headers["x-correlation-id"])
        ?? randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});

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
    res.json({
        status: "ok",
        uptimeMs: Date.now() - sidecarStartedAtMs,
        activeWalrusUploads,
    });
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
    let phase = "validate";
    try {
        const { data, owner, packageId } = req.body;
        if (!data || !owner || !packageId) {
            return res.status(400).json({ error: "Missing required fields: data, owner, packageId" });
        }

        phase = "encrypt";
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
        sendSealFailure(res, "seal/encrypt", phase, err, requestIdFor(req));
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
    let phase = "validate";
    try {
        const { data, packageId, accountId } = req.body;
        if (!data || !packageId || !accountId) {
            return res.status(400).json({ error: "Missing required fields: data, packageId, accountId" });
        }

        phase = "resolve_session";
        // ENG-1697: resolve credential (x-seal-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
            });
        }

        phase = "parse";
        // Parse encrypted object to get key ID
        const encryptedData = new Uint8Array(Buffer.from(data, "base64"));
        const parsed = EncryptedObject.parse(encryptedData);
        const fullId = parsed.id;

        phase = "build_ptb";
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

        phase = "fetch_keys";
        // Fetch keys from key servers
        await sealClient.fetchKeys({
            ids: [fullId],
            txBytes,
            sessionKey,
            threshold: SEAL_THRESHOLD,
        });

        phase = "decrypt";
        // Decrypt locally
        const decrypted = await sealClient.decrypt({
            data: encryptedData,
            sessionKey,
            txBytes,
        });

        const decryptedBase64 = Buffer.from(decrypted).toString("base64");
        res.json({ decryptedData: decryptedBase64 });
    } catch (err: any) {
        sendSealFailure(res, "seal/decrypt", phase, err, requestIdFor(req));
    }
});

// ============================================================
// POST /seal/decrypt-batch
// Decrypt multiple SEAL-encrypted blobs with a single SessionKey.
// Avoids "Not enough shares" errors when decrypting many blobs at once.
// ============================================================
// HIGH-13: batch body can be large (up to 25 × ~320 KiB max-item = ~8 MB).
app.post("/seal/decrypt-batch", express.json({ limit: JSON_LIMIT_SEAL_DECRYPT_BATCH }), async (req, res) => {
    let phase = "validate";
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

        phase = "resolve_session";
        // ENG-1697: resolve credential (x-seal-session preferred; legacy
        // x-delegate-key supported during the deprecation window).
        const sessionKey = await resolveSessionKey(req, packageId);
        if (!sessionKey) {
            return res.status(400).json({
                error: "Missing credential: provide x-seal-session (preferred) or x-delegate-key header",
            });
        }

        phase = "parse";
        // Parse all encrypted objects and collect unique SEAL IDs
        const parsedItems: { index: number; encryptedData: Uint8Array; fullId: string }[] = [];
        const errors: { index: number; error: string }[] = [];

        for (let i = 0; i < items.length; i++) {
            try {
                const encryptedData = new Uint8Array(Buffer.from(items[i], "base64"));
                const parsed = EncryptedObject.parse(encryptedData);
                parsedItems.push({ index: i, encryptedData, fullId: parsed.id });
            } catch (err: any) {
                errors.push({ index: i, error: `parse failed: ${errorMessage(err)}` });
            }
        }

        if (parsedItems.length === 0) {
            return res.json({ results: [], errors });
        }

        phase = "build_ptb";
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

        phase = "fetch_keys";
        // ONE fetchKeys call for ALL IDs
        try {
            await sealClient.fetchKeys({
                ids: allIds,
                txBytes,
                sessionKey,
                threshold: SEAL_THRESHOLD,
            });
        } catch (err: any) {
            const traceId = randomUUID();
            const message = formattedError(err);
            const error = `fetch_keys failed: ${message} (traceId=${traceId}, timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS})`;
            console.error(
                `[seal/decrypt-batch] [${traceId}] phase=fetch_keys items=${parsedItems.length} uniqueIds=${allIds.length} timeoutMs=${SEAL_KEY_SERVER_TIMEOUT_MS} error: ${message}`,
                err,
            );
            return res.json({
                results: [],
                errors: [
                    ...errors,
                    ...parsedItems.map((item) => ({ index: item.index, error })),
                ],
            });
        }

        phase = "decrypt";
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
                errors.push({ index: item.index, error: `decrypt failed: ${formattedError(err)}` });
            }
        }

        console.log(`[seal/decrypt-batch] ${results.length}/${items.length} decrypted ok, ${errors.length} errors`);
        res.json({ results, errors });
    } catch (err: any) {
        sendSealFailure(res, "seal/decrypt-batch", phase, err, requestIdFor(req));
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
    const traceId = requestIdFor(req);
    let phase = "receive";
    let keyIndexForLog: unknown;
    let ownerForLog: unknown;
    let namespaceForLog: unknown;
    let signerAddressForLog: string | undefined;
    let blobBytesForLog: number | undefined;
    activeWalrusUploads += 1;
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
        keyIndexForLog = keyIndex;
        ownerForLog = owner;
        namespaceForLog = namespace;
        // LOW-17: Cap epochs to prevent accidental large storage purchases.
        const epochs = clampWalrusEpochs(rawEpochs);

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
        phase = "decode_signer";
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        const signer = Ed25519Keypair.fromSecretKey(secretKey);

        const signerAddress = signer.toSuiAddress();
        signerAddressForLog = signerAddress;
        const blobData = new Uint8Array(Buffer.from(data, "base64"));
        blobBytesForLog = blobData.length;
        refreshWalrusClientIfStale();
        const signerSuiBalanceMist = await getSuiBalanceMist(signerAddress);
        console.log(`[walrus/upload] [${traceId}] begin ${JSON.stringify({
            keyIndex,
            signer: shortAddress(signerAddress),
            owner: shortAddress(owner),
            namespace: namespace || "default",
            bytes: blobData.length,
            epochs,
            deferTransfer,
            signerSuiBalanceMist,
            enokiEnabled: !!enokiApiKey,
            fallbackToDirectSign: ENOKI_FALLBACK_TO_DIRECT_SIGN,
            state: sidecarStateSnapshot(),
        })}`);

        // writeBlobFlow is intentionally not serialized by signer. Current Sui
        // no longer permanently locks coin objects for concurrent submissions;
        // transient gas/RPC races are retried by the Apalis wallet job layer.
        phase = "encode";
        const flow = walrusClient.writeBlobFlow({ blob: blobData });
        await flow.encode();

        phase = "register_build";
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
        phase = "register_sponsor";
        console.log(`[walrus/upload] [${traceId}] register_sponsor ${JSON.stringify({
            keyIndex,
            signer: shortAddress(signerAddress),
            tipRecipient: shortAddress(tipRecipient),
            allowedAddresses: registerAllowedAddresses.map(shortAddress),
        })}`);
        const registerDigest = await submitWalletTransaction(
            registerTx,
            signer,
            registerAllowedAddresses,
        );
        phase = "register_wait";
        await suiClient.waitForTransaction({ digest: registerDigest });

        phase = "upload_blob";
        await flow.upload({ digest: registerDigest });

        phase = "certify_sponsor";
        const certifyTx = flow.certify();
        const certifyDigest = await submitWalletTransaction(certifyTx, signer);
        phase = "certify_wait";
        await suiClient.waitForTransaction({ digest: certifyDigest });

        phase = "get_blob";
        const blob = await flow.getBlob();

        const blobObjectId = extractBlobObjectId(blob);

        // Set on-chain metadata + transfer blob to user in a single transaction
        if (!deferTransfer && owner && owner !== signerAddress && blobObjectId) {
            try {
                phase = "metadata_transfer";
                await setMetadataAndTransferBlobs(
                    signer,
                    [{ blobObjectId, namespace }],
                    owner,
                    packageId,
                    agentId,
                );
                console.log(`[walrus/upload] [${traceId}] metadata_transfer_ok ${JSON.stringify({
                    blobObjectId,
                    owner: shortAddress(owner),
                    namespace: namespace || "default",
                })}`);
            } catch (metaErr: any) {
                // LOW-14: Previously the metadata-set + transfer failure was swallowed
                // and /walrus/upload returned 200 with the blob_id, leaving the blob
                // owned by the server wallet and the client unable to observe the
                // failure. We still can't delete the blob from Walrus (no delete
                // primitive after certify), so at minimum we log loudly AND return
                // 500 so the caller can react (retry / mark stored-but-not-owned).
                console.error(
                    `[walrus/upload] [${traceId}] metadata+transfer FAILED for blob_object=${blobObjectId} ` +
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

        phase = "respond";
        console.log(`[walrus/upload] [${traceId}] ok ${JSON.stringify({
            blobId: blob.blobId,
            objectId: blobObjectId,
            transferStatus: deferTransfer ? "deferred" : "ok",
            keyIndex,
            bytes: blobBytesForLog,
        })}`);
        res.json({
            blobId: blob.blobId,
            objectId: blobObjectId,
            transferStatus: deferTransfer ? "deferred" : "ok",
        });
    } catch (err: any) {
        const message = err?.message || String(err);
        if (phase === "register_sponsor" && isMoveAbortBalanceSplit(message)) {
            refreshWalrusClient("register_sponsor_balance_split");
        }
        if (isWalrusPackageVersionMismatch(message)) {
            // EWrongVersion is phase-independent: can fire from register / upload / certify
            // any time the Walrus system package gets upgraded on-chain after this sidecar
            // booted. Refresh the cached client so the next Apalis retry picks up the new
            // package metadata; no in-handler retry needed.
            const versionBefore = await fetchWalrusSystemVersion();
            refreshWalrusClient("walrus_package_version_mismatch");
            const versionAfter = await fetchWalrusSystemVersion();
            console.warn(
                `[walrus/client] EWrongVersion detected — Walrus on-chain package upgraded. ` +
                `Action: client refreshed, Apalis will retry against new package metadata. ` +
                `Walrus system version: before=${versionBefore ?? "unknown"} after=${versionAfter ?? "unknown"}. ` +
                `Sidecar @mysten/walrus dep=${WALRUS_DEP_VERSION}. ` +
                `traceId=${traceId}`
            );
        }
        const postFailureSignerSuiBalanceMist = signerAddressForLog
            ? await getSuiBalanceMist(signerAddressForLog)
            : null;
        console.error(`[walrus/upload] [${traceId}] failed ${JSON.stringify({
            phase,
            keyIndex: keyIndexForLog,
            signer: shortAddress(signerAddressForLog),
            owner: shortAddress(ownerForLog),
            namespace: namespaceForLog || "default",
            bytes: blobBytesForLog,
            uptimeMs: Date.now() - sidecarStartedAtMs,
            postFailureSignerSuiBalanceMist,
            message: truncateForLog(message),
            hasMoveAbort: /moveabort/i.test(message),
            hasBalanceSplit: /balance.*split|split.*balance/i.test(message),
            state: sidecarStateSnapshot(),
        })}`, err);
        sidecarLog("error", "walrus_upload_failed", {
            requestId: traceId,
            phase,
            error: message,
        });
        res.status(500).json({ error: message, traceId });
    } finally {
        activeWalrusUploads = Math.max(0, activeWalrusUploads - 1);
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
        const traceId = requestIdFor(req);
        const message = errorMessage(err);
        sidecarLog("error", "walrus_set_metadata_batch_failed", {
            requestId: traceId,
            error: message,
        });
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
        const traceId = requestIdFor(req);
        const message = errorMessage(err);
        sidecarLog("error", "walrus_set_metadata_failed", {
            requestId: traceId,
            error: message,
        });
        res.status(500).json({ error: message, traceId });
    }
});

// ============================================================
// POST /walrus/query-blobs
// Query user's Walrus Blob objects from Sui chain, filter by namespace
// ============================================================

/**
 * Direct JSON-RPC helper for APIs that are not consistently exposed across
 * @mysten/sui client minor versions used by this sidecar.
 */
async function suiRpc<T>(method: string, params: unknown[]): Promise<T> {
    const resp = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method,
            params,
        }),
    });

    const text = await resp.text();
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error(`Sui RPC ${method} returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }

    if (!resp.ok || body.error) {
        const message = body.error?.message || text || `HTTP ${resp.status}`;
        throw new Error(`Sui RPC ${method} failed: ${message}`);
    }

    return body.result as T;
}

function isRetryableRpcError(err: any): boolean {
    const msg = String(err?.message || err).toLowerCase();
    return msg.includes("429")
        || msg.includes("503")
        || msg.includes("rate")
        || msg.includes("too many")
        || msg.includes("timeout")
        || msg.includes("temporarily unavailable");
}

async function withRpcRetry<T>(
    label: string,
    fn: () => Promise<T>,
    maxRetries = 4,
): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            if (!isRetryableRpcError(err) || attempt === maxRetries - 1) throw err;
            const baseDelayMs = 1_000 * Math.pow(2, attempt);
            const jitterMs = Math.floor(Math.random() * Math.floor(baseDelayMs * 0.4));
            const delayMs = Math.min(15_000, baseDelayMs + jitterMs);
            console.warn(`[query-blobs] ${label} retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

function blobIdFromRaw(rawBlobId: string | number | null | undefined): string | null {
    if (!rawBlobId) return null;
    let blobIdStr = String(rawBlobId);
    if (/^\d+$/.test(blobIdStr) && blobIdStr.length > 20) {
        try {
            const bigInt = BigInt(blobIdStr);
            const hex = bigInt.toString(16).padStart(64, "0");
            const bytesBE = hex.match(/.{2}/g)!.map(b => parseInt(b, 16));
            const bytesLE = new Uint8Array(bytesBE.reverse());
            blobIdStr = Buffer.from(bytesLE).toString("base64url");
        } catch {
            // Keep as-is if conversion fails.
        }
    }
    return blobIdStr;
}

function ownerMatchesRecipient(recipient: any, owner: string): boolean {
    if (typeof recipient === "string") return recipient === owner;
    if (!recipient || typeof recipient !== "object") return false;
    return recipient.AddressOwner === owner
        || recipient.ObjectOwner === owner
        || recipient.SingleOwner === owner
        || recipient.owner === owner;
}

function isWalrusBlobObjectType(objectType: any, blobType: string): boolean {
    if (objectType === blobType) return true;
    if (typeof objectType !== "string") return false;
    const objectParts = objectType.split("::");
    const blobParts = blobType.split("::");
    return objectParts.length === 3
        && blobParts.length === 3
        && objectParts[1] === blobParts[1]
        && objectParts[2] === blobParts[2]
        && objectParts[0].toLowerCase().replace(/^0x0+/, "0x") === blobParts[0].toLowerCase().replace(/^0x0+/, "0x");
}

type RecentBlobCandidate = {
    objectId: string;
    timestampMs: string | null;
};

type RawBlobObj = {
    objectId: string;
    rawBlobId: string | number | null;
    timestampMs?: string | null;
};

/**
 * Query newest transactions that transferred Walrus Blob objects to the owner.
 * This avoids scanning every Blob object in the wallet before namespace
 * filtering. We still verify object content/metadata after collecting
 * candidates.
 */
async function queryRecentBlobObjectCandidates(
    owner: string,
    blobType: string,
    desiredMatches: number,
): Promise<RecentBlobCandidate[]> {
    const candidateCap = Math.max(1, Math.min(desiredMatches * 5, 100));
    const txPageSize = 50;
    const candidates: RecentBlobCandidate[] = [];
    const seen = new Set<string>();
    let cursor: any = null;

    while (candidates.length < candidateCap) {
        const result = await withRpcRetry<any>(
            "queryTransactionBlocks",
            () => suiRpc("suix_queryTransactionBlocks", [
                {
                    filter: { ToAddress: owner },
                    options: {
                        showObjectChanges: true,
                        showEffects: false,
                        showInput: false,
                    },
                },
                cursor,
                txPageSize,
                true,
            ]),
        );

        const txs = Array.isArray(result?.data) ? result.data : [];
        if (txs.length === 0) break;

        for (const tx of txs) {
            const timestampMs = typeof tx.timestampMs === "string" ? tx.timestampMs : null;
            const objectChanges = Array.isArray(tx.objectChanges) ? tx.objectChanges : [];
            for (const change of objectChanges) {
                if (!isWalrusBlobObjectType(change?.objectType, blobType)) continue;
                if (change?.type !== "transferred" && change?.type !== "created" && change?.type !== "mutated") continue;
                const belongsToOwner = ownerMatchesRecipient(change.recipient, owner)
                    || ownerMatchesRecipient(change.owner, owner);
                if (!belongsToOwner) continue;
                const objectId = change.objectId;
                if (typeof objectId !== "string" || seen.has(objectId)) continue;
                seen.add(objectId);
                candidates.push({ objectId, timestampMs });
                if (candidates.length >= candidateCap) break;
            }
            if (candidates.length >= candidateCap) break;
        }

        if (!result?.hasNextPage || !result?.nextCursor) break;
        cursor = result.nextCursor;
    }

    return candidates;
}

async function fetchRawBlobObjects(candidates: RecentBlobCandidate[]): Promise<RawBlobObj[]> {
    if (candidates.length === 0) return [];

    const timestampByObject = new Map(candidates.map(c => [c.objectId, c.timestampMs ?? null]));
    const results: any[] = [];
    for (let i = 0; i < candidates.length; i += 50) {
        const objectIds = candidates.slice(i, i + 50).map(c => c.objectId);
        const batch = await withRpcRetry<any[]>(
            "multiGetObjects",
            () => suiRpc("sui_multiGetObjects", [
                objectIds,
                {
                    showContent: true,
                    showType: true,
                },
            ]),
        );
        results.push(...(Array.isArray(batch) ? batch : []));
    }

    return results
        .map((obj: any) => {
            const objectId = obj?.data?.objectId;
            const content = obj?.data?.content;
            if (typeof objectId !== "string" || !content || content.dataType !== "moveObject") return null;
            const fields = content.fields;
            const rawBlobId = fields?.blob_id ?? fields?.blobId ?? null;
            return { objectId, rawBlobId, timestampMs: timestampByObject.get(objectId) ?? null };
        })
        .filter((obj: RawBlobObj | null): obj is RawBlobObj => obj !== null);
}

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
            if (!isRetryableRpcError(err) || attempt === maxRetries - 1) throw err;
            const baseDelayMs = 1_000 * Math.pow(2, attempt);
            const jitterMs = Math.floor(Math.random() * Math.floor(baseDelayMs * 0.4));
            const delayMs = Math.min(15_000, baseDelayMs + jitterMs);
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
        const { owner, namespace, packageId, limit } = req.body;
        if (!owner) {
            return res.status(400).json({ error: "Missing required field: owner" });
        }
        const desiredMatches = Math.max(1, Math.min(Number(limit) || 0, 500));
        const useRecentTxPath = Number.isFinite(Number(limit)) && Number(limit) > 0;

        // Walrus Blob type (derived from env-driven WALRUS_PACKAGE_ID)
        const WALRUS_BLOB_TYPE = `${WALRUS_PACKAGE_ID}::blob::Blob`;

        // Step 1: Collect raw blob objects. Restore passes `limit`, so prefer
        // newest transfer transactions and cap candidates at 100 instead of
        // scanning every Walrus Blob object owned by the wallet.
        let rawObjs: RawBlobObj[] = [];
        if (useRecentTxPath) {
            const candidates = await queryRecentBlobObjectCandidates(owner, WALRUS_BLOB_TYPE, desiredMatches);
            rawObjs = await fetchRawBlobObjects(candidates);
            console.log(
                `[query-blobs] found ${rawObjs.length}/${candidates.length} recent raw blob candidates for owner=${owner} ` +
                `(target=${desiredMatches}, candidateCap=${Math.min(desiredMatches * 5, 100)})`,
            );
        } else {
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
        }

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

        const metadataConcurrency = useRecentTxPath ? 2 : 5;
        const metas: BlobMeta[] = await mapConcurrent(rawObjs, metadataConcurrency, async (obj) => {
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
                // blob_id from chain is a big integer (U256); convert to base64url (little-endian).
                const blobIdStr = blobIdFromRaw(meta.rawBlobId);
                if (blobIdStr) {
                    blobs.push({ blobId: blobIdStr, objectId: meta.objectId, namespace: meta.blobNamespace, packageId: meta.blobPackageId, agentId: meta.blobAgentId });
                }
            }
        }

        console.log(`[query-blobs] returning ${blobs.length} blobs (filtered from ${rawObjs.length}) for owner=${owner} ns=${namespace || '*'}`);
        res.json({ blobs, total: blobs.length });
    } catch (err: any) {
        const traceId = requestIdFor(req);
        const message = errorMessage(err);
        sidecarLog("error", "walrus_query_blobs_failed", {
            requestId: traceId,
            error: message,
        });
        res.status(500).json({ error: message, traceId });
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
        const traceId = requestIdFor(req);
        const message = errorMessage(err);
        sidecarLog("error", "sponsor_failed", {
            requestId: traceId,
            error: message,
        });
        res.status(500).json({ error: message, traceId });
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
        const traceId = requestIdFor(req);
        const message = errorMessage(err);
        sidecarLog("error", "sponsor_execute_failed", {
            requestId: traceId,
            error: message,
        });
        res.status(500).json({ error: message, traceId });
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
        state: sidecarStateSnapshot(),
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
process.on("uncaughtException", (err) => {
    console.error(`[sidecar] uncaught_exception ${JSON.stringify({
        uptimeMs: Date.now() - sidecarStartedAtMs,
        message: truncateForLog(err?.message || String(err)),
        stack: truncateForLog(err?.stack || ""),
        state: sidecarStateSnapshot(),
    })}`);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error(`[sidecar] unhandled_rejection ${JSON.stringify({
        uptimeMs: Date.now() - sidecarStartedAtMs,
        reason: truncateForLog(reason instanceof Error ? reason.message : reason),
        stack: truncateForLog(reason instanceof Error ? reason.stack || "" : ""),
        state: sidecarStateSnapshot(),
    })}`);
});
