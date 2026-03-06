/**
 * App-wide configuration from environment variables
 */
export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memwalPackageId: import.meta.env.VITE_MEMWAL_PACKAGE_ID as string ||
        '0xb625c403a26c4b985a3f2549e6115c1646b0094d39fa142016807ba015952869',
    memwalRegistryId: import.meta.env.VITE_MEMWAL_REGISTRY_ID as string ||
        '0x3d46792b7676e6558707982b535092454a46e668b52c0a6d83b9a9fdecd71c46',
    memwalServerUrl: import.meta.env.VITE_MEMWAL_SERVER_URL as string || 'http://localhost:3001',
    suiNetwork: (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
} as const
