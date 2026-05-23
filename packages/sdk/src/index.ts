/**
 * @mysten-incubation/memwal
 *
 * Privacy-first AI memory SDK.
 * Ed25519 delegate key auth + server-side TEE processing.
 *
 * This is the default entry point — MemWal client + types only.
 * Does NOT import account.js (which requires @mysten/sui).
 *
 * For account management, import from "@mysten-incubation/memwal/account".
 * For manual (client-side SEAL + Walrus), import from "@mysten-incubation/memwal/manual".
 */

// Core client (server-mode: server handles SEAL + Walrus + embedding)
export { MemWal } from "./memwal.js";
export {
    MEMWAL_TYPESCRIPT_COMPATIBILITY_VERSION,
    MemWalCompatibilityError,
    SUPPORTED_RELAYER_API_MAJOR,
} from "./compatibility.js";

// Delegate key utilities (no @mysten/sui dependency)
export { delegateKeyToSuiAddress, delegateKeyToPublicKey } from "./utils.js";

// Types (server-mode only — no manual types here)
export type {
    MemWalConfig,
    RememberAcceptedResult,
    RememberJobStatus,
    RememberResult,
    RecallResult,
    RecallMemory,
    RecallOptions,
    EmbedResult,
    AnalyzeResult,
    AnalyzeWaitResult,
    AnalyzedFact,
    HealthResult,
    RestoreResult,
    RememberBulkItem,
    RememberBulkOptions,
    RememberBulkAcceptedResult,
    RememberBulkStatusItem,
    RememberBulkStatusResult,
    RememberBulkResult,
    RememberBulkItemResult,
    MinSupportedSdk,
    RelayerBuildMetadata,
    RelayerDeprecationNotice,
    RelayerVersionMetadata,
} from "./types.js";
