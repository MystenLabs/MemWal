/**
 * Wallet Architecture Types for Personal Data Wallet SDK
 * 
 * Defines the TypeScript interfaces for the wallet system including:
 * - Main wallet (per user identity)
 * - Context wallets (per app per user) 
 * - Access control and permissions
 * - Cross-app consent and grants
 */

/**
 * Main wallet represents a user's primary identity anchor
 * Contains derivation salts and key management metadata
 */
export interface MainWallet {
  /** Sui address of the wallet owner */
  owner: string;
  /** Unique identifier for this main wallet */
  walletId: string;
  /** Timestamp when wallet was created */
  createdAt: number;
  /** Cryptographic salts for key derivation */
  salts: {
    /** Salt used for deriving context IDs */
    context: string;
  };
}

/**
 * Context wallet represents an app-scoped data container
 * Provides isolation between different applications
 */
export interface ContextWallet {
  /** Unique context identifier (derived from user + app + salt) */
  id: string;
  /** Application ID that owns this context */
  appId: string;
  /** Sui address of the wallet owner */
  owner: string;
  /** Optional reference to access control policy */
  policyRef?: string;
  /** Timestamp when context was created */
  createdAt: number;
}

/**
 * Request for user consent to access data across contexts
 * Used in OAuth-style permission flow
 */
export interface ConsentRequest {
  /** Wallet requesting access */
  requesterWallet: string;
  /** Target wallet that owns the data */
  targetWallet: string;
  /** Specific permission scopes being requested */
  targetScopes: PermissionScope[];
  /** Human-readable purpose for the access request */
  purpose: string;
  /** Optional expiration timestamp for the request */
  expiresAt?: number;
}

/**
 * Granted access permission from user to app
 * Stored on-chain and mirrored in Walrus for quick lookups
 */
export interface AccessGrant {
  /** Unique grant identifier */
  id: string;
  /** Wallet requesting access (grantee) */
  requestingWallet: string;
  /** Target wallet that grants access */
  targetWallet: string;
  /** Specific permission scopes granted */
  scopes: PermissionScope[];
  /** Expiration timestamp for this grant */
  expiresAt?: number;
  /** Timestamp when grant was issued */
  grantedAt: number;
  /** Optional transaction digest once executed on-chain */
  transactionDigest?: string;
}

/**
 * Options for creating a new main wallet
 */
export interface CreateMainWalletOptions {
  /** User's Sui address */
  userAddress: string;
  /** Optional custom salts (will be generated if not provided) */
  salts?: {
    context?: string;
  };
}

/**
 * Options for creating a new context wallet
 */
export interface CreateContextWalletOptions {
  /** Application identifier */
  appId: string;
  /** Optional policy reference for access control */
  policyRef?: string;
  /** Optional metadata for the context */
  metadata?: Record<string, any>;
}

/**
 * Options for deriving a context ID
 */
export interface DeriveContextIdOptions {
  /** User's Sui address */
  userAddress: string;
  /** Application identifier */
  appId: string;
  /** Optional custom salt (uses main wallet salt if not provided) */
  salt?: string;
}

/**
 * Options for key rotation
 */
export interface RotateKeysOptions {
  /** User's Sui address */
  userAddress: string;
  /** Optional TTL for new session key in minutes */
  sessionKeyTtlMin?: number;
}

/**
 * Result of key rotation operation
 */
export interface RotateKeysResult {
  /** New session key identifier */
  sessionKeyId: string;
  /** Expiration timestamp for the new session key */
  expiresAt: number;
  /** Whether backup key was also rotated */
  backupKeyRotated: boolean;
}

/**
 * Permission scope constants for OAuth-style access control
 */
export const PermissionScopes = {
  /** Can decrypt and read user's memory data */
  READ_MEMORIES: 'read:memories',
  /** Can create/modify memory entries */
  WRITE_MEMORIES: 'write:memories',
  /** Can access user settings/preferences */
  READ_PREFERENCES: 'read:preferences',
  /** Can modify user settings */
  WRITE_PREFERENCES: 'write:preferences',
  /** Can list user's app contexts */
  READ_CONTEXTS: 'read:contexts',
  /** Can create new contexts for user */
  WRITE_CONTEXTS: 'write:contexts',
} as const;

/**
 * Type for permission scope values
 */
export type PermissionScope = typeof PermissionScopes[keyof typeof PermissionScopes];

/**
 * Options for requesting consent
 */
export interface RequestConsentOptions {
  /** Wallet requesting access */
  requesterWallet: string;
  /** Target wallet that owns the data */
  targetWallet: string;
  /** Permission scopes being requested */
  scopes: PermissionScope[];
  /** Human-readable purpose */
  purpose: string;
  /** Optional expiration in milliseconds from now */
  expiresIn?: number;
}

/**
 * Options for granting permissions
 */
export interface GrantPermissionsOptions {
  /** Wallet requesting access (grantee) */
  requestingWallet: string;
  /** Target wallet that owns the data */
  targetWallet: string;
  /** Permission scopes to grant */
  scopes: PermissionScope[];
  /** Optional expiration timestamp */
  expiresAt?: number;
}

/**
 * Options for revoking permissions
 */
export interface RevokePermissionsOptions {
  /** Wallet requesting access */
  requestingWallet: string;
  /** Target wallet that granted access */
  targetWallet: string;
  /** Optional scope to revoke */
  scope?: PermissionScope;
}

/**
 * Options for aggregated queries across contexts
 */
export interface AggregatedQueryOptions {
  /** Wallet requesting the aggregated query */
  requestingWallet: string;
  /** User address for permission validation */
  userAddress: string;
  /** Optional list of target wallets to include */
  targetWallets?: string[];
  /** Search query */
  query: string;
  /** Required permission scope */
  scope: PermissionScope;
  /** Optional result limit */
  limit?: number;
}