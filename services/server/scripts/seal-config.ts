import { isValidSuiObjectId, normalizeSuiObjectId } from "@mysten/sui/utils";

export type SealServerConfig = {
  objectId: string;
  weight: number;
  aggregatorUrl?: string;
  apiKeyName?: string;
  apiKey?: string;
};

export type SealCommitteeIdentity = {
  servers: Array<{ objectId: string; weight: number }>;
  threshold: number;
};

type Env = Record<string, string | undefined>;

const MAX_SEAL_WEIGHTED_SERVERS = 254;

const DEFAULT_SEAL_SERVER_CONFIGS: Record<string, SealServerConfig[]> = {
  mainnet: [
    {
      objectId:
        "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6",
      weight: 1,
    },
    {
      objectId:
        "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10",
      weight: 1,
    },
  ],
  testnet: [
    {
      // Keep the original Mysten testnet independent key servers as the
      // built-in default so existing encrypted memories remain decryptable.
      // Operators can opt into Mysten's committee Seal aggregator with
      // SEAL_SERVER_CONFIGS after migrating or re-encrypting old data.
      objectId:
        "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
      weight: 1,
    },
    {
      objectId:
        "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
      weight: 1,
    },
  ],
};

function requireObject(value: unknown, index: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`SEAL_SERVER_CONFIGS[${index}] must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  index: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `SEAL_SERVER_CONFIGS[${index}].${field} must be a non-empty string`
    );
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  index: number
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, index);
}

function normalizeWeight(value: unknown, index: number): number {
  if (value === undefined) return 1;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SEAL_WEIGHTED_SERVERS
  ) {
    throw new Error(
      `SEAL_SERVER_CONFIGS[${index}].weight must be an integer between 1 and ${MAX_SEAL_WEIGHTED_SERVERS}`
    );
  }
  return value;
}

function normalizeObjectId(value: unknown, index: number): string {
  const raw = requireNonEmptyString(value, "objectId", index);
  const objectId = normalizeSuiObjectId(raw);
  if (!isValidSuiObjectId(objectId)) {
    throw new Error(
      `SEAL_SERVER_CONFIGS[${index}].objectId must be a Sui object ID`
    );
  }
  return objectId;
}

function normalizeSealServerConfig(
  value: unknown,
  index: number
): SealServerConfig {
  const raw = requireObject(value, index);
  const objectId = normalizeObjectId(raw.objectId, index);
  const weight = normalizeWeight(raw.weight, index);
  const aggregatorUrl = optionalNonEmptyString(
    raw.aggregatorUrl,
    "aggregatorUrl",
    index
  );
  const apiKeyName = optionalNonEmptyString(
    raw.apiKeyName,
    "apiKeyName",
    index
  );
  const apiKey = optionalNonEmptyString(raw.apiKey, "apiKey", index);

  if ((apiKeyName && !apiKey) || (!apiKeyName && apiKey)) {
    throw new Error(
      `SEAL_SERVER_CONFIGS[${index}] must provide both apiKeyName and apiKey, or neither`
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
    .map((objectId, index) => normalizeSealServerConfig({ objectId }, index));
}

function getDefaultSealServerConfigs(
  network: string | undefined
): SealServerConfig[] {
  return (DEFAULT_SEAL_SERVER_CONFIGS[network || "mainnet"] ?? []).map(
    normalizeSealServerConfig
  );
}

function sealTotalWeight(configs: SealServerConfig[]): number {
  const totalWeight = configs.reduce((sum, config) => sum + config.weight, 0);
  if (
    !Number.isSafeInteger(totalWeight) ||
    totalWeight > MAX_SEAL_WEIGHTED_SERVERS
  ) {
    throw new Error(
      `total configured SEAL server weight must be at most ${MAX_SEAL_WEIGHTED_SERVERS}`
    );
  }
  return totalWeight;
}

export function getSealServerConfigsFromEnv(
  env: Env = process.env
): SealServerConfig[] {
  const rawServerConfigs = env.SEAL_SERVER_CONFIGS?.trim();
  const legacyConfigs = parseLegacyKeyServers(env.SEAL_KEY_SERVERS);
  const configs = rawServerConfigs
    ? parseSealServerConfigsJson(rawServerConfigs)
    : legacyConfigs.length > 0
    ? legacyConfigs
    : getDefaultSealServerConfigs(env.SUI_NETWORK);
  if (
    new Set(configs.map(({ objectId }) => objectId)).size !== configs.length
  ) {
    throw new Error("SEAL server object IDs must be unique");
  }
  sealTotalWeight(configs);
  return configs;
}

export function getSealDecryptServerConfigsFromEnv(
  activeConfigs: SealServerConfig[],
  env: Env = process.env
): SealServerConfig[] {
  const legacyConfigs = parseLegacyKeyServers(
    env.SEAL_LEGACY_DECRYPT_KEY_SERVERS
  );
  const configs = [...activeConfigs];
  const objectIds = new Set(configs.map(({ objectId }) => objectId));
  for (const config of legacyConfigs) {
    if (!objectIds.has(config.objectId)) {
      configs.push(config);
      objectIds.add(config.objectId);
    }
  }
  sealTotalWeight(configs);
  return configs;
}

export function getSealThresholdFromEnv(
  configs: SealServerConfig[],
  env: Env = process.env
): number {
  const totalWeight = sealTotalWeight(configs);
  const defaultThreshold = totalWeight > 0 ? Math.min(2, totalWeight) : 2;
  const rawThreshold = env.SEAL_THRESHOLD?.trim();

  if (!rawThreshold) {
    return defaultThreshold;
  }

  const threshold = Number(rawThreshold);
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > MAX_SEAL_WEIGHTED_SERVERS
  ) {
    throw new Error("SEAL_THRESHOLD must be a positive integer");
  }

  if (totalWeight > 0 && threshold > totalWeight) {
    throw new Error(
      "SEAL_THRESHOLD must be less than or equal to total configured SEAL server weight"
    );
  }

  return threshold;
}

export function getSealCommitteeIdentity(
  configs: SealServerConfig[],
  threshold: number
): SealCommitteeIdentity {
  return {
    servers: configs.map(({ objectId, weight }) => ({ objectId, weight })),
    threshold,
  };
}

export function sealCommitteeIdentityMatches(
  expected: unknown,
  actual: SealCommitteeIdentity
): boolean {
  if (!expected || typeof expected !== "object") return false;
  const candidate = expected as Partial<SealCommitteeIdentity>;
  return (
    candidate.threshold === actual.threshold &&
    Array.isArray(candidate.servers) &&
    candidate.servers.length === actual.servers.length &&
    candidate.servers.every(
      (server, index) =>
        server?.objectId === actual.servers[index].objectId &&
        server.weight === actual.servers[index].weight
    )
  );
}
