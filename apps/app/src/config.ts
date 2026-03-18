/**
 * App-wide configuration from environment variables
 */
export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memwalPackageId: import.meta.env.VITE_MEMWAL_PACKAGE_ID as string ||
        '0x12b28adbe55c25341f08b8ad9ac69462aab917048c7cd5b736d951200090ee3f',
    memwalRegistryId: import.meta.env.VITE_MEMWAL_REGISTRY_ID as string ||
        '0xfb8a1d298e2a73bdab353da3fcb3b16f68ab7d1f392f3a5c4944c747c026fc05',
    memwalServerUrl: import.meta.env.VITE_MEMWAL_SERVER_URL as string || 'http://localhost:8000',
    suiNetwork: (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
    docsUrl: import.meta.env.VITE_DOCS_URL as string || '',
} as const
