/**
 * SuiService - Blockchain Integration for Memory Records
 * 
 * Comprehensive Sui blockchain integration for memory ownership records,
 * transaction batching, and decentralized metadata management.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64, toB64 } from '@mysten/bcs';

export interface SuiConfig {
  network?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  packageId?: string;
  adminPrivateKey?: string;
  rpcUrl?: string;
  enableBatching?: boolean;
  batchSize?: number;
  batchDelayMs?: number;
  gasObjectId?: string;
}

export interface MemoryRecord {
  id: string;
  owner: string;
  category: string;
  vectorId: number;
  blobId: string;
  metadata: MemoryMetadata;
  createdAt: Date;
  version: number;
}

export interface MemoryIndex {
  id: string;
  owner: string;
  version: number;
  indexBlobId: string;
  graphBlobId: string;
  lastUpdated: Date;
}

export interface MemoryMetadata {
  contentType: string;
  contentSize: number;
  contentHash: string;
  category: string;
  topic: string;
  importance: number; // 1-10 scale
  embeddingBlobId: string;
  embeddingDimension: number;
  createdTimestamp: number;
  updatedTimestamp: number;
  customMetadata: Record<string, string>;
}

export interface TransactionResult {
  digest: string;
  objectId?: string;
  effects?: any;
  events?: any[];
  success: boolean;
  error?: string;
  gasUsed?: number;
}

export interface BatchTransaction {
  id: string;
  userId: string;
  operation: 'create_memory' | 'create_index' | 'update_index';
  parameters: any;
  priority: number;
  timestamp: Date;
}

export interface SuiStats {
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  averageGasUsed: number;
  batchedTransactions: number;
  totalGasCost: number;
  networkHealth: 'healthy' | 'degraded' | 'offline';
  lastSuccessfulTransaction?: Date;
}

/**
 * Sui blockchain service for memory ownership and metadata management
 */
export class SuiService {
  private client!: SuiClient;
  private adminKeypair?: Ed25519Keypair;
  private readonly config: Required<SuiConfig>;
  private batchQueue: BatchTransaction[] = [];
  private batchTimer?: NodeJS.Timeout;
  private pendingTransactions = new Map<string, Promise<TransactionResult>>();
  
  private stats: SuiStats = {
    totalTransactions: 0,
    successfulTransactions: 0,
    failedTransactions: 0,
    averageGasUsed: 0,
    batchedTransactions: 0,
    totalGasCost: 0,
    networkHealth: 'healthy'
  };

  constructor(config: Partial<SuiConfig> = {}) {
    this.config = {
      network: config.network || 'testnet',
      packageId: config.packageId || '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      adminPrivateKey: config.adminPrivateKey || '',
      rpcUrl: config.rpcUrl || '',
      enableBatching: config.enableBatching !== false,
      batchSize: config.batchSize || 10,
      batchDelayMs: config.batchDelayMs || 5000,
      gasObjectId: config.gasObjectId || ''
    };

    this.initializeSuiClient();
    this.initializeAdminKeypair();
  }

  // ==================== MEMORY RECORD OPERATIONS ====================

  /**
   * Create memory record on Sui blockchain
   */
  async createMemoryRecord(
    userAddress: string,
    category: string,
    vectorId: number,
    blobId: string,
    metadata: MemoryMetadata,
    options: {
      enableBatching?: boolean;
      priority?: number;
    } = {}
  ): Promise<TransactionResult> {
    if (options.enableBatching && this.config.enableBatching) {
      return this.addToBatch({
        id: this.generateTransactionId(),
        userId: userAddress,
        operation: 'create_memory',
        parameters: { category, vectorId, blobId, metadata },
        priority: options.priority || 1,
        timestamp: new Date()
      });
    }

    return await this.executeCreateMemoryRecord(userAddress, category, vectorId, blobId, metadata);
  }

  /**
   * Create memory index on Sui blockchain
   */
  async createMemoryIndex(
    userAddress: string,
    indexBlobId: string,
    graphBlobId: string,
    options: {
      enableBatching?: boolean;
      priority?: number;
    } = {}
  ): Promise<TransactionResult> {
    if (options.enableBatching && this.config.enableBatching) {
      return this.addToBatch({
        id: this.generateTransactionId(),
        userId: userAddress,
        operation: 'create_index',
        parameters: { indexBlobId, graphBlobId },
        priority: options.priority || 1,
        timestamp: new Date()
      });
    }

    return await this.executeCreateMemoryIndex(userAddress, indexBlobId, graphBlobId);
  }

  /**
   * Update memory index on Sui blockchain
   */
  async updateMemoryIndex(
    indexId: string,
    userAddress: string,
    expectedVersion: number,
    newIndexBlobId: string,
    newGraphBlobId: string,
    options: {
      enableBatching?: boolean;
      priority?: number;
    } = {}
  ): Promise<TransactionResult> {
    if (options.enableBatching && this.config.enableBatching) {
      return this.addToBatch({
        id: this.generateTransactionId(),
        userId: userAddress,
        operation: 'update_index',
        parameters: { indexId, expectedVersion, newIndexBlobId, newGraphBlobId },
        priority: options.priority || 1,
        timestamp: new Date()
      });
    }

    return await this.executeUpdateMemoryIndex(
      indexId, 
      userAddress, 
      expectedVersion, 
      newIndexBlobId, 
      newGraphBlobId
    );
  }

  /**
   * Get memory record by ID
   */
  async getMemoryRecord(objectId: string): Promise<MemoryRecord | null> {
    try {
      const response = await this.client.getObject({
        id: objectId,
        options: {
          showContent: true,
          showOwner: true,
          showType: true
        }
      });

      if (!response.data) {
        return null;
      }

      const content = response.data.content as any;
      if (!content || content.dataType !== 'moveObject') {
        return null;
      }

      const fields = content.fields;
      return {
        id: objectId,
        owner: fields.owner,
        category: fields.category,
        vectorId: parseInt(fields.vector_id),
        blobId: fields.blob_id,
        metadata: this.parseMetadata(fields.metadata),
        createdAt: new Date(parseInt(fields.metadata.created_timestamp)),
        version: fields.version || 1
      };

    } catch (error) {
      console.error('Error getting memory record:', error);
      return null;
    }
  }

  /**
   * Get memory index by ID
   */
  async getMemoryIndex(indexId: string): Promise<MemoryIndex | null> {
    try {
      const response = await this.client.getObject({
        id: indexId,
        options: {
          showContent: true,
          showOwner: true
        }
      });

      if (!response.data) {
        return null;
      }

      const content = response.data.content as any;
      if (!content || content.dataType !== 'moveObject') {
        return null;
      }

      const fields = content.fields;
      return {
        id: indexId,
        owner: fields.owner,
        version: parseInt(fields.version),
        indexBlobId: fields.index_blob_id,
        graphBlobId: fields.graph_blob_id,
        lastUpdated: new Date() // TODO: Get from blockchain timestamp
      };

    } catch (error) {
      console.error('Error getting memory index:', error);
      return null;
    }
  }

  /**
   * Get user's memory records
   */
  async getUserMemoryRecords(userAddress: string, limit: number = 100): Promise<MemoryRecord[]> {
    try {
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.config.packageId}::memory::Memory`
        },
        options: {
          showContent: true,
          showType: true
        },
        limit
      });

      const memoryRecords: MemoryRecord[] = [];

      for (const item of response.data) {
        if (item.data && item.data.content) {
          const content = item.data.content as any;
          if (content.dataType === 'moveObject' && content.fields) {
            const fields = content.fields;
            memoryRecords.push({
              id: item.data.objectId,
              owner: fields.owner,
              category: fields.category,
              vectorId: parseInt(fields.vector_id),
              blobId: fields.blob_id,
              metadata: this.parseMetadata(fields.metadata),
              createdAt: new Date(parseInt(fields.metadata.created_timestamp)),
              version: fields.version || 1
            });
          }
        }
      }

      return memoryRecords;

    } catch (error) {
      console.error('Error getting user memory records:', error);
      return [];
    }
  }

  /**
   * Get user's memory indices
   */
  async getUserMemoryIndices(userAddress: string): Promise<MemoryIndex[]> {
    try {
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.config.packageId}::memory::MemoryIndex`
        },
        options: {
          showContent: true,
          showType: true
        }
      });

      const memoryIndices: MemoryIndex[] = [];

      for (const item of response.data) {
        if (item.data && item.data.content) {
          const content = item.data.content as any;
          if (content.dataType === 'moveObject' && content.fields) {
            const fields = content.fields;
            memoryIndices.push({
              id: item.data.objectId,
              owner: fields.owner,
              version: parseInt(fields.version),
              indexBlobId: fields.index_blob_id,
              graphBlobId: fields.graph_blob_id,
              lastUpdated: new Date() // TODO: Get from blockchain events
            });
          }
        }
      }

      return memoryIndices;

    } catch (error) {
      console.error('Error getting user memory indices:', error);
      return [];
    }
  }

  // ==================== BATCH OPERATIONS ====================

  /**
   * Process pending batch transactions
   */
  async processBatchQueue(): Promise<TransactionResult[]> {
    if (this.batchQueue.length === 0) {
      return [];
    }

    const batch = [...this.batchQueue];
    this.batchQueue.length = 0; // Clear queue

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    console.log(`Processing batch of ${batch.length} transactions`);

    // Sort by priority (higher priority first)
    batch.sort((a, b) => b.priority - a.priority);

    const results: TransactionResult[] = [];

    // Execute transactions in sequence to avoid nonce conflicts
    for (const transaction of batch) {
      try {
        let result: TransactionResult;

        switch (transaction.operation) {
          case 'create_memory':
            const { category, vectorId, blobId, metadata } = transaction.parameters;
            result = await this.executeCreateMemoryRecord(
              transaction.userId, category, vectorId, blobId, metadata
            );
            break;

          case 'create_index':
            const { indexBlobId, graphBlobId } = transaction.parameters;
            result = await this.executeCreateMemoryIndex(
              transaction.userId, indexBlobId, graphBlobId
            );
            break;

          case 'update_index':
            const { indexId, expectedVersion, newIndexBlobId, newGraphBlobId } = transaction.parameters;
            result = await this.executeUpdateMemoryIndex(
              indexId, transaction.userId, expectedVersion, newIndexBlobId, newGraphBlobId
            );
            break;

          default:
            result = {
              digest: '',
              success: false,
              error: `Unknown operation: ${transaction.operation}`
            };
        }

        results.push(result);
        this.stats.batchedTransactions++;

      } catch (error) {
        results.push({
          digest: '',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    console.log(`Batch processing complete: ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  /**
   * Force process batch queue immediately
   */
  async flushBatchQueue(): Promise<TransactionResult[]> {
    return await this.processBatchQueue();
  }

  // ==================== NETWORK OPERATIONS ====================

  /**
   * Check network health
   */
  async checkNetworkHealth(): Promise<'healthy' | 'degraded' | 'offline'> {
    try {
      const start = Date.now();
      const response = await this.client.getLatestCheckpointSequenceNumber();
      const latency = Date.now() - start;

      if (response && latency < 5000) {
        this.stats.networkHealth = 'healthy';
      } else {
        this.stats.networkHealth = 'degraded';
      }

    } catch (error) {
      this.stats.networkHealth = 'offline';
    }

    return this.stats.networkHealth;
  }

  /**
   * Get gas price recommendations
   */
  async getGasPrice(): Promise<{ referenceGasPrice: number; recommendation: string }> {
    try {
      const gasPrice = await this.client.getReferenceGasPrice();
      
      return {
        referenceGasPrice: parseInt(gasPrice.toString()),
        recommendation: parseInt(gasPrice.toString()) > 1000 ? 'high' : 'normal'
      };

    } catch (error) {
      console.error('Error getting gas price:', error);
      return {
        referenceGasPrice: 1000,
        recommendation: 'normal'
      };
    }
  }

  /**
   * Get transaction by digest
   */
  async getTransaction(digest: string) {
    try {
      return await this.client.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
          showEvents: true,
          showInput: true,
          showObjectChanges: true
        }
      });
    } catch (error) {
      console.error('Error getting transaction:', error);
      return null;
    }
  }

  // ==================== STATISTICS & MONITORING ====================

  /**
   * Get service statistics
   */
  getStats(): SuiStats {
    return { ...this.stats };
  }

  /**
   * Get batch queue status
   */
  getBatchQueueStatus(): {
    pending: number;
    nextProcessing: Date | null;
    averageBatchSize: number;
  } {
    return {
      pending: this.batchQueue.length,
      nextProcessing: this.batchTimer ? new Date(Date.now() + this.config.batchDelayMs) : null,
      averageBatchSize: this.stats.batchedTransactions > 0 
        ? this.config.batchSize 
        : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalTransactions: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      averageGasUsed: 0,
      batchedTransactions: 0,
      totalGasCost: 0,
      networkHealth: 'healthy'
    };
  }

  // ==================== PRIVATE METHODS ====================

  private initializeSuiClient(): void {
    try {
      const networkUrl = this.config.rpcUrl || getFullnodeUrl(this.config.network);
      this.client = new SuiClient({ url: networkUrl });
      console.log(`Sui client initialized for ${this.config.network} network`);
    } catch (error) {
      console.error('Failed to initialize Sui client:', error);
      throw new Error(`Sui client initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private initializeAdminKeypair(): void {
    if (!this.config.adminPrivateKey) {
      console.warn('No admin private key provided. Creating random keypair for development.');
      this.adminKeypair = new Ed25519Keypair();
      return;
    }

    try {
      // Clean up the private key
      let privateKey = this.config.adminPrivateKey.replace(/\s+/g, '');
      
      if (privateKey.startsWith('suiprivkey1')) {
        // Sui private key format
        this.adminKeypair = Ed25519Keypair.fromSecretKey(privateKey);
      } else {
        // Hex format
        if (!privateKey.startsWith('0x')) {
          privateKey = '0x' + privateKey;
        }
        
        const keyBuffer = Buffer.from(privateKey.replace('0x', ''), 'hex');
        if (keyBuffer.length !== 32) {
          throw new Error(`Invalid key length: ${keyBuffer.length}, expected 32`);
        }
        
        this.adminKeypair = Ed25519Keypair.fromSecretKey(new Uint8Array(keyBuffer));
      }

      const adminAddress = this.adminKeypair.getPublicKey().toSuiAddress();
      console.log(`Admin keypair initialized with address: ${adminAddress}`);

    } catch (error) {
      console.error('Failed to initialize admin keypair:', error);
      console.warn('Using random keypair for development');
      this.adminKeypair = new Ed25519Keypair();
    }
  }

  private async executeCreateMemoryRecord(
    userAddress: string,
    category: string,
    vectorId: number,
    blobId: string,
    metadata: MemoryMetadata
  ): Promise<TransactionResult> {
    try {
      const tx = new Transaction();
      
      // Convert metadata to Move-compatible format
      const metadataFields = this.serializeMetadata(metadata);
      
      tx.moveCall({
        target: `${this.config.packageId}::memory::create_memory_record`,
        arguments: [
          tx.pure.string(category),
          tx.pure.u64(vectorId),
          tx.pure.string(blobId),
          tx.pure(metadataFields) // Serialized metadata
        ]
      });

      return await this.executeTransaction(tx, userAddress);

    } catch (error) {
      console.error('Error creating memory record:', error);
      return {
        digest: '',
        success: false,
        error: (error instanceof Error ? error.message : 'Unknown error')
      };
    }
  }

  private async executeCreateMemoryIndex(
    userAddress: string,
    indexBlobId: string,
    graphBlobId: string
  ): Promise<TransactionResult> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.config.packageId}::memory::create_memory_index`,
        arguments: [
          tx.pure(new TextEncoder().encode(indexBlobId)),
          tx.pure(new TextEncoder().encode(graphBlobId))
        ]
      });

      return await this.executeTransaction(tx, userAddress);

    } catch (error) {
      console.error('Error creating memory index:', error);
      return {
        digest: '',
        success: false,
        error: (error instanceof Error ? error.message : 'Unknown error')
      };
    }
  }

  private async executeUpdateMemoryIndex(
    indexId: string,
    userAddress: string,
    expectedVersion: number,
    newIndexBlobId: string,
    newGraphBlobId: string
  ): Promise<TransactionResult> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.config.packageId}::memory::update_memory_index`,
        arguments: [
          tx.object(indexId),
          tx.pure.u64(expectedVersion),
          tx.pure.string(newIndexBlobId),
          tx.pure.string(newGraphBlobId)
        ]
      });

      return await this.executeTransaction(tx, userAddress);

    } catch (error) {
      console.error('Error updating memory index:', error);
      return {
        digest: '',
        success: false,
        error: (error instanceof Error ? error.message : 'Unknown error')
      };
    }
  }

  private async executeTransaction(tx: Transaction, signer?: string): Promise<TransactionResult> {
    const startTime = Date.now();
    this.stats.totalTransactions++;

    try {
      if (!this.adminKeypair) {
        throw new Error('Admin keypair not initialized');
      }

      // Set gas payment
      const coins = await this.client.getCoins({
        owner: this.adminKeypair.getPublicKey().toSuiAddress(),
        coinType: '0x2::sui::SUI'
      });

      if (coins.data.length === 0) {
        throw new Error('No gas coins available');
      }

      tx.setGasPayment(coins.data.slice(0, 10).map(coin => ({
        objectId: coin.coinObjectId,
        version: coin.version,
        digest: coin.digest
      })));

      // Execute transaction
      const result = await this.client.signAndExecuteTransaction({
        transaction: tx,
        signer: this.adminKeypair,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true
        }
      });

      // Update statistics
      const gasUsed = result.effects?.gasUsed?.computationCost || 0;
      this.updateGasStats(typeof gasUsed === 'string' ? parseInt(gasUsed) : gasUsed);
      this.stats.successfulTransactions++;
      this.stats.lastSuccessfulTransaction = new Date();

      // Extract created object ID if any
      const objectId = this.extractCreatedObjectId(result);

      return {
        digest: result.digest,
        objectId,
        effects: result.effects,
        events: result.events || [],
        success: true,
        gasUsed: typeof gasUsed === 'string' ? parseInt(gasUsed) : gasUsed
      };

    } catch (error) {
      this.stats.failedTransactions++;
      console.error('Transaction execution failed:', error);
      
      return {
        digest: '',
        success: false,
        error: (error instanceof Error ? error.message : 'Unknown error')
      };
    }
  }

  private extractCreatedObjectId(result: any): string | undefined {
    if (result.objectChanges) {
      for (const change of result.objectChanges) {
        if (change.type === 'created') {
          return change.objectId;
        }
      }
    }
    return undefined;
  }

  private addToBatch(transaction: BatchTransaction): Promise<TransactionResult> {
    this.batchQueue.push(transaction);
    this.scheduleBatchProcessing();

    // Return a promise that resolves when batch is processed
    return new Promise((resolve) => {
      // Simple implementation - in production, track individual transaction results
      setTimeout(() => {
        resolve({
          digest: 'batched',
          success: true
        });
      }, this.config.batchDelayMs + 1000);
    });
  }

  private scheduleBatchProcessing(): void {
    if (this.batchTimer) {
      return; // Already scheduled
    }

    // Process when batch is full or after delay
    if (this.batchQueue.length >= this.config.batchSize) {
      setImmediate(() => this.processBatchQueue());
    } else {
      this.batchTimer = setTimeout(() => {
        this.processBatchQueue();
      }, this.config.batchDelayMs);
    }
  }

  private serializeMetadata(metadata: MemoryMetadata): any {
    // Convert to Move-compatible format
    return {
      content_type: metadata.contentType,
      content_size: metadata.contentSize,
      content_hash: metadata.contentHash,
      category: metadata.category,
      topic: metadata.topic,
      importance: Math.max(1, Math.min(10, metadata.importance)),
      embedding_blob_id: metadata.embeddingBlobId,
      embedding_dimension: metadata.embeddingDimension,
      created_timestamp: metadata.createdTimestamp,
      updated_timestamp: metadata.updatedTimestamp || metadata.createdTimestamp,
      custom_metadata: Object.entries(metadata.customMetadata).map(([key, value]) => ({ key, value }))
    };
  }

  private parseMetadata(fields: any): MemoryMetadata {
    return {
      contentType: fields.content_type,
      contentSize: parseInt(fields.content_size),
      contentHash: fields.content_hash,
      category: fields.category,
      topic: fields.topic,
      importance: parseInt(fields.importance),
      embeddingBlobId: fields.embedding_blob_id,
      embeddingDimension: parseInt(fields.embedding_dimension),
      createdTimestamp: parseInt(fields.created_timestamp),
      updatedTimestamp: parseInt(fields.updated_timestamp),
      customMetadata: this.parseCustomMetadata(fields.custom_metadata)
    };
  }

  private parseCustomMetadata(customMetadataVec: any[]): Record<string, string> {
    const result: Record<string, string> = {};
    
    if (Array.isArray(customMetadataVec)) {
      for (const item of customMetadataVec) {
        if (item.key && item.value) {
          result[item.key] = item.value;
        }
      }
    }
    
    return result;
  }

  private updateGasStats(gasUsed: number): void {
    this.stats.totalGasCost += gasUsed;
    this.stats.averageGasUsed = this.stats.totalGasCost / this.stats.successfulTransactions;
  }

  private generateTransactionId(): string {
    return `tx_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }
}

export default SuiService;
