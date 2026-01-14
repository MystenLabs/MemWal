/**
 * PDWVectorStore - AI SDK Integration
 *
 * A vector store implementation designed for Vercel AI SDK and other AI frameworks.
 * Provides a familiar API (similar to Pinecone/Chroma) while leveraging PDW's full
 * capabilities: Walrus decentralized storage, Sui blockchain, knowledge graphs,
 * and optional SEAL encryption.
 *
 * @module ai-sdk/PDWVectorStore
 *
 * @example
 * ```typescript
 * import { embed } from 'ai';
 * import { PDWVectorStore } from 'pdw-sdk/ai-sdk';
 *
 * const store = new PDWVectorStore(config);
 * await store.initialize();
 *
 * // Add vector from AI SDK
 * const { embedding } = await embed({ model, value: text });
 * await store.add({ id, vector: embedding, text });
 *
 * // Search
 * const results = await store.search(queryVector, { limit: 5 });
 * ```
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { StorageService } from '../services/StorageService';
// Import environment detection from browser-safe file (no Node.js deps)
import { isBrowser, isNode } from '../vector/IHnswService';
import type { IHnswService } from '../vector/IHnswService';
import { GraphService } from '../graph/GraphService';
import { EmbeddingService } from '../services/EmbeddingService';
import type {
  PDWVectorStoreConfig,
  AddVectorParams,
  AddVectorBatchParams,
  SearchParams,
  SearchResult,
  AddVectorResult,
  AddVectorBatchResult,
  GetVectorParams,
  GetVectorResult,
  DeleteVectorParams,
  DeleteVectorResult,
  VectorStoreStats,
  PDWErrorType,
  PDWVectorStoreError as PDWVectorStoreErrorType,
} from './types';

/**
 * Custom error class for PDW Vector Store operations
 */
export class PDWVectorStoreError extends Error implements PDWVectorStoreErrorType {
  constructor(
    public type: PDWErrorType,
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'PDWVectorStoreError';
  }
}

/**
 * PDW Vector Store - Full-featured vector database with decentralized storage
 */
export class PDWVectorStore {
  private config: PDWVectorStoreConfig;
  private storageService: StorageService;
  private vectorService: IHnswService | null = null;
  private vectorServicePromise: Promise<IHnswService> | null = null;
  private graphService?: GraphService;
  private embeddingService?: EmbeddingService;
  private suiClient: SuiClient;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // Cache for vector ID to blob ID mapping
  private vectorIdMap: Map<string, { blobId: string; vectorId: number }> = new Map();

  constructor(config: PDWVectorStoreConfig) {
    this.config = config;

    // Initialize Sui client
    this.suiClient = config.sui.client || new SuiClient({
      url: getFullnodeUrl(config.sui.network)
    });

    // Initialize StorageService
    // Map devnet to testnet since StorageService only accepts testnet/mainnet
    const networkForStorage = config.sui.network === 'devnet' ? 'testnet' : config.sui.network as 'testnet' | 'mainnet';

    this.storageService = new StorageService({
      packageId: config.sui.packageId,
      walrusAggregatorUrl: config.walrus.aggregator,
      walrusPublisherUrl: config.walrus.publisher,
      suiClient: this.suiClient,
      network: networkForStorage,
      epochs: config.storage?.epochs || 3,
      useUploadRelay: true,
      sealService: config.sealService,
    });

    // Initialize optional services
    if (config.features?.extractKnowledgeGraph !== false && config.geminiApiKey) {
      this.embeddingService = new EmbeddingService({
        apiKey: config.geminiApiKey,
        model: 'text-embedding-004',
        dimensions: 3072,
      });

      this.storageService.initializeSearch(this.embeddingService);

      // Initialize knowledge graph
      this.initializeGraphService();
    }

    const envType = isBrowser() ? 'browser (hnswlib-wasm)' : isNode() ? 'Node.js (hnswlib-node)' : 'unknown';
    console.log(`🚀 PDWVectorStore initializing with hybrid HNSW (${envType})`);

    // Start initialization (includes HNSW service creation)
    this.initPromise = this.initialize();
  }

  /**
   * Get vector service (waits for initialization if needed)
   */
  private async getVectorService(): Promise<IHnswService> {
    if (this.vectorService) {
      return this.vectorService;
    }
    if (this.vectorServicePromise) {
      return this.vectorServicePromise;
    }
    throw new Error('Vector service not initialized');
  }

  /**
   * Initialize the vector store (HNSW service creation, index setup)
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('🚀 Initializing PDW Vector Store...');

      // Initialize HNSW service using factory (auto-detects environment)
      // Dynamic import to avoid webpack bundling Node.js modules at build time
      const distanceMetric = this.config.distanceMetric === 'euclidean' ? 'l2' : (this.config.distanceMetric || 'cosine');

      const { createHnswService } = await import('../vector/createHnswService');
      this.vectorServicePromise = createHnswService({
        indexConfig: {
          dimension: this.config.dimensions,
          maxElements: this.config.index?.maxElements || 10000,
          efConstruction: this.config.index?.efConstruction || 200,
          m: this.config.index?.M || 16,
          spaceType: distanceMetric as 'cosine' | 'l2' | 'ip',
        },
        batchConfig: {
          maxBatchSize: this.config.features?.enableBatching !== false ? 50 : 1,
          batchDelayMs: 5000,
        }
      });

      this.vectorService = await this.vectorServicePromise;

      // Try to create or get index for user
      await this.vectorService.getOrCreateIndex(this.config.userAddress);

      this.initialized = true;
      console.log('✅ PDW Vector Store initialized');
    } catch (error) {
      console.error('❌ Failed to initialize PDW Vector Store:', error);
      throw new PDWVectorStoreError(
        'INDEX_ERROR' as any,
        'Failed to initialize vector store',
        error as Error
      );
    }
  }

  /**
   * Initialize knowledge graph service
   */
  private async initializeGraphService(): Promise<void> {
    if (!this.embeddingService) return;

    try {
      this.graphService = await this.storageService.initializeKnowledgeGraph({
        embeddingService: this.embeddingService,
      });
      console.log('✅ Knowledge graph service initialized');
    } catch (error) {
      console.warn('⚠️  Knowledge graph initialization failed (non-fatal):', error);
    }
  }

  /**
   * Wait for initialization to complete
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Add a vector with text and metadata to the store
   *
   * Performs full PDW pipeline:
   * 1. Optional: Encrypt content with SEAL
   * 2. Upload to Walrus decentralized storage
   * 3. Register on Sui blockchain
   * 4. Index vector in HNSW
   * 5. Optional: Extract knowledge graph
   *
   * @param params - Vector parameters
   * @returns Result with blob ID, transaction digest, and vector ID
   */
  async add(params: AddVectorParams): Promise<AddVectorResult> {
    await this.ensureInitialized();

    const startTime = Date.now();
    const {
      id,
      vector,
      text,
      metadata = {},
      category = 'general',
      importance = 5,
      topic = '',
    } = params;

    try {
      // Validate vector dimensions
      if (vector.length !== this.config.dimensions) {
        throw new PDWVectorStoreError(
          'VALIDATION_ERROR' as any,
          `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`
        );
      }

      // Prepare memory package
      let encryptedContent: Uint8Array | undefined;
      let isEncrypted = false;

      if (this.config.features?.encryption && this.config.sealService) {
        try {
          const textBytes = new TextEncoder().encode(text);
          const identity = `${this.config.sui.packageId}${this.config.userAddress.replace('0x', '')}`;
          const result = await this.config.sealService.encryptData({
            data: textBytes,
            id: identity,
            threshold: 2
          });
          encryptedContent = result.encryptedObject;
          isEncrypted = true;
        } catch (error) {
          console.warn('⚠️  Encryption failed, storing unencrypted:', error);
        }
      }

      // Upload to Walrus with full metadata
      const uploadResult = await this.storageService.uploadMemoryPackage(
        {
          content: text,
          embedding: vector,
          metadata: {
            id,
            category,
            importance,
            topic,
            ...metadata,
          },
          encryptedContent,
          encryptionType: isEncrypted ? 'seal-real' : undefined,
          identity: this.config.userAddress,
        },
        {
          signer: this.config.signer,
          epochs: this.config.storage?.epochs || 3,
          deletable: this.config.storage?.deletable !== false,
          metadata: {
            'vector-id': id,
            'category': category,
            'importance': importance.toString(),
            'topic': topic,
          },
        }
      );

      // Index vector
      // Generate numeric vector ID from string ID (simple hash)
      const vectorId = Math.abs(this.hashString(id));

      // Add vector to index
      const vectorService = await this.getVectorService();
      await vectorService.addVector(
        this.config.userAddress,
        vectorId,
        vector,
        metadata
      );

      // Cache the mapping
      this.vectorIdMap.set(id, {
        blobId: uploadResult.blobId,
        vectorId,
      });

      // Extract knowledge graph if enabled
      let graphExtracted = false;
      if (this.graphService && this.config.features?.extractKnowledgeGraph !== false) {
        try {
          const graphResult = await this.storageService.extractKnowledgeGraph(
            text,
            uploadResult.blobId,
            { confidenceThreshold: 0.6 }
          );

          if (graphResult.confidence > 0.5) {
            this.storageService['knowledgeGraph'].addToUserGraph(
              this.config.userAddress,
              graphResult.entities,
              graphResult.relationships,
              uploadResult.blobId
            );
            graphExtracted = true;
          }
        } catch (error) {
          console.warn('⚠️  Knowledge graph extraction failed (non-fatal):', error);
        }
      }

      const uploadTimeMs = Date.now() - startTime;

      return {
        id,
        blobId: uploadResult.blobId,
        txDigest: uploadResult.metadata.contentHash, // Using content hash as tx digest
        vectorId,
        graphExtracted,
        encrypted: isEncrypted,
        uploadTimeMs,
      };
    } catch (error) {
      throw new PDWVectorStoreError(
        'STORAGE_ERROR' as any,
        `Failed to add vector: ${error instanceof Error ? error.message : String(error)}`,
        error as Error
      );
    }
  }

  /**
   * Add multiple vectors in batch
   *
   * @param params - Batch parameters with progress callback
   * @returns Batch result with successful and failed items
   */
  async addBatch(params: AddVectorBatchParams): Promise<AddVectorBatchResult> {
    await this.ensureInitialized();

    const startTime = Date.now();
    const { vectors, onProgress } = params;
    const successful: AddVectorResult[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (let i = 0; i < vectors.length; i++) {
      const vectorParams = vectors[i];

      try {
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: vectors.length,
            stage: 'uploading',
            message: `Processing vector ${i + 1}/${vectors.length}`,
          });
        }

        const result = await this.add(vectorParams);
        successful.push(result);
      } catch (error) {
        failed.push({
          id: vectorParams.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const totalTimeMs = Date.now() - startTime;

    return {
      successful,
      failed,
      totalTimeMs,
    };
  }

  /**
   * Search for similar vectors
   *
   * @param params - Search parameters
   * @returns Array of search results sorted by similarity
   */
  async search(params: SearchParams): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const {
      vector,
      limit = 5,
      filters,
      minScore = 0,
      includeGraph = false,
      includeContent = true,
    } = params;

    try {
      // Validate query vector
      if (vector.length !== this.config.dimensions) {
        throw new PDWVectorStoreError(
          'VALIDATION_ERROR' as any,
          `Query vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`
        );
      }

      // Search HNSW index
      const vectorService = await this.getVectorService();
      const hnswResults = await vectorService.search(
        this.config.userAddress,
        vector,
        {
          k: limit * 2, // Get extra for filtering
          ef: 50,
        }
      );

      // Filter and format results
      const results: SearchResult[] = [];

      // Iterate over search results (IHnswSearchResultItem has vectorId, distance, score)
      for (const result of hnswResults) {
        const vectorId = result.vectorId;
        const distance = result.distance;
        const similarity = result.score;

        // Find the cached vector info by numeric ID
        const cachedEntry = Array.from(this.vectorIdMap.entries()).find(([_, v]) => v.vectorId === vectorId);
        if (!cachedEntry) continue;

        const [stringId, cached] = cachedEntry;

        // Calculate similarity score (0-1 scale)
        const score = similarity;

        if (score < minScore) continue;

        try {
          // Retrieve content from Walrus
          let text = '';
          let metadata: Record<string, any> = {};

          if (includeContent) {
            const memoryPackage = await this.storageService.retrieveMemoryPackage(cached.blobId);

            if (memoryPackage.storageApproach === 'json-package' && memoryPackage.memoryPackage) {
              text = memoryPackage.memoryPackage.content;
              metadata = memoryPackage.memoryPackage.metadata || {};
            } else if (memoryPackage.isEncrypted && this.config.sealService) {
              // Decrypt if encrypted
              // TODO: Implement full decryption with session keys
              console.warn('⚠️  SEAL decryption requires session keys - not yet implemented in PDWVectorStore');
              text = '[Encrypted content - decryption requires session keys]';
            }
          }

          // Apply metadata filters
          if (filters) {
            if (filters.category && !this.matchesFilter(metadata.category, filters.category)) {
              continue;
            }
            if (filters.topic && !this.matchesFilter(metadata.topic, filters.topic)) {
              continue;
            }
            if (filters.importance) {
              const imp = metadata.importance || 5;
              if (filters.importance.min && imp < filters.importance.min) continue;
              if (filters.importance.max && imp > filters.importance.max) continue;
            }
          }

          const result: SearchResult = {
            id: stringId, // Use the string ID from the cache
            text,
            metadata,
            score,
            distance,
            blobId: cached.blobId,
          };

          // Add graph data if requested
          if (includeGraph && this.graphService) {
            try {
              const graphData = await this.storageService.searchKnowledgeGraph(
                this.config.userAddress,
                { searchText: text, limit: 5 }
              );

              result.relatedEntities = graphData.entities.map(e => ({
                id: e.id,
                name: e.label, // Entity uses 'label' property
                type: e.type,
                confidence: e.confidence ?? 0, // Default to 0 if undefined
              }));

              result.relatedRelationships = graphData.relationships.map(r => ({
                source: r.source,
                target: r.target,
                type: r.type ?? 'related', // Default type if undefined
                confidence: r.confidence ?? 0, // Default to 0 if undefined
              }));
            } catch (error) {
              console.warn('⚠️  Graph retrieval failed (non-fatal):', error);
            }
          }

          results.push(result);

          if (results.length >= limit) break;
        } catch (error) {
          console.warn(`⚠️  Failed to retrieve result for vector ${vectorId}:`, error);
          continue;
        }
      }

      return results;
    } catch (error) {
      throw new PDWVectorStoreError(
        'INDEX_ERROR' as any,
        `Search failed: ${error instanceof Error ? error.message : String(error)}`,
        error as Error
      );
    }
  }

  /**
   * Get a vector by ID
   *
   * @param params - Get parameters
   * @returns Vector data with metadata
   */
  async get(params: GetVectorParams): Promise<GetVectorResult | null> {
    await this.ensureInitialized();

    const { id, includeContent = true, includeGraph = false } = params;

    try {
      const cached = this.vectorIdMap.get(id);
      if (!cached) return null;

      const memoryPackage = await this.storageService.retrieveMemoryPackage(cached.blobId);

      let text = '';
      let vector: number[] = [];
      let metadata: Record<string, any> = {};
      let encrypted = memoryPackage.isEncrypted;
      let createdAt = memoryPackage.metadata.createdTimestamp;

      if (memoryPackage.storageApproach === 'json-package' && memoryPackage.memoryPackage) {
        text = memoryPackage.memoryPackage.content;
        vector = memoryPackage.memoryPackage.embedding;
        metadata = memoryPackage.memoryPackage.metadata || {};
        createdAt = memoryPackage.memoryPackage.timestamp;
      } else if (encrypted && this.config.sealService) {
        // TODO: Implement full decryption with session keys
        console.warn('⚠️  SEAL decryption requires session keys - not yet implemented in PDWVectorStore');
        text = '[Encrypted content - decryption requires session keys]';
      }

      const result: GetVectorResult = {
        id,
        vector,
        text,
        metadata,
        blobId: cached.blobId,
        encrypted,
        createdAt,
      };

      if (includeGraph && this.graphService) {
        const graphData = await this.storageService.searchKnowledgeGraph(
          this.config.userAddress,
          { searchText: text, limit: 10 }
        );

        result.graph = {
          entities: graphData.entities.map(e => ({
            id: e.id,
            name: e.label, // Entity uses 'label' property
            type: e.type,
            confidence: e.confidence ?? 0,
          })),
          relationships: graphData.relationships.map(r => ({
            source: r.source,
            target: r.target,
            type: r.type ?? 'related',
            confidence: r.confidence ?? 0,
          })),
        };
      }

      return result;
    } catch (error) {
      throw new PDWVectorStoreError(
        'STORAGE_ERROR' as any,
        `Failed to get vector: ${error instanceof Error ? error.message : String(error)}`,
        error as Error
      );
    }
  }

  /**
   * Delete vectors by IDs
   *
   * @param params - Delete parameters
   * @returns Delete result
   */
  async delete(params: DeleteVectorParams): Promise<DeleteVectorResult> {
    await this.ensureInitialized();

    const deleted: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of params.ids) {
      try {
        // Remove from cache
        this.vectorIdMap.delete(id);

        // Note: Walrus blobs are immutable, so we just remove from index
        // In a production system, you'd mark as deleted in blockchain metadata

        deleted.push(id);
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { deleted, failed };
  }

  /**
   * Get statistics about the vector store
   *
   * @returns Store statistics
   */
  async stats(): Promise<VectorStoreStats> {
    await this.ensureInitialized();

    // Get vector count from our local mapping
    const vectorCount = this.vectorIdMap.size;

    const stats: VectorStoreStats = {
      totalVectors: vectorCount,
      storageBytes: 0, // Would need to track this
      blockchainTxCount: vectorCount, // One tx per vector
      index: {
        dimensions: this.config.dimensions,
        distanceMetric: this.config.distanceMetric || 'cosine',
        indexSize: vectorCount,
      },
    };

    if (this.graphService) {
      const graphStats = await this.storageService.getGraphStatistics(this.config.userAddress);
      stats.graph = {
        totalEntities: graphStats.totalEntities,
        totalRelationships: graphStats.totalRelationships,
        entityTypes: graphStats.entityTypes,
        relationshipTypes: graphStats.relationshipTypes,
      };
    }

    return stats;
  }

  /**
   * Helper: Hash string to numeric ID
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Helper: Check if a value matches a filter
   */
  private matchesFilter(value: any, filter: string | string[]): boolean {
    if (Array.isArray(filter)) {
      return filter.includes(value);
    }
    return value === filter;
  }
}
