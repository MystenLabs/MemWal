/**
 * App-wide configuration from environment variables
 */
export const config = {
    enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY as string || '',
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID as string || '',
    memwalPackageId: import.meta.env.VITE_MEMWAL_PACKAGE_ID as string ||
        '0x93c775e573c0d9aefc0908cc9bb5b0952e131ab6c40b2b769c8b74bb991d34a0',
    memwalServerUrl: import.meta.env.VITE_MEMWAL_SERVER_URL as string || 'http://localhost:3001',
    suiNetwork: (import.meta.env.VITE_SUI_NETWORK as string || 'testnet') as 'testnet' | 'mainnet',
} as const
