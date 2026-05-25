/**
 * @mysten-incubation/memwal/manual
 *
 * Manual (client-side) mode entry point.
 * Requires: @mysten/seal, @mysten/walrus, @mysten/sui
 *
 * Usage:
 *   import { MemWalManual } from "@mysten-incubation/memwal/manual";
 */

export { MemWalManual } from "./manual.js";
export {
    MEMWAL_TYPESCRIPT_COMPATIBILITY_VERSION,
    MemWalCompatibilityError,
    SUPPORTED_RELAYER_API_MAJOR,
} from "./compatibility.js";

export type {
    MemWalManualConfig,
    RelayerVersionMetadata,
    SealServerConfig,
    WalletSigner,
    ScoringWeights,
    RememberManualOptions,
    RememberManualResult,
    RecallManualOptions,
    MemWalManualRecallOptions,
    RecallManualResult,
    RecallManualHit,
    RecallManualMemory,
} from "./types.js";
