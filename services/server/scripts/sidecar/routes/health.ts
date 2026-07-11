/**
 * Unauthenticated observability endpoints.
 *
 * Both are registered BEFORE the shared-secret middleware (see app.ts):
 * /health must always be reachable for liveness probes, and
 * /metrics/wallet is scraped by operators without a token.
 */

import type { Express, Request, Response as ExpressResponse } from "express";
import {
    ENOKI_API_KEY,
    SUI_NETWORK,
    WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
    WALRUS_UPLOAD_MAX_CONCURRENCY,
    WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
} from "../config.js";
import { getUploadCounts } from "../concurrency.js";
import { sidecarMetrics, sidecarStartedAtMs } from "../state.js";

export function registerHealthRoute(app: Express): void {
    app.get("/health", (_req: Request, res: ExpressResponse) => {
        const uploads = getUploadCounts();
        res.json({
            status: "ok",
            pid: process.pid,
            uptimeMs: Date.now() - sidecarStartedAtMs,
            activeWalrusUploads: uploads.active,
            queuedWalrusUploads: uploads.queued,
            walrusUploadLimits: {
                globalCapacity: WALRUS_UPLOAD_MAX_CONCURRENCY,
                perWalletCapacity: WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
                acquireTimeoutMs: WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
            },
        });
    });
}

// Wallet-execution metrics (observability).
//
// `walletObjectLockEquivocationTotal` is the canary for concurrent uploads
// equivocating owned objects: a non-zero value means jobs are hitting Sui
// object locks that hold until the epoch boundary, which is the signal for
// the follow-up single-flight / coin-reservation work.
//
// Values are integer counters that monotonically increase; clients compute
// deltas.
export function registerWalletMetricsRoute(app: Express): void {
    app.get("/metrics/wallet", (_req: Request, res: ExpressResponse) => {
        res.json({
            ...sidecarMetrics,
            enokiEnabled: !!ENOKI_API_KEY,
            suiNetwork: SUI_NETWORK,
        });
    });
}

// Authenticated identity probe — registered AFTER the shared-secret
// middleware (see app.ts). A foreign sidecar (another checkout running on
// the same port) answers /health fine but rejects our SIDECAR_AUTH_TOKEN
// here with 401, so the relayer can detect the cross-wiring at boot and in
// the watchdog instead of surfacing it as "seal encrypt failed: Unauthorized"
// on the first user request.
export function registerWhoamiRoute(app: Express): void {
    app.get("/internal/whoami", (_req: Request, res: ExpressResponse) => {
        res.json({
            pid: process.pid,
            startedAtMs: sidecarStartedAtMs,
        });
    });
}
