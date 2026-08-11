/**
 * Environment-driven configuration for the sidecar.
 *
 * Every tunable lives here so the rest of the sidecar imports parsed
 * constants instead of re-reading process.env. Parsing happens once at
 * module load; invalid values fall back to defaults with a warning.
 */

import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { getSealCommitteeIdentity, getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "../seal-config.js";
import { parseSuiNetwork } from "./sui-transport-policy.js";

export function parsePositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min) {
        console.warn(`[sidecar] ignoring invalid ${name}=${raw}; using ${fallback}`);
        return fallback;
    }
    return Math.min(parsed, max);
}

export function parseBooleanEnv(name: string, fallback = false): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true" || raw === "yes";
}

// ============================================================
// Network
// ============================================================

export const SUI_NETWORK = parseSuiNetwork(process.env.SUI_NETWORK);
// One transport for reads and writes. Production supplies the co-located
// Mysten gRPC endpoint; the public fullnode remains a development default.
export const SUI_GRPC_URL = process.env.SUI_GRPC_URL?.trim() || `https://fullnode.${SUI_NETWORK}.sui.io`;
// Provenance lookups need historical transactions/object versions that fullnodes
// are allowed to prune. Sui's GraphQL service retains that history; deployments
// may point this at a private archival GraphQL indexer.
export const SUI_GRAPHQL_URL =
    process.env.SUI_GRAPHQL_URL?.trim() || `https://graphql.${SUI_NETWORK}.sui.io/graphql`;
export const SUI_CHAIN_IDENTIFIER =
    SUI_NETWORK === "testnet"
    ? "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD"
    : "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
export const SUI_TYPE = "0x2::sui::SUI";

// ============================================================
// SEAL
// ============================================================

export const SEAL_SERVER_CONFIGS = getSealServerConfigsFromEnv();
export const SEAL_THRESHOLD = getSealThresholdFromEnv(SEAL_SERVER_CONFIGS);
export const SEAL_COMMITTEE_IDENTITY = getSealCommitteeIdentity(SEAL_SERVER_CONFIGS, SEAL_THRESHOLD);
export const SEAL_KEY_SERVER_TIMEOUT_MS = parsePositiveIntEnv("SEAL_KEY_SERVER_TIMEOUT_MS", 25_000, 1_000, 120_000);
// Migration-only behavior is opt-in. Normal relayers do not need the inactive
// account encrypt route or the legacy two-argument seal_approve ABI.
export const SIDECAR_ENABLE_MIGRATION_SEAL_ROUTE = parseBooleanEnv("SIDECAR_ENABLE_MIGRATION_SEAL_ROUTE");
export const SIDECAR_ENABLE_LEGACY_SEAL_ABI = parseBooleanEnv("SIDECAR_ENABLE_LEGACY_SEAL_ABI");
// The executable policy target is operator configuration, never request data.
// Migrator deployments use WM_DST_PACKAGE_ID; normal relayers use MEMWAL_*.
export const SEAL_POLICY_PACKAGE_ID =
    process.env.MEMWAL_SEAL_POLICY_PACKAGE_ID?.trim()
    || process.env.MEMWAL_PACKAGE_ID?.trim()
    || process.env.WM_DST_PACKAGE_ID?.trim()
    || "";

if (SEAL_SERVER_CONFIGS.length === 0) {
    console.error(
        "[sidecar] WARNING: SEAL_SERVER_CONFIGS/SEAL_KEY_SERVERS env vars are empty and no network default exists — SEAL encrypt/decrypt will fail"
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

export const SERVER_SUI_ADDRESSES = SERVER_SUI_PRIVATE_KEYS.map((privateKey, index) => {
    try {
        const { scheme, secretKey } = decodeSuiPrivateKey(privateKey);
        if (scheme !== "ED25519") {
            throw new Error(`unsupported key scheme ${scheme}`);
        }
        return Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid SERVER_SUI_PRIVATE_KEYS[${index}]: ${message}`);
    }
});

if (new Set(SERVER_SUI_ADDRESSES).size !== SERVER_SUI_ADDRESSES.length) {
    throw new Error("SERVER_SUI_PRIVATE_KEYS contains duplicate wallet addresses");
}

// Restore provenance trusts the normal server wallet pool plus historical
// migration writers. Operators must populate TRUSTED_UPLOADER_ADDRESSES from
// migration.upload_writer_shards, or pass the JSON emitted by
// collect-live-writer-addresses.sh as TRUSTED_UPLOADER_INVENTORY_JSON before
// cutover; request data can never extend this set.
export function parseTrustedUploaderAddresses(raw: string): string[] {
    return [
        ...new Set(
            raw
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
                .map((value) => {
                    if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
                        throw new Error(`invalid TRUSTED_UPLOADER_ADDRESSES entry: ${value}`);
                    }
                    return normalizeSuiAddress(value);
                })
        ),
    ];
}

export function parseTrustedUploaderInventory(raw: string): string[] {
    if (!raw.trim()) return [];
    let inventory: unknown;
    try {
        inventory = JSON.parse(raw);
    } catch (error) {
        throw new Error(`invalid TRUSTED_UPLOADER_INVENTORY_JSON: ${error instanceof Error ? error.message : error}`);
    }
    if (!inventory || typeof inventory !== "object" || !Array.isArray((inventory as any).writers)) {
        throw new Error("invalid TRUSTED_UPLOADER_INVENTORY_JSON: writers array is required");
    }
    const addresses = (inventory as any).writers.flatMap((writer: any) =>
        Array.isArray(writer?.addresses) ? writer.addresses : []
    );
    if (!addresses.every((address: unknown) => typeof address === "string")) {
        throw new Error("invalid TRUSTED_UPLOADER_INVENTORY_JSON: every writer address must be a string");
    }
    return parseTrustedUploaderAddresses(addresses.join(","));
}

export const TRUSTED_WALRUS_UPLOADER_SET: ReadonlySet<string> = new Set([
    ...SERVER_SUI_ADDRESSES.map((address) => normalizeSuiAddress(address)),
    ...parseTrustedUploaderAddresses(process.env.TRUSTED_UPLOADER_ADDRESSES ?? ""),
    ...parseTrustedUploaderInventory(process.env.TRUSTED_UPLOADER_INVENTORY_JSON ?? ""),
]);

// ============================================================
// Walrus
// ============================================================

// Walrus package ID (for on-chain Move calls: metadata, blob type queries)
export const WALRUS_PACKAGE_ID =
    process.env.WALRUS_PACKAGE_ID ||
    (SUI_NETWORK === "testnet"
        ? "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"
        : "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77");

// @mysten/walrus's WalrusClient only recognizes "mainnet"/"testnet" as named
// networks — it throws "Unsupported network" for anything else (e.g. a
// devstack localnet). Set both to hand it an explicit on-chain packageConfig
// instead of a named network; see createWalrusClient in clients.ts. Left
// unset on mainnet/testnet, where the named-network default already
// resolves the right ids.
export const WALRUS_SYSTEM_OBJECT_ID = process.env.WALRUS_SYSTEM_OBJECT_ID?.trim() || "";
export const WALRUS_STAKING_POOL_ID = process.env.WALRUS_STAKING_POOL_ID?.trim() || "";

export const WALRUS_UPLOAD_RELAY_URL =
    process.env.WALRUS_UPLOAD_RELAY_URL ||
    (SUI_NETWORK === "testnet"
        ? "https://upload-relay.testnet.walrus.space"
        : "https://upload-relay.mainnet.walrus.space");
// Explicit direct-upload switch used by migration/test deployments. Empty or
// "none" relay URLs remain supported for backwards compatibility.
export const WALRUS_DIRECT_UPLOAD = process.env.WALRUS_DIRECT_UPLOAD === "true";

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
                `using network default ${NETWORK_DEFAULT_WALRUS_EPOCHS}`
        );
    } else {
        console.warn(
            `[sidecar] ignoring invalid WALRUS_STORAGE_EPOCHS=${raw}; ` +
                `using network default ${NETWORK_DEFAULT_WALRUS_EPOCHS}`
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

export function parseDurableWalrusEpochs(rawEpochs: unknown, network = SUI_NETWORK): number | null {
    const epochs =
        typeof rawEpochs === "number" &&
        Number.isSafeInteger(rawEpochs) &&
        rawEpochs >= 1 &&
        rawEpochs <= MAX_WALRUS_EPOCHS
        ? rawEpochs
        : null;
    return network === "mainnet" && epochs !== MAX_WALRUS_EPOCHS ? null : epochs;
}

// The cached WalrusClient snapshots `systemState` (storage/write price,
// committee) at creation and reuses it for its whole lifetime. The register
// PTB pre-funds an *exact* WAL payment from that cached price, so when mainnet
// price drifts the split leaves change and `coin::destroy_zero` aborts. Keep
// the client young so the cached price tracks the live price closely; the
// register-path `destroy_zero` handler also recreates it on demand. Was 30 min,
// which let the cached price fall far behind a live-drifting mainnet price.
export const WALRUS_CLIENT_MAX_AGE_MS = (() => {
    const parsed = Number.parseInt(process.env.WALRUS_CLIENT_MAX_AGE_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 1000;
})();

// Mirror of services/server/src/alerts.rs SIDECAR_WALRUS_DEP_VERSION.
// Bump this in lockstep with package.json's @mysten/walrus dep so the
// version-mismatch warn log reports the actual runtime dep.
export const WALRUS_DEP_VERSION = "1.1.7";

export const UPLOAD_RELAY_TIP_CACHE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.UPLOAD_RELAY_TIP_CACHE_TTL_MS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

export const UPLOAD_RELAY_TIP_TIMEOUT_MS = parsePositiveIntEnv("UPLOAD_RELAY_TIP_TIMEOUT_MS", 10_000, 1, 60_000);

// ============================================================
// Walrus upload concurrency limits
// ============================================================

export const WALRUS_UPLOAD_MAX_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_MAX_CONCURRENCY",
    Math.max(1, SERVER_SUI_PRIVATE_KEYS.length || 1),
    1,
    100
);
export const WALRUS_UPLOAD_PER_WALLET_CONCURRENCY = parsePositiveIntEnv(
    "WALRUS_UPLOAD_PER_WALLET_CONCURRENCY",
    1,
    1,
    10
);
export const WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS = parsePositiveIntEnv(
    "WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS",
    120_000,
    1_000,
    180_000
);
export const WALRUS_UPLOAD_EFFECTS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000] as const;
export const DURABLE_UPLOAD_PROTOCOL_VERSION = 3;

export const SIDECAR_SHUTDOWN_TIMEOUT_MS = parsePositiveIntEnv("SIDECAR_SHUTDOWN_TIMEOUT_MS", 330_000, 5_000, 600_000);

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
export const ENOKI_TRANSIENT_MAX_ATTEMPTS = parsePositiveIntEnv("ENOKI_TRANSIENT_MAX_ATTEMPTS", 2, 1, 5);
export const ENOKI_TRANSIENT_BASE_DELAY_MS = parsePositiveIntEnv("ENOKI_TRANSIENT_BASE_DELAY_MS", 5_000, 100, 60_000);
export const ENOKI_TRANSIENT_MAX_DELAY_MS = parsePositiveIntEnv("ENOKI_TRANSIENT_MAX_DELAY_MS", 30_000, 1_000, 120_000);
export const ENOKI_INVALIDATED_MAX_ATTEMPTS = parsePositiveIntEnv("ENOKI_INVALIDATED_MAX_ATTEMPTS", 4, 1, 10);
export const ENOKI_INVALIDATED_BASE_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_INVALIDATED_BASE_DELAY_MS",
    1_000,
    100,
    60_000
);
export const ENOKI_INVALIDATED_MAX_DELAY_MS = parsePositiveIntEnv(
    "ENOKI_INVALIDATED_MAX_DELAY_MS",
    8_000,
    100,
    120_000
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
export const JSON_LIMIT_WALRUS_VERIFY = JSON_LIMIT_WALRUS_UPLOAD;

export const SIDECAR_PORT = parseInt(process.env.SIDECAR_PORT || "9000", 10);
export const SIDECAR_HOST = process.env.SIDECAR_HOST || "127.0.0.1";
export const SIDECAR_ROUTE_MODE = (() => {
    const mode = (process.env.SIDECAR_ROUTE_MODE || "full").trim().toLowerCase();
    if (mode === "full" || mode === "writer") return mode;
    throw new Error(`invalid SIDECAR_ROUTE_MODE=${mode}; expected full or writer`);
})();
