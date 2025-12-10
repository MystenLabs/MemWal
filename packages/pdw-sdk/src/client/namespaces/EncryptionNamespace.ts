/**
 * Encryption Namespace - SEAL-based Encryption Operations
 *
 * Pure delegation to EncryptionService for SEAL encryption.
 * Provides identity-based encryption with decentralized key management.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type { SessionKey } from '@mysten/seal';

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
 * Encryption Namespace
 *
 * Handles SEAL-based encryption with identity-based access control
 */
export class EncryptionNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Encrypt data using SEAL
   *
   * Delegates to: EncryptionService.encrypt()
   *
   * NOTE: This uses userAddress as identity. For capability pattern,
   * use encryptWithKeyId() instead.
   *
   * @param data - Data to encrypt
   * @param threshold - Min key servers required (default: 2)
   * @returns Encrypted data and backup key
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
   * Use this for capability pattern where keyId = keccak256(owner || nonce)
   * The keyId MUST match what's passed to seal_approve during decryption.
   *
   * @param data - Data to encrypt
   * @param keyId - Key ID bytes (compute with computeKeyId())
   * @param threshold - Min key servers required (default: 2)
   * @returns Encrypted data and backup key
   */
  async encryptWithKeyId(data: Uint8Array, keyId: Uint8Array, threshold: number = 2): Promise<EncryptionResult> {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured. Initialize with encryption config.');
    }

    // Convert keyId to hex string for SEAL identity
    const keyIdHex = '0x' + Array.from(keyId).map(b => b.toString(16).padStart(2, '0')).join('');
    console.log(`🔒 Encrypting with capability keyId: ${keyIdHex.substring(0, 20)}...`);

    const result = await this.services.encryption.encrypt(
      data,
      keyIdHex,
      threshold
    );

    return {
      encryptedData: result.encryptedObject,
      backupKey: result.backupKey
    };
  }

  /**
   * Decrypt SEAL-encrypted data
   *
   * Delegates to: EncryptionService.decrypt()
   *
   * Supports two access control patterns:
   * 1. Capability pattern (recommended): Pass memoryCapId and keyId
   * 2. Legacy allowlist pattern: Only requestingWallet needed
   *
   * @param options - Decryption options
   * @returns Decrypted data
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
   * Use this to compute the key_id needed for capability-based decryption.
   * The nonce comes from the MemoryCap object on-chain.
   *
   * @param ownerAddress - Owner's Sui address
   * @param nonce - Nonce from MemoryCap object (32 bytes)
   * @returns key_id bytes for SEAL approval
   */
  computeKeyId(ownerAddress: string, nonce: Uint8Array): Uint8Array {
    if (!this.services.encryption) {
      throw new Error('Encryption service not configured.');
    }

    return this.services.encryption.computeKeyId(ownerAddress, nonce);
  }

  /**
   * Create session key for SEAL operations
   *
   * Delegates to: EncryptionService.createSessionKey()
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
   * Delegates to: EncryptionService.getOrCreateSessionKey()
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
   * Delegates to: EncryptionService.exportSessionKey()
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
   * Delegates to: EncryptionService.importSessionKey()
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
