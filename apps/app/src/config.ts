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

export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memwalPackageId: import.meta.env.VITE_MEMWAL_PACKAGE_ID as string ||
        '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6',
    memwalRegistryId: import.meta.env.VITE_MEMWAL_REGISTRY_ID as string ||
        '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437',
    memwalServerUrl: import.meta.env.VITE_MEMWAL_SERVER_URL as string || 'http://localhost:8000',
    suiNetwork: (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
    sealKeyServers: (import.meta.env.VITE_SEAL_KEY_SERVERS as string || '')
        .split(',').map(s => s.trim()).filter(Boolean) as string[],
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
    demoUrls: (import.meta.env.VITE_DEMO_URLS as string || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(entry => {
            const [label, url] = entry.split('|').map(s => s.trim())
            return url ? { label, url } : { label: label, url: label }
        }),
} as const
