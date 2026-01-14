/**
 * Tx Namespace - Transaction Utilities
 *
 * Pure delegation to TransactionService for PTB building and execution.
 * Provides convenient methods for common blockchain operations.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import { Transaction } from '@mysten/sui/transactions';
import type { TransactionResult } from '../../types';

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
 * Tx Namespace
 *
 * Handles transaction building and execution utilities
 */
export class TxNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Build transaction for creating memory record
   *
   * Delegates to: TransactionService.buildCreateMemoryRecordLightweight()
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
   * Delegates to: TransactionService.buildUpdateMemoryMetadata()
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
      embeddingDimension: 3072 // Default for Gemini
    });
  }

  /**
   * Build transaction for deleting memory record
   *
   * Delegates to: TransactionService.buildDeleteMemoryRecord()
   *
   * @param memoryId - Memory ID to delete
   * @returns Transaction object
   */
  buildDelete(memoryId: string): Transaction {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }

    return this.services.tx.buildDeleteMemoryRecord({
      memoryId
    });
  }

  /**
   * Execute a transaction
   *
   * Delegates to: TransactionService.executeTransaction()
   *
   * @param tx - Transaction to execute
   * @returns Transaction result with digest and status
   */
  async execute(tx: Transaction): Promise<TransactionResult> {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }

    return await this.services.tx.executeTransaction(
      tx,
      this.services.config.signer.getSigner()
    );
  }

  /**
   * Build and execute in one call
   *
   * Convenience method combining build + execute
   *
   * @param options - Memory creation options
   * @returns Transaction result
   */
  async createMemory(options: MemoryTxOptions): Promise<TransactionResult> {
    const tx = this.buildCreate(options);
    return await this.execute(tx);
  }

  /**
   * Build batch transaction (combine multiple operations into single PTB)
   *
   * Delegates to TransactionService.buildBatchTransaction() for proper PTB composition.
   * All operations are executed atomically in a single transaction.
   *
   * @param operations - Array of typed operations to batch
   * @returns Combined transaction with all move calls
   *
   * @example
   * ```typescript
   * const tx = pdw.tx.buildBatch([
   *   { type: 'createMemory', options: { category: 'note', vectorId: 1, blobId: 'abc', importance: 5 } },
   *   { type: 'createMemory', options: { category: 'task', vectorId: 2, blobId: 'def', importance: 7 } },
   * ]);
   * const result = await pdw.tx.execute(tx);
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
   * Convenience method combining buildBatch + execute
   *
   * @param operations - Array of typed operations to batch
   * @param gasBudget - Optional gas budget override
   * @returns Transaction result with digest and status
   *
   * @example
   * ```typescript
   * const result = await pdw.tx.executeBatch([
   *   { type: 'createMemory', options: { ... } },
   *   { type: 'deleteMemory', options: { memoryId: '0x123' } },
   * ]);
   * ```
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
   * Dry-runs transaction to estimate gas
   *
   * @param tx - Transaction to estimate
   * @returns Estimated gas cost
   */
  async estimateGas(tx: Transaction): Promise<number> {
    if (!this.services.tx) {
      throw new Error('Transaction service not configured.');
    }

    try {
      // Use Sui client to dry-run
      const dryRun = await this.services.config.sui.client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: this.services.config.sui.client })
      });

      const gasUsed = dryRun.effects.gasUsed;
      const totalGas =
        Number(gasUsed.computationCost) +
        Number(gasUsed.storageCost) -
        Number(gasUsed.storageRebate);

      return totalGas;
    } catch (error) {
      throw new Error(`Gas estimation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Wait for transaction confirmation
   *
   * Waits for transaction to be confirmed on-chain
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
