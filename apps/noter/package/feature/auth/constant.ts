/**
 * AUTH CONSTANTS
 * Static values for authentication.
 */

// OAuth provider registry — the source of the OAuthProvider union used on
// user/profile types. Enoki handles the actual OAuth client config
// (NEXT_PUBLIC_GOOGLE_CLIENT_ID, see lib/enoki/config.ts); this only enumerates
// the supported providers, so it carries no client id / auth URL of its own.
export const OAUTH_PROVIDERS = {
  google: {
    name: "Google",
  },
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

// Sui network config (used for explorer links, etc.)
export const ZKLOGIN_CONFIG = {
  // Sui network (testnet or mainnet)
  network: (process.env.NEXT_PUBLIC_SUI_NETWORK || "mainnet") as "testnet" | "mainnet",
} as const;

// Session storage keys
export const STORAGE_KEYS = {
  sessionId: "zklogin:session:id",
} as const;

// Error messages
export const AUTH_ERRORS = {
  NETWORK_ERROR: "Network error during authentication",
} as const;
