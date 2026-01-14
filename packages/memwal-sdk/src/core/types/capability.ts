/**
 * Capability-Based Architecture Types for Personal Data Wallet SDK
 *
 * This module defines the TypeScript interfaces for the new capability-based
 * access control system following SEAL PrivateData pattern.
 *
 * Key concepts:
 * - MemoryCap: Capability object for app context access
 * - Object ownership = access permission (SEAL idiomatic)
 * - Transfer capability = share access
 * - Burn capability = revoke access
 *
 * @see CAPABILITY-ARCHITECTURE-SUMMARY.md
 */

/**
 * Memory capability object - core unit of access control
 *
 * Owns this object = can decrypt memories for this app context
 * Can be transferred to share access with others
 * Burn to permanently revoke access
 */
export interface MemoryCap {
  /** Sui object ID of the capability */
  id: string;
  /** Random nonce for SEAL key derivation */
  nonce: string;
  /** Application context identifier (e.g., "MEMO", "HEALTH") */
  appId: string;
  /** Owner address (who can call seal_approve) */
  owner: string;
  /** Creation timestamp (epoch) */
  createdAt?: number;
}

/**
 * Options for creating a new MemoryCap
 */
export interface CreateMemoryCapOptions {
  /** Application identifier (e.g., "MEMO", "HEALTH") */
  appId: string;
}

/**
 * Options for transferring a MemoryCap
 */
export interface TransferCapOptions {
  /** Object ID of the capability to transfer */
  capId: string;
  /** Recipient address */
  recipient: string;
}

/**
 * Options for burning (revoking) a MemoryCap
 */
export interface BurnCapOptions {
  /** Object ID of the capability to burn */
  capId: string;
}

/**
 * Options for SEAL approval
 */
export interface SealApproveOptions {
  /** Reference to the MemoryCap object */
  capId: string;
  /** SEAL key ID to validate */
  keyId: string;
}

/**
 * Result of querying user's capabilities
 */
export interface MemoryCapList {
  /** All capabilities owned by the user */
  capabilities: MemoryCap[];
  /** Total count */
  count: number;
}

/**
 * Options for filtering capabilities
 */
export interface ListCapsOptions {
  /** Filter by specific app ID */
  appId?: string;
  /** User address (defaults to current signer) */
  userAddress?: string;
}

/**
 * Options for getting or creating a capability
 */
export interface GetOrCreateCapOptions {
  /** Application identifier */
  appId: string;
  /** User address (defaults to current signer) */
  userAddress?: string;
}

/**
 * Event emitted when capability is created
 */
export interface MemoryCapCreatedEvent {
  capId: string;
  owner: string;
  appId: string;
  nonce: string;
  createdAt: number;
}

/**
 * Event emitted when capability is transferred
 */
export interface MemoryCapTransferredEvent {
  capId: string;
  from: string;
  to: string;
  appId: string;
}

/**
 * Event emitted when capability is burned
 */
export interface MemoryCapBurnedEvent {
  capId: string;
  owner: string;
  appId: string;
}

/**
 * Options for computing SEAL key ID
 */
export interface ComputeKeyIdOptions {
  /** Owner address */
  owner: string;
  /** Nonce from capability */
  nonce: string;
}

/**
 * Capability namespace for SimplePDWClient
 * Provides methods for managing MemoryCap objects
 */
export interface CapabilityNamespace {
  /**
   * Create a new MemoryCap for an app context
   * @param appId Application identifier
   * @returns Created capability
   */
  create(appId: string): Promise<MemoryCap>;

  /**
   * Get an existing capability by app ID
   * @param appId Application identifier
   * @returns Capability or null if not found
   */
  get(appId: string): Promise<MemoryCap | null>;

  /**
   * Get or create a capability for an app context
   * @param appId Application identifier
   * @returns Existing or newly created capability
   */
  getOrCreate(appId: string): Promise<MemoryCap>;

  /**
   * List all capabilities owned by the user
   * @param options Optional filter options
   * @returns List of capabilities
   */
  list(options?: ListCapsOptions): Promise<MemoryCap[]>;

  /**
   * Transfer a capability to another address
   * @param capId Capability object ID
   * @param recipient Recipient address
   */
  transfer(capId: string, recipient: string): Promise<void>;

  /**
   * Burn (revoke) a capability
   * @param capId Capability object ID
   */
  burn(capId: string): Promise<void>;

  /**
   * Compute SEAL key ID for a capability
   * @param cap Capability object
   * @returns Key ID bytes as hex string
   */
  computeKeyId(cap: MemoryCap): string;
}

/**
 * Context namespace for SimplePDWClient
 * Higher-level abstraction over capabilities
 */
export interface ContextNamespace {
  /**
   * Create a new context (creates MemoryCap)
   * @param appId Application identifier
   * @returns Created capability
   */
  create(appId: string): Promise<MemoryCap>;

  /**
   * Get context by app ID
   * @param appId Application identifier
   * @returns Capability or null
   */
  get(appId: string): Promise<MemoryCap | null>;

  /**
   * Get or create context
   * @param appId Application identifier
   * @returns Existing or new capability
   */
  getOrCreate(appId: string): Promise<MemoryCap>;

  /**
   * List all contexts for user
   * @returns List of capabilities
   */
  list(): Promise<MemoryCap[]>;

  /**
   * Delete a context (burns capability)
   * @param appId Application identifier
   */
  delete(appId: string): Promise<void>;

  /**
   * Transfer context to another user
   * @param appId Application identifier
   * @param recipient Recipient address
   */
  transfer(appId: string, recipient: string): Promise<void>;
}

/**
 * Wallet namespace for SimplePDWClient
 * Simplified wallet operations (no HD wallet complexity)
 */
export interface WalletNamespace {
  /**
   * Get current wallet address
   * @returns Wallet address
   */
  getAddress(): Promise<string>;

  /**
   * Check if wallet is connected/ready
   * @returns Connection status
   */
  isConnected(): Promise<boolean>;

  /**
   * Get all owned objects of a specific type
   * @param structType Move struct type
   * @returns List of objects
   */
  getOwnedObjects<T>(structType: string): Promise<T[]>;
}

/**
 * Memory creation options with capability
 */
export interface CreateMemoryWithCapOptions {
  /** Capability to use for access control */
  cap: MemoryCap;
  /** Memory content */
  content: string;
  /** Memory category */
  category: string;
  /** Optional topic */
  topic?: string;
  /** Importance level 1-10 */
  importance?: number;
  /** Custom metadata */
  customMetadata?: Record<string, string>;
}

/**
 * Memory query options with context filtering
 */
export interface QueryMemoriesOptions {
  /** User address */
  userAddress: string;
  /** Filter by app context (app_id) */
  appId?: string;
  /** Filter by category */
  category?: string;
  /** Maximum results */
  limit?: number;
}
