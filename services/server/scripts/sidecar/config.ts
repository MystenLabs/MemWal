/**
 * Environment-driven configuration for the sidecar.
 *
 * Every tunable lives here so the rest of the sidecar imports parsed
 * constants instead of re-reading process.env. Parsing happens once at
 * module load; invalid values fall back to defaults with a warning.
 */

import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "../seal-config.js";

export function parsePositiveIntEnv(
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

// ============================================================
// Network
// ============================================================

export const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";
export const SUI_RPC_URL = getJsonRpcFullnodeUrl(SUI_NETWORK);
export const SUI_TYPE = "0x2::sui::SUI";

// ============================================================
// SEAL
// ============================================================

export const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
export const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);
export const SEAL_KEY_SERVER_TIMEOUT_MS = parsePositiveIntEnv(
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

// ============================================================
// Server wallets (Walrus uploads)
// ============================================================

export const SERVER_SUI_PRIVATE_KEYS = (process.env.SERVER_SUI_PRIVATE_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

if (SERVER_SUI_PRIVATE_KEYS.length === 0 && process.env.SERVER_SUI_PRIVATE_KEY) {
    SERVER_SUI_PRIVATE_KEYS.push(process.env.SERVER_SUI_PRIVATE_KEY.trim());
}

if (SERVER_SUI_PRIVATE_KEYS.length === 0) {
    console.error("[sidecar] WARNING: SERVER_SUI_PRIVATE_KEYS env var is empty — Walrus uploads will fail");
}

// ============================================================
// Walrus
// ============================================================

// Walrus package ID (for on-chain Move calls: metadata, blob type queries)
export const WALRUS_PACKAGE_ID = process.env.WALRUS_PACKAGE_ID || (
    SUI_NETWORK === "testnet"
        ? "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"
        : "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77"
);

export const WALRUS_UPLOAD_RELAY_URL = process.env.WALRUS_UPLOAD_RELAY_URL || (
    SUI_NETWORK === "testnet"
        ? "https://upload-relay.testnet.walrus.space"
        : "https://upload-relay.mainnet.walrus.space"
);

export const MAX_WALRUS_EPOCHS = 15;
const DEFAULT_TESTNET_WALRUS_EPOCHS = 5;
const NETWORK_DEFAULT_WALRUS_EPOCHS = SUI_NETWORK === "mainnet" ? 3 : DEFAULT_TESTNET_WALRUS_EPOCHS;
export const DEFAULT_WALRUS_EPOCHS = (() => {
    const raw = process.env.WALRUS_STORAGE_EPOCHS?.trim();
    if (!raw) {
        return NETWORK_DEFAULT_WALRUS_EPOCHS;
    }

    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_WALRUS_EPOCHS) {
        return parsed;
    }

    if (Number.isFinite(parsed) && parsed > MAX_WALRUS_EPOCHS) {
        console.warn(
            `[sidecar] WALRUS_STORAGE_EPOCHS=${raw} exceeds max ${MAX_WALRUS_EPOCHS}; ` +
            `using network default ${NETWORK_DEFAULT_WALRUS_EPOCHS}`,
        );
    } else {
        console.warn(
            `[sidecar] ignoring invalid WALRUS_STORAGE_EPOCHS=${raw}; ` +
            `using network default ${NETWORK_DEFAULT_WALRUS_EPOCHS}`,
        );
    }

    return NETWORK_DEFAULT_WALRUS_EPOCHS;
})();

export function clampWalrusEpochs(rawEpochs: unknown): number {
    const parsed = Number(rawEpochs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_WALRUS_EPOCHS;
    }
    return Math.min(Math.floor(parsed), MAX_WALRUS_EPOCHS);
}

export const WALRUS_CLIENT_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.WALRUS_CLIENT_MAX_AGE_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();

// Mirror of services/server/src/alerts.rs SIDECAR_WALRUS_DEP_VERSION.
// Bump this in lockstep with package.json's @mysten/walrus dep so the
// version-mismatch warn log reports the actual runtime dep.
export const WALRUS_DEP_VERSION = "1.1.7";

export const UPLOAD_RELAY_TIP_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.UPLOAD_RELAY_TIP_CACHE_TTL_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

// ============================================================
// Walrus upload concurrency limits
// ============================================================

export const WALRUS_UPLOAD_MAX_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_MAX_CONCURRENCY",
    Math.max(1, SERVER_SUI_PRIVATE_KEYS.length || 1),
    1,
    100,
);
export const WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_PER_WALLET_CONCURRENCY",
    1,
    1,
    10,
);
export const WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = parsePositiveIntEnv(
    "WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS",
    120_000,
    1_000,
    180_000,
);
export const WALRUS_UPLOAD_EFFECTS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000] as const;

// ============================================================
// Enoki sponsorship
// ============================================================

export const ENOKI_API_BASE_URL = "https://api.enoki.mystenlabs.com/v1";
export const ENOKI_API_KEY = process.env.ENOKI_API_KEY;
export const ENOKI_NETWORK = (process.env.ENOKI_NETWORK || process.env.SUI_NETWORK || "mainnet") as
    | "mainnet"
    | "testnet"
    | "devnet";
export const ENOKI_FALLBACK_TO_DIRECT_SIGN = (() => {
    const raw = (process.env.ENOKI_FALLBACK_TO_DIRECT_SIGN || "false").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
})();
export const ENOKI_TRANSIENT_MAX_ATTEMPTS = parsePositiveIntEnv(
    "ENOKI_TRANSIENT_MAX_ATTEMPTS",
    2,
    1,
    5,
);
export const ENOKI_TRANSIENT_BASE_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_TRANSIENT_BASE_DELAY_MS",
    5_000,
    100,
    60_000,
);
export const ENOKI_TRANSIENT_MAX_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_TRANSIENT_MAX_DELAY_MS",
    30_000,
    1_000,
    120_000,
);
export const ENOKI_INVALIDATED_MAX_ATTEMPTS = parsePositiveIntEnv(
    "ENOKI_INVALIDATED_MAX_ATTEMPTS",
    4,
    1,
    10,
);
export const ENOKI_INVALIDATED_BASE_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_INVALIDATED_BASE_DELAY_MS",
    1_000,
    100,
    60_000,
);
export const ENOKI_INVALIDATED_MAX_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_INVALIDATED_MAX_DELAY_MS",
    8_000,
    100,
    120_000,
);

// ============================================================
// HTTP server
// ============================================================

// JSON body limits are per-route. A global app.use(json)
// would parse and reject oversize bodies before any per-route json() ran
// (Express middleware fires in declaration order; whichever json() consumes
// the body first wins). We declare named limits and apply them explicitly
// on each route instead.
export const JSON_LIMIT_METADATA = "256kb"; // walrus/query-blobs, sponsor, sponsor/execute
export const JSON_LIMIT_SEAL_ENCRYPT = "2mb"; // matches PROTECTED_BODY_LIMIT_BYTES (auth cap)
export const JSON_LIMIT_SEAL_DECRYPT = "2mb"; // single encrypted blob, same size class as encrypt
export const JSON_LIMIT_SEAL_DECRYPT_BATCH = "8mb"; // up to 25 × ~320 KiB items
export const JSON_LIMIT_WALRUS_UPLOAD = "10mb"; // base64-encoded encrypted blob

export const SIDECAR_PORT = parseInt(process.env.SIDECAR_PORT || "9000", 10);
export const SIDECAR_HOST = process.env.SIDECAR_HOST || "127.0.0.1";
