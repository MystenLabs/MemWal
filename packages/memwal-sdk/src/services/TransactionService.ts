import { Transaction, SerialTransactionExecutor } from '@mysten/sui/transactions';
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
 *
 * Uses SerialTransactionExecutor to prevent gas coin version conflicts and equivocation
 * when multiple transactions are executed in sequence. The executor caches object versions
 * and manages gas coins automatically.
 *
 * @see https://sdk.mystenlabs.com/typescript/executors
 */
export class TransactionService {
  private executor: SerialTransactionExecutor | null = null;
  private currentSigner: any = null;

  constructor(
    private client: SuiClient,
    private config: PDWConfig
  ) {}

  /**
   * Get or create SerialTransactionExecutor for the given signer.
   * The executor caches object versions and prevents equivocation.
   */
  private getExecutor(signer: any): SerialTransactionExecutor {
    // Create new executor if signer changed or doesn't exist
    if (!this.executor || this.currentSigner !== signer) {
      this.executor = new SerialTransactionExecutor({
        client: this.client,
        signer,
      });
      this.currentSigner = signer;
    }
    return this.executor;
  }

  /**
   * Reset the executor (useful when gas coin is exhausted or for cleanup)
   */
  resetExecutor(): void {
    this.executor = null;
    this.currentSigner = null;
  }

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

    // Call the memory contract function with Clock for real-time timestamp
    tx.moveCall({
      target: `${this.config.packageId}::memory::create_memory_record`,
      arguments: [
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.category))),
        tx.pure.u64(options.vectorId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.contentType))),
        tx.pure.u64(options.contentSize),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.contentHash))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.topic))),
        tx.pure.u8(options.importance),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.embeddingBlobId))),
        tx.object('0x6'), // Sui Clock object for real-time timestamp
      ],
    });

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
    // Clock object (0x6) is required for real-time timestamp
    tx.moveCall({
      target: `${this.config.packageId}::memory::create_memory_record_lightweight`,
      arguments: [
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.category))),
        tx.pure.u64(options.vectorId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobObjectId || ''))),
        tx.pure.u8(options.importance),
        tx.object('0x6'), // Sui Clock object for real-time timestamp
      ],
    });

    return tx;
  }

  /**
   * Build transaction to create a lightweight memory record with capability (V2 - RECOMMENDED)
   *
   * Gas-optimized version for capability-based access control with SEAL encryption.
   * This creates a memory record linked to a MemoryCap, enabling:
   * - Identity-based encryption/decryption via SEAL
   * - Cross-package memory sharing via capability transfer
   * - Fine-grained access control
   *
   * Use this when:
   * - Encryption is enabled (SEAL requires capability)
   * - You need cross-package memory sharing
   * - You want capability-based access control
   *
   * @param options - Lightweight memory creation options with capability
   * @returns Transaction to create lightweight memory record with capability
   */
  buildCreateMemoryRecordLightweightWithCap(options: CreateMemoryRecordLightweightTxOptions & { capId: string }): Transaction {
    const tx = new Transaction();

    // Set gas budget if provided
    if (options.gasBudget) {
      tx.setGasBudget(options.gasBudget);
    }

    // Set gas price if provided
    if (options.gasPrice) {
      tx.setGasPrice(options.gasPrice);
    }

    // Call the capability-based memory creation function
    // Note: Clock object (0x6) is required for real-time timestamp
    tx.moveCall({
      target: `${this.config.packageId}::memory::create_memory_lightweight_with_cap`,
      arguments: [
        tx.object(options.capId), // &MemoryCap reference (FIRST argument)
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.category))),
        tx.pure.u64(options.vectorId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobId))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.blobObjectId || ''))),
        tx.pure.u8(options.importance),
        tx.object('0x6'), // Sui Clock object for real-time timestamp
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

    // Note: Using tx.moveCall with Clock for real-time timestamp
    tx.moveCall({
      target: `${this.config.packageId}::memory::update_memory_metadata`,
      arguments: [
        tx.object(options.memoryId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.metadataBlobId))),
        tx.pure.u8(options.embeddingDimension || 5),
        tx.object('0x6'), // Sui Clock object for real-time timestamp
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

    // Use direct moveCall with Clock object for real-time timestamp
    tx.moveCall({
      target: `${this.config.packageId}::memory::update_memory_record`,
      arguments: [
        tx.object(options.memoryId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.newBlobId || ''))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.newCategory || ''))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.newTopic || ''))),
        tx.pure.u8(options.newImportance || 0),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.newEmbeddingBlobId || ''))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(options.newContentHash || ''))),
        tx.pure.u64(options.newContentSize || 0),
        tx.object('0x6'), // Sui Clock object for real-time timestamp
      ],
    });

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
   * Execute a transaction using SerialTransactionExecutor with automatic retry.
   *
   * The executor automatically:
   * - Caches object versions to prevent version conflicts within same session
   * - Manages gas coins to prevent equivocation (24h lock)
   * - Queues transactions sequentially for safe execution
   *
   * When version conflict occurs (external modification), the executor cache
   * is reset and transaction is retried with fresh object references.
   *
   * @see https://sdk.mystenlabs.com/typescript/executors
   * @see https://docs.sui.io/concepts/sui-architecture/epochs#equivocation
   */
  async executeTransaction(
    tx: Transaction,
    signer: any,
    options: TransactionOptions = {}
  ): Promise<TransactionResult> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Set sender if provided
        if (options.sender) {
          tx.setSender(options.sender);
        }

        // Use SerialTransactionExecutor to prevent equivocation and version conflicts
        const executor = this.getExecutor(signer);
        // Pass options to get full response data including objectChanges
        const executorResult = await executor.executeTransaction(tx, {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        });

        // SerialTransactionExecutor returns { digest, effects (string), data (SuiTransactionBlockResponse) }
        // The actual response data is in executorResult.data
        const result = executorResult.data;

        // Parse the result
        const transactionResult: TransactionResult = {
          digest: executorResult.digest,
          effects: result.effects,
          status: result.effects?.status?.status === 'success' ? 'success' : 'failure',
          gasUsed: result.effects?.gasUsed?.computationCost
            ? Number(result.effects.gasUsed.computationCost)
            : undefined,
        };

        // Extract created objects
        if (result.objectChanges) {
          transactionResult.createdObjects = result.objectChanges
            .filter((change: any) => change.type === 'created')
            .map((change: any) => ({
              objectId: change.objectId,
              objectType: change.objectType || 'unknown',
            }));

          transactionResult.mutatedObjects = result.objectChanges
            .filter((change: any) => change.type === 'mutated')
            .map((change: any) => ({
              objectId: change.objectId,
              objectType: change.objectType || 'unknown',
            }));

          transactionResult.deletedObjects = result.objectChanges
            .filter((change: any) => change.type === 'deleted')
            .map((change: any) => change.objectId);
        }

        // Add error if transaction failed
        if (transactionResult.status === 'failure') {
          transactionResult.error = result.effects?.status?.error || 'Unknown transaction error';
        }

        return transactionResult;
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if it's a version conflict error (external modification)
        const isVersionConflict =
          errorMsg.includes('is not available for consumption') ||
          errorMsg.includes('current version') ||
          errorMsg.includes('ObjectVersionTooOld') ||
          errorMsg.includes('EquivocationError');

        if (isVersionConflict && attempt < maxRetries) {
          // Reset executor cache to get fresh object versions
          console.log(`⚠️ Version conflict detected (attempt ${attempt}/${maxRetries}), resetting cache...`);
          await this.executor?.resetCache();

          // Exponential backoff: 500ms, 1000ms, 2000ms
          const delay = 500 * Math.pow(2, attempt - 1);
          console.log(`   Retrying in ${delay}ms with fresh object references...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        console.error('Transaction execution failed:', error);
        // Reset executor on final failure to get fresh state for next call
        this.resetExecutor();
        return {
          digest: '',
          status: 'failure',
          error: errorMsg,
        };
      }
    }

    // Should never reach here, but TypeScript needs a return
    return {
      digest: '',
      status: 'failure',
      error: 'Max retries exceeded',
    };
  }

  /**
   * Execute a transaction directly without the executor (legacy method).
   * Use this only when you need direct control over execution or for one-off transactions.
   *
   * WARNING: This method does not protect against equivocation.
   * For sequential transactions, use executeTransaction() instead.
   */
  async executeTransactionDirect(
    tx: Transaction,
    signer: any,
    options: TransactionOptions = {}
  ): Promise<TransactionResult> {
    try {
      // Set sender if provided
      if (options.sender) {
        tx.setSender(options.sender);
      }

      // Execute the transaction directly
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });

      // Wait for transaction to be finalized on-chain
      if (result.digest) {
        try {
          await this.client.waitForTransaction({
            digest: result.digest,
            options: { showEffects: true },
          });
        } catch (waitError) {
          console.warn('waitForTransaction warning:', waitError);
        }
      }

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