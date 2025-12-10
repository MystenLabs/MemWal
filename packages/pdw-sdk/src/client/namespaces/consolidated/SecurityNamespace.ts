/**
 * Security Namespace - Consolidated Security & Access Control
 *
 * Merges functionality from:
 * - EncryptionNamespace: SEAL-based encryption/decryption
 * - PermissionsNamespace: OAuth-style access control
 * - ContextNamespace: App context (MemoryCap) management
 *
 * Provides a unified interface for all security operations.
 *
 * Key features:
 * - SEAL encryption with identity-based access control
 * - Decryption with capability-based or legacy allowlist patterns
 * - App contexts (MemoryCap) for app-scoped data
 * - OAuth-style permission grants and revocations
 *
 * @module client/namespaces/consolidated
 */

import type { ServiceContainer } from '../../SimplePDWClient';
import type { SessionKey } from '@mysten/seal';
import type { MemoryCap } from '../../../core/types/capability';
import type {
  ConsentRequestRecord,
  AccessGrant,
  PermissionScope
} from '../../../types/wallet';
import { CapabilityService } from '../../../services/CapabilityService';

// ============================================================================
// Types
// ============================================================================

/**
 * Encryption result
 */
export interface EncryptionResult {
  encryptedData: Uint8Array;
  backupKey: Uint8Array;
}

/**
 * Decryption options
 */
export interface DecryptionOptions {
  encryptedData: Uint8Array;
  sessionKey?: SessionKey;
  requestingWallet?: string;
  /** MemoryCap object ID for capability-based access control */
  memoryCapId?: string;
  /** SEAL key ID bytes - required with memoryCapId */
  keyId?: Uint8Array;
}

/**
 * Context info with additional metadata
 */
export interface ContextInfo extends MemoryCap {
  /** Number of memories in this context */
  memoryCount?: number;
  /** Last activity timestamp */
  lastActivity?: number;
}

// ============================================================================
// Sub-Namespaces
// ============================================================================

/**
 * Context sub-namespace for app context management
 */
class ContextSubNamespace {
  private capService: CapabilityService | null = null;

  constructor(private services: ServiceContainer) {
    const suiClient = this.services.config.sui?.client;
    const packageId = this.services.config.sui?.packageId;

    if (suiClient && packageId) {
      this.capService = new CapabilityService({ suiClient, packageId });
    }
  }

  private ensureService(): CapabilityService {
    if (!this.capService) {
      throw new Error('CapabilityService not initialized. Check Sui configuration.');
    }
    return this.capService;
  }

  /**
   * Create a new context for an app
   *
   * @param appId - Application identifier (e.g., "MEMO", "HEALTH", "FINANCE")
   * @returns Created context (MemoryCap)
   *
   * @example
   * ```typescript
   * const memoContext = await pdw.security.context.create('MEMO');
   * ```
   */
  async create(appId: string): Promise<MemoryCap> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();
    return await service.create({ appId }, signer);
  }

  /**
   * Get context by app ID
   *
   * @param appId - Application identifier
   * @returns Context or null if not found
   */
  async get(appId: string): Promise<MemoryCap | null> {
    const service = this.ensureService();
    return await service.get(this.services.config.userAddress, appId);
  }

  /**
   * Get or create context for an app
   *
   * @param appId - Application identifier
   * @returns Existing or newly created context
   *
   * @example
   * ```typescript
   * const ctx = await pdw.security.context.getOrCreate('MEMO');
   * ```
   */
  async getOrCreate(appId: string): Promise<MemoryCap> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();
    return await service.getOrCreate(
      { appId, userAddress: this.services.config.userAddress },
      signer
    );
  }

  /**
   * List all contexts owned by the user
   *
   * @returns Array of contexts (MemoryCaps)
   */
  async list(): Promise<MemoryCap[]> {
    const service = this.ensureService();
    return await service.list({ userAddress: this.services.config.userAddress });
  }

  /**
   * Delete a context (burns the capability)
   *
   * Warning: This permanently revokes access to all memories
   * encrypted with this context's key.
   *
   * @param appId - Application identifier
   */
  async delete(appId: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();
    const cap = await service.get(this.services.config.userAddress, appId);
    if (!cap) {
      throw new Error(`Context not found for appId: ${appId}`);
    }
    await service.burn({ capId: cap.id }, signer);
  }

  /**
   * Transfer context to another user
   *
   * @param appId - Application identifier
   * @param recipient - Recipient's Sui address
   */
  async transfer(appId: string, recipient: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();
    const cap = await service.get(this.services.config.userAddress, appId);
    if (!cap) {
      throw new Error(`Context not found for appId: ${appId}`);
    }
    await service.transfer({ capId: cap.id, recipient }, signer);
  }

  /**
   * Check if context exists for an app
   *
   * @param appId - Application identifier
   * @returns True if context exists
   */
  async exists(appId: string): Promise<boolean> {
    const service = this.ensureService();
    return await service.hasCapability(this.services.config.userAddress, appId);
  }

  /**
   * Get SEAL key ID for a context
   *
   * @param appId - Application identifier
   * @returns Key ID as hex string
   */
  async getKeyId(appId: string): Promise<string | null> {
    const service = this.ensureService();
    const cap = await service.get(this.services.config.userAddress, appId);
    if (!cap) return null;
    return service.computeKeyId(cap);
  }

  /**
   * Get all app IDs for user's contexts
   *
   * @returns Array of app IDs
   */
  async getAppIds(): Promise<string[]> {
    const contexts = await this.list();
    return contexts.map(ctx => ctx.appId);
  }
}

/**
 * Permissions sub-namespace for OAuth-style access control
 */
class PermissionsSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Request user consent for data access
   *
   * @param appId - Application identifier
   * @param scopes - Requested permission scopes
   * @param purpose - Purpose description
   * @returns Consent request record
   */
  async request(
    appId: string,
    scopes: PermissionScope[],
    purpose: string
  ): Promise<ConsentRequestRecord> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    return await this.services.permissions.requestConsent({
      requesterWallet: appId,
      targetWallet: this.services.config.userAddress,
      scopes,
      purpose
    });
  }

  /**
   * Grant permissions to an app
   *
   * @param appId - Application to grant access
   * @param scopes - Scopes to grant
   * @param expiresAt - Optional expiration timestamp
   * @returns Access grant record
   *
   * @example
   * ```typescript
   * await pdw.security.permissions.grant('HEALTH_APP', ['read', 'write']);
   * ```
   */
  async grant(
    appId: string,
    scopes: PermissionScope[],
    expiresAt?: number
  ): Promise<AccessGrant> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    return await this.services.permissions.grantPermissions(
      this.services.config.userAddress,
      {
        requestingWallet: appId,
        targetWallet: this.services.config.userAddress,
        scopes,
        expiresAt,
        signer: this.services.config.signer.getSigner()
      }
    );
  }

  /**
   * Revoke permission scope from an app
   *
   * @param appId - Application to revoke from
   * @param scope - Scope to revoke
   * @returns Success status
   *
   * @example
   * ```typescript
   * await pdw.security.permissions.revoke('HEALTH_APP', 'write');
   * ```
   */
  async revoke(appId: string, scope: PermissionScope): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    return await this.services.permissions.revokePermissions(
      this.services.config.userAddress,
      {
        requestingWallet: appId,
        targetWallet: this.services.config.userAddress,
        scope,
        signer: this.services.config.signer.getSigner()
      }
    );
  }

  /**
   * Check if app has specific permission
   *
   * @param appId - Application to check
   * @param scope - Scope to check
   * @returns True if permission exists and valid
   */
  async check(appId: string, scope: PermissionScope): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    return await this.services.permissions.checkPermission(
      appId,
      scope,
      this.services.config.userAddress
    );
  }

  /**
   * List all permission grants for the current user
   *
   * @returns Array of active grants
   */
  async list(): Promise<AccessGrant[]> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    const grants = await this.services.permissions.getGrantsByUser(
      this.services.config.userAddress
    );
    const now = Date.now();
    return grants.filter(g => !g.expiresAt || g.expiresAt > now);
  }

  /**
   * Get pending consent requests
   *
   * @returns Array of pending consent requests
   */
  async getPending(): Promise<ConsentRequestRecord[]> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    const consents = await this.services.permissions.getPendingConsents(
      this.services.config.userAddress
    );
    return consents.map(c => ({
      ...c,
      requestId: c.requestId || `req_${Date.now()}`,
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || Date.now(),
      status: c.status || 'pending'
    })) as ConsentRequestRecord[];
  }

  /**
   * Approve a consent request
   *
   * @param consentId - Consent request ID
   * @returns Access grant
   */
  async approve(consentId: string): Promise<AccessGrant> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    const consents = await this.getPending();
    const consent = consents.find(c => c.requestId === consentId);
    if (!consent) {
      throw new Error(`Consent request ${consentId} not found`);
    }
    return await this.services.permissions.approveConsent(
      this.services.config.userAddress,
      consent as any,
      consent.targetWallet
    );
  }

  /**
   * Deny a consent request
   *
   * @param consentId - Consent request ID
   * @returns Success status
   */
  async deny(consentId: string): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }
    const consents = await this.getPending();
    const consent = consents.find(c => c.requestId === consentId);
    if (!consent) {
      throw new Error(`Consent request ${consentId} not found`);
    }
    return await this.services.permissions.denyConsent(
      this.services.config.userAddress,
      consent as any
    );
  }
}

// ============================================================================
// Security Namespace
// ============================================================================

/**
 * Security Namespace - Unified Security Operations
 *
 * Consolidates encryption, decryption, permissions, and context management.
 *
 * @example
 * ```typescript
 * // Encrypt data
 * const { encryptedData, backupKey } = await pdw.security.encrypt(data);
 *
 * // Decrypt data
 * const decrypted = await pdw.security.decrypt({ encryptedData });
 *
 * // Manage app contexts
 * const ctx = await pdw.security.context.getOrCreate('MEMO');
 *
 * // Grant permissions
 * await pdw.security.permissions.grant('APP_ID', ['read', 'write']);
 * ```
 */
export class SecurityNamespace {
  private _context: ContextSubNamespace;
  private _permissions: PermissionsSubNamespace;

  constructor(private services: ServiceContainer) {
    this._context = new ContextSubNamespace(services);
    this._permissions = new PermissionsSubNamespace(services);
  }

  // ==========================================================================
  // Sub-Namespaces
  // ==========================================================================

  /**
   * App context (MemoryCap) management
   */
  get context(): ContextSubNamespace {
    return this._context;
  }

  /**
   * OAuth-style permission management
   */
  get permissions(): PermissionsSubNamespace {
    return this._permissions;
  }

  // ==========================================================================
  // Encryption Operations (from EncryptionNamespace)
  // ==========================================================================

  /**
   * Encrypt data using SEAL
   *
   * NOTE: This uses userAddress as identity. For capability pattern,
   * use encryptWithKeyId() instead.
   *
   * @param data - Data to encrypt
   * @param threshold - Min key servers required (default: 2)
   * @returns Encrypted data and backup key
   *
   * @example
   * ```typescript
   * const encoder = new TextEncoder();
   * const data = encoder.encode('sensitive data');
   * const { encryptedData, backupKey } = await pdw.security.encrypt(data);
   * ```
   */
  async encrypt(data: Uint8Array, threshold: number = 2): Promise<EncryptionResult> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured. Initialize with encryption config.');
    }
    const result = await this.services.encryption.encrypt(
      data,
      this.services.config.userAddress,
      threshold
    );
    return {
      encryptedData: result.encryptedObject,
      backupKey: result.backupKey
    };
  }

  /**
   * Encrypt data using SEAL with capability-based key ID
   *
   * Use this for capability pattern where keyId = keccak256(owner || nonce).
   * The keyId MUST match what's passed to seal_approve during decryption.
   *
   * @param data - Data to encrypt
   * @param keyId - Key ID bytes (compute with computeKeyId())
   * @param threshold - Min key servers required (default: 2)
   * @returns Encrypted data and backup key
   *
   * @example
   * ```typescript
   * const keyId = pdw.security.computeKeyId(ownerAddress, nonce);
   * const { encryptedData } = await pdw.security.encryptWithKeyId(data, keyId);
   * ```
   */
  async encryptWithKeyId(data: Uint8Array, keyId: Uint8Array, threshold: number = 2): Promise<EncryptionResult> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured. Initialize with encryption config.');
    }
    const keyIdHex = '0x' + Array.from(keyId).map(b => b.toString(16).padStart(2, '0')).join('');
    const result = await this.services.encryption.encrypt(data, keyIdHex, threshold);
    return {
      encryptedData: result.encryptedObject,
      backupKey: result.backupKey
    };
  }

  /**
   * Decrypt SEAL-encrypted data
   *
   * Supports two access control patterns:
   * 1. Capability pattern (recommended): Pass memoryCapId and keyId
   * 2. Legacy allowlist pattern: Only requestingWallet needed
   *
   * @param options - Decryption options
   * @returns Decrypted data
   *
   * @example
   * ```typescript
   * // Capability-based decryption
   * const decrypted = await pdw.security.decrypt({
   *   encryptedData,
   *   memoryCapId: cap.id,
   *   keyId: keyIdBytes
   * });
   *
   * // Or simple decryption (legacy)
   * const decrypted = await pdw.security.decrypt({ encryptedData });
   * ```
   */
  async decrypt(options: DecryptionOptions): Promise<Uint8Array> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return await this.services.encryption.decrypt({
      encryptedContent: options.encryptedData,
      userAddress: this.services.config.userAddress,
      sessionKey: options.sessionKey,
      requestingWallet: options.requestingWallet || this.services.config.userAddress,
      memoryCapId: options.memoryCapId,
      keyId: options.keyId
    });
  }

  /**
   * Compute SEAL key_id from owner and nonce
   *
   * Use this to compute the key_id needed for capability-based encryption/decryption.
   * The nonce comes from the MemoryCap object on-chain.
   *
   * @param ownerAddress - Owner's Sui address
   * @param nonce - Nonce from MemoryCap object (32 bytes)
   * @returns key_id bytes for SEAL operations
   *
   * @example
   * ```typescript
   * const ctx = await pdw.security.context.get('MEMO');
   * const keyId = pdw.security.computeKeyId(userAddress, ctx.nonce);
   * ```
   */
  computeKeyId(ownerAddress: string, nonce: Uint8Array): Uint8Array {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return this.services.encryption.computeKeyId(ownerAddress, nonce);
  }

  // ==========================================================================
  // Session Key Management
  // ==========================================================================

  /**
   * Create session key for SEAL operations
   *
   * @param signer - Optional signer (keypair or signPersonalMessage function)
   * @returns Session key
   */
  async createSessionKey(signer?: {
    signPersonalMessageFn?: (message: string) => Promise<{ signature: string }>;
    keypair?: any;
  }): Promise<SessionKey> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return await this.services.encryption.createSessionKey(
      this.services.config.userAddress,
      signer
    );
  }

  /**
   * Get or create session key (cached)
   *
   * @returns Cached or new session key
   */
  async getSessionKey(): Promise<SessionKey> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return await this.services.encryption.getOrCreateSessionKey(
      this.services.config.userAddress
    );
  }

  /**
   * Export session key for persistence
   *
   * @param sessionKey - Session key to export
   * @returns Serialized session key
   */
  async exportSessionKey(sessionKey: SessionKey): Promise<string> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return await this.services.encryption.exportSessionKey(sessionKey);
  }

  /**
   * Import previously exported session key
   *
   * @param exportedKey - Serialized session key
   * @returns Session key instance
   */
  async importSessionKey(exportedKey: string): Promise<SessionKey> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }
    return await this.services.encryption.importSessionKey(
      exportedKey,
      this.services.config.userAddress
    );
  }
}
