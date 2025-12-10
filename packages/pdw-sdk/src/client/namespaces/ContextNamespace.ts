/**
 * Context Namespace - App Context Management & Cross-Context Data Transfer
 *
 * Higher-level abstraction over MemoryCap capabilities.
 * Provides user-friendly API for managing app contexts and
 * exporting/importing data between different dApp contexts.
 *
 * A "context" is simply a MemoryCap for a specific app ID.
 * This namespace makes it easier to work with app-scoped data.
 *
 * Key features:
 * - Create/manage app contexts (MemoryCaps)
 * - Export private data from one context
 * - Import data into another context (re-encrypted)
 * - User must sign to authorize decryption
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type { MemoryCap } from '../../core/types/capability';
import { CapabilityService } from '../../services/CapabilityService';

/**
 * Context info with additional metadata
 */
export interface ContextInfo extends MemoryCap {
  /** Number of memories in this context */
  memoryCount?: number;
  /** Last activity timestamp */
  lastActivity?: number;
}

/**
 * Context Namespace
 *
 * Higher-level API for managing app contexts
 */
export class ContextNamespace {
  private capService: CapabilityService | null = null;

  constructor(private services: ServiceContainer) {
    // Initialize CapabilityService if SuiClient and packageId available
    const suiClient = this.services.config.sui?.client;
    const packageId = this.services.config.sui?.packageId;

    if (suiClient && packageId) {
      this.capService = new CapabilityService({
        suiClient,
        packageId,
      });
    }
  }

  /**
   * Ensure CapabilityService is initialized
   */
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
   * const memoContext = await pdw.context.create('MEMO');
   * const healthContext = await pdw.context.create('HEALTH');
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
   * Convenience method - returns existing context if found,
   * otherwise creates a new one.
   *
   * @param appId - Application identifier
   * @returns Existing or newly created context
   *
   * @example
   * ```typescript
   * // Always get a context, create if needed
   * const ctx = await pdw.context.getOrCreate('MEMO');
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
   *
   * @example
   * ```typescript
   * const contexts = await pdw.context.list();
   * contexts.forEach(ctx => console.log(ctx.appId));
   * ```
   */
  async list(): Promise<MemoryCap[]> {
    const service = this.ensureService();

    return await service.list({
      userAddress: this.services.config.userAddress,
    });
  }

  /**
   * Delete a context (burns the capability)
   *
   * Warning: This permanently revokes access to all memories
   * encrypted with this context's key.
   *
   * @param appId - Application identifier
   *
   * @example
   * ```typescript
   * await pdw.context.delete('OLD_APP');
   * ```
   */
  async delete(appId: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();

    // Get the capability first
    const cap = await service.get(this.services.config.userAddress, appId);
    if (!cap) {
      throw new Error(`Context not found for appId: ${appId}`);
    }

    // Burn the capability
    await service.burn({ capId: cap.id }, signer);
  }

  /**
   * Transfer context to another user
   *
   * After transfer:
   * - New owner can decrypt memories for this context
   * - Original owner loses access
   *
   * @param appId - Application identifier
   * @param recipient - Recipient's Sui address
   */
  async transfer(appId: string, recipient: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();

    // Get the capability first
    const cap = await service.get(this.services.config.userAddress, appId);
    if (!cap) {
      throw new Error(`Context not found for appId: ${appId}`);
    }

    // Transfer the capability
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
   * Get context with extended info (memory count, last activity)
   *
   * Queries actual memory count and last activity from:
   * 1. ViewService (on-chain query) if available
   * 2. MemoryIndexService (local index) as fallback
   *
   * @param appId - Application identifier
   * @returns Context info or null
   */
  async getInfo(appId: string): Promise<ContextInfo | null> {
    const cap = await this.get(appId);
    if (!cap) {
      return null;
    }

    let memoryCount = 0;
    let lastActivity = cap.createdAt;

    try {
      // Try ViewService first (on-chain query)
      if (this.services.viewService) {
        const result = await this.services.viewService.getUserMemories(
          this.services.config.userAddress,
          { category: appId, limit: 1000 }
        );
        memoryCount = result.data.length;

        // Find most recent activity
        if (result.data.length > 0) {
          const timestamps = result.data
            .map(m => m.updatedAt || m.createdAt || 0)
            .filter(t => t > 0);
          if (timestamps.length > 0) {
            lastActivity = Math.max(...timestamps);
          }
        }
      }
      // Fallback to MemoryIndexService (local index)
      else if (this.services.memoryIndex) {
        const memories = await this.services.memoryIndex.getUserMemories(
          this.services.config.userAddress,
          { categories: [appId] }
        );
        memoryCount = memories.length;

        // Find most recent activity
        if (memories.length > 0) {
          const timestamps = memories
            .map(m => m.metadata?.createdTimestamp || m.metadata?.updatedTimestamp || 0)
            .filter(t => t > 0);
          if (timestamps.length > 0) {
            lastActivity = Math.max(...timestamps);
          }
        }
      }
    } catch (error) {
      // Log but don't fail - return basic info
      console.warn(`Failed to query memory stats for context ${appId}:`, error);
    }

    return {
      ...cap,
      memoryCount,
      lastActivity,
    };
  }

  /**
   * Get SEAL key ID for a context
   *
   * Used for encryption/decryption operations.
   *
   * @param appId - Application identifier
   * @returns Key ID as hex string
   */
  async getKeyId(appId: string): Promise<string | null> {
    const service = this.ensureService();
    const cap = await service.get(this.services.config.userAddress, appId);

    if (!cap) {
      return null;
    }

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
