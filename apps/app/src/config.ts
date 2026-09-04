/**
 * App-wide configuration from environment variables
 */
const DEFAULT_ANALYTICS_ALLOWED_HOSTS = 'walrus.xyz,www.walrus.xyz'

function parseCsv(value: string | undefined, fallback = '') {
    return (value || fallback)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
}

type SealServerConfigEnv = {
    objectId: string
    weight: number
    aggregatorUrl?: string
    apiKeyName?: string
    apiKey?: string
}

/** Same JSON shape as the relayer SEAL_SERVER_CONFIGS array. */
function parseSealServerConfigsJson(raw: string | undefined): {
    configs: SealServerConfigEnv[]
    error: string | null
} {
    const trimmed = (raw || '').trim()
    if (!trimmed) return { configs: [], error: null }
    try {
        const parsed = JSON.parse(trimmed) as unknown
        if (!Array.isArray(parsed)) {
            return { configs: [], error: 'VITE_SEAL_SERVER_CONFIGS must be a JSON array' }
        }
        const configs = parsed.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return []
            const row = entry as Record<string, unknown>
            const objectId = typeof row.objectId === 'string' ? row.objectId.trim() : ''
            if (!objectId) return []
            const weight = typeof row.weight === 'number' && Number.isInteger(row.weight) && row.weight >= 1
                ? row.weight
                : 1
            const aggregatorUrl = typeof row.aggregatorUrl === 'string' ? row.aggregatorUrl.trim() : ''
            const apiKeyName = typeof row.apiKeyName === 'string' ? row.apiKeyName.trim() : ''
            const apiKey = typeof row.apiKey === 'string' ? row.apiKey.trim() : ''
            return [{
                objectId,
                weight,
                ...(aggregatorUrl ? { aggregatorUrl } : {}),
                ...(apiKeyName && apiKey ? { apiKeyName, apiKey } : {}),
            }]
        })
        if (configs.length === 0) {
            return { configs: [], error: 'VITE_SEAL_SERVER_CONFIGS has no valid server entries' }
        }
        return { configs, error: null }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { configs: [], error: `VITE_SEAL_SERVER_CONFIGS is not valid JSON (${message})` }
    }
}

function parseSealThreshold(raw: string | undefined): number {
    const value = Number((raw || '').trim())
    return Number.isInteger(value) && value >= 1 ? value : 0
}

const memwalPackageId = import.meta.env.VITE_MEMWAL_PACKAGE_ID as string ||
    '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6'
const memwalRegistryId = import.meta.env.VITE_MEMWAL_REGISTRY_ID as string ||
    '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437'
const sealKeyServers = parseCsv(import.meta.env.VITE_SEAL_KEY_SERVERS as string)
const sealServerConfigsParsed = parseSealServerConfigsJson(
    import.meta.env.VITE_SEAL_SERVER_CONFIGS as string,
)
const legacySealKeyServers = parseCsv(import.meta.env.VITE_LEGACY_SEAL_KEY_SERVERS as string)
const localE2eJsonRpc = import.meta.env.DEV &&
    (import.meta.env.VITE_SUI_LOCAL_E2E_JSON_RPC as string || '') === 'true'

export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memwalPackageId,
    memwalRegistryId,
    // Legacy-deployment ids for the security-delete surface. The exposed
    // blobs were Seal-encrypted under the PRE-cutover package, and Seal
    // decryption is package-bound (identity namespace + seal_approve policy
    // + the Account object's type all live in that package) — after cutover
    // ships a new package, the preview must keep talking to the old one,
    // exactly like the server keeps LEGACY_DB_URL next to DATABASE_URL.
    // Unset falls back to the current ids, so pre-cutover deployments need
    // no configuration change.
    legacyMemwalPackageId: import.meta.env.VITE_LEGACY_MEMWAL_PACKAGE_ID as string || memwalPackageId,
    legacyMemwalRegistryId: import.meta.env.VITE_LEGACY_MEMWAL_REGISTRY_ID as string || memwalRegistryId,
    // Target of the pre-migration cleanup notice's guide link.
    securityGuideUrl: import.meta.env.VITE_SECURITY_GUIDE_URL as string ||
        'https://docs.wal.app/walrus-memory/guides/delete-old-memories',
    // Date the v1 → v1_new security migration completed. Shown in the
    // pre-migration delete card.
    migrationCompletedDate: import.meta.env.VITE_MIGRATION_COMPLETED_DATE as string ||
        'July 30, 2026',
    memwalServerUrl: import.meta.env.VITE_MEMWAL_SERVER_URL as string || 'http://localhost:8000',
    suiNetwork: (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
    // The local browser suite gets a distinct dapp-kit/wallet chain identity;
    // protocol package defaults still intentionally use suiNetwork above.
    suiClientNetwork: localE2eJsonRpc ? 'localnet' as const :
        (import.meta.env.VITE_SUI_NETWORK as 'testnet' | 'mainnet' || 'testnet'),
    // JSON-RPC endpoint override for the app's shared Sui client. For a real
    // network it applies only to the active network; the local browser suite
    // also uses it for its explicit localnet escape hatch.
    suiRpcUrl: import.meta.env.VITE_SUI_RPC_URL as string || '',
    localE2eJsonRpc,
    // gRPC endpoint used by the security-delete subsystem's dedicated client.
    suiGrpcUrl: import.meta.env.VITE_SUI_GRPC_URL as string || '',
    sealKeyServers,
    // Unwrap committee must match the relayer (SEAL_SERVER_CONFIGS / SEAL_THRESHOLD).
    sealServerConfigs: sealServerConfigsParsed.configs,
    sealServerConfigsError: sealServerConfigsParsed.error,
    sealThreshold: parseSealThreshold(import.meta.env.VITE_SEAL_THRESHOLD as string),
    // Same cutover rationale as legacyMemwalPackageId: legacy blobs were
    // encrypted against the pre-cutover key-server committee. Unset falls
    // back to the current set.
    legacySealKeyServers: legacySealKeyServers.length > 0 ? legacySealKeyServers : sealKeyServers,
    // Walrus aggregator read fallback for the security-delete preview.
    // WalrusClient.readBlob() resolves storage-node URLs from on-chain
    // committee data and always dials them over `https://`
    // (@mysten/walrus's WalrusClient hardcodes the scheme) — against a
    // local devstack cluster, that on-chain-advertised address is a
    // Docker-internal hostname unreachable from the browser, and even
    // devstack's router-exposed alias for the node only answers plain
    // HTTP. There is no WalrusClient config hook to remap this. Empty (the
    // default) preserves today's behavior exactly (direct node quorum
    // reads); set to an aggregator base URL to fetch the decoded blob
    // bytes via a plain HTTP GET instead. See utils/blobPreview.ts.
    walrusAggregatorUrl: import.meta.env.VITE_WALRUS_AGGREGATOR_URL as string || '',
    // Walrus package config override, mirroring the sidecar's
    // WALRUS_SYSTEM_OBJECT_ID/WALRUS_STAKING_POOL_ID (see
    // services/server/scripts/sidecar/clients.ts createWalrusClient).
    // WalrusClient only resolves package/staking ids itself for
    // "mainnet"/"testnet" — a devstack localnet needs them supplied
    // directly, or every WalrusClient call that touches on-chain package
    // state (including blobPreview.ts's aggregator-bytes blob id check)
    // resolves the wrong (real testnet) system object and fails. Empty
    // (the default) keeps using `suiNetwork`'s built-in config.
    walrusSystemObjectId: import.meta.env.VITE_WALRUS_SYSTEM_OBJECT_ID as string || '',
    walrusStakingPoolId: import.meta.env.VITE_WALRUS_STAKING_POOL_ID as string || '',
    sidecarUrl: import.meta.env.VITE_SIDECAR_URL as string || 'http://localhost:9000',
    docsUrl: import.meta.env.VITE_DOCS_URL as string || '',
    termsOfServiceUrl: import.meta.env.VITE_TERMS_OF_SERVICE_URL as string ||
        'https://docs.wal.app/docs/legal/walrus_general_tos',
    privacyPolicyUrl: import.meta.env.VITE_PRIVACY_POLICY_URL as string ||
        'https://docs.wal.app/docs/legal/privacy',
    gtmContainerId: import.meta.env.VITE_GTM_CONTAINER_ID as string || '',
    gaMeasurementId: import.meta.env.VITE_GA_MEASUREMENT_ID as string || '',
    posthogProjectApiKey: (
        (import.meta.env.VITE_POSTHOG_PROJECT_API_KEY as string | undefined) ||
        (import.meta.env.VITE_POSTHOG_KEY as string | undefined) ||
        ''
    ),
    posthogHost: import.meta.env.VITE_POSTHOG_HOST as string || 'https://t.walrus.xyz',
    posthogUiHost: import.meta.env.VITE_POSTHOG_UI_HOST as string || 'https://us.posthog.com',
    analyticsAllowedHosts: parseCsv(
        import.meta.env.VITE_ANALYTICS_ALLOWED_HOSTS as string | undefined,
        DEFAULT_ANALYTICS_ALLOWED_HOSTS,
    ),
    // Permanent V1 memory deletion UI. Off by default so nothing
    // is user-visible until the feature is tested and rollout is agreed.
    // Must be enabled together with the relayer's ENABLE_MEMORY_DELETION.
    enableMemoryDeletion: (import.meta.env.VITE_ENABLE_MEMORY_DELETION as string || '') === 'true',
    securityDeleteEnabled: (import.meta.env.VITE_SECURITY_DELETE_ENABLED as string || '') === 'true',
    // V2 namespace slice. V1 package/registry defaults above stay unchanged.
    // Testnet object-id fallbacks match scripts/v2e2e/STATE.md only when the
    // VITE_MEMWAL_V2_* vars are unset — never override an explicit env value.
    v2PackageId: (import.meta.env.VITE_MEMWAL_V2_PACKAGE_ID as string) || (
        (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') === 'testnet'
            ? '0xdf67385f0842bcdd7234b73d9822f1b29f7d7991115c219a589118d8c5501dfc'
            : ''
    ),
    v2RegistryId: (import.meta.env.VITE_MEMWAL_V2_REGISTRY_ID as string) || (
        (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') === 'testnet'
            ? '0x0e04320f37466a449d7bf6980bf8dad22d563da41faf98a0aab8b82c802eff86'
            : ''
    ),
    v2NamespaceRegistryId: (import.meta.env.VITE_MEMWAL_V2_NAMESPACE_REGISTRY_ID as string) || (
        (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') === 'testnet'
            ? '0x1d0a9f1bf04832387fa911cbb83e59c99332439d93e89e1e868f23f5a08cb995'
            : ''
    ),
    v2NamespacesEnabled: (import.meta.env.VITE_V2_NAMESPACES_ENABLED as string || '') === 'true',
    v2WriterAddresses: parseCsv(import.meta.env.VITE_MEMWAL_V2_WRITER_ADDRESSES as string),
    demoUrls: (import.meta.env.VITE_DEMO_URLS as string || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(entry => {
            const [label, url] = entry.split('|').map(s => s.trim())
            return url ? { label, url } : { label: label, url: label }
        }),
} as const
