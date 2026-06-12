/**
 * Server-wallet transaction submission.
 *
 * Wraps the Enoki sponsor path with metrics, lock-error classification
 * (the validation canary) and the rebuild-and-retry loop for sponsored
 * transactions that get invalidated before execution.
 */

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
    classifyEnokiSponsoredTransactionInvalidation,
    isWalrusObjectLockEquivocation,
} from "../walrus-error-detection.js";
import {
    ENOKI_INVALIDATED_BASE_DELAY_MS,
    ENOKI_INVALIDATED_MAX_ATTEMPTS,
    ENOKI_INVALIDATED_MAX_DELAY_MS,
    SUI_TYPE,
} from "./config.js";
import { executeWithEnokiSponsor } from "./enoki.js";
import { sidecarMetrics } from "./state.js";
import { errorMessage, sleep, truncateForLog } from "./util.js";

const COIN_WITH_BALANCE_INTENT = "CoinWithBalance";
const GAS_INTENT_TYPE = "gas";
type TxIntentCommand = {
    $kind?: string;
    $Intent?: {
        name?: string;
        data?: { type?: string };
    };
};
type TxDataWithCommands = { commands: TxIntentCommand[] };

/**
 * Rewrite CoinWithBalance "gas" intents to explicit SUI coin type so Enoki
 * sponsorship can build the transaction (Enoki rejects GasCoin tx arguments).
 */
export function patchGasCoinIntents(tx: Transaction): void {
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

/**
 * Submit a Sui transaction via the Enoki sponsor path (or direct sign as
 * fallback). Wraps `executeWithEnokiSponsor` with metrics + lock-error
 * detection for the validation canary.
 */
export async function submitWalletTransaction(
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
        if (isWalrusObjectLockEquivocation(msg)) {
            // Non-recoverable owned-object lock — held until the lock clears
            // (typically the next epoch boundary). The Rust worker classifies
            // this as ObjectLockedUntilEpoch and aborts rather than burning
            // wallet retries; here we only categorize the metric.
            sidecarMetrics.walletObjectLockEquivocationTotal += 1;
            console.error(`[wallet] object lock / equivocation: ${msg}`);
        } else if (/objectlocked|locked at version|object is locked/i.test(msg)) {
            sidecarMetrics.walletLockErrorsTotal += 1;
            console.error(`[wallet] coin-object lock error: ${msg}`);
        } else if (/moveabort|move abort/i.test(msg)) {
            sidecarMetrics.walletPermanentFailuresTotal += 1;
        }
        throw err;
    }
}

function getEnokiInvalidatedRetryDelayMs(attempt: number): number | null {
    if (attempt >= ENOKI_INVALIDATED_MAX_ATTEMPTS) {
        return null;
    }

    const delay = ENOKI_INVALIDATED_BASE_DELAY_MS * 2 ** (attempt - 1);
    return Math.min(delay, ENOKI_INVALIDATED_MAX_DELAY_MS);
}

/**
 * Submit a transaction that can be cheaply rebuilt from scratch. When the
 * sponsored transaction gets invalidated (expired / referenced object stale)
 * the transaction is rebuilt via `buildTransaction` and resubmitted with
 * exponential backoff.
 */
export async function submitRebuildableWalletTransaction(
    phaseName: string,
    buildTransaction: () => Transaction,
    signer: Ed25519Keypair,
    allowedAddresses?: string[],
    logContext: Record<string, unknown> = {},
): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await submitWalletTransaction(buildTransaction(), signer, allowedAddresses);
        } catch (err: unknown) {
            const message = errorMessage(err);
            const reason = classifyEnokiSponsoredTransactionInvalidation(message);
            const retryDelayMs = getEnokiInvalidatedRetryDelayMs(attempt);
            if (!reason || retryDelayMs === null) {
                throw err;
            }

            console.warn(`[enoki-sponsor] rebuildable_retry ${JSON.stringify({
                phase: phaseName,
                ...logContext,
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: ENOKI_INVALIDATED_MAX_ATTEMPTS,
                retryDelayMs,
                reason,
                message: truncateForLog(message),
            })}`);
            await sleep(retryDelayMs);
        }
    }
}
