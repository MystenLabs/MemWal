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

export type {
    MemWalManualConfig,
    WalletSigner,
    RememberManualOptions,
    RememberManualResult,
    RecallManualOptions,
    RecallManualResult,
    RecallManualHit,
    RecallManualMemory,
} from "./types.js";
