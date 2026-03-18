/**
 * @cmdoss/memwal
 *
 * Privacy-first AI memory SDK.
 * Ed25519 delegate key auth + server-side TEE processing.
 *
 * This is the default entry point — server-delegated mode only.
 * For manual (client-side SEAL + Walrus), import from "@cmdoss/memwal/manual".
 */

// Core client (server-mode: server handles SEAL + Walrus + embedding)
export { MemWal } from "./memwal.js";

// Delegate key utilities
export { delegateKeyToSuiAddress, delegateKeyToPublicKey } from "./utils.js";

// Types (server-mode only — no manual types here)
export type {
    MemWalConfig,
    RememberResult,
    RecallResult,
    RecallMemory,
    EmbedResult,
    AnalyzeResult,
    AnalyzedFact,
    HealthResult,
    RestoreResult,
} from "./types.js";

