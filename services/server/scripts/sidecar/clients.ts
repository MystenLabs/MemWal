/**
 * Shared Sui / SEAL / Walrus clients.
 *
 * Initialized once at boot — eliminates ~1-2s Node.js cold-start per call,
 * which is the whole reason the sidecar exists. The Walrus client is the
 * one exception: it caches on-chain package metadata, so it is recreated
 * (`refreshWalrusClient`) whenever that metadata goes stale.
 */

import { randomUUID } from "crypto";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { SealClient } from "@mysten/seal";
import { WalrusClient } from "@mysten/walrus";
import {
    SEAL_KEY_SERVER_TIMEOUT_MS,
    SEAL_SERVER_CONFIGS,
    SUI_NETWORK,
    SUI_RPC_URL,
    SUI_TYPE,
    UPLOAD_RELAY_TIP_CACHE_TTL_MS,
    WALRUS_CLIENT_MAX_AGE_MS,
    WALRUS_UPLOAD_RELAY_URL,
} from "./config.js";
import { shortAddress } from "./util.js";

export const suiClient = new SuiJsonRpcClient({
    url: SUI_RPC_URL,
    network: SUI_NETWORK,
});

export const sealClient = new SealClient({
    suiClient: suiClient as any,
    serverConfigs: SEAL_SERVER_CONFIGS,
    verifyKeyServers: true,
    timeout: SEAL_KEY_SERVER_TIMEOUT_MS,
});

function createWalrusClient(): WalrusClient {
    return new WalrusClient({
        network: SUI_NETWORK,
        suiClient: suiClient as any,
        uploadRelay: {
            host: WALRUS_UPLOAD_RELAY_URL,
            sendTip: { max: 10_000_000 },
        },
    });
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

export function refreshWalrusClientIfStale(): void {
    const ageMs = walrusClientAgeMs();
    if (ageMs >= WALRUS_CLIENT_MAX_AGE_MS) {
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
    if (
        uploadRelayTipAddressCache !== undefined &&
        Date.now() - uploadRelayTipAddressCacheLoadedAtMs < UPLOAD_RELAY_TIP_CACHE_TTL_MS
    ) {
        return uploadRelayTipAddressCache;
    }

    try {
        const resp = await fetch(`${WALRUS_UPLOAD_RELAY_URL}/v1/tip-config`);
        if (!resp.ok) {
            throw new Error(`tip-config request failed (${resp.status})`);
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
        // Don't cache transient failures; retry on next request.
        return null;
    }
}

// ============================================================
// Raw JSON-RPC access
// ============================================================

/**
 * Direct JSON-RPC helper for APIs that are not consistently exposed across
 * @mysten/sui client minor versions used by this sidecar.
 */
export async function suiRpc<T>(method: string, params: unknown[]): Promise<T> {
    const resp = await fetch(SUI_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method,
            params,
        }),
    });

    const text = await resp.text();
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error(`Sui RPC ${method} returned non-JSON (${resp.status}): ${text.slice(0, 200)}`);
    }

    if (!resp.ok || body.error) {
        const message = body.error?.message || text || `HTTP ${resp.status}`;
        throw new Error(`Sui RPC ${method} failed: ${message}`);
    }

    return body.result as T;
}

export async function getSuiBalanceMist(owner: string): Promise<string | null> {
    try {
        const balance = await (suiClient as any).getBalance({ owner, coinType: SUI_TYPE });
        return typeof balance?.totalBalance === "string" ? balance.totalBalance : null;
    } catch (err: any) {
        console.warn(`[wallet] balance lookup failed for ${shortAddress(owner)}: ${err?.message || err}`);
        return null;
    }
}
