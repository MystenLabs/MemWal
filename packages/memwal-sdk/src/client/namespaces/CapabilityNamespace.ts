/**
 * Capability Namespace - MemoryCap Object Operations
 *
 * Provides API for managing MemoryCap capability objects using
 * the SEAL PrivateData pattern.
 *
 * Key concepts:
 * - MemoryCap: Capability object for app context access
 * - Object ownership = access permission (SEAL idiomatic)
 * - Transfer capability = share access
 * - Burn capability = revoke access
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type { MemoryCap } from '../../core/types/capability';
import { CapabilityService } from '../../services/CapabilityService';

/**
 * Options for creating a capability
 */
export interface CreateCapabilityOptions {
  appId: string;
}

/**
 * Options for listing capabilities
 */
export interface ListCapabilityOptions {
  appId?: string;
}

/**
 * Capability Namespace
 *
 * Handles MemoryCap CRUD operations
 */
export class CapabilityNamespace {
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
   * Create a new MemoryCap for an app context
   *
   * @param appId - Application identifier (e.g., "MEMO", "HEALTH")
   * @returns Created MemoryCap
   *
   * @example
   * ```typescript
   * const cap = await pdw.capability.create('MEMO');
   * console.log(cap.id, cap.appId, cap.nonce);
   * ```
   */
  async create(appId: string): Promise<MemoryCap> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();

    return await service.create({ appId }, signer);
  }

  /**
   * Get an existing capability by app ID
   *
   * @param appId - Application identifier
   * @returns MemoryCap or null if not found
   */
  async get(appId: string): Promise<MemoryCap | null> {
    const service = this.ensureService();
    return await service.get(this.services.config.userAddress, appId);
  }

  /**
   * Get or create a capability for an app context
   *
   * Convenience method that returns existing capability if found,
   * otherwise creates a new one.
   *
   * @param appId - Application identifier
   * @returns Existing or newly created MemoryCap
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
   * List all capabilities owned by the current user
   *
   * @param options - Optional filter by appId
   * @returns Array of MemoryCaps
   *
   * @example
   * ```typescript
   * // List all capabilities
   * const allCaps = await pdw.capability.list();
   *
   * // Filter by app ID
   * const memoCaps = await pdw.capability.list({ appId: 'MEMO' });
   * ```
   */
  async list(options?: ListCapabilityOptions): Promise<MemoryCap[]> {
    const service = this.ensureService();

    return await service.list({
      userAddress: this.services.config.userAddress,
      appId: options?.appId,
    });
  }

  /**
   * Transfer a capability to another address
   *
   * After transfer:
   * - New owner can decrypt memories for this context
   * - Original owner loses access
   *
   * @param capId - Capability object ID to transfer
   * @param recipient - Recipient's Sui address
   *
   * @example
   * ```typescript
   * await pdw.capability.transfer(cap.id, '0x1234...');
   * ```
   */
  async transfer(capId: string, recipient: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();

    await service.transfer({ capId, recipient }, signer);
  }

  /**
   * Burn (revoke) a capability
   *
   * This permanently revokes the capability.
   * After burning:
   * - No one can decrypt memories for this context
   * - Object is permanently deleted
   *
   * @param capId - Capability object ID to burn
   *
   * @example
   * ```typescript
   * await pdw.capability.burn(cap.id);
   * ```
   */
  async burn(capId: string): Promise<void> {
    const service = this.ensureService();
    const signer = this.services.config.signer.getSigner();

    await service.burn({ capId }, signer);
  }

  /**
   * Check if user has capability for an app context
   *
   * @param appId - Application identifier
   * @returns True if capability exists
   */
  async has(appId: string): Promise<boolean> {
    const service = this.ensureService();
    return await service.hasCapability(this.services.config.userAddress, appId);
  }

  /**
   * Get capability by object ID
   *
   * @param capId - Capability object ID
   * @returns MemoryCap or null
   */
  async getById(capId: string): Promise<MemoryCap | null> {
    const service = this.ensureService();
    return await service.getById(capId);
  }

  /**
   * Compute SEAL key ID for a capability
   *
   * Used for SEAL encryption/decryption key derivation.
   * key_id = keccak256(owner || nonce)
   *
   * @param cap - MemoryCap object
   * @returns Key ID as hex string
   */
  computeKeyId(cap: MemoryCap): string {
    const service = this.ensureService();
    return service.computeKeyId(cap);
  }
}
