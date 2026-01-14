/**
 * @deprecated This service is deprecated and will be removed in the next major version.
 * Use {@link ContextNamespace} from `../client/namespaces/ContextNamespace` instead.
 *
 * The new capability-based architecture replaces context wallets with
 * MemoryCap objects that follow the SEAL PrivateData pattern.
 *
 * Migration guide:
 * - ContextWalletService.create() -> SimplePDWClient.context.getOrCreate(appId)
 * - ContextWalletService.getContextForApp() -> SimplePDWClient.context.get(appId)
 * - ContextWalletService.listUserContexts() -> SimplePDWClient.context.list()
 * - ContextWalletService.ensureContext() -> SimplePDWClient.context.getOrCreate(appId)
 *
 * Key differences:
 * - No more dynamic fields on MainWallet
 * - Each MemoryCap is a standalone object with `key + store` abilities
 * - Access sharing via capability transfer instead of allowlists
 * - SEAL key derivation uses keccak256(owner || nonce)
 *
 * @see ContextNamespace for the new implementation
 * @see CapabilityService for low-level MemoryCap operations
 *
 * --------------------------------
 * OLD DOCUMENTATION (for reference):
 * --------------------------------
 * ContextWalletService - App-scoped data container management
 *
 * Manages app-specific data contexts for users, including:
 * - Context wallet creation and metadata management
 * - App isolation and data segregation
 * - CRUD operations within contexts
 * - Integration with MainWalletService for identity
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  ContextWallet,
  CreateContextWalletOptions,
  MainWallet
} from '../core/types/wallet';
import { MainWalletService } from './MainWalletService.js';
import { StorageService } from '../services/StorageService.js';
import { EncryptionService } from '../services/EncryptionService.js';

/**
 * Configuration for ContextWalletService
 */
export interface ContextWalletServiceConfig {
  /** Sui client instance */
  suiClient: SuiClient;
  /** Package ID for Move contracts */
  packageId: string;
  /** MainWalletService instance for identity management */
  mainWalletService: MainWalletService;
  /** StorageService for Walrus blob retrieval */
  storageService?: StorageService;
  /** EncryptionService for SEAL decryption */
  encryptionService?: EncryptionService;
}

/**
 * ContextWalletService handles app-scoped data containers
 * @deprecated Use {@link ContextNamespace} from SimplePDWClient instead
 */
export class ContextWalletService {
  private suiClient: SuiClient;
  private packageId: string;
  private mainWalletService: MainWalletService;
  private storageService?: StorageService;
  private encryptionService?: EncryptionService;

  constructor(config: ContextWalletServiceConfig) {
    this.suiClient = config.suiClient;
    this.packageId = config.packageId;
    this.mainWalletService = config.mainWalletService;
    this.storageService = config.storageService;
    this.encryptionService = config.encryptionService;
  }

  /**
   * Create a new context wallet for an app (stored as dynamic field on MainWallet)
   * @param userAddress - User's Sui address
   * @param options - Context creation options
   * @param signer - Transaction signer
   * @returns Created ContextWallet metadata
   */
  async create(
    userAddress: string, 
    options: CreateContextWalletOptions,
    signer: any
  ): Promise<ContextWallet> {
    // Ensure main wallet exists
    const mainWallet = await this.mainWalletService.getMainWallet(userAddress);
    if (!mainWallet) {
      throw new Error('Main wallet not found - create one first');
    }

    // Derive context ID
    const contextId = await this.mainWalletService.deriveContextId({
      userAddress,
      appId: options.appId
    });

    // Build transaction to create context wallet as dynamic field
    const tx = new Transaction();
    
    tx.moveCall({
      target: `${this.packageId}::wallet::create_context_wallet`,
      arguments: [
        tx.object(mainWallet.walletId), // mutable main wallet
        tx.pure.string(options.appId),
      ],
    });

    // Execute transaction
    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    // Wait for transaction to be finalized to prevent gas coin version conflicts
    if (result.digest) {
      await this.suiClient.waitForTransaction({ digest: result.digest });
    }

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to create context wallet: ${result.effects?.status?.error}`);
    }

    // Extract created object ID from events
    const createdEvent = result.events?.find(
      (event: any) => event.type.includes('::wallet::ContextWalletCreated')
    );

    const eventData = createdEvent?.parsedJson as any;
    const objectId = eventData?.wallet_id || '';

    const contextWallet: ContextWallet = {
      id: objectId,
      appId: options.appId,
      contextId,
      owner: userAddress,
      mainWalletId: mainWallet.walletId,
      policyRef: options.policyRef,
      createdAt: Date.now(),
      permissions: ['read:own', 'write:own'], // Default permissions
    };

    return contextWallet;
  }

  /**
   * Get context wallet by app ID (fetches from dynamic field)
   * @param userAddress - User's Sui address
   * @param appId - Application identifier
   * @returns ContextWallet metadata or null if not found
   */
  async getContextForApp(
    userAddress: string,
    appId: string
  ): Promise<ContextWallet | null> {
    try {
      // Get main wallet
      const mainWallet = await this.mainWalletService.getMainWallet(userAddress);
      if (!mainWallet) {
        return null;
      }

      // Fetch context wallet as dynamic field
      const response = await this.suiClient.getDynamicFieldObject({
        parentId: mainWallet.walletId,
        name: {
          type: '0x1::string::String',
          value: appId
        }
      });

      if (!response.data || !response.data.content) {
        return null;
      }

      const content = response.data.content as any;
      if (content.dataType !== 'moveObject') {
        return null;
      }

      const fields = content.fields.value?.fields || content.fields;

      // Derive context ID for consistency
      const contextId = await this.mainWalletService.deriveContextId({
        userAddress,
        appId
      });

      return {
        id: response.data.objectId,
        appId: fields.app_id || appId,
        contextId: contextId,
        owner: userAddress,
        mainWalletId: mainWallet.walletId,
        policyRef: fields.policy_ref || undefined,
        createdAt: parseInt(fields.created_at || '0'),
        permissions: fields.permissions || ['read:own', 'write:own'],
      };
    } catch (error) {
      console.error('Error fetching context wallet:', error);
      return null;
    }
  }

  /**
   * Get context wallet by ID (deprecated - use getContextForApp)
   * @param contextId - Context wallet ID
   * @returns ContextWallet metadata or null if not found
   */
  async getContext(contextId: string): Promise<ContextWallet | null> {
    try {
      const response = await this.suiClient.getObject({
        id: contextId,
        options: {
          showContent: true,
          showOwner: true,
          showType: true,
        },
      });

      const objectData = response.data;
      if (!objectData || !objectData.content || objectData.content.dataType !== 'moveObject') {
        return null;
      }

      const fields = objectData.content.fields as any;

      const contextIdBytes: number[] = Array.isArray(fields.context_id)
        ? fields.context_id
        : Array.isArray(fields.context_id?.fields?.contents)
        ? fields.context_id.fields.contents
        : [];

      const derivedContextId = `0x${contextIdBytes
        .map((byte: number) => Number(byte).toString(16).padStart(2, '0'))
        .join('')}`;

      const ownerAddress = fields.owner ? normalizeSuiAddress(String(fields.owner)) : undefined;
      const mainWalletId = fields.main_wallet_id
        ? normalizeSuiAddress(String(fields.main_wallet_id))
        : undefined;

      return {
        id: objectData.objectId,
        appId: fields.app_id || '',
        contextId: derivedContextId,
        owner: ownerAddress || (mainWalletId ?? ''),
        mainWalletId: mainWalletId || '',
        policyRef: this.extractOptionalString(fields.policy_ref),
        createdAt: Number(fields.created_at || Date.now()),
        permissions: Array.isArray(fields.permissions)
          ? fields.permissions.map((permission: any) => String(permission))
          : ['read:own', 'write:own'],
      };
    } catch (error) {
      console.error('Error fetching context wallet:', error);
      return null;
    }
  }

  /**
   * List all context wallets for a user (from dynamic fields on MainWallet)
   * @param userAddress - User's Sui address
   * @returns Array of ContextWallet metadata
   */
  async listUserContexts(userAddress: string): Promise<ContextWallet[]> {
    try {
      // Get main wallet first
      const mainWallet = await this.mainWalletService.getMainWallet(userAddress);
      if (!mainWallet) {
        return [];
      }

      // Query dynamic fields on main wallet
      const response = await this.suiClient.getDynamicFields({
        parentId: mainWallet.walletId,
      });

      const contexts: ContextWallet[] = [];
      
      for (const field of response.data) {
        if (field.name.type !== '0x1::string::String') {
          continue;
        }

        const appId = field.name.value as string;
        const contextWallet = await this.getContextForApp(userAddress, appId);
        
        if (contextWallet) {
          contexts.push(contextWallet);
        }
      }

      return contexts;
    } catch (error) {
      console.error('Error listing user contexts:', error);
      return [];
    }
  }

  /**
   * Add data item to a context
   * @param contextId - Context wallet ID
   * @param data - Data to store
   * @returns Data item ID
   */
  async addData(contextId: string, data: {
    content: string;
    category?: string;
    metadata?: Record<string, any>;
  }): Promise<string> {
    // Validate context exists and user has access
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    // TODO: Implement actual data storage to Walrus with context tagging
    // For now, return simulated item ID
    const itemId = `item_${contextId}_${Date.now()}`;
    
    return itemId;
  }

  /**
   * Remove data item from a context
   * @param contextId - Context wallet ID
   * @param itemId - Data item ID to remove
   * @returns Success status
   */
  async removeData(contextId: string, itemId: string): Promise<boolean> {
    // Validate context exists and user has access
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    // TODO: Implement actual data removal from Walrus
    // For now, return success
    return true;
  }

  /**
   * List data items in a context
   * @param contextId - Context wallet ID
   * @param filters - Optional filters
   * @returns Array of data items
   */
  async listData(contextId: string, filters?: {
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<{
    id: string;
    content: string;
    category?: string;
    metadata?: Record<string, any>;
    createdAt: number;
  }>> {
    // Validate context exists and user has access
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    if (!this.storageService) {
      console.warn('StorageService not configured, returning empty data');
      return [];
    }

    try {
      // Query Sui blockchain for memory objects with this context
      const response = await this.suiClient.getOwnedObjects({
        owner: context.owner,
        filter: {
          StructType: `${this.packageId}::memory::MemoryRecord`
        },
        options: {
          showContent: true,
          showType: true
        }
      });

      const dataItems: Array<{
        id: string;
        content: string;
        category?: string;
        metadata?: Record<string, any>;
        createdAt: number;
      }> = [];

      for (const item of response.data) {
        if (!item.data?.content || item.data.content.dataType !== 'moveObject') {
          continue;
        }

        const fields = item.data.content.fields as any;
        const blobId = fields.blob_id;
        
        if (!blobId || blobId === 'temp_blob_id') {
          continue;
        }

        try {
          // Retrieve blob from Walrus
          const blobContent = await this.storageService.getBlob(blobId);
          
          // Check if blob is SEAL-encrypted
          let decryptedContent: string;
          
          // Try to parse as JSON to check for encrypted format
          try {
            const textDecoder = new TextDecoder();
            const blobText = textDecoder.decode(blobContent);
            const parsed = JSON.parse(blobText);
            
            // Check if this is a SEAL encrypted object
            if (parsed.encrypted === true || parsed.encryptionType === 'seal') {
              if (!this.encryptionService) {
                console.warn(`Blob ${blobId} is encrypted but EncryptionService not configured`);
                continue;
              }

              // Decrypt with SEAL using context's app ID
              // Note: In real implementation, userAddress and sessionKey should be provided
              const decrypted = await this.encryptionService.decrypt({
                encryptedData: parsed,
                userAddress: context.owner,  // Use context owner's address
                requestingWallet: context.id,  // Use context wallet address for permission validation
                // sessionKey would need to be provided by caller in real implementation
              });
              
              decryptedContent = typeof decrypted === 'string' ? decrypted : JSON.stringify(decrypted);
            } else {
              // Not encrypted, use as-is
              decryptedContent = blobText;
            }
          } catch (parseError) {
            // Not JSON or not encrypted, treat as plain text
            const textDecoder = new TextDecoder();
            decryptedContent = textDecoder.decode(blobContent);
          }

          // Parse final content
          let parsedContent: any;
          try {
            parsedContent = JSON.parse(decryptedContent);
          } catch {
            parsedContent = { content: decryptedContent };
          }

          // Filter by category if specified
          if (filters?.category && parsedContent.category !== filters.category) {
            continue;
          }

          dataItems.push({
            id: item.data.objectId,
            content: parsedContent.content || decryptedContent,
            category: parsedContent.category || fields.category,
            metadata: parsedContent.metadata || {},
            createdAt: parseInt(fields.created_at || '0')
          });

        } catch (error) {
          console.error(`Failed to retrieve/decrypt blob ${blobId}:`, error);
          // Continue with other items
        }
      }

      // Apply pagination
      const offset = filters?.offset || 0;
      const limit = filters?.limit;
      
      let paginatedItems = dataItems.slice(offset);
      if (limit) {
        paginatedItems = paginatedItems.slice(0, limit);
      }

      return paginatedItems;

    } catch (error) {
      console.error('Error listing context data:', error);
      throw new Error(`Failed to list data for context ${contextId}: ${error}`);
    }
  }

  /**
   * Ensure context wallet exists for an app, create if not found
   * @param userAddress - User's Sui address
   * @param appId - Application ID
   * @param signer - Transaction signer for creation
   * @returns Existing or newly created ContextWallet
   */
  async ensureContext(
    userAddress: string,
    appId: string,
    signer: any
  ): Promise<ContextWallet> {
    const existing = await this.getContextForApp(userAddress, appId);
    if (existing) {
      return existing;
    }

    // Create new context wallet
    return await this.create(userAddress, { appId }, signer);
  }

  /**
   * Delete a context wallet and all its data
   * @param contextId - Context wallet ID
   * @returns Success status
   */
  async deleteContext(contextId: string): Promise<boolean> {
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    // TODO: Implement actual context deletion
    // This should:
    // 1. Delete all data items from Walrus
    // 2. Remove context wallet from blockchain
    // 3. Clean up any access grants
    
    return true;
  }

  /**
   * Update context wallet metadata
   * @param contextId - Context wallet ID
   * @param updates - Updates to apply
   * @returns Updated ContextWallet
   */
  async updateContext(contextId: string, updates: {
    policyRef?: string;
    metadata?: Record<string, any>;
  }): Promise<ContextWallet> {
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    // TODO: Implement actual context update on blockchain
    // For now, return updated context
    return {
      ...context,
      policyRef: updates.policyRef || context.policyRef
    };
  }

  /**
   * Validate that a user has access to a context
   * @param contextId - Context wallet ID
   * @param userAddress - User's Sui address
   * @returns True if user has access
   */
  async validateAccess(contextId: string, userAddress: string): Promise<boolean> {
    const normalizedUser = normalizeSuiAddress(userAddress);
    const targetId = contextId.toLowerCase();

    // First, try direct lookup by object ID
    const context = await this.getContext(contextId);
    if (context && normalizeSuiAddress(context.owner) === normalizedUser) {
      return true;
    }

    // Fallback: iterate through user contexts and match by id or derived context id
    const userContexts = await this.listUserContexts(normalizedUser);
    const match = userContexts.find(ctx => this.matchesContextIdentifier(ctx, targetId));

    if (!match) {
      return false;
    }

    return normalizeSuiAddress(match.owner) === normalizedUser;
  }

  /**
   * Get statistics for a context wallet
   * @param contextId - Context wallet ID
   * @returns Context usage statistics
   */
  async getContextStats(contextId: string): Promise<{
    itemCount: number;
    totalSize: number;
    categories: Record<string, number>;
    lastActivity: number;
  }> {
    const context = await this.getContext(contextId);
    if (!context) {
      throw new Error(`Context not found: ${contextId}`);
    }

    // TODO: Implement actual statistics from Walrus data
    return {
      itemCount: 0,
      totalSize: 0,
      categories: {},
      lastActivity: context.createdAt
    };
  }

  private extractOptionalString(value: any): string | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (value.fields) {
      if (Array.isArray(value.fields.vec) && value.fields.vec.length > 0) {
        const first = value.fields.vec[0];
        if (typeof first === 'string') {
          return first;
        }
        if (first?.fields?.bytes) {
          return first.fields.bytes;
        }
      }

      if (value.fields.some) {
        return value.fields.some;
      }
    }

    if (value.some) {
      return value.some;
    }

    return undefined;
  }

  private matchesContextIdentifier(context: ContextWallet, identifier: string): boolean {
    const normalizedIdentifier = identifier.toLowerCase();
    return (
      context.id.toLowerCase() === normalizedIdentifier ||
      context.contextId.toLowerCase() === normalizedIdentifier
    );
  }
}