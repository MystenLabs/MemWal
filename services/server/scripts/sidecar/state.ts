/**
 * Process-wide metrics counters + diagnostic state snapshot.
 */

import {
    ENOKI_API_KEY,
    ENOKI_FALLBACK_TO_DIRECT_SIGN,
    ENOKI_INVALIDATED_MAX_ATTEMPTS,
    ENOKI_NETWORK,
    ENOKI_TRANSIENT_MAX_ATTEMPTS,
    SEAL_KEY_SERVER_TIMEOUT_MS,
    SEAL_SERVER_CONFIGS,
    SEAL_THRESHOLD,
    SERVER_SUI_PRIVATE_KEYS,
    SUI_NETWORK,
    WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
    WALRUS_UPLOAD_MAX_CONCURRENCY,
    WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
} from "./config.js";
import { uploadRelayTipCacheSnapshot, walrusClientAgeMs } from "./clients.js";
import { getUploadCounts } from "./concurrency.js";

export const sidecarStartedAtMs = Date.now();

// in-memory counters surfaced via /metrics/wallet.
//
// `walletLockErrorsTotal` counts the recoverable "locked at version" class,
// where a retry can rebuild against a fresh version. `walletObjectLockEquivocationTotal`
// counts the NON-recoverable class — an owned object equivocated and is locked
// to a competing transaction until the lock clears (typically the next epoch
// boundary). The latter has been observed in production despite earlier
// guidance that Sui no longer permanently locks coin objects on equivocation,
// so it is tracked separately as the canary for whether concurrent uploads are
// still equivocating owned objects.
export const sidecarMetrics = {
    walletSubmittedTotal: 0,
    walletLockErrorsTotal: 0,
    walletObjectLockEquivocationTotal: 0,
    walletPermanentFailuresTotal: 0,
};

export function sidecarStateSnapshot(): Record<string, unknown> {
    const memory = process.memoryUsage();
    const now = Date.now();
    const uploads = getUploadCounts();
    const tipCache = uploadRelayTipCacheSnapshot();
    return {
        pid: process.pid,
        uptimeMs: now - sidecarStartedAtMs,
        memory: {
            rssMb: Math.round(memory.rss / 1024 / 1024),
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
            externalMb: Math.round(memory.external / 1024 / 1024),
        },
        activeWalrusUploads: uploads.active,
        queuedWalrusUploads: uploads.queued,
        walrusUploadLimits: {
            globalCapacity: WALRUS_UPLOAD_MAX_CONCURRENCY,
            perWalletCapacity: WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
            acquireTimeoutMs: WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
        },
        walletSubmittedTotal: sidecarMetrics.walletSubmittedTotal,
        walletLockErrorsTotal: sidecarMetrics.walletLockErrorsTotal,
        walletObjectLockEquivocationTotal: sidecarMetrics.walletObjectLockEquivocationTotal,
        walletPermanentFailuresTotal: sidecarMetrics.walletPermanentFailuresTotal,
        uploadRelayTipCache: tipCache.status,
        uploadRelayTipCacheAgeMs: tipCache.ageMs,
        walrusClientAgeMs: walrusClientAgeMs(),
        serverKeyCount: SERVER_SUI_PRIVATE_KEYS.length,
        sealServerCount: SEAL_SERVER_CONFIGS.length,
        sealThreshold: SEAL_THRESHOLD,
        sealKeyServerTimeoutMs: SEAL_KEY_SERVER_TIMEOUT_MS,
        suiNetwork: SUI_NETWORK,
        enokiNetwork: ENOKI_NETWORK,
        enokiEnabled: !!ENOKI_API_KEY,
        fallbackToDirectSign: ENOKI_FALLBACK_TO_DIRECT_SIGN,
        enokiTransientMaxAttempts: ENOKI_TRANSIENT_MAX_ATTEMPTS,
        enokiInvalidatedMaxAttempts: ENOKI_INVALIDATED_MAX_ATTEMPTS,
    };
}
