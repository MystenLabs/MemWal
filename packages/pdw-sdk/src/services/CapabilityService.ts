/**
 * CapabilityService - Capability-based access control for Personal Data Wallet
 *
 * This service implements the SEAL PrivateData pattern for simplified access control
 * using Move's capability pattern. It replaces the old HD wallet + allowlist architecture.
 *
 * Key benefits:
 * - 1 user wallet instead of N HD wallets
 * - Object ownership = access permission (SEAL idiomatic)
 * - No global registry needed
 * - 60% gas savings vs allowlist pattern
 * - Type-safe access control
 *
 * @see CAPABILITY-ARCHITECTURE-SUMMARY.md
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { sha3_256 } from '@noble/hashes/sha3';
import { bcs } from '@mysten/sui/bcs';
import type {
  MemoryCap,
  CreateMemoryCapOptions,
  TransferCapOptions,
  BurnCapOptions,
  ListCapsOptions,
  GetOrCreateCapOptions,
  MemoryCapList,
  ComputeKeyIdOptions
} from '../core/types/capability';

/**
 * Configuration for CapabilityService
 */
export interface CapabilityServiceConfig {
  /** Sui client instance */
  suiClient: SuiClient;
  /** Package ID for Move contracts */
  packageId: string;
}

/**
 * CapabilityService handles MemoryCap object operations
 *
 * Implements the SEAL PrivateData pattern for simplified access control.
 */
export class CapabilityService {
  private suiClient: SuiClient;
  private packageId: string;

  constructor(config: CapabilityServiceConfig) {
    this.suiClient = config.suiClient;
    this.packageId = config.packageId;
  }

  /**
   * Create a new MemoryCap for an app context
   *
   * @param options - Creation options
   * @param signer - Transaction signer
   * @returns Created MemoryCap
   */
  async create(
    options: CreateMemoryCapOptions,
    signer: any
  ): Promise<MemoryCap> {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::create_memory_cap`,
      arguments: [
        tx.pure.string(options.appId),
      ],
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to create MemoryCap: ${result.effects?.status?.error}`);
    }

    // Extract created MemoryCap from events
    const createdEvent = result.events?.find(
      (event: any) => event.type.includes('::capability::MemoryCapCreated')
    );

    if (!createdEvent) {
      throw new Error('MemoryCapCreated event not found');
    }

    const eventData = createdEvent.parsedJson as any;

    return {
      id: eventData.cap_id,
      nonce: eventData.nonce,
      appId: eventData.app_id,
      owner: eventData.owner,
      createdAt: eventData.created_at,
    };
  }

  /**
   * Get a MemoryCap by app ID for a user
   *
   * @param userAddress - User's Sui address
   * @param appId - Application identifier
   * @returns MemoryCap or null if not found
   */
  async get(userAddress: string, appId: string): Promise<MemoryCap | null> {
    const caps = await this.list({ userAddress, appId });
    return caps.length > 0 ? caps[0] : null;
  }

  /**
   * Get or create a MemoryCap for an app context
   *
   * @param options - Get or create options
   * @param signer - Transaction signer (required for creation)
   * @returns Existing or newly created MemoryCap
   */
  async getOrCreate(
    options: GetOrCreateCapOptions,
    signer: any
  ): Promise<MemoryCap> {
    const userAddress = options.userAddress || await signer.getPublicKey?.()?.toSuiAddress?.() || '';

    // Try to get existing capability
    const existing = await this.get(userAddress, options.appId);
    if (existing) {
      return existing;
    }

    // Create new capability
    return await this.create({ appId: options.appId }, signer);
  }

  /**
   * List all MemoryCaps owned by a user
   *
   * @param options - List options (filter by appId, userAddress)
   * @returns Array of MemoryCaps
   */
  async list(options?: ListCapsOptions): Promise<MemoryCap[]> {
    const userAddress = options?.userAddress;
    if (!userAddress) {
      throw new Error('userAddress is required for listing capabilities');
    }

    const response = await this.suiClient.getOwnedObjects({
      owner: userAddress,
      filter: {
        StructType: `${this.packageId}::capability::MemoryCap`
      },
      options: {
        showContent: true,
        showType: true,
      },
    });

    const caps: MemoryCap[] = [];

    for (const obj of response.data) {
      if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
        continue;
      }

      const fields = obj.data.content.fields as any;
      const appId = fields.app_id;

      // Filter by appId if specified
      if (options?.appId && appId !== options.appId) {
        continue;
      }

      // Convert nonce from bytes to hex string
      const nonceBytes: number[] = Array.isArray(fields.nonce)
        ? fields.nonce
        : [];
      const nonceHex = nonceBytes
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');

      caps.push({
        id: obj.data.objectId,
        nonce: nonceHex,
        appId,
        owner: userAddress,
      });
    }

    return caps;
  }

  /**
   * Transfer a MemoryCap to another address
   *
   * After transfer:
   * - New owner can call seal_approve
   * - New owner can decrypt memories
   * - Original owner loses access
   *
   * @param options - Transfer options
   * @param signer - Transaction signer
   */
  async transfer(options: TransferCapOptions, signer: any): Promise<void> {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::transfer_cap`,
      arguments: [
        tx.object(options.capId),
        tx.pure.address(options.recipient),
      ],
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to transfer MemoryCap: ${result.effects?.status?.error}`);
    }
  }

  /**
   * Burn (revoke) a MemoryCap
   *
   * This permanently revokes the capability.
   * After burning:
   * - No one can decrypt memories for this context
   * - Object is permanently deleted
   *
   * @param options - Burn options
   * @param signer - Transaction signer
   */
  async burn(options: BurnCapOptions, signer: any): Promise<void> {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::burn_cap`,
      arguments: [
        tx.object(options.capId),
      ],
    });

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to burn MemoryCap: ${result.effects?.status?.error}`);
    }
  }

  /**
   * Compute SEAL key ID for a capability
   *
   * key_id = keccak256(owner || nonce)
   *
   * @param cap - MemoryCap object
   * @returns Key ID as hex string
   */
  computeKeyId(cap: MemoryCap): string {
    return this.computeKeyIdFromParts({
      owner: cap.owner,
      nonce: cap.nonce,
    });
  }

  /**
   * Compute SEAL key ID from owner and nonce
   *
   * @param options - Owner address and nonce
   * @returns Key ID as hex string
   */
  computeKeyIdFromParts(options: ComputeKeyIdOptions): string {
    // Convert owner address to bytes (32 bytes for Sui address)
    const ownerBytes = this.addressToBytes(options.owner);

    // Convert nonce from hex string to bytes
    const nonceBytes = this.hexToBytes(options.nonce);

    // Concatenate: owner || nonce
    const data = new Uint8Array(ownerBytes.length + nonceBytes.length);
    data.set(ownerBytes, 0);
    data.set(nonceBytes, ownerBytes.length);

    // Hash with keccak256
    const hash = sha3_256(data);

    // Return as hex string
    return '0x' + Array.from(hash)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Get MemoryCap object by ID
   *
   * @param capId - Capability object ID
   * @returns MemoryCap or null
   */
  async getById(capId: string): Promise<MemoryCap | null> {
    try {
      const response = await this.suiClient.getObject({
        id: capId,
        options: {
          showContent: true,
          showOwner: true,
        },
      });

      if (!response.data?.content || response.data.content.dataType !== 'moveObject') {
        return null;
      }

      const fields = response.data.content.fields as any;

      // Get owner from object ownership
      let owner = '';
      if (response.data.owner && typeof response.data.owner === 'object') {
        if ('AddressOwner' in response.data.owner) {
          owner = response.data.owner.AddressOwner;
        }
      }

      // Convert nonce
      const nonceBytes: number[] = Array.isArray(fields.nonce)
        ? fields.nonce
        : [];
      const nonceHex = nonceBytes
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');

      return {
        id: capId,
        nonce: nonceHex,
        appId: fields.app_id,
        owner,
      };
    } catch (error) {
      console.error('Error fetching MemoryCap by ID:', error);
      return null;
    }
  }

  /**
   * Check if user has capability for an app context
   *
   * @param userAddress - User's Sui address
   * @param appId - Application identifier
   * @returns True if capability exists
   */
  async hasCapability(userAddress: string, appId: string): Promise<boolean> {
    const cap = await this.get(userAddress, appId);
    return cap !== null;
  }

  /**
   * Build transaction for creating MemoryCap (for PTB composition)
   *
   * @param tx - Transaction to add call to
   * @param appId - Application identifier
   */
  buildCreateCall(tx: Transaction, appId: string): void {
    tx.moveCall({
      target: `${this.packageId}::capability::create_memory_cap`,
      arguments: [
        tx.pure.string(appId),
      ],
    });
  }

  /**
   * Build seal_approve transaction argument
   *
   * @param tx - Transaction to add call to
   * @param capId - Capability object ID
   * @param keyId - SEAL key ID (as hex string)
   */
  buildSealApproveCall(tx: Transaction, capId: string, keyId: string): void {
    const keyIdBytes = this.hexToBytes(keyId);

    tx.moveCall({
      target: `${this.packageId}::capability::seal_approve`,
      arguments: [
        tx.object(capId),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(keyIdBytes))),
      ],
    });
  }

  // ========== Private Helper Methods ==========

  private addressToBytes(address: string): Uint8Array {
    // Remove 0x prefix if present
    const cleanAddr = address.startsWith('0x') ? address.slice(2) : address;

    // Sui addresses are 32 bytes (64 hex chars)
    const padded = cleanAddr.padStart(64, '0');

    return this.hexToBytes(padded);
  }

  private hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleanHex.length / 2);

    for (let i = 0; i < cleanHex.length; i += 2) {
      bytes[i / 2] = parseInt(cleanHex.slice(i, i + 2), 16);
    }

    return bytes;
  }
}
