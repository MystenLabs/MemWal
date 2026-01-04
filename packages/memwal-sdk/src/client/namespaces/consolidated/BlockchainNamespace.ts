/**
 * Blockchain Namespace - Consolidated Sui Blockchain Operations
 *
 * Merges functionality from:
 * - TxNamespace: Transaction building and execution
 * - WalletNamespace: Wallet operations and queries
 *
 * Provides a unified interface for all Sui blockchain interactions.
 *
 * @module client/namespaces/consolidated
 */

import type { ServiceContainer } from '../../SimplePDWClient';
import { Transaction } from '@mysten/sui/transactions';
import type { TransactionResult } from '../../../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Memory transaction options
 */
export interface MemoryTxOptions {
  category: string;
  vectorId: number;
  blobId: string;
  importance: number;
  gasBudget?: number;
}

/**
 * Batch operation types supported by PTB
 */
export type BatchOperationType = 'createMemory' | 'updateMemory' | 'deleteMemory' | 'createCap' | 'transferCap' | 'burnCap';

/**
 * Batch operation definition
 */
export interface BatchOperation {
  type: BatchOperationType;
  options: any;
}

/**
 * Wallet info
 */
export interface WalletInfo {
  address: string;
  connected: boolean;
  network: string;
}

/**
 * Object info
 */
export interface OwnedObject {
  id: string;
  type: string;
  version: string;
  digest: string;
}

// ============================================================================
// Sub-Namespaces
// ============================================================================

/**
 * Transaction sub-namespace
 */
class TxSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Build transaction for creating memory record
   *
   * @param options - Memory creation options
   * @returns Transaction object
   */
  buildCreate(options: MemoryTxOptions): Transaction {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return this.services.tx.buildCreateMemoryRecordLightweight({
      category: options.category,
      vectorId: options.vectorId,
      blobId: options.blobId,
      importance: options.importance,
      gasBudget: options.gasBudget
    });
  }

  /**
   * Build transaction for updating memory metadata
   *
   * @param memoryId - Memory ID to update
   * @param metadataBlobId - New metadata blob ID
   * @returns Transaction object
   */
  buildUpdate(memoryId: string, metadataBlobId: string): Transaction {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return this.services.tx.buildUpdateMemoryMetadata({
      memoryId,
      metadataBlobId,
      embeddingDimension: 3072
    });
  }

  /**
   * Build transaction for deleting memory record
   *
   * @param memoryId - Memory ID to delete
   * @returns Transaction object
   */
  buildDelete(memoryId: string): Transaction {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return this.services.tx.buildDeleteMemoryRecord({ memoryId });
  }

  /**
   * Execute a transaction
   *
   * @param tx - Transaction to execute
   * @returns Transaction result with digest and status
   *
   * @example
   * ```typescript
   * const tx = pdw.blockchain.tx.buildCreate({ ... });
   * const result = await pdw.blockchain.tx.execute(tx);
   * console.log('Tx digest:', result.digest);
   * ```
   */
  async execute(tx: Transaction): Promise<TransactionResult> {
    const signer = this.services.config.signer;

    // Check if signer supports signAndExecuteTransaction (browser wallets like DappKitSigner)
    // Browser wallets cannot expose raw Signer for security reasons
    if ('signAndExecuteTransaction' in signer && typeof signer.signAndExecuteTransaction === 'function') {
      try {
        // Use the signer's signAndExecuteTransaction directly
        const result = await signer.signAndExecuteTransaction(tx);

        // Get full transaction details to extract created objects
        let createdObjects: Array<{ objectId: string; objectType: string }> | undefined;
        let mutatedObjects: Array<{ objectId: string; objectType: string }> | undefined;

        if (result.objectChanges && Array.isArray(result.objectChanges)) {
          createdObjects = result.objectChanges
            .filter((change: any) => change.type === 'created')
            .map((change: any) => ({
              objectId: change.objectId,
              objectType: change.objectType || 'unknown',
            }));

          mutatedObjects = result.objectChanges
            .filter((change: any) => change.type === 'mutated')
            .map((change: any) => ({
              objectId: change.objectId,
              objectType: change.objectType || 'unknown',
            }));
        }

        // Determine status from effects
        // dapp-kit may not return full effects structure unless custom execute is configured
        // We check multiple indicators:
        // 1. If effects.status.status explicitly says 'failure', it failed
        // 2. If effects.status.status says 'success', it succeeded
        // 3. If we have a digest but no effects status, assume success (tx was submitted and confirmed)
        let status: 'success' | 'failure';
        const effectsStatus = result.effects?.status?.status;

        if (effectsStatus === 'failure') {
          status = 'failure';
        } else if (effectsStatus === 'success') {
          status = 'success';
        } else if (result.digest) {
          // Has digest but no explicit status - DappKitSigner waits for confirmation
          // If we reach here without error, the transaction was successful
          status = 'success';
        } else {
          status = 'failure';
        }

        return {
          digest: result.digest,
          status,
          effects: result.effects,
          createdObjects,
          mutatedObjects,
          gasUsed: result.effects?.gasUsed?.computationCost
            ? Number(result.effects.gasUsed.computationCost)
            : undefined,
          error: status === 'failure' ? (result.effects?.status?.error || 'Transaction failed without digest') : undefined,
        };
      } catch (error) {
        console.error('Transaction execution failed:', error);
        return {
          digest: '',
          status: 'failure',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // Fallback: Use TransactionService with raw Signer (Node.js/backend)
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return await this.services.tx.executeTransaction(
      tx,
      signer.getSigner()
    );
  }

  /**
   * Build batch transaction (combine multiple operations into single PTB)
   *
   * @param operations - Array of typed operations to batch
   * @returns Combined transaction with all move calls
   *
   * @example
   * ```typescript
   * const tx = pdw.blockchain.tx.buildBatch([
   *   { type: 'createMemory', options: { ... } },
   *   { type: 'createMemory', options: { ... } },
   * ]);
   * const result = await pdw.blockchain.tx.execute(tx);
   * ```
   */
  buildBatch(operations: BatchOperation[]): Transaction {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return this.services.tx.buildBatchTransaction(operations);
  }

  /**
   * Build and execute batch transaction in one call
   *
   * @param operations - Array of typed operations to batch
   * @param gasBudget - Optional gas budget override
   * @returns Transaction result with digest and status
   */
  async executeBatch(operations: BatchOperation[], gasBudget?: number): Promise<TransactionResult> {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    return await this.services.tx.executeBatch(
      operations,
      this.services.config.signer.getSigner(),
      { gasBudget }
    );
  }

  /**
   * Estimate gas cost for transaction
   *
   * @param tx - Transaction to estimate
   * @returns Estimated gas cost
   */
  async estimateGas(tx: Transaction): Promise<number> {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    try {
      const dryRun = await this.services.config.sui.client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: this.services.config.sui.client })
      });
      const gasUsed = dryRun.effects.gasUsed;
      return Number(gasUsed.computationCost) +
        Number(gasUsed.storageCost) -
        Number(gasUsed.storageRebate);
    } catch (error) {
      throw new Error(`Gas estimation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for transaction confirmation
   *
   * @param digest - Transaction digest
   * @returns Transaction effects
   */
  async waitForConfirmation(digest: string): Promise<TransactionResult> {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }
    try {
      const result = await this.services.config.sui.client.waitForTransaction({
        digest,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true
        }
      });
      return {
        digest: result.digest,
        status: result.effects?.status?.status === 'success' ? 'success' : 'failure',
        effects: result.effects,
        gasUsed: result.effects?.gasUsed?.computationCost
          ? Number(result.effects.gasUsed.computationCost)
          : undefined
      };
    } catch (error) {
      throw new Error(`Wait for confirmation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Wallet sub-namespace
 */
class WalletSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get current wallet address
   *
   * @returns Wallet address
   *
   * @example
   * ```typescript
   * const address = await pdw.blockchain.wallet.getAddress();
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
   *
   * @example
   * ```typescript
   * const balance = await pdw.blockchain.wallet.getFormattedBalance();
   * console.log('Balance:', balance); // "1.2345 SUI"
   * ```
   */
  async getFormattedBalance(): Promise<string> {
    const balanceMist = await this.getBalance();
    const balanceSui = Number(balanceMist) / 1_000_000_000;
    return `${balanceSui.toFixed(4)} SUI`;
  }

  /**
   * Get all owned objects of a specific type
   *
   * @param structType - Move struct type (e.g., "0x123::memory::Memory")
   * @returns Array of owned objects
   */
  async getOwnedObjects(structType: string): Promise<OwnedObject[]> {
    const suiClient = this.services.config.sui?.client;
    if (!suiClient) {
      throw new Error('SuiClient not initialized');
    }
    const response = await suiClient.getOwnedObjects({
      owner: this.services.config.userAddress,
      filter: { StructType: structType },
      options: { showContent: true, showType: true },
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
        options: { showContent: true, showOwner: true, showType: true },
      });
      return response.data || null;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Blockchain Namespace
// ============================================================================

/**
 * Blockchain Namespace - Unified Sui Operations
 *
 * Consolidates transaction building/execution and wallet operations.
 *
 * @example
 * ```typescript
 * // Transaction operations
 * const tx = pdw.blockchain.tx.buildCreate({ ... });
 * const result = await pdw.blockchain.tx.execute(tx);
 *
 * // Wallet operations
 * const address = await pdw.blockchain.wallet.getAddress();
 * const balance = await pdw.blockchain.wallet.getFormattedBalance();
 * ```
 */
export class BlockchainNamespace {
  private _tx: TxSubNamespace;
  private _wallet: WalletSubNamespace;

  constructor(private services: ServiceContainer) {
    this._tx = new TxSubNamespace(services);
    this._wallet = new WalletSubNamespace(services);
  }

  /**
   * Transaction operations
   */
  get tx(): TxSubNamespace {
    return this._tx;
  }

  /**
   * Wallet operations
   */
  get wallet(): WalletSubNamespace {
    return this._wallet;
  }

  // ==========================================================================
  // Convenience Methods (Top-level shortcuts)
  // ==========================================================================

  /**
   * Get current wallet address (shortcut)
   *
   * @returns Wallet address
   */
  async getAddress(): Promise<string> {
    return this._wallet.getAddress();
  }

  /**
   * Get SUI balance (shortcut)
   *
   * @returns Balance in MIST
   */
  async getBalance(): Promise<bigint> {
    return this._wallet.getBalance();
  }

  /**
   * Execute a transaction (shortcut)
   *
   * @param tx - Transaction to execute
   * @returns Transaction result
   */
  async execute(tx: Transaction): Promise<TransactionResult> {
    return this._tx.execute(tx);
  }
}
