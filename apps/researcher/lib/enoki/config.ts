/** Enoki zkLogin configuration from NEXT_PUBLIC_* environment variables. */
export const enokiConfig = {
  enokiApiKey: process.env.NEXT_PUBLIC_ENOKI_API_KEY || "",
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
  suiNetwork: (process.env.NEXT_PUBLIC_SUI_NETWORK || "testnet") as
    | "testnet"
    | "mainnet",
  memwalPackageId: process.env.NEXT_PUBLIC_MEMWAL_PACKAGE_ID || "",
  memwalRegistryId: process.env.NEXT_PUBLIC_MEMWAL_REGISTRY_ID || "",
  memwalServerUrl:
    process.env.NEXT_PUBLIC_MEMWAL_SERVER_URL || "http://localhost:9000",
} as const;
