/**
 * @cmdoss/memwal-v2
 *
 * Privacy-first AI memory SDK.
 * Ed25519 delegate key auth + server-side TEE processing.
 */

// Core client
export { MemWal } from "./memwal.js";

// Types
export type {
    MemWalConfig,
    RememberResult,
    RecallResult,
    RecallMemory,
    EmbedResult,
    HealthResult,
} from "./types.js";
