export type SealServerConfig = {
    objectId: string;
    weight: number;
    aggregatorUrl?: string;
    apiKeyName?: string;
    apiKey?: string;
};

type Env = Record<string, string | undefined>;

const MYSTEN_TESTNET_COMMITTEE_CONFIG: SealServerConfig = {
    objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    weight: 1,
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
};

const DEFAULT_SEAL_SERVER_CONFIGS: Record<string, SealServerConfig[]> = {
    testnet: [MYSTEN_TESTNET_COMMITTEE_CONFIG],
};

function requireObject(value: unknown, index: number): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`SEAL_SERVER_CONFIGS[${index}] must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string, index: number): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`SEAL_SERVER_CONFIGS[${index}].${field} must be a non-empty string`);
    }
    return value.trim();
}

function optionalNonEmptyString(value: unknown, field: string, index: number): string | undefined {
    if (value === undefined) return undefined;
    return requireNonEmptyString(value, field, index);
}

function normalizeWeight(value: unknown, index: number): number {
    if (value === undefined) return 1;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`SEAL_SERVER_CONFIGS[${index}].weight must be a positive integer`);
    }
    return value;
}

function normalizeSealServerConfig(value: unknown, index: number): SealServerConfig {
    const raw = requireObject(value, index);
    const objectId = requireNonEmptyString(raw.objectId, "objectId", index);
    const weight = normalizeWeight(raw.weight, index);
    const aggregatorUrl = optionalNonEmptyString(raw.aggregatorUrl, "aggregatorUrl", index);
    const apiKeyName = optionalNonEmptyString(raw.apiKeyName, "apiKeyName", index);
    const apiKey = optionalNonEmptyString(raw.apiKey, "apiKey", index);

    if ((apiKeyName && !apiKey) || (!apiKeyName && apiKey)) {
        throw new Error(
            `SEAL_SERVER_CONFIGS[${index}] must provide both apiKeyName and apiKey, or neither`,
        );
    }

    return {
        objectId,
        weight,
        ...(aggregatorUrl ? { aggregatorUrl } : {}),
        ...(apiKeyName && apiKey ? { apiKeyName, apiKey } : {}),
    };
}

function parseSealServerConfigsJson(value: string): SealServerConfig[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`SEAL_SERVER_CONFIGS must be valid JSON: ${message}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error("SEAL_SERVER_CONFIGS must be a JSON array");
    }

    return parsed.map(normalizeSealServerConfig);
}

function parseLegacyKeyServers(value: string | undefined): SealServerConfig[] {
    return (value || "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((objectId) => ({ objectId, weight: 1 }));
}

function getDefaultSealServerConfigs(network: string | undefined): SealServerConfig[] {
    return DEFAULT_SEAL_SERVER_CONFIGS[network || ""] ?? [];
}

export function getSealServerConfigsFromEnv(env: Env = process.env): SealServerConfig[] {
    const rawServerConfigs = env.SEAL_SERVER_CONFIGS?.trim();
    if (rawServerConfigs) {
        return parseSealServerConfigsJson(rawServerConfigs);
    }

    const legacyConfigs = parseLegacyKeyServers(env.SEAL_KEY_SERVERS);
    if (legacyConfigs.length > 0) {
        return legacyConfigs;
    }

    return getDefaultSealServerConfigs(env.SUI_NETWORK);
}
