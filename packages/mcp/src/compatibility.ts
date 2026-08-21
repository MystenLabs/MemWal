export const MEMWAL_MCP_COMPATIBILITY_VERSION = "0.0.1";
export const SUPPORTED_RELAYER_API_MAJOR = 1;

/** Default budget for ONE relayer connect attempt — the compatibility check
 * (`GET /version`, and a `/health` fallback) PLUS the initial SSE `GET` share
 * this deadline (the caller threads a single `AbortSignal` through both). Kept
 * well under the MCP client's ~30s connection timeout so a slow-but-alive
 * relayer still succeeds, while a hung one aborts long before the client would
 * SIGTERM us. Since `initialize` is now answered locally, exceeding this only
 * defers when `tools/call` becomes available — it surfaces as a tool-call
 * error, never a failed handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolve the per-step relayer connect timeout. Overridable via
 * `MEMWAL_MCP_CONNECT_TIMEOUT_MS` (same pattern as `MEMWAL_MCP_SSE_IDLE_MS`).
 * Non-numeric / non-positive values fall back to the default. A value of `0`
 * is treated as "use the default" rather than "no timeout" — an unbounded
 * connect is the bug we're fixing, so we never expose a way back to it.
 */
export function resolveConnectTimeoutMs(): number {
    const raw = process.env.MEMWAL_MCP_CONNECT_TIMEOUT_MS;
    if (!raw) return DEFAULT_CONNECT_TIMEOUT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONNECT_TIMEOUT_MS;
    return n;
}

interface RelayerVersionMetadata {
    relayerVersion?: string;
    apiVersion?: string;
    minSupportedSdk?: {
        mcp?: string;
    };
}

let compatibilityCache: RelayerVersionMetadata | null = null;
let compatibilityCacheUrl: string | null = null;
let compatibilityPromise: Promise<void> | null = null;

/**
 * @param signal Optional abort signal bounding the whole check. The caller
 *   passes ONE signal shared with the subsequent SSE connect so a single
 *   connect attempt is bounded in total, not per-step. When omitted, each fetch
 *   gets its own `AbortSignal.timeout(resolveConnectTimeoutMs())`.
 */
export async function ensureCompatibleRelayer(
    relayerUrl: string,
    signal?: AbortSignal,
): Promise<void> {
    const base = relayerUrl.replace(/\/+$/, "");
    if (compatibilityCache && compatibilityCacheUrl === base) return;
    if (compatibilityPromise) return compatibilityPromise;

    compatibilityPromise = fetchAndValidate(base, signal).finally(() => {
        compatibilityPromise = null;
    });
    return compatibilityPromise;
}

async function fetchAndValidate(relayerUrl: string, signal?: AbortSignal): Promise<void> {
    const base = relayerUrl;
    // Bound the request(s) so a hung relayer aborts well before the MCP client's
    // ~30s connection timeout. Prefer the caller's shared signal (so the compat
    // check + SSE connect share one budget); else fall back to a per-check one.
    const abort = signal ?? AbortSignal.timeout(resolveConnectTimeoutMs());
    const versionResp = await fetch(`${base}/version`, {
        method: "GET",
        signal: abort,
    });
    let metadata: RelayerVersionMetadata;

    if (versionResp.ok) {
        metadata = (await versionResp.json()) as RelayerVersionMetadata;
    } else if (versionResp.status === 404 || versionResp.status === 405) {
        const healthResp = await fetch(`${base}/health`, {
            method: "GET",
            signal: abort,
        });
        if (!healthResp.ok) {
            throw new Error(
                `Walrus Memory MCP compatibility check failed: GET /version returned ` +
                    `${versionResp.status}, and GET /health returned ${healthResp.status}`
            );
        }
        metadata = (await healthResp.json()) as RelayerVersionMetadata;
    } else {
        throw new Error(
            `Walrus Memory MCP compatibility check failed: GET /version returned ${versionResp.status}`
        );
    }

    assertCompatible(metadata, base);
    compatibilityCache = metadata;
    compatibilityCacheUrl = base;
}

function assertCompatible(metadata: RelayerVersionMetadata, relayerUrl: string): void {
    if (
        !metadata.apiVersion ||
        !metadata.relayerVersion ||
        !metadata.minSupportedSdk ||
        typeof metadata.minSupportedSdk !== "object"
    ) {
        throw new Error(
            `Walrus Memory relayer at ${relayerUrl} does not expose compatibility metadata. ` +
                "Upgrade the relayer to a version that serves GET /version, or use an older MCP package."
        );
    }

    const apiMajor = semverMajor(metadata.apiVersion);
    if (apiMajor === null) {
        throw new Error(
            `Walrus Memory relayer at ${relayerUrl} returned invalid apiVersion ` +
                `"${metadata.apiVersion}".`
        );
    }

    if (apiMajor !== SUPPORTED_RELAYER_API_MAJOR) {
        throw new Error(
            `This Walrus Memory MCP package supports relayer API ` +
                `${SUPPORTED_RELAYER_API_MAJOR}.x, but ${relayerUrl} reports ` +
                `apiVersion ${metadata.apiVersion}. Upgrade or downgrade the MCP package/relayer pair.`
        );
    }

    const minMcp = metadata.minSupportedSdk.mcp;
    if (!minMcp) {
        throw new Error(
            `Walrus Memory relayer at ${relayerUrl} did not report minSupportedSdk.mcp.`
        );
    }
    if (semverMajor(minMcp) === null) {
        throw new Error(
            `Walrus Memory relayer at ${relayerUrl} returned invalid minSupportedSdk.mcp "${minMcp}".`
        );
    }
    if (compareSemver(MEMWAL_MCP_COMPATIBILITY_VERSION, minMcp) < 0) {
        throw new Error(
            `Walrus Memory relayer at ${relayerUrl} requires MCP package >= ${minMcp}, ` +
                `but this package supports the ${MEMWAL_MCP_COMPATIBILITY_VERSION} ` +
                "compatibility baseline. Upgrade " +
                "@mysten-incubation/memwal-mcp or use an older compatible relayer."
        );
    }
}

function semverMajor(version: string): number | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    return match ? Number(match[1]) : null;
}

function compareSemver(a: string, b: string): number {
    const left = parseSemver(a);
    const right = parseSemver(b);
    if (!left || !right) {
        throw new Error(`invalid semver comparison: ${a} vs ${b}`);
    }

    for (let idx = 0; idx < 3; idx += 1) {
        if (left[idx] !== right[idx]) return left[idx] - right[idx];
    }
    return 0;
}

function parseSemver(version: string): [number, number, number] | null {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
