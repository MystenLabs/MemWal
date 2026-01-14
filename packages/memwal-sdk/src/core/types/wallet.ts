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
 * Stored as dynamic field on MainWallet for easy lookup
 * Provides isolation between different applications
 */
export interface ContextWallet {
  /** Sui object ID of the ContextWallet */
  id: string;
  /** Application ID that owns this context */
  appId: string;
  /** Deterministic context ID (sha3_256 hash) */
  contextId: string;
  /** Sui address of the wallet owner */
  owner: string;
  /** Parent MainWallet object ID */
  mainWalletId: string;
  /** Optional reference to access control policy */
  policyRef?: string;
  /** Timestamp when context was created */
  createdAt: number;
  /** Granted permissions for this context */
  permissions: string[];
}

/**
 * Combined view of derived context information
 * Includes both the deterministic hash ID and the actual Sui object address
 */
export interface DerivedContext {
  /** Deterministic context ID (sha3_256 hash) - used for SEAL keys, tags */
  contextId: string;
  /** Application identifier */
  appId: string;
  /** Actual Sui object address (if context wallet has been created on-chain) */
  objectAddress?: string;
  /** Whether the context wallet exists on-chain */
  exists: boolean;
}

/**
 * Request for user consent to access data across contexts
 * Used in OAuth-style permission flow
 */
export type ConsentStatus = 'pending' | 'approved' | 'denied';

export interface ConsentRequest {
  /** Wallet requesting access (requester app/context wallet address) */
  requesterWallet: string;
  /** Wallet that will grant access (target context wallet address) */
  targetWallet: string;
  /** Specific permission scopes being requested */
  targetScopes: PermissionScope[];
  /** Human-readable purpose for the access request */
  purpose: string;
  /** Optional expiration timestamp for the request */
  expiresAt?: number;
  /** Unique identifier for the request */
  requestId?: string;
  /** Timestamp when the request was created */
  createdAt?: number;
  /** Current status of the consent request */
  status?: ConsentStatus;
  /** Timestamp when the request was last updated */
  updatedAt?: number;
}

/**
 * Persisted consent request with required metadata fields
 */
export interface ConsentRequestRecord extends ConsentRequest {
  /** Unique identifier for the request */
  requestId: string;
  /** Timestamp when the request was created */
  createdAt: number;
  /** Current status of the consent request */
  status: ConsentStatus;
  /** Timestamp when the request was last updated */
  updatedAt: number;
}

/**
 * Granted access permission from user to app
 * Stored on-chain and mirrored in Walrus for quick lookups
 */
export interface AccessGrant {
  /** Unique grant identifier */
  id: string;
  /** Wallet that requested access (grantee) */
  requestingWallet: string;
  /** Target wallet that granted access (context owner wallet) */
  targetWallet: string;
  /** Specific permission scopes granted */
  scopes: PermissionScope[];
  /** Expiration timestamp for this grant */
  expiresAt?: number;
  /** Timestamp when grant was recorded */
  grantedAt: number;
  /** Optional transaction digest if executed on-chain */
  transactionDigest?: string;
  /** Timestamp when grant was revoked */
  revokedAt?: number;
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
  /** Target wallet that granted the access */
  targetWallet: string;
  /** Optional scope to revoke (revokes all if omitted) */
  scope?: PermissionScope;
}

/**
 * Options for aggregated queries across contexts
 */
export interface AggregatedQueryOptions {
  /** Wallet requesting the aggregated query */
  requestingWallet: string;
  /** Owner of the contexts being queried */
  userAddress: string;
  /** Optional explicit list of target wallets to include */
  targetWallets?: string[];
  /** Search query */
  query: string;
  /** Required permission scope */
  scope: PermissionScope;
  /** Optional result limit */
  limit?: number;
}