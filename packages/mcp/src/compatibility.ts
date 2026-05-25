export const MEMWAL_MCP_COMPATIBILITY_VERSION = "0.0.1";
export const SUPPORTED_RELAYER_API_MAJOR = 1;

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

export async function ensureCompatibleRelayer(relayerUrl: string): Promise<void> {
    const base = relayerUrl.replace(/\/+$/, "");
    if (compatibilityCache && compatibilityCacheUrl === base) return;
    if (compatibilityPromise) return compatibilityPromise;

    compatibilityPromise = fetchAndValidate(base).finally(() => {
        compatibilityPromise = null;
    });
    return compatibilityPromise;
}

async function fetchAndValidate(relayerUrl: string): Promise<void> {
    const base = relayerUrl;
    const versionResp = await fetch(`${base}/version`, { method: "GET" });
    let metadata: RelayerVersionMetadata;

    if (versionResp.ok) {
        metadata = (await versionResp.json()) as RelayerVersionMetadata;
    } else if (versionResp.status === 404 || versionResp.status === 405) {
        const healthResp = await fetch(`${base}/health`, { method: "GET" });
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
