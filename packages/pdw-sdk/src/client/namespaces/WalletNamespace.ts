/**
 * Wallet Namespace - Simplified Wallet Operations
 *
 * Provides basic wallet operations without HD wallet complexity.
 * In the new capability-based architecture, wallet operations are minimal:
 * - Get current wallet address
 * - Check connection status
 * - Query owned objects
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Wallet info
 */
export interface WalletInfo {
  /** Wallet address */
  address: string;
  /** Whether wallet is connected */
  connected: boolean;
  /** Network the wallet is on */
  network: string;
}

/**
 * Object info
 */
export interface OwnedObject {
  /** Object ID */
  id: string;
  /** Object type */
  type: string;
  /** Object version */
  version: string;
  /** Object digest */
  digest: string;
}

/**
 * Wallet Namespace
 *
 * Simplified wallet operations
 */
export class WalletNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get current wallet address
   *
   * @returns Wallet address
   *
   * @example
   * ```typescript
   * const address = await pdw.wallet.getAddress();
   * console.log('Connected as:', address);
   * ```
   */
  async getAddress(): Promise<string> {
    return this.services.config.userAddress;
  }

  /**
   * Check if wallet is connected/ready
   *
   * @returns Connection status
   */
  async isConnected(): Promise<boolean> {
    try {
      const address = await this.getAddress();
      return !!address && address.startsWith('0x');
    } catch {
      return false;
    }
  }

  /**
   * Get wallet info
   *
   * @returns Wallet information
   */
  async getInfo(): Promise<WalletInfo> {
    return {
      address: this.services.config.userAddress,
      connected: await this.isConnected(),
      network: this.services.config.sui?.network || 'testnet',
    };
  }

  /**
   * Get all owned objects of a specific type
   *
   * @param structType - Move struct type (e.g., "0x123::memory::Memory")
   * @returns Array of owned objects
   *
   * @example
   * ```typescript
   * const memories = await pdw.wallet.getOwnedObjects(
   *   `${packageId}::memory::Memory`
   * );
   * ```
   */
  async getOwnedObjects(structType: string): Promise<OwnedObject[]> {
    const suiClient = this.services.config.sui?.client;
    if (!suiClient) {
      throw new Error('SuiClient not initialized');
    }

    const response = await suiClient.getOwnedObjects({
      owner: this.services.config.userAddress,
      filter: {
        StructType: structType,
      },
      options: {
        showContent: true,
        showType: true,
      },
    });

    return response.data.map(obj => ({
      id: obj.data?.objectId || '',
      type: obj.data?.type || '',
      version: obj.data?.version || '',
      digest: obj.data?.digest || '',
    }));
  }

  /**
   * Get all MemoryCap objects owned by user
   *
   * Convenience method for getting capability objects
   *
   * @returns Array of MemoryCap object IDs
   */
  async getMemoryCaps(): Promise<OwnedObject[]> {
    const packageId = this.services.config.sui?.packageId;
    if (!packageId) {
      throw new Error('Package ID not configured');
    }

    return await this.getOwnedObjects(`${packageId}::capability::MemoryCap`);
  }

  /**
   * Get all Memory objects owned by user
   *
   * @returns Array of Memory object IDs
   */
  async getMemories(): Promise<OwnedObject[]> {
    const packageId = this.services.config.sui?.packageId;
    if (!packageId) {
      throw new Error('Package ID not configured');
    }

    return await this.getOwnedObjects(`${packageId}::memory::Memory`);
  }

  /**
   * Get SUI balance
   *
   * @returns Balance in MIST (smallest unit)
   */
  async getBalance(): Promise<bigint> {
    const suiClient = this.services.config.sui?.client;
    if (!suiClient) {
      throw new Error('SuiClient not initialized');
    }

    const balance = await suiClient.getBalance({
      owner: this.services.config.userAddress,
      coinType: '0x2::sui::SUI',
    });

    return BigInt(balance.totalBalance);
  }

  /**
   * Get formatted SUI balance
   *
   * @returns Balance in SUI (human readable)
   */
  async getFormattedBalance(): Promise<string> {
    const balanceMist = await this.getBalance();
    const balanceSui = Number(balanceMist) / 1_000_000_000; // 1 SUI = 10^9 MIST
    return `${balanceSui.toFixed(4)} SUI`;
  }

  /**
   * Sign a message with the connected wallet
   *
   * @param message - Message to sign (string or bytes)
   * @returns Signature as hex string
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    const signer = this.services.config.signer;

    const messageBytes = typeof message === 'string'
      ? new TextEncoder().encode(message)
      : message;

    const result = await signer.signPersonalMessage(messageBytes);

    // Result may have different shapes depending on signer type
    if (typeof result === 'string') {
      return result;
    }
    if (result && typeof result === 'object' && 'signature' in result) {
      return result.signature as string;
    }

    throw new Error('Unexpected signature format');
  }

  /**
   * Get object by ID
   *
   * @param objectId - Object ID to fetch
   * @returns Object data or null
   */
  async getObject(objectId: string): Promise<any | null> {
    const suiClient = this.services.config.sui?.client;
    if (!suiClient) {
      throw new Error('SuiClient not initialized');
    }

    try {
      const response = await suiClient.getObject({
        id: objectId,
        options: {
          showContent: true,
          showOwner: true,
          showType: true,
        },
      });

      return response.data || null;
    } catch (error) {
      console.error('Error fetching object:', error);
      return null;
    }
  }
}
