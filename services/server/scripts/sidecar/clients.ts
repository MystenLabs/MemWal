/**
 * Shared Sui / SEAL / Walrus clients.
 *
 * Initialized once at boot — eliminates ~1-2s Node.js cold-start per call,
 * which is the whole reason the sidecar exists. The Walrus client is the
 * one exception: it caches on-chain package metadata, so it is recreated
 * (`refreshWalrusClient`) whenever that metadata goes stale.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import { SealClient } from "@mysten/seal";
import { WalrusClient, type WalrusClientConfig } from "@mysten/walrus";
import {
    SEAL_KEY_SERVER_TIMEOUT_MS,
    SEAL_SERVER_CONFIGS,
    SUI_GRPC_URL,
    SUI_NETWORK,
    SUI_TYPE,
    UPLOAD_RELAY_TIP_CACHE_TTL_MS,
    UPLOAD_RELAY_TIP_TIMEOUT_MS,
    WALRUS_CLIENT_MAX_AGE_MS,
    WALRUS_DIRECT_UPLOAD,
    WALRUS_PACKAGE_ID,
    WALRUS_STAKING_POOL_ID,
    WALRUS_SYSTEM_OBJECT_ID,
    WALRUS_UPLOAD_RELAY_URL,
} from "./config.js";
import { shortAddress } from "./util.js";

// Shared gRPC core client for Walrus, SEAL, Enoki, and blob queries.
export const suiClient = new SuiGrpcClient({ network: SUI_NETWORK, baseUrl: SUI_GRPC_URL });

export function createSealClient(): SealClient {
    return new SealClient({
        suiClient: suiClient as any,
        serverConfigs: SEAL_SERVER_CONFIGS,
        verifyKeyServers: true,
        timeout: SEAL_KEY_SERVER_TIMEOUT_MS,
    });
}

// Encryption caches public key-server metadata only. Decrypt routes must use a
// fresh client per request because SealClient's derived-key cache is not scoped
// to the authenticated SessionKey.
export const sealEncryptClient = createSealClient();

function createWalrusClient(): WalrusClient {
    // WalrusClient only resolves package/staking ids itself for
    // "mainnet"/"testnet" — anything else (e.g. a devstack localnet) needs
    // them supplied directly via packageConfig.
    const useRelay =
        !WALRUS_DIRECT_UPLOAD && !!WALRUS_UPLOAD_RELAY_URL && WALRUS_UPLOAD_RELAY_URL !== "none";
    const baseConfig = {
        suiClient: suiClient as any,
        ...(useRelay
            ? {
                  uploadRelay: {
                      host: WALRUS_UPLOAD_RELAY_URL,
                      sendTip: { max: 10_000_000 },
                      timeout: Number(process.env.WALRUS_RELAY_TIMEOUT_MS) || 120_000,
                  },
              }
            : {}),
    };
    const config: WalrusClientConfig = WALRUS_SYSTEM_OBJECT_ID && WALRUS_STAKING_POOL_ID
        ? {
            ...baseConfig,
            packageConfig: {
                systemObjectId: WALRUS_SYSTEM_OBJECT_ID,
                stakingPoolId: WALRUS_STAKING_POOL_ID,
            },
        }
        : { ...baseConfig, network: SUI_NETWORK as "mainnet" | "testnet" };
    return new WalrusClient(config);
}

let walrusClient = createWalrusClient();
let walrusClientCreatedAtMs = Date.now();

export function getWalrusClient(): WalrusClient {
    return walrusClient;
}

export function walrusClientAgeMs(): number {
    return Date.now() - walrusClientCreatedAtMs;
}

export function refreshWalrusClient(reason: string): void {
    try {
        walrusClient.reset();
    } catch (err: any) {
        console.warn(`[walrus/client] reset failed before refresh reason=${reason}: ${err?.message || err}`);
    }
    walrusClient = createWalrusClient();
    walrusClientCreatedAtMs = Date.now();
    clearUploadRelayTipCache();
    console.warn(`[walrus/client] refreshed reason=${reason}`);
}

export function refreshWalrusClientIfStale(maxAgeMs = WALRUS_CLIENT_MAX_AGE_MS): void {
    const ageMs = walrusClientAgeMs();
    if (ageMs >= maxAgeMs) {
        refreshWalrusClient(`max_age_${ageMs}ms`);
    }
}

/**
 * Fetch the Walrus on-chain System object's version (u64 -> decimal string).
 * Reads go through the version-unchecked `inner` accessor so even the
 * stale cached client returns the value it last cached. After
 * refreshWalrusClient(), the recreated client refetches fresh metadata so
 * the returned value reflects the new on-chain version.
 *
 * Safe in the error path: any failure (RPC down, API drift) returns null
 * rather than throwing — we never want diagnostic logging to mask the
 * original error.
 */
export async function fetchWalrusSystemVersion(): Promise<string | null> {
    try {
        const sys = await walrusClient.systemObject();
        const version = (sys as any)?.version;
        if (version === undefined || version === null) return null;
        return String(version);
    } catch {
        return null;
    }
}

// ============================================================
// Upload-relay tip address cache
// ============================================================

type UploadRelayTipConfigResponse = {
    send_tip?: {
        address?: string;
    };
};

let uploadRelayTipAddressCache: string | null | undefined = undefined;
let uploadRelayTipAddressCacheLoadedAtMs = 0;

export function clearUploadRelayTipCache(): void {
    uploadRelayTipAddressCache = undefined;
    uploadRelayTipAddressCacheLoadedAtMs = 0;
}

export function uploadRelayTipCacheSnapshot(): {
    status: "uninitialized" | "none" | "present";
    ageMs: number | null;
} {
    return {
        status:
            uploadRelayTipAddressCache === undefined
                ? "uninitialized"
                : uploadRelayTipAddressCache === null
                    ? "none"
                    : "present",
        ageMs: uploadRelayTipAddressCache === undefined
            ? null
            : Date.now() - uploadRelayTipAddressCacheLoadedAtMs,
    };
}

export async function getUploadRelayTipAddress(): Promise<string | null> {
    if (WALRUS_DIRECT_UPLOAD || !WALRUS_UPLOAD_RELAY_URL || WALRUS_UPLOAD_RELAY_URL === "none") {
        return null;
    }

    if (
        uploadRelayTipAddressCache !== undefined &&
        Date.now() - uploadRelayTipAddressCacheLoadedAtMs < UPLOAD_RELAY_TIP_CACHE_TTL_MS
    ) {
        return uploadRelayTipAddressCache;
    }

    try {
        const resp = await fetch(`${WALRUS_UPLOAD_RELAY_URL}/v1/tip-config`, {
            signal: AbortSignal.timeout(UPLOAD_RELAY_TIP_TIMEOUT_MS),
        });
        if (!resp.ok) {
            // Carry the HTTP status as a structured field so the strict
            // durable-path classifier treats relay outages as shared-infra
            // (budget-free) rather than burning the row's retry budget.
            const error = new Error(`tip-config request failed (${resp.status})`);
            (error as Error & { status?: number }).status = resp.status;
            throw error;
        }

        const json = await resp.json() as UploadRelayTipConfigResponse;
        const address = json.send_tip?.address;
        if (typeof address === "string" && address.startsWith("0x")) {
            uploadRelayTipAddressCache = address;
            uploadRelayTipAddressCacheLoadedAtMs = Date.now();
            return address;
        }

        uploadRelayTipAddressCache = null;
        uploadRelayTipAddressCacheLoadedAtMs = Date.now();
        return null;
    } catch (err: any) {
        console.warn(`[upload-relay] could not load tip-config: ${err.message || err}`);
        // Fail before transaction submission: omitting a required relay tip can
        // turn a recoverable dependency outage into a permanently ambiguous job.
        throw err;
    }
}

export async function getSuiBalanceMist(owner: string): Promise<string | null> {
    try {
        const res: any = await (suiClient as any).getBalance({ owner, coinType: SUI_TYPE });
        const total = res?.balance?.balance ?? res?.balance?.coinBalance;
        return total != null ? String(total) : null;
    } catch (err: any) {
        console.warn(`[wallet] balance lookup failed for ${shortAddress(owner)}: ${err?.message || err}`);
        return null;
    }
}

export type WalletBalanceSnapshot = {
    walletSuiBalanceMist: string;
    walletSuiAddressBalanceMist: string;
    walletSuiCoinBalanceMist: string;
    walletSuiAddressFundedCount: number;
    walletWalBalanceFrost: string;
    walletWalAddressBalanceFrost: string;
    walletWalCoinBalanceFrost: string;
    walletWalAddressFundedCount: number;
};

const BALANCE_RPC_TIMEOUT_MS = 1_500;
let walCoinTypePromise: Promise<string> | undefined;
let walletBalanceSnapshotPromise: Promise<WalletBalanceSnapshot> | undefined;

function getWalCoinType(): Promise<string> {
    walCoinTypePromise ??= suiClient.movePackageService.getFunction(
        {
            packageId: WALRUS_PACKAGE_ID,
            moduleName: "staking",
            name: "stake_with_pool",
        },
        { timeout: BALANCE_RPC_TIMEOUT_MS },
    ).then(({ response }) => {
        const typeName =
            response.function?.parameters[1]?.body?.typeParameterInstantiation[0]?.typeName;
        if (!typeName) {
            throw new Error("canonical WAL coin type not found");
        }
        return normalizeStructTag(typeName);
    }).catch((error) => {
        walCoinTypePromise = undefined;
        throw error;
    });
    return walCoinTypePromise;
}

async function listAllBalances(owner: string) {
    const balances = [];
    let pageToken: Uint8Array | undefined;
    do {
        const { response } = await suiClient.stateService.listBalances(
            { owner, pageSize: 1_000, pageToken },
            { timeout: BALANCE_RPC_TIMEOUT_MS },
        );
        balances.push(...response.balances);
        pageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
    } while (pageToken);
    return balances;
}

async function loadWalletBalanceSnapshot(owners: string[]): Promise<WalletBalanceSnapshot> {
    const [walType, balancesByOwner] = await Promise.all([
        getWalCoinType(),
        Promise.all(owners.map(listAllBalances)),
    ]);
    let suiBalanceMist = 0n;
    let suiAddressBalanceMist = 0n;
    let suiCoinBalanceMist = 0n;
    let walBalanceFrost = 0n;
    let walAddressBalanceFrost = 0n;
    let walCoinBalanceFrost = 0n;
    let suiAddressFundedCount = 0;
    let walAddressFundedCount = 0;
    const suiType = normalizeStructTag(SUI_TYPE);
    for (const balances of balancesByOwner) {
        let ownerSuiAddressBalance = 0n;
        let ownerWalAddressBalance = 0n;
        for (const balance of balances) {
            if (!balance.coinType) {
                throw new Error("Sui gRPC balance entry has no coin type");
            }
            const coinType = normalizeStructTag(balance.coinType);
            const total = balance.balance ?? 0n;
            const address = balance.addressBalance ?? 0n;
            const coins = balance.coinBalance ?? total - address;
            if (coinType === suiType) {
                suiBalanceMist += total;
                suiAddressBalanceMist += address;
                suiCoinBalanceMist += coins;
                ownerSuiAddressBalance += address;
            } else if (coinType === walType) {
                walBalanceFrost += total;
                walAddressBalanceFrost += address;
                walCoinBalanceFrost += coins;
                ownerWalAddressBalance += address;
            }
        }
        if (ownerSuiAddressBalance > 0n) suiAddressFundedCount += 1;
        if (ownerWalAddressBalance > 0n) walAddressFundedCount += 1;
    }
    return {
        walletSuiBalanceMist: suiBalanceMist.toString(),
        walletSuiAddressBalanceMist: suiAddressBalanceMist.toString(),
        walletSuiCoinBalanceMist: suiCoinBalanceMist.toString(),
        walletSuiAddressFundedCount: suiAddressFundedCount,
        walletWalBalanceFrost: walBalanceFrost.toString(),
        walletWalAddressBalanceFrost: walAddressBalanceFrost.toString(),
        walletWalCoinBalanceFrost: walCoinBalanceFrost.toString(),
        walletWalAddressFundedCount: walAddressFundedCount,
    };
}

export function getWalletBalanceSnapshot(owners: string[]): Promise<WalletBalanceSnapshot> {
    walletBalanceSnapshotPromise ??= loadWalletBalanceSnapshot(owners).finally(() => {
        walletBalanceSnapshotPromise = undefined;
    });
    return walletBalanceSnapshotPromise;
}
