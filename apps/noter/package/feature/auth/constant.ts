/**
 * AUTH CONSTANTS
 * Static values for zkLogin authentication
 */

// Supported OAuth providers for zkLogin
export const OAUTH_PROVIDERS = {
  google: {
    name: "Google",
    clientId: process.env.GOOGLE_CLIENT_ID!,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  },
  // Future providers can be added here:
  // facebook: { ... },
  // twitch: { ... },
} as const;

export type OAuthProvider = keyof typeof OAUTH_PROVIDERS;

// ════════════════════════════════════════════════════════════════
// WALLET AUTHENTICATION
// ════════════════════════════════════════════════════════════════

// Supported wallet types
export const WALLET_TYPES = {
  slush: {
    name: "Slush Wallet",
    installUrl: "https://chromewebstore.google.com/detail/slush-sui-wallet/bkbnpojckbglpdapinihmmfbncjejmgk",
    // Wallet Standard detection (wallet may identify as "Slush" or "Sui Wallet")
    detectionNames: ["slush", "sui wallet"],
  },
} as const;

export type WalletType = keyof typeof WALLET_TYPES;

// Legacy exports for backward compatibility
export const WALLET_INSTALL_URLS: Record<WalletType, string> = {
  slush: WALLET_TYPES.slush.installUrl,
} as const;

export const WALLET_NAMES: Record<WalletType, string> = {
  slush: WALLET_TYPES.slush.name,
} as const;

// zkLogin configuration
export const ZKLOGIN_CONFIG = {
  // Sui network (testnet or mainnet)
  network: (process.env.NEXT_PUBLIC_SUI_NETWORK || "mainnet") as "testnet" | "mainnet",

  // Mysten Labs prover service URL
  proverUrl: process.env.NEXT_PUBLIC_ZK_PROVER_URL || "https://prover-dev.mystenlabs.com/v1",

  // Salt service URL
  saltServiceUrl: process.env.SALT_SERVICE_URL || "https://salt.api.mystenlabs.com/get_salt",

  // Session duration in hours (aligned with Sui epochs ~24h)
  sessionDurationHours: 23,

  // Max epoch offset (how far ahead to set expiration)
  maxEpochOffset: 2,
} as const;

// OAuth scopes required for zkLogin
export const OAUTH_SCOPES = {
  google: ["openid", "email", "profile"],
} as const;

// Session storage keys
export const STORAGE_KEYS = {
  ephemeralPrivateKey: "zklogin:ephemeral:private",
  ephemeralPublicKey: "zklogin:ephemeral:public",
  sessionId: "auth:session:id",
  nonce: "zklogin:nonce",
  maxEpoch: "zklogin:maxEpoch",
  randomness: "zklogin:randomness",
  zkProof: "zklogin:proof",
} as const;

// Error messages
export const AUTH_ERRORS = {
  OAUTH_CANCELLED: "Authentication was cancelled",
  INVALID_JWT: "Invalid or expired JWT token",
  PROOF_GENERATION_FAILED: "Failed to generate zero-knowledge proof",
  SESSION_EXPIRED: "Session has expired",
  NETWORK_ERROR: "Network error during authentication",
  SALT_FETCH_FAILED: "Failed to fetch user salt",
  INVALID_PROVIDER: "Unsupported OAuth provider",
} as const;
