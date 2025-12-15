/**
 * VectorService - Unified Vector Operations
 *
 * Consolidated service combining embedding generation and HNSW indexing
 * with smart caching and Walrus persistence.
 *
 * Uses hybrid HNSW implementation:
 * - Browser: hnswlib-wasm
 * - Node.js: hnswlib-node
 *
 * Replaces: HnswIndexService + VectorManager
 */

import { createHnswService, isBrowser, isNode } from '../vector/createHnswService';
import type { IHnswService, HnswServiceConfig } from '../vector/IHnswService';
import { EmbeddingService } from './EmbeddingService';
import { StorageService } from './StorageService';
import {
  VectorEmbedding,
  EmbeddingConfig,
  HNSWIndexConfig,
  BatchConfig,
  VectorSearchOptions,
  VectorSearchResult
} from '../embedding/types';
import type { MemoryMetadata } from './StorageService';

// Local VectorError class implementation
class VectorErrorImpl extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorError';
  }
}

export interface VectorServiceConfig {
  embedding: EmbeddingConfig;
  index?: Partial<HNSWIndexConfig>;
  batch?: Partial<BatchConfig>;
  enableAutoIndex?: boolean;
  enableMemoryCache?: boolean;
}

interface IndexCacheEntry {
  lastModified: Date;
  pendingVectors: Map<number, number[]>;
  isDirty: boolean;
  version: number;
  metadata: Map<number, any>;
  /** Cached vectors for serialization (vectorId -> vector) */
  vectors: Map<number, number[]>;
}

/**
 * VectorService provides unified vector operations including:
 * - Embedding generation via EmbeddingService
 * - HNSW vector indexing and search (hybrid: hnswlib-wasm for browser, hnswlib-node for Node.js)
 * - Intelligent batching and caching
 * - Persistence via Walrus storage
 */
export class VectorService {
  private embeddingService: EmbeddingService;
  private storageService: StorageService;
  private indexCache: Map<string, IndexCacheEntry> = new Map();
  private hnswService: IHnswService | null = null;
  private hnswServicePromise: Promise<IHnswService> | null = null;

  constructor(
    private config: VectorServiceConfig,
    embeddingService?: EmbeddingService,
    storageService?: StorageService
  ) {
    this.embeddingService = embeddingService || new EmbeddingService(config.embedding);
    this.storageService = storageService || new StorageService({ packageId: '' }); // Will be properly configured

    const envType = isBrowser() ? 'browser (hnswlib-wasm)' : isNode() ? 'Node.js (hnswlib-node)' : 'unknown';
    console.log(`✅ VectorService initializing with hybrid HNSW (${envType})`);
  }

  /**
   * Get the HNSW service, initializing it if needed
   */
  private async getHnswService(): Promise<IHnswService> {
    if (this.hnswService) {
      return this.hnswService;
    }
    if (this.hnswServicePromise) {
      return this.hnswServicePromise;
    }
    throw new VectorErrorImpl('HNSW service not initialized. Call initialize() first.');
  }

  /**
   * Initialize the HNSW service (must be called before using any index operations)
   */
  async initialize(): Promise<void> {
    if (this.hnswService) {
      return; // Already initialized
    }

    if (this.hnswServicePromise) {
      await this.hnswServicePromise;
      return;
    }

    this.hnswServicePromise = createHnswService({
      indexConfig: {
        dimension: this.config.index?.dimension || 3072,
        maxElements: this.config.index?.maxElements || 10000,
        efConstruction: this.config.index?.efConstruction || 200,
        m: this.config.index?.m || 16
      },
      batchConfig: this.config.batch
    });

    try {
      this.hnswService = await this.hnswServicePromise;
      console.log('✅ VectorService HNSW service initialized successfully');
    } catch (error) {
      this.hnswServicePromise = null;
      console.error('❌ Failed to initialize VectorService HNSW service:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for text content
   */
  async generateEmbedding(text: string): Promise<VectorEmbedding> {
    const result = await this.embeddingService.embedText({ text });
    return {
      vector: result.vector,
      dimension: result.dimension,
      model: result.model
    };
  }

  /**
   * Create or get HNSW index for a specific space
   */
  async createIndex(spaceId: string, dimension?: number, config?: Partial<HNSWIndexConfig>): Promise<void> {
    await this.initialize();
    const hnswService = await this.getHnswService();

    // Use IHnswService.getOrCreateIndex to create the index
    await hnswService.getOrCreateIndex(spaceId);

    // Initialize local cache entry for metadata tracking
    if (!this.indexCache.has(spaceId)) {
      this.indexCache.set(spaceId, {
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: false,
        version: 1,
        metadata: new Map(),
        vectors: new Map()
      });
    }
  }

  /**
   * Add vector to index
   */
  async addVector(spaceId: string, vectorId: number, vector: number[], metadata?: any): Promise<void> {
    const hnswService = await this.getHnswService();

    // Add to HNSW index
    await hnswService.addVector(spaceId, vectorId, vector, metadata);

    // Update local cache entry for metadata tracking
    let entry = this.indexCache.get(spaceId);
    if (!entry) {
      entry = {
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: true,
        version: 1,
        metadata: new Map(),
        vectors: new Map()
      };
      this.indexCache.set(spaceId, entry);
    }

    if (metadata) {
      entry.metadata.set(vectorId, metadata);
    }
    // Cache vector for serialization
    entry.vectors.set(vectorId, vector);
    entry.isDirty = true;
    entry.lastModified = new Date();
  }

  /**
   * Get cached vector by ID
   */
  getVector(spaceId: string, vectorId: number): number[] | undefined {
    const entry = this.indexCache.get(spaceId);
    return entry?.vectors.get(vectorId);
  }

  /**
   * Get all cached vectors
   */
  getAllCachedVectors(spaceId: string): Map<number, number[]> {
    const entry = this.indexCache.get(spaceId);
    return entry?.vectors || new Map();
  }

  /**
   * Search vectors in index
   */
  async searchVectors(
    spaceId: string,
    queryVector: number[],
    options?: Partial<VectorSearchOptions>
  ): Promise<VectorSearchResult> {
    const hnswService = await this.getHnswService();
    const entry = this.indexCache.get(spaceId);

    const k = options?.k || 10;
    const startTime = performance.now();

    // Use IHnswService.search
    const searchResults = await hnswService.search(spaceId, queryVector, {
      k,
      ef: options?.efSearch || 50
    });

    const searchTime = performance.now() - startTime;

    // Get metadata from local cache
    return {
      results: searchResults.map((result) => ({
        memoryId: result.vectorId.toString(),
        vectorId: result.vectorId,
        similarity: result.score,
        distance: result.distance,
        metadata: entry?.metadata.get(result.vectorId) || result.metadata
      })),
      searchStats: {
        searchTime,
        nodesVisited: searchResults.length,
        exactMatches: searchResults.length,
        approximateMatches: 0,
        cacheHits: 0,
        indexSize: 0 // TODO: Get from IHnswService
      }
    };
  }

  /**
   * Save index to Walrus storage
   */
  async saveIndex(spaceId: string): Promise<string> {
    const hnswService = await this.getHnswService();
    const entry = this.indexCache.get(spaceId);

    // Use IHnswService.saveIndex to save the index
    await hnswService.saveIndex(spaceId);

    // Also save metadata to Walrus for persistence
    if (entry) {
      const indexData = {
        spaceId,
        version: entry.version,
        metadata: Array.from(entry.metadata.entries()),
        vectors: Array.from(entry.vectors.entries()),
        lastModified: entry.lastModified.toISOString()
      };

      const serializedData = JSON.stringify(indexData);
      const metadata: MemoryMetadata = {
        contentType: 'application/json',
        contentSize: serializedData.length,
        contentHash: '',
        category: 'vector-index',
        topic: spaceId,
        importance: 8,
        embeddingDimension: 3072,
        createdTimestamp: Date.now(),
        customMetadata: {
          type: 'hnsw-index',
          spaceId,
          version: entry.version.toString()
        }
      };

      const result = await this.storageService.upload(serializedData, metadata);
      entry.isDirty = false;
      return result.blobId;
    }

    return '';
  }

  /**
   * Load index from persistent storage or Walrus
   * @param spaceId - Index space identifier
   * @param blobId - Optional blob ID for Walrus storage (if provided, loads metadata from Walrus)
   */
  async loadIndex(spaceId: string, blobId?: string): Promise<void> {
    const hnswService = await this.getHnswService();

    // Load the HNSW index using IHnswService (from local IndexedDB/filesystem)
    await hnswService.loadIndex(spaceId);

    // If blobId provided, also load metadata from Walrus
    if (blobId) {
      try {
        const result = await this.storageService.retrieve(blobId);
        const indexData = JSON.parse(new TextDecoder().decode(result.content));

        // Initialize or update local cache entry
        const entry = this.indexCache.get(spaceId) || {
          lastModified: new Date(),
          pendingVectors: new Map(),
          isDirty: false,
          version: 1,
          metadata: new Map(),
          vectors: new Map()
        };

        entry.version = indexData.version || 1;
        entry.metadata = new Map(indexData.metadata || []);
        entry.vectors = new Map(indexData.vectors || []);
        entry.lastModified = new Date(indexData.lastModified || Date.now());
        entry.isDirty = false;

        this.indexCache.set(spaceId, entry);

        // Re-add vectors to HNSW index from cached vectors
        for (const [vectorId, vector] of entry.vectors.entries()) {
          await hnswService.addVector(spaceId, vectorId, vector, entry.metadata.get(vectorId));
        }
      } catch (error) {
        console.warn(`Failed to load metadata from Walrus for ${blobId}:`, error);
        // Index is still loaded via IHnswService, just without local metadata
      }
    }
  }

  /**
   * Process text to vector pipeline
   */
  async processText(spaceId: string, text: string, vectorId: number, metadata?: any): Promise<VectorEmbedding> {
    // Generate embedding
    const embedding = await this.generateEmbedding(text);
    
    // Add to index
    await this.addVector(spaceId, vectorId, embedding.vector, metadata);
    
    return embedding;
  }

  /**
   * Search by text query
   */
  async searchByText(
    spaceId: string, 
    query: string, 
    options?: Partial<VectorSearchOptions>
  ): Promise<VectorSearchResult> {
    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);
    
    // Search vectors
    return await this.searchVectors(spaceId, queryEmbedding.vector, options);
  }

  /**
   * Get index statistics
   */
  getIndexStats(spaceId: string): any {
    const entry = this.indexCache.get(spaceId);
    if (!entry) {
      return null;
    }

    return {
      spaceId,
      version: entry.version,
      currentElements: entry.metadata.size,
      maxElements: this.config.index?.maxElements || 10000,
      isDirty: entry.isDirty,
      lastModified: entry.lastModified,
      metadataCount: entry.metadata.size,
      vectorCount: entry.vectors.size
    };
  }

  /**
   * Get all vectors matching a category filter
   *
   * @param spaceId - Index space identifier
   * @param category - Category to filter by
   * @returns Array of metadata objects matching the category
   */
  getVectorsByCategory(spaceId: string, category: string): Array<{ vectorId: number; metadata: any }> {
    const entry = this.indexCache.get(spaceId);
    if (!entry) {
      return [];
    }

    const results: Array<{ vectorId: number; metadata: any }> = [];
    for (const [vectorId, metadata] of entry.metadata.entries()) {
      if (metadata?.category === category) {
        results.push({ vectorId, metadata });
      }
    }
    return results;
  }

  /**
   * Get all vectors with their metadata
   *
   * @param spaceId - Index space identifier
   * @returns Array of all vectors with metadata
   */
  getAllVectors(spaceId: string): Array<{ vectorId: number; metadata: any }> {
    const entry = this.indexCache.get(spaceId);
    if (!entry) {
      return [];
    }

    const results: Array<{ vectorId: number; metadata: any }> = [];
    for (const [vectorId, metadata] of entry.metadata.entries()) {
      results.push({ vectorId, metadata });
    }
    return results;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Save all dirty indices
    for (const [spaceId, entry] of this.indexCache.entries()) {
      if (entry.isDirty) {
        await this.saveIndex(spaceId);
      }
    }

    // Destroy HNSW service
    if (this.hnswService) {
      this.hnswService.destroy();
      this.hnswService = null;
      this.hnswServicePromise = null;
    }

    this.indexCache.clear();
  }
}
