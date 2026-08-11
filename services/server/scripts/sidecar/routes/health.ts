/**
 * Unauthenticated observability endpoints.
 *
 * All are registered BEFORE the shared-secret middleware (see app.ts):
 * /health is local liveness, /ready validates upload execution identity, and
 * /metrics/wallet exposes aggregate metrics to unauthenticated scrapers.
 * Per-wallet addresses and balances are served separately behind sidecar auth.
 */

import type { Express, Request, Response as ExpressResponse } from "express";
import {
    DURABLE_UPLOAD_PROTOCOL_VERSION,
    ENOKI_API_KEY,
    SEAL_COMMITTEE_IDENTITY,
    SEAL_SERVER_CONFIGS,
    SEAL_THRESHOLD,
    SERVER_SUI_ADDRESSES,
    SERVER_SUI_PRIVATE_KEYS,
    TRUSTED_WALRUS_UPLOADER_SET,
    SUI_CHAIN_IDENTIFIER,
    SUI_NETWORK,
    WALRUS_PACKAGE_ID,
    WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
    WALRUS_UPLOAD_MAX_CONCURRENCY,
    WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
} from "../config.js";
import { getWalletBalanceSnapshot, getWalrusClient, suiClient, suiGraphqlClient } from "../clients.js";
import { getUploadCounts } from "../concurrency.js";
import { sidecarLog } from "../log.js";
import { sidecarStartedAtMs, sidecarStateSnapshot } from "../state.js";
import { errorMessage } from "../util.js";

const READINESS_CACHE_MS = 30_000;
const READINESS_RPC_TIMEOUT_MS = 5_000;
export type UploadExecutionIdentity = { chainIdentifier: string; walrusPackageId: string };
let readinessPromise: Promise<UploadExecutionIdentity> | undefined;
let cachedIdentity: { value: UploadExecutionIdentity; checkedAtMs: number } | undefined;

export function executionIdentity(): Promise<UploadExecutionIdentity> {
    if (cachedIdentity && Date.now() - cachedIdentity.checkedAtMs < READINESS_CACHE_MS) {
        return Promise.resolve(cachedIdentity.value);
    }
    readinessPromise ??= Promise.all([
        suiClient.ledgerService.getServiceInfo({}, { timeout: READINESS_RPC_TIMEOUT_MS }),
        getWalrusClient().getBlobType(),
    ])
        .then(([{ response }, blobType]) => {
            if (!response.chainId) throw new Error("Sui gRPC service info has no chain id");
            if (response.chainId !== SUI_CHAIN_IDENTIFIER) {
                throw new Error(`Sui endpoint chain id does not match ${SUI_NETWORK}`);
            }
            const expectedBlobType = `${WALRUS_PACKAGE_ID}::blob::Blob`;
            if (blobType !== expectedBlobType) {
                throw new Error(`Walrus SDK blob type ${blobType} does not match ${expectedBlobType}`);
            }
            const value = {
                chainIdentifier: response.chainId,
                walrusPackageId: WALRUS_PACKAGE_ID,
            };
            cachedIdentity = { value, checkedAtMs: Date.now() };
            return value;
        })
        .finally(() => {
            readinessPromise = undefined;
        });
    return readinessPromise;
}

export function parseUploadExecutionIdentity(value: unknown): UploadExecutionIdentity | null {
    if (!value || typeof value !== "object") return null;
    const { chainIdentifier, walrusPackageId } = value as Record<string, unknown>;
    if (typeof chainIdentifier !== "string" || !chainIdentifier
        || typeof walrusPackageId !== "string" || !walrusPackageId) {
        return null;
    }
    return { chainIdentifier, walrusPackageId };
}

export async function assertUploadExecutionIdentity(
    expected: UploadExecutionIdentity,
): Promise<void> {
    const actual = await executionIdentity();
    if (actual.chainIdentifier === expected.chainIdentifier
        && actual.walrusPackageId === expected.walrusPackageId) {
        return;
    }
    throw Object.assign(
        new Error(`upload execution identity mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
        { code: "UNAVAILABLE" },
    );
}

async function assertProvenanceEndpointIdentity(): Promise<void> {
    const result = await suiGraphqlClient.query<{ chainIdentifier?: string }>({
        query: "query ProvenanceReadiness { chainIdentifier }",
        variables: {},
        signal: AbortSignal.timeout(READINESS_RPC_TIMEOUT_MS),
    });
    if (result.errors?.length || result.data?.chainIdentifier !== SUI_CHAIN_IDENTIFIER) {
        throw new Error(`Sui archival GraphQL endpoint does not match ${SUI_NETWORK}`);
    }
}

export function registerHealthRoute(app: Express, requireProvenance = true): void {
    app.get("/health", (_req: Request, res: ExpressResponse) => {
        res.json({ status: "ok", uptimeMs: Date.now() - sidecarStartedAtMs });
    });

    app.get("/ready", async (_req: Request, res: ExpressResponse) => {
        try {
            const identity = await executionIdentity();
            if (requireProvenance) await assertProvenanceEndpointIdentity();
            const uploads = getUploadCounts();
            res.json({
                status: "ok",
                uptimeMs: Date.now() - sidecarStartedAtMs,
                activeWalrusUploads: uploads.active,
                queuedWalrusUploads: uploads.queued,
                serverKeyCount: SERVER_SUI_PRIVATE_KEYS.length,
                serverKeyAddresses: SERVER_SUI_ADDRESSES,
                trustedUploaderCount: TRUSTED_WALRUS_UPLOADER_SET.size,
                suiNetwork: SUI_NETWORK,
                uploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                durableUploadDirectSign: !ENOKI_API_KEY,
                durableUploadAddressBalance: true,
                uploadExecutionIdentity: identity,
                sealCommitteeIdentity: SEAL_COMMITTEE_IDENTITY,
                sealServerCount: SEAL_SERVER_CONFIGS.length,
                sealThreshold: SEAL_THRESHOLD,
                walrusUploadLimits: {
                    globalCapacity: WALRUS_UPLOAD_MAX_CONCURRENCY,
                    perWalletCapacity: WALRUS_UPLOAD_PER_WALLET_CONCURRENCY,
                    acquireTimeoutMs: WALRUS_UPLOAD_ACQUIRE_TIMEOUT_MS,
                },
            });
        } catch (error) {
            sidecarLog("error", "readiness_identity_failed", { error: errorMessage(error) });
            res.status(503).json({ status: "error", error: "Upload execution identity unavailable" });
        }
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
    app.get("/metrics/wallet", async (_req: Request, res: ExpressResponse) => {
        const snapshot = sidecarStateSnapshot();
        try {
            const balances: Partial<Awaited<ReturnType<typeof getWalletBalanceSnapshot>>> = {
                ...await getWalletBalanceSnapshot(SERVER_SUI_ADDRESSES),
            };
            delete balances.perWallet;
            res.json({ ...snapshot, ...balances });
        } catch (error) {
            sidecarLog("warn", "wallet_balance_metrics_failed", { error: errorMessage(error) });
            res.json(snapshot);
        }
    });
}

// Operational wallet details. Register this route only after
// sharedSecretAuthMiddleware in app.ts.
export function registerInternalWalletBalancesRoute(app: Express): void {
    app.get("/internal/wallet-balances", async (_req: Request, res: ExpressResponse) => {
        try {
            const { perWallet } = await getWalletBalanceSnapshot(SERVER_SUI_ADDRESSES);
            res.json({ perWallet });
        } catch (error) {
            sidecarLog("warn", "internal_wallet_balances_failed", { error: errorMessage(error) });
            res.status(503).json({ error: "Wallet balances unavailable" });
        }
    });
}
