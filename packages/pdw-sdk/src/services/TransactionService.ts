import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import {
  PDWConfig,
  TransactionOptions,
  TransactionResult,
  CreateMemoryRecordTxOptions,
  CreateMemoryRecordLightweightTxOptions,
  UpdateMemoryMetadataTxOptions,
  UpdateMemoryRecordTxOptions,
  DeleteMemoryRecordTxOptions,
  CreateMemoryIndexTxOptions,
  UpdateMemoryIndexTxOptions,
  GrantAccessTxOptions,
  RevokeAccessTxOptions,
  RegisterContentTxOptions,
} from '../types';

// Import generated Move contract functions
import * as MemoryModule from '../generated/pdw/memory';
import * as CapabilityModule from '../generated/pdw/capability';

/**
 * TransactionService provides high-level transaction building and execution
 * for Personal Data Wallet Move contracts with proper error handling and gas management.
 */
export class TransactionService {
  constructor(
    private client: SuiClient,
    private config: PDWConfig
  ) {}

  // ==================== MEMORY TRANSACTIONS ====================

  /**
   * Build transaction to create a new memory record
   */
  buildCreateMemoryRecord(options: CreateMemoryRecordTxOptions): Transaction {
    const tx = new Transaction();
    
    // Set gas budget if provided
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }
    
    // Set gas price if provided
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Call the memory contract function
    const moveCall = MemoryModule.createMemoryRecord({
      package: this.config.packageId!,
      arguments: [
        Array.from(new TextEncoder().encode(options.category)),
        options.vectorId,
        Array.from(new TextEncoder().encode(options.blobId)),
        Array.from(new TextEncoder().encode(options.contentType)),
        options.contentSize,
        Array.from(new TextEncoder().encode(options.contentHash)),
        Array.from(new TextEncoder().encode(options.topic)),
        options.importance,
        Array.from(new TextEncoder().encode(options.embeddingBlobId)),
      ],
    });
    moveCall(tx);

    return tx;
  }

  /**
   * Build transaction to create a lightweight memory record
   *
   * This creates a minimal on-chain Memory struct with only essential queryable fields.
   * Rich metadata should be stored as Walrus blob metadata for gas efficiency.
   *
   * Use this when:
   * - Gas costs are a concern (saves ~50% gas vs full metadata)
   * - Rich metadata is stored on Walrus blob
   * - Only need basic filtering (category, vector_id, importance)
   *
   * @param options - Lightweight memory creation options
   * @returns Transaction to create lightweight memory record
   */
  buildCreateMemoryRecordLightweight(options: CreateMemoryRecordLightweightTxOptions): Transaction {
    const tx = new Transaction();

    // Set gas budget if provided
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    // Set gas price if provided
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Call the lightweight memory creation function
    // Note: Walrus blob_id is a base64 string (URL-safe, no padding)
    // Example: "E7_nNXvFU_3qZVu3OH1yycRG7LZlyn1-UxEDCDDqGGU"
    // We encode the string to vector<u8> for the Move function parameter
    tx.moveCall({
      target: `${this.config.packageId}::memory::create_memory_record_lightweight`,
      arguments: [
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.category))),
        tx.pure.u64(options.vectorId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobObjectId || ''))),
        tx.pure.u8(options.importance),
      ],
    });

    return tx;
  }

  /**
   * Build transaction to update memory metadata
   */
  buildUpdateMemoryMetadata(options: UpdateMemoryMetadataTxOptions): Transaction {
    const tx = new Transaction();
    
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }
    
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Note: Using tx.moveCall for actual implementation
    tx.moveCall({
      target: `${this.config.packageId}::memory::update_memory_metadata`,
      arguments: [
        tx.pure.string(options.memoryId),
        tx.pure.string(options.metadataBlobId),
        tx.pure.u64(options.embeddingDimension || 0)
      ]
    });

    return tx;
  }

  /**
   * Build transaction for comprehensive memory record update
   *
   * Updates multiple fields of a Memory object in a single transaction.
   * Only non-empty/non-zero values will be updated on-chain.
   *
   * @param options - Update options with memoryId and fields to update
   * @returns Transaction to update memory record
   */
  buildUpdateMemoryRecord(options: UpdateMemoryRecordTxOptions): Transaction {
    const tx = new Transaction();

    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Use generated updateMemoryRecord function
    const moveCall = MemoryModule.updateMemoryRecord({
      package: this.config.packageId!,
      arguments: {
        memory: options.memoryId,
        newBlobId: Array.from(new TextEncoder().encode(options.newBlobId || '')),
        newCategory: Array.from(new TextEncoder().encode(options.newCategory || '')),
        newTopic: Array.from(new TextEncoder().encode(options.newTopic || '')),
        newImportance: options.newImportance || 0,
        newEmbeddingBlobId: Array.from(new TextEncoder().encode(options.newEmbeddingBlobId || '')),
        newContentHash: Array.from(new TextEncoder().encode(options.newContentHash || '')),
        newContentSize: options.newContentSize || 0,
      },
    });
    moveCall(tx);

    return tx;
  }

  /**
   * Build transaction to delete a memory record
   */
  buildDeleteMemoryRecord(options: DeleteMemoryRecordTxOptions): Transaction {
    const tx = new Transaction();

    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Note: Using tx.moveCall for actual implementation
    tx.moveCall({
      target: `${this.config.packageId}::memory::delete_memory_record`,
      arguments: [tx.pure.string(options.memoryId)]
    });

    return tx;
  }

  /**
   * Build transaction to create a memory index
   *
   * Smart contract signature:
   * ```move
   * public entry fun create_memory_index(
   *     index_blob_id: vector<u8>,
   *     graph_blob_id: vector<u8>,
   *     ctx: &mut tx_context::TxContext
   * )
   * ```
   */
  buildCreateMemoryIndex(options: CreateMemoryIndexTxOptions): Transaction {
    const tx = new Transaction();

    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Convert strings to vector<u8> for Move
    const indexBlobIdBytes = Array.from(new TextEncoder().encode(options.indexBlobId));
    const graphBlobIdBytes = Array.from(new TextEncoder().encode(options.graphBlobId));

    tx.moveCall({
      target: `${this.config.packageId}::memory::create_memory_index`,
      arguments: [
        tx.pure.vector('u8', indexBlobIdBytes),
        tx.pure.vector('u8', graphBlobIdBytes)
      ]
    });

    return tx;
  }

  /**
   * Build transaction to update a memory index
   *
   * Smart contract signature:
   * ```move
   * public entry fun update_memory_index(
   *     memory_index: &mut MemoryIndex,
   *     expected_version: u64,
   *     new_index_blob_id: vector<u8>,
   *     new_graph_blob_id: vector<u8>,
   *     ctx: &tx_context::TxContext
   * )
   * ```
   *
   * @param options - Update options including indexId (object ID), expectedVersion, and new blob IDs
   */
  buildUpdateMemoryIndex(options: UpdateMemoryIndexTxOptions): Transaction {
    const tx = new Transaction();

    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Convert strings to vector<u8> for Move
    const newIndexBlobIdBytes = Array.from(new TextEncoder().encode(options.newIndexBlobId));
    const newGraphBlobIdBytes = Array.from(new TextEncoder().encode(options.newGraphBlobId));

    tx.moveCall({
      target: `${this.config.packageId}::memory::update_memory_index`,
      arguments: [
        tx.object(options.indexId),                      // &mut MemoryIndex (object reference)
        tx.pure.u64(options.expectedVersion),            // expected_version: u64
        tx.pure.vector('u8', newIndexBlobIdBytes),       // new_index_blob_id: vector<u8>
        tx.pure.vector('u8', newGraphBlobIdBytes)        // new_graph_blob_id: vector<u8>
      ]
    });

    return tx;
  }

  // ==================== ACCESS CONTROL TRANSACTIONS ====================

  /**
   * Build transaction to grant access to content
   */
  buildGrantAccess(options: GrantAccessTxOptions): Transaction {
    const tx = new Transaction();
    
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }
    
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Note: Using tx.moveCall for actual implementation
    tx.moveCall({
      target: `${this.config.packageId}::access::grant_access`,
      arguments: [
        tx.pure.string(options.contentId),
        tx.pure.address(options.recipient),
        tx.pure.u8(Array.isArray(options.permissions) ? options.permissions[0] : options.permissions),
        tx.pure.u64(options.expirationTime || 0)
      ]
    });

    return tx;
  }

  /**
   * Build transaction to revoke access from content
   */
  buildRevokeAccess(options: RevokeAccessTxOptions): Transaction {
    const tx = new Transaction();
    
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }
    
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Note: Using tx.moveCall for actual implementation
    tx.moveCall({
      target: `${this.config.packageId}::access::revoke_access`,
      arguments: [
        tx.pure.string(options.contentId),
        tx.pure.address(options.recipient)
      ]
    });

    return tx;
  }

  /**
   * Build transaction to register content for access control
   */
  buildRegisterContent(options: RegisterContentTxOptions): Transaction {
    const tx = new Transaction();
    
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }
    
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Note: Using tx.moveCall for actual implementation
    tx.moveCall({
      target: `${this.config.packageId}::access::register_content`,
      arguments: [
        tx.pure.string(options.contentHash),
        tx.pure.string(options.encryptionKey),
        tx.pure.string(Array.isArray(options.accessPolicy) ? JSON.stringify(options.accessPolicy) : options.accessPolicy)
      ]
    });

    return tx;
  }

  // ==================== EXECUTION METHODS ====================

  /**
   * Execute a transaction and return structured result
   *
   * Note: For version conflict errors (stale gas coin), retry logic should be
   * implemented at the caller level with a fresh transaction build, since
   * the transaction object holds reference to the gas coin.
   */
  async executeTransaction(
    tx: Transaction,
    signer: any,
    options: TransactionOptions = {}
  ): Promise<TransactionResult> {
    try {
      // Set sender if provided
      if (options.sender) {
        tx.setSender(options.sender);
      }

      // Execute the transaction
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });

      // Parse the result
      const transactionResult: TransactionResult = {
        digest: result.digest,
        effects: result.effects,
        status: result.effects?.status?.status === 'success' ? 'success' : 'failure',
        gasUsed: result.effects?.gasUsed?.computationCost
          ? Number(result.effects.gasUsed.computationCost)
          : undefined,
      };

      // Extract created objects
      if (result.objectChanges) {
        transactionResult.createdObjects = result.objectChanges
          .filter(change => change.type === 'created')
          .map(change => ({
            objectId: change.objectId,
            objectType: change.objectType || 'unknown',
          }));

        transactionResult.mutatedObjects = result.objectChanges
          .filter(change => change.type === 'mutated')
          .map(change => ({
            objectId: change.objectId,
            objectType: change.objectType || 'unknown',
          }));

        transactionResult.deletedObjects = result.objectChanges
          .filter(change => change.type === 'deleted')
          .map(change => change.objectId);
      }

      // Add error if transaction failed
      if (transactionResult.status === 'failure') {
        transactionResult.error = result.effects?.status?.error || 'Unknown transaction error';
      }

      return transactionResult;
    } catch (error) {
      console.error('Transaction execution failed:', error);
      return {
        digest: '',
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ==================== CONVENIENCE METHODS ====================

  /**
   * Create and execute a memory record transaction
   */
  async createMemoryRecord(
    options: CreateMemoryRecordTxOptions, 
    signer: any
  ): Promise<TransactionResult> {
    const tx = this.buildCreateMemoryRecord(options);
    return this.executeTransaction(tx, signer, options);
  }

  /**
   * Create and execute an update memory metadata transaction
   */
  async updateMemoryMetadata(
    options: UpdateMemoryMetadataTxOptions, 
    signer: any
  ): Promise<TransactionResult> {
    const tx = this.buildUpdateMemoryMetadata(options);
    return this.executeTransaction(tx, signer, options);
  }

  /**
   * Create and execute a delete memory record transaction
   */
  async deleteMemoryRecord(
    options: DeleteMemoryRecordTxOptions, 
    signer: any
  ): Promise<TransactionResult> {
    const tx = this.buildDeleteMemoryRecord(options);
    return this.executeTransaction(tx, signer, options);
  }

  /**
   * Create and execute a grant access transaction
   */
  async grantAccess(
    options: GrantAccessTxOptions, 
    signer: any
  ): Promise<TransactionResult> {
    const tx = this.buildGrantAccess(options);
    return this.executeTransaction(tx, signer, options);
  }

  /**
   * Create and execute a revoke access transaction
   */
  async revokeAccess(
    options: RevokeAccessTxOptions, 
    signer: any
  ): Promise<TransactionResult> {
    const tx = this.buildRevokeAccess(options);
    return this.executeTransaction(tx, signer, options);
  }

  // ==================== BATCH OPERATIONS ====================

  /**
   * Build a batch transaction combining multiple operations
   *
   * Access control uses capability-based pattern:
   * - createCap: Create a new MemoryCap for an app context
   * - transferCap: Transfer capability to recipient (grants access)
   * - burnCap: Burn capability (revokes access permanently)
   */
  buildBatchTransaction(operations: Array<{
    type: 'createMemory' | 'updateMemory' | 'deleteMemory' | 'createCap' | 'transferCap' | 'burnCap';
    options: any;
  }>): Transaction {
    const tx = new Transaction();

    for (const operation of operations) {
      switch (operation.type) {
        case 'createMemory':
          MemoryModule.createMemoryRecord({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        case 'updateMemory':
          MemoryModule.updateMemoryMetadata({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        case 'deleteMemory':
          MemoryModule.deleteMemoryRecord({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        case 'createCap':
          // Create a new MemoryCap for an app context
          CapabilityModule.createMemoryCap({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        case 'transferCap':
          // Transfer capability to recipient (grants access)
          CapabilityModule.transferCap({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        case 'burnCap':
          // Burn capability (revokes access permanently)
          CapabilityModule.burnCap({
            package: this.config.packageId,
            arguments: operation.options,
          })(tx);
          break;

        default:
          console.warn(`Unknown operation type: ${operation.type}`);
      }
    }

    return tx;
  }

  /**
   * Execute a batch transaction
   */
  async executeBatch(
    operations: Array<{
      type: 'createMemory' | 'updateMemory' | 'deleteMemory' | 'createCap' | 'transferCap' | 'burnCap';
      options: any;
    }>,
    signer: any,
    txOptions: TransactionOptions = {}
  ): Promise<TransactionResult> {
    const tx = this.buildBatchTransaction(operations);
    
    if (txOptions.gasBudget) {
      tx.setGasBudget(txOptions.gasBudget);
    }
    
    return this.executeTransaction(tx, signer, txOptions);
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Estimate gas cost for a transaction
   */
  async estimateGas(tx: Transaction, signer: any): Promise<number> {
    try {
      const dryRunResult = await this.client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: this.client }),
      });
      
      return dryRunResult.effects.gasUsed?.computationCost 
        ? Number(dryRunResult.effects.gasUsed.computationCost)
        : 0;
    } catch (error) {
      console.error('Gas estimation failed:', error);
      return 0;
    }
  }

  /**
   * Get recommended gas budget based on transaction complexity
   */
  getRecommendedGasBudget(operationCount: number = 1): number {
    const baseGas = 1000000; // 1M MIST base
    const perOperationGas = 500000; // 500K MIST per operation
    return baseGas + (operationCount * perOperationGas);
  }
}