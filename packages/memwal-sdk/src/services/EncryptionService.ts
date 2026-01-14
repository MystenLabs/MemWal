/**
 * EncryptionService - SEAL-based encryption and access control
 * 
 * Provides identity-based encryption using Mysten's SEAL SDK with decentralized
 * key management and onchain access control policies.
 */

import { SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex } from '@mysten/sui/utils';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { SealService } from '../infrastructure/seal/SealService';
import { CrossContextPermissionService } from './CrossContextPermissionService';
import type {
  ClientWithCoreApi,
  PDWConfig,
  AccessPermission,
  AccessControlOptions,
  Thunk,
  SealEncryptionResult,
  SealDecryptionOptions
} from '../types';

export interface AccessGrantOptions {
  ownerAddress: string;
  recipientAddress: string;
  contentId: string;
  accessLevel: 'read' | 'write';
  expiresIn?: number; // milliseconds from now
}

export interface AccessRevokeOptions {
  ownerAddress: string;
  recipientAddress: string;
  contentId: string;
}

export class EncryptionService {
  private sealService: SealService;
  private suiClient: any;
  private packageId: string;
  private sessionKeyCache = new Map<string, SessionKey>();
  private permissionService: CrossContextPermissionService;

  constructor(
    private client: ClientWithCoreApi,
    private config: PDWConfig
  ) {
    this.suiClient = (client as any).client || client;
    this.packageId = config.packageId || '';
    this.sealService = this.initializeSealService();
    
    // Initialize permission service for OAuth-style access control
    this.permissionService = new CrossContextPermissionService(
      {
        packageId: this.packageId,
        accessRegistryId: config.accessRegistryId || ''
      },
      this.suiClient
    );
  }

  /**
   * Initialize SEAL service with proper configuration
   */
  private initializeSealService(): SealService {
    const encryptionConfig = this.config.encryptionConfig;
    
    if (!encryptionConfig?.enabled) {
      console.warn('Encryption is disabled in configuration - creating SealService anyway');
    }

    // Default testnet key servers (replace with actual server object IDs)
    const defaultKeyServers = [
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
    ];

    const keyServerIds = encryptionConfig?.keyServers || defaultKeyServers;
    
    // Create SealService with proper configuration
    const sealConfig = {
      suiClient: this.suiClient,
      packageId: this.packageId,
      keyServerUrls: [], // Empty for now, URLs handled separately if needed
      keyServerObjectIds: keyServerIds,
      network: process.env.NODE_ENV === 'production' ? 'mainnet' as const : 'testnet' as const,
      threshold: 2,
      enableMetrics: true,
      retryAttempts: 3,
      timeoutMs: 30000
    };

    return new SealService(sealConfig);
  }

  /**
   * Build access approval transaction for SEAL key servers (LEGACY)
   *
   * @deprecated Use buildAccessTransactionForWallet instead for wallet-based permissions
   */
  async buildAccessTransaction(
    userAddress: string,
    accessType: 'read' | 'write' = 'read'
  ): Promise<Transaction> {
    console.warn('buildAccessTransaction is deprecated - use buildAccessTransactionForWallet for wallet-based permissions');

    return this.buildAccessTransactionForWallet(userAddress, userAddress, accessType);
  }

  /**
   * Build access approval transaction using capability pattern
   *
   * Uses pdw::capability::seal_approve which validates:
   * - User owns the MemoryCap object
   * - Provided key_id matches computed key from owner + nonce
   *
   * @param keyId - SEAL key ID bytes (computed from owner + nonce)
   * @param memoryCapId - MemoryCap object ID on Sui
   * @returns Transaction for SEAL key server approval
   */
  buildCapabilityApproveTransaction(
    keyId: Uint8Array,
    memoryCapId: string
  ): Transaction {
    return this.permissionService.buildSealApproveTransaction(keyId, memoryCapId);
  }

  /**
   * Build access approval transaction for a requesting wallet address
   * Uses CrossContextPermissionService for proper permission validation
   *
   * @deprecated Use buildCapabilityApproveTransaction for capability-based access
   * @param userAddress - User's wallet address (used as SEAL identity)
   * @param requestingWallet - Wallet requesting access
   * @param accessType - Access level (read/write)
   * @returns Transaction for SEAL key server approval
   */
  async buildAccessTransactionForWallet(
    userAddress: string,
    requestingWallet: string,
    accessType: 'read' | 'write' = 'read'
  ): Promise<Transaction> {
    // Legacy: Convert user address to bytes for SEAL identity
    const identityBytes = fromHex(userAddress.replace('0x', ''));

    // Use legacy method if memoryCapId is not available
    return this.permissionService.buildSealApproveTransactionLegacy(
      identityBytes,
      requestingWallet
    );
  }

  /**
   * Encrypt data using SEAL via SealService
   *
   * @param data - Data to encrypt
   * @param userAddress - User's wallet address (used as SEAL identity/id)
   * @param threshold - Minimum key servers required for decryption (default: 2)
   * @returns Encrypted data and backup key
   */
  async encrypt(
    data: Uint8Array,
    userAddress: string,
    threshold?: number
  ): Promise<{ encryptedObject: Uint8Array; backupKey: Uint8Array }> {
    try {
      console.log('🔒 EncryptionService: Starting SEAL encryption...');
      console.log(`   User address (identity): ${userAddress}`);
      console.log(`   Data size: ${data.length} bytes`);
      console.log(`   Threshold: ${threshold || 2} key servers`);

      const result = await this.sealService.encryptData({
        data,
        id: userAddress, // Use user's address as SEAL identity
        threshold: threshold || 2
      });

      console.log('✅ EncryptionService: SEAL encryption successful');
      console.log(`   Encrypted size: ${result.encryptedObject.length} bytes`);
      console.log(`   Backup key generated: ${result.key.length} bytes`);

      return {
        encryptedObject: result.encryptedObject,
        backupKey: result.key
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * Decrypt data using SEAL with session keys via SealService
   * Handles both new binary format (Uint8Array) and legacy base64 format
   *
   * Supports two access control patterns:
   * 1. Capability pattern (recommended): Requires memoryCapId and keyId
   * 2. Legacy allowlist pattern: Uses requestingWallet for permission check
   */
  async decrypt(options: SealDecryptionOptions): Promise<Uint8Array> {
    try {
      console.log('🔓 EncryptionService: Starting SEAL decryption...');
      console.log(`   User address: ${options.userAddress}`);
      const requestingWallet = options.requestingWallet ?? options.userAddress;

      // Get or create session key
      let activeSessionKey = options.sessionKey;
      if (!activeSessionKey) {
        console.log('🔄 Creating session key...');
        activeSessionKey = await this.getOrCreateSessionKey(options.userAddress);
      }

      // Build access transaction if not provided
      let txBytes = options.signedTxBytes;
      if (!txBytes) {
        // Check if capability pattern is being used
        if (options.memoryCapId && options.keyId) {
          console.log('🔄 Building capability-based access transaction...');
          console.log(`   MemoryCap ID: ${options.memoryCapId}`);
          console.log(`   Key ID length: ${options.keyId.length} bytes`);

          const tx = this.buildCapabilityApproveTransaction(options.keyId, options.memoryCapId);
          // CRITICAL: Set sender before building - required by Transaction.build()
          tx.setSender(requestingWallet);
          console.log(`   Transaction sender set to: ${requestingWallet}`);
          // SEAL REQUIREMENT: Must use onlyTransactionKind: true for PTB validation
          txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });
        } else {
          // Fallback to legacy allowlist pattern
          console.log('🔄 Building legacy access transaction (allowlist pattern)...');
          console.warn('   ⚠️  Consider using capability pattern with memoryCapId and keyId');
          console.log(`   Requesting wallet: ${requestingWallet}`);

          const tx = await this.buildAccessTransactionForWallet(
            options.userAddress,
            requestingWallet,
            'read'
          );
          // CRITICAL: Set sender before building - required by Transaction.build()
          tx.setSender(requestingWallet);
          console.log(`   Transaction sender set to: ${requestingWallet}`);
          // SEAL REQUIREMENT: Must use onlyTransactionKind: true for PTB validation
          txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });
        }
      }

      if (!txBytes) {
        throw new Error('Failed to build SEAL approval transaction bytes');
      }

      // ✅ CRITICAL: Handle both binary and legacy formats
      let encryptedBytes: Uint8Array;
      
      if (options.encryptedContent && options.encryptedContent instanceof Uint8Array) {
        // **NEW BINARY FORMAT** (preferred - matches memory-workflow-seal.ts)
        encryptedBytes = options.encryptedContent;
        console.log('✅ Using new binary format (Uint8Array)');
        console.log(`   Binary data size: ${encryptedBytes.length} bytes`);
        console.log(`   Format: Direct binary (preserves SEAL integrity)`);
      } else if (options.encryptedData) {
        // **LEGACY BASE64 FORMAT** (deprecated but supported for backward compatibility)
        console.log('⚠️  Using legacy base64 format (deprecated)');
        const encryptedDataBase64 = options.encryptedData;
        const binaryString = atob(encryptedDataBase64);
        encryptedBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          encryptedBytes[i] = binaryString.charCodeAt(i);
        }
        console.log(`   Converted from base64: ${encryptedDataBase64.length} chars → ${encryptedBytes.length} bytes`);
        console.log('   Recommendation: Use encryptedContent (Uint8Array) for better performance');
      } else {
        throw new Error('No encrypted data provided. Use either encryptedContent (Uint8Array) or encryptedData (base64 string)');
      }

      console.log('🔄 Calling SEAL decryption...');
      console.log(`   Encrypted data length: ${encryptedBytes.length} bytes`);
      console.log(`   Session key available: ${!!activeSessionKey}`);
      console.log(`   Transaction bytes length: ${txBytes.length} bytes`);

      // Use SealService for decryption (matches memory-workflow-seal.ts pattern)
      const decryptResult = await this.sealService.decryptData({
        encryptedObject: encryptedBytes,
        sessionKey: activeSessionKey,
        txBytes
      });

      console.log(`✅ EncryptionService: SEAL decryption successful`);
      console.log(`   Decrypted data size: ${decryptResult.length} bytes`);
      console.log(`   Binary integrity preserved throughout process`);

      return decryptResult;
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  // ==================== SESSION KEY MANAGEMENT ====================

  /**
   * Create a new session key for a user via SealService
   * 
   * Two usage patterns:
   * 1. Frontend: Pass signPersonalMessageFn from @mysten/dapp-kit useSignPersonalMessage hook
   * 2. Backend: Pass keypair for direct signing (auto-converts format)
   */
  async createSessionKey(
    userAddress: string, 
    signer?: {
      // Frontend pattern: dapp-kit signPersonalMessage function
      signPersonalMessageFn?: (message: string) => Promise<{ signature: string }>;
      // Backend pattern: Ed25519Keypair for direct signing
      keypair?: any;
    }
  ): Promise<SessionKey> {
    try {
      console.log('🔄 EncryptionService: Creating SEAL session key...');
      console.log(`   User address: ${userAddress}`);
      console.log(`   TTL: 30 minutes (maximum allowed)`);
      
      const sessionResult = await this.sealService.createSession({
        address: userAddress,
        packageId: this.packageId,
        ttlMin: 30, // Use 30 minutes (maximum allowed)
      });

      // Handle signing based on provided signer type
      if (signer?.signPersonalMessageFn) {
        // Frontend pattern: Use dapp-kit signPersonalMessage (RECOMMENDED)
        console.log('🔄 Signing with dapp-kit signPersonalMessage (recommended)...');
        const personalMessage = sessionResult.personalMessage;
        
        // Convert to string if it's a byte array
        const messageString = typeof personalMessage === 'string' 
          ? personalMessage 
          : new TextDecoder().decode(personalMessage);
        
        console.log(`   Message (first 100 chars): ${messageString.substring(0, 100)}...`);
        
        // Use dapp-kit signPersonalMessage - returns signature in correct format
        const result = await signer.signPersonalMessageFn(messageString);
        
        console.log(`   Signature from dapp-kit: ${result.signature.substring(0, 20)}...`);
        console.log(`   ✅ Using dapp-kit signature format (already compatible with SEAL)`);
        
        // Set signature directly - dapp-kit returns it in SEAL-compatible format
        await sessionResult.sessionKey.setPersonalMessageSignature(result.signature);
        console.log('✅ Personal message signed with dapp-kit');
        
      } else if (signer?.keypair) {
        // Backend pattern: Use Ed25519Keypair with format conversion
        console.log('🔄 Signing with Ed25519Keypair (backend fallback)...');
        const personalMessage = sessionResult.personalMessage;
        
        // Convert to string if it's a byte array
        const messageString = typeof personalMessage === 'string' 
          ? personalMessage 
          : new TextDecoder().decode(personalMessage);
        
        console.log(`   Message (first 100 chars): ${messageString.substring(0, 100)}...`);
        
        // Sign with keypair
        const messageSignature = await signer.keypair.signPersonalMessage(new TextEncoder().encode(messageString));
        
        // CRITICAL FIX: Use signature as-is from Ed25519Keypair (SEAL expects original format)
        // According to SEAL documentation, pass signature directly from keypair.signPersonalMessage()
        console.log(`   ✅ Using signature as-is from Ed25519Keypair (SEAL-compatible format)`);
        console.log(`   Original signature: ${messageSignature.signature.substring(0, 20)}...`);
        
        // Set signature exactly as returned by keypair (no conversion needed)
        await sessionResult.sessionKey.setPersonalMessageSignature(messageSignature.signature);
        console.log('✅ Personal message signed with Ed25519Keypair');
        
      } else {
        console.log('⚠️  No signer provided - session key created but not signed');
        console.log('   Note: Call setPersonalMessageSignature() later with wallet-signed message');
        console.log('   Frontend: Use dapp-kit useSignPersonalMessage hook');
        console.log('   Backend: Provide Ed25519Keypair');
      }

      // Cache the session key
      this.sessionKeyCache.set(userAddress, sessionResult.sessionKey);
      
      console.log('✅ EncryptionService: Session key created and cached');
      return sessionResult.sessionKey;
    } catch (error) {
      throw new Error(`Failed to create session key: ${error}`);
    }
  }

  /**
   * Get cached session key or create new one
   */
  async getOrCreateSessionKey(userAddress: string): Promise<SessionKey> {
    const cached = this.sessionKeyCache.get(userAddress);
    if (cached) {
      return cached;
    }

    return this.createSessionKey(userAddress);
  }

  /**
   * Export session key for persistence
   */
  async exportSessionKey(sessionKey: SessionKey): Promise<string> {
    try {
      const exported = sessionKey.export();
      return JSON.stringify(exported);
    } catch (error) {
      throw new Error(`Failed to export session key: ${error}`);
    }
  }

  /**
   * Import previously exported session key
   */
  async importSessionKey(exportedKey: string, userAddress?: string): Promise<SessionKey> {
    try {
      const keyData = JSON.parse(exportedKey);
      const sessionKey = SessionKey.import(keyData, this.suiClient);

      if (userAddress) {
        this.sessionKeyCache.set(userAddress, sessionKey);
      }

      return sessionKey;
    } catch (error) {
      throw new Error(`Failed to import session key: ${error}`);
    }
  }

  // ==================== ACCESS CONTROL TRANSACTIONS ====================

  /**
   * Create SEAL approval transaction bytes (matches memory-workflow-seal.ts pattern)
   * Returns raw PTB format bytes for SEAL verification
   */
  async createSealApproveTransaction(userAddress: string, contentOwner: string): Promise<Uint8Array> {
    try {
      console.log('🔄 EncryptionService: Creating SEAL approval transaction...');
      console.log(`   User address: ${userAddress}`);
      console.log(`   Content owner: ${contentOwner}`);

      // Create the approval transaction (not signed, just bytes)
      const tx = await this.buildAccessTransactionForWallet(userAddress, contentOwner, 'read');
      // CRITICAL: Set sender before building - required by Transaction.build()
      tx.setSender(contentOwner);
      // SEAL REQUIREMENT: Must use onlyTransactionKind: true for PTB validation
      const txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });

      console.log(`✅ Created SEAL approval transaction bytes (${txBytes.length} bytes)`);
      console.log('   Format: Raw PTB (Programmable Transaction Block) for SEAL verification');

      return txBytes;
    } catch (error) {
      throw new Error(`Failed to create SEAL approval transaction: ${error}`);
    }
  }

  /**
   * Build transaction to grant access to another user
   */
  async buildGrantAccessTransaction(options: AccessGrantOptions): Promise<Transaction> {
    const { ownerAddress, recipientAddress, contentId, accessLevel, expiresIn } = options;
    const tx = new Transaction();

    const expiresAt = expiresIn ? Date.now() + expiresIn : Date.now() + 86400000; // 24h default

    tx.moveCall({
      target: `${this.packageId}::capability::grant_access`,
      arguments: [
        tx.pure.address(ownerAddress),
        tx.pure.address(recipientAddress),
        tx.pure.string(contentId),
        tx.pure.string(accessLevel),
        tx.pure.u64(expiresAt),
      ],
    });

    return tx;
  }

  /**
   * Build transaction to revoke access from a user
   */
  async buildRevokeAccessTransaction(options: AccessRevokeOptions): Promise<Transaction> {
    const { ownerAddress, recipientAddress, contentId } = options;
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::revoke_access`,
      arguments: [
        tx.pure.address(ownerAddress),
        tx.pure.address(recipientAddress),
        tx.pure.string(contentId),
      ],
    });

    return tx;
  }

  /**
   * Build transaction to register content ownership
   */
  async buildRegisterContentTransaction(
    ownerAddress: string,
    contentId: string,
    contentHash: string
  ): Promise<Transaction> {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::register_content`,
      arguments: [
        tx.pure.address(ownerAddress),
        tx.pure.string(contentId),
        tx.pure.string(contentHash),
        tx.pure.string(''), // encryption_info
      ],
    });

    return tx;
  }

  // ==================== TRANSACTION BUILDERS ====================

  get tx() {
    return {
      /**
       * Grant access to encrypted memory
       */
      grantAccess: (options: AccessGrantOptions) => {
        return this.buildGrantAccessTransaction(options);
      },

      /**
       * Revoke access to encrypted memory
       */
      revokeAccess: (options: AccessRevokeOptions) => {
        return this.buildRevokeAccessTransaction(options);
      },

      /**
       * Register content ownership
       */
      registerContent: (ownerAddress: string, contentId: string, contentHash: string) => {
        return this.buildRegisterContentTransaction(ownerAddress, contentId, contentHash);
      },

      /**
       * Build access approval transaction
       */
      buildAccessTransaction: (userAddress: string, accessType: 'read' | 'write' = 'read') => {
        return this.buildAccessTransaction(userAddress, accessType);
      },
    };
  }

  // ==================== MOVE CALL BUILDERS ====================

  get call() {
    return {
      /**
       * Move call for granting access
       */
      grantAccess: (options: AccessGrantOptions): Thunk => {
        return async (tx) => {
          const grantTx = await this.buildGrantAccessTransaction(options);
          return grantTx;
        };
      },

      /**
       * Move call for revoking access
       */
      revokeAccess: (options: AccessRevokeOptions): Thunk => {
        return async (tx) => {
          const revokeTx = await this.buildRevokeAccessTransaction(options);
          return revokeTx;
        };
      },
    };
  }

  // ==================== ACCESS CONTROL QUERIES ====================

  /**
   * Check if a user has access to decrypt content
   */
  async hasAccess(
    userAddress: string,
    contentId: string,
    ownerAddress: string
  ): Promise<boolean> {
    try {
      if (userAddress === ownerAddress) {
        return true;
      }

      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::capability::check_access`,
        arguments: [
          tx.pure.address(userAddress),
          tx.pure.string(contentId),
          tx.pure.address(ownerAddress),
        ],
      });

      const result = await this.suiClient.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: userAddress,
      });

      return result.effects.status.status === 'success';
    } catch (error) {
      console.error(`Error checking access: ${error}`);
      return false;
    }
  }

  // ==================== VIEW METHODS ====================

  get view() {
    return {
      /**
       * Get access permissions for memories
       */
      getAccessPermissions: async (userAddress: string, memoryId?: string): Promise<AccessPermission[]> => {
        // Note: This would typically require event queries or indexing
        // For now, return empty array as this requires additional infrastructure
        console.warn('getAccessPermissions: This method requires event indexing infrastructure');
        return [];
      },

      /**
       * Check if user has access to content
       */
      hasAccess: (userAddress: string, contentId: string, ownerAddress: string) => {
        return this.hasAccess(userAddress, contentId, ownerAddress);
      },
    };
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Compute SEAL key_id from owner address and nonce
   *
   * Mirrors the Move implementation in capability.move:
   * key_id = keccak256(owner || nonce)
   *
   * @param ownerAddress - Owner's Sui address
   * @param nonce - Nonce from MemoryCap object (32 bytes keccak hash)
   * @returns key_id bytes for SEAL approval (32 bytes)
   */
  computeKeyId(ownerAddress: string, nonce: Uint8Array): Uint8Array {
    // Convert owner address to bytes (BCS format - 32 bytes)
    const ownerBytes = fromHex(ownerAddress.replace('0x', '').padStart(64, '0'));

    // Concatenate owner || nonce (matches Move: bcs::to_bytes(&owner) + nonce)
    const data = new Uint8Array(ownerBytes.length + nonce.length);
    data.set(ownerBytes, 0);
    data.set(nonce, ownerBytes.length);

    // Use keccak256 hash (matches Move implementation exactly)
    const keyId = keccak_256(data);

    console.log(`🔑 Computed key_id from owner ${ownerAddress.slice(0, 10)}... and nonce (${nonce.length} bytes)`);
    return keyId;
  }

  /**
   * Generate content hash for verification
   */
  private async generateContentHash(data: Uint8Array): Promise<string> {
    // Create a new Uint8Array to ensure proper typing
    const dataArray = new Uint8Array(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataArray);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Verify content integrity
   */
  async verifyContentHash(data: Uint8Array, expectedHash: string): Promise<boolean> {
    const actualHash = await this.generateContentHash(data);
    return actualHash === expectedHash;
  }

  /**
   * Check if SEAL service is available
   */
  isAvailable(): boolean {
    return this.sealService !== null;
  }

  /**
   * Get SEAL service configuration info
   */
  getClientInfo(): {
    isInitialized: boolean;
    packageId: string;
    encryptionEnabled: boolean;
  } {
    return {
      isInitialized: this.sealService !== null,
      packageId: this.packageId,
      encryptionEnabled: this.config.encryptionConfig?.enabled || false,
    };
  }
}