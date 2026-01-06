/**
 * HnswWasmService - Browser-Compatible HNSW Vector Indexing
 *
 * Provides browser-compatible Hierarchical Navigable Small World (HNSW) vector indexing
 * using hnswlib-wasm with IndexedDB persistence. Replaces Node.js-only hnswlib-node.
 *
 * Key Features:
 * - ✅ Runs in browsers (WebAssembly)
 * - ✅ IndexedDB persistence (no filesystem needed)
 * - ✅ Intelligent batching and caching
 * - ✅ Walrus storage integration
 * - ✅ Near-native performance via WASM
 * - ✅ Safe for Node.js/SSR (uses dynamic import)
 * - ✅ LRU cache with memory limits to prevent OOM
 */

// Dynamic import for hnswlib-wasm to avoid bundling issues in Node.js
// Types defined locally to avoid static import issues
type HierarchicalNSW = any;
type HnswlibModule = any;

/**
 * Helper to dynamically load hnswlib-wasm (browser only)
 */
async function loadHnswlibDynamic(): Promise<HnswlibModule> {
  const module = await import('hnswlib-wasm/dist/hnswlib.js');
  return module.loadHnswlib();
}
import { StorageService, type MemoryMetadata } from '../services/StorageService';
import {
  HNSWIndexConfig,
  HNSWSearchResult,
  HNSWSearchOptions,
  BatchConfig,
  BatchJob,
  BatchStats,
  VectorError
} from '../embedding/types';
import { LRUCache, estimateIndexCacheSize } from '../utils/LRUCache';

interface IndexCacheEntry {
  index: HierarchicalNSW;
  lastModified: Date;
  pendingVectors: Map<number, number[]>; // vectorId -> vector
  isDirty: boolean;
  version: number;
  metadata: Map<number, any>; // vectorId -> metadata
  dimensions: number;
  /** Cached vectors for serialization - only store if needed */
  vectors: Map<number, number[]>;
}

interface IndexMetadata {
  dimension: number;
  maxElements: number;
  efConstruction: number;
  m: number;
  spaceType: string;
  version: number;
  createdAt: Date;
  lastUpdated: Date;
}

// Memory management constants
const DEFAULT_MAX_CACHED_INDEXES = 5; // Max number of user indexes to keep in memory
const DEFAULT_INDEX_TTL_MS = 10 * 60 * 1000; // 10 minutes TTL for idle indexes
const DEFAULT_MAX_MEMORY_MB = 512; // 512MB max memory for index cache
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000; // Check every 1 minute

/**
 * Browser-compatible HNSW vector indexing service using WebAssembly
 * Drop-in replacement for HnswIndexService with identical API
 *
 * Memory Management:
 * - LRU cache limits number of indexes in memory (default: 5)
 * - TTL-based expiration for idle indexes (default: 10 minutes)
 * - Optional memory limit (default: 512MB)
 * - Automatic cleanup of expired/evicted indexes
 */
export class HnswWasmService {
  private hnswlib: HnswlibModule | null = null;
  private readonly indexCache: LRUCache<IndexCacheEntry>;
  private readonly batchJobs = new Map<string, BatchJob>();
  private readonly config: Required<BatchConfig>;
  private readonly indexConfig: Required<HNSWIndexConfig>;
  private batchProcessor?: ReturnType<typeof setInterval>;
  private initPromise: Promise<void> | null = null;

  // Memory management settings
  private readonly maxCachedIndexes: number;
  private readonly indexTtlMs: number;
  private readonly maxMemoryBytes: number;

  constructor(
    private storageService: StorageService,
    indexConfig: Partial<HNSWIndexConfig> = {},
    batchConfig: Partial<BatchConfig> = {},
    memoryConfig?: {
      maxCachedIndexes?: number;
      indexTtlMs?: number;
      maxMemoryMB?: number;
    }
  ) {
    // Default HNSW configuration (matching HnswIndexService)
    this.indexConfig = {
      dimension: indexConfig.dimension || 3072,
      maxElements: indexConfig.maxElements || 10000,
      efConstruction: indexConfig.efConstruction || 200,
      m: indexConfig.m || 16,
      randomSeed: indexConfig.randomSeed || 42,
      spaceType: indexConfig.spaceType || 'cosine'
    };

    // Default batch configuration
    this.config = {
      maxBatchSize: batchConfig.maxBatchSize || 50,
      batchDelayMs: batchConfig.batchDelayMs || 5000,
      maxCacheSize: batchConfig.maxCacheSize || 100,
      cacheTtlMs: batchConfig.cacheTtlMs || 30 * 60 * 1000 // 30 minutes
    };

    // Memory management configuration
    this.maxCachedIndexes = memoryConfig?.maxCachedIndexes ?? DEFAULT_MAX_CACHED_INDEXES;
    this.indexTtlMs = memoryConfig?.indexTtlMs ?? DEFAULT_INDEX_TTL_MS;
    this.maxMemoryBytes = (memoryConfig?.maxMemoryMB ?? DEFAULT_MAX_MEMORY_MB) * 1024 * 1024;

    // Initialize LRU cache with memory limits
    this.indexCache = new LRUCache<IndexCacheEntry>({
      maxSize: this.maxCachedIndexes,
      ttlMs: this.indexTtlMs,
      cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
      maxMemoryBytes: this.maxMemoryBytes,
      sizeEstimator: (entry) => estimateIndexCacheSize({
        vectors: entry.vectors || new Map(),
        metadata: entry.metadata,
        pendingVectors: entry.pendingVectors,
      }),
      onEvict: (userAddress, entry, reason) => {
        console.log(`🧹 [HnswWasmService] Evicting index for ${userAddress} (reason: ${reason})`);
        // Dispose WASM resources
        if (entry.index) {
          try {
            if (typeof entry.index.free === 'function') {
              entry.index.free();
            }
          } catch (e) {
            // Ignore cleanup errors
          }
        }
        // Remove associated batch job
        this.batchJobs.delete(userAddress);
      },
    });

    console.log(`✅ HnswWasmService initialized with memory limits:`);
    console.log(`   Max indexes: ${this.maxCachedIndexes}, TTL: ${this.indexTtlMs / 1000}s, Max memory: ${this.maxMemoryBytes / 1024 / 1024}MB`);

    // Initialize WASM library asynchronously
    this.initPromise = this.initialize();
  }

  /**
   * Initialize hnswlib-wasm (must be called before use)
   */
  private async initialize(): Promise<void> {
    try {
      console.log('🔧 Loading hnswlib-wasm...');
      this.hnswlib = await loadHnswlibDynamic();
      console.log('✅ hnswlib-wasm loaded successfully');

      // Start batch processor (cache cleanup is handled by LRUCache)
      this.startBatchProcessor();
    } catch (error) {
      console.error('❌ Failed to load hnswlib-wasm:', error);
      throw error;
    }
  }

  /**
   * Ensure WASM library is loaded
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (!this.hnswlib) {
      throw new Error('hnswlib-wasm not initialized');
    }
  }

  /**
   * Create a new HNSW index
   */
  async createIndex(
    userAddress: string,
    options: Partial<HNSWIndexConfig> = {}
  ): Promise<{ index: HierarchicalNSW; serialized: Uint8Array }> {
    await this.ensureInitialized();

    try {
      const config = { ...this.indexConfig, ...options };

      console.log(`🔨 Creating new HNSW index for user ${userAddress}`);
      console.log(`   Dimensions: ${config.dimension}, M: ${config.m}, efConstruction: ${config.efConstruction}`);
      console.log(`   Cache stats: ${this.indexCache.size}/${this.maxCachedIndexes} indexes, ${(this.indexCache.memoryBytes / 1024 / 1024).toFixed(1)}MB`);

      // Create a new index using WASM (constructor takes: spaceName, numDimensions, autoSaveFilename)
      const index = new this.hnswlib!.HierarchicalNSW(config.spaceType, config.dimension, '');
      index.initIndex(config.maxElements, config.m, config.efConstruction, config.randomSeed);

      // Create cache entry (LRU cache handles eviction automatically)
      this.indexCache.set(userAddress, {
        index,
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: false,
        version: 1,
        metadata: new Map(),
        dimensions: config.dimension,
        vectors: new Map(),
      });

      // Serialize the empty index
      const indexName = `index_${userAddress}_${Date.now()}`;
      await index.writeIndex(indexName);

      // Sync to IndexedDB (persist the index) - syncFS requires a callback
      await this.hnswlib!.EmscriptenFileSystemManager.syncFS(false, () => {});

      // Read serialized data from filesystem for returning
      const serialized = new Uint8Array(0); // Placeholder - actual data is in IndexedDB

      console.log(`✅ Index created successfully for ${userAddress}`);

      return { index, serialized };
    } catch (error) {
      throw this.createVectorError('INDEX_ERROR', `Failed to create index: ${error}`, error);
    }
  }

  /**
   * Add vector to index with batching (main entry point)
   */
  addVectorToIndexBatched(
    userAddress: string,
    vectorId: number,
    vector: number[],
    metadata?: any
  ): void {
    try {
      // Validate input
      this.validateVector(vector);

      // Get or create cache entry (LRU cache will evict old entries if needed)
      let cacheEntry = this.indexCache.get(userAddress);
      if (!cacheEntry) {
        console.warn(`No cached index found for user ${userAddress}, will create on first flush`);
        // Create placeholder entry - actual index created on first flush
        cacheEntry = {
          index: null as any, // Will be created on flush
          lastModified: new Date(),
          pendingVectors: new Map(),
          isDirty: true,
          version: 1,
          metadata: new Map(),
          dimensions: vector.length,
          vectors: new Map(),
        };
        this.indexCache.set(userAddress, cacheEntry);
      }

      // Validate vector dimensions
      if (cacheEntry.dimensions && vector.length !== cacheEntry.dimensions) {
        throw new Error(`Vector dimension mismatch: expected ${cacheEntry.dimensions}, got ${vector.length}`);
      }

      // Add to pending queue
      cacheEntry.pendingVectors.set(vectorId, vector);
      if (metadata) {
        cacheEntry.metadata.set(vectorId, metadata);
      }
      // Also cache the vector for serialization
      cacheEntry.vectors.set(vectorId, vector);
      cacheEntry.isDirty = true;
      cacheEntry.lastModified = new Date();

      // Schedule or update batch job
      this.scheduleBatchJob(userAddress, vectorId, vector);

      console.debug(`📊 Vector ${vectorId} queued for batch processing. Pending: ${cacheEntry.pendingVectors.size}`);

      // Process immediately if batch size limit reached
      if (cacheEntry.pendingVectors.size >= this.config.maxBatchSize) {
        console.log(`⚡ Batch size limit reached (${this.config.maxBatchSize}), processing immediately`);
        setTimeout(() => this.flushPendingVectors(userAddress), 0);
      }
    } catch (error) {
      throw this.createVectorError('INDEX_ERROR', `Failed to queue vector: ${error}`, error);
    }
  }

  /**
   * Search vectors in the index (including pending vectors)
   */
  async searchVectors(
    userAddress: string,
    queryVector: number[],
    options: HNSWSearchOptions = {}
  ): Promise<HNSWSearchResult> {
    await this.ensureInitialized();

    try {
      this.validateVector(queryVector);

      const cacheEntry = this.indexCache.get(userAddress);
      if (!cacheEntry?.index) {
        throw new Error(`No index found for user ${userAddress}`);
      }

      const { k = 10, efSearch = 50, filter } = options;

      // Set search parameters
      cacheEntry.index.setEfSearch(efSearch);

      let searchIndex = cacheEntry.index;

      // If there are pending vectors, flush them first
      if (cacheEntry.pendingVectors.size > 0) {
        console.log(`⏳ Flushing ${cacheEntry.pendingVectors.size} pending vectors before search`);
        await this.flushPendingVectors(userAddress);
        // Get updated index
        const updatedEntry = this.indexCache.get(userAddress);
        if (updatedEntry?.index) {
          searchIndex = updatedEntry.index;
        }
      }

      // Perform search (convert to Float32Array if needed)
      const queryFloat32 = queryVector instanceof Float32Array
        ? queryVector
        : new Float32Array(queryVector);
      const result = searchIndex.searchKnn(
        queryFloat32,
        k,
        filter && typeof filter === 'function' ? (filter as (label: number) => boolean) : undefined
      );

      // Apply metadata filter if provided (additional filtering)
      let filteredIds = result.neighbors;
      let filteredDistances = result.distances;

      if (filter && typeof filter === 'function') {
        const filtered = this.applyMetadataFilter(
          result.neighbors,
          result.distances,
          cacheEntry.metadata,
          filter as (metadata: any) => boolean
        );
        filteredIds = filtered.ids;
        filteredDistances = filtered.distances;
      }

      // Convert distances to similarities (for cosine distance)
      const similarities = this.indexConfig.spaceType === 'cosine'
        ? filteredDistances.map((dist: number) => 1 - dist)
        : filteredDistances.map((dist: number) => 1 / (1 + dist));

      console.log(`🔍 Search completed: ${filteredIds.length} results found`);

      return {
        ids: filteredIds,
        distances: filteredDistances,
        similarities
      };
    } catch (error) {
      throw this.createVectorError('SEARCH_ERROR', `Search failed: ${error}`, error);
    }
  }

  /**
   * Load index from Walrus storage
   */
  async loadIndex(blobId: string, userAddress: string): Promise<HierarchicalNSW> {
    await this.ensureInitialized();

    try {
      console.log(`📥 Loading HNSW index from Walrus: ${blobId}`);

      // Download index from Walrus
      const retrieveResult = await this.storageService.retrieve(blobId);
      const indexBuffer = retrieveResult.content;

      // Save to Emscripten virtual filesystem
      const indexName = `index_${userAddress}_${Date.now()}`;
      (this.hnswlib!.EmscriptenFileSystemManager as any).writeFile(indexName, indexBuffer);

      // Sync from IndexedDB (load the data into memory)
      await this.hnswlib!.EmscriptenFileSystemManager.syncFS(true, () => {});

      // Create and load index (constructor: spaceName, numDimensions, autoSaveFilename)
      const index = new this.hnswlib!.HierarchicalNSW(this.indexConfig.spaceType, this.indexConfig.dimension, '');
      await index.readIndex(indexName, this.indexConfig.maxElements);

      // Cache the loaded index
      this.indexCache.set(userAddress, {
        index,
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: false,
        version: 1,
        metadata: new Map(),
        dimensions: this.indexConfig.dimension,
        vectors: new Map(),
      });

      console.log(`✅ Index loaded successfully for ${userAddress}`);
      return index;
    } catch (error) {
      throw this.createVectorError('STORAGE_ERROR', `Failed to load index: ${error}`, error);
    }
  }

  /**
   * Save index to Walrus storage
   */
  async saveIndex(userAddress: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const cacheEntry = this.indexCache.get(userAddress);
      if (!cacheEntry?.index) {
        throw new Error(`No index found for user ${userAddress}`);
      }

      console.log(`💾 Saving index to Walrus for ${userAddress}`);

      return await this.saveIndexToWalrus(cacheEntry.index, userAddress);
    } catch (error) {
      throw this.createVectorError('STORAGE_ERROR', `Failed to save index: ${error}`, error);
    }
  }

  /**
   * Force flush all pending vectors for a user
   */
  async forceFlush(userAddress: string): Promise<void> {
    await this.flushPendingVectors(userAddress);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): BatchStats & {
    memoryUsageMB: number;
    maxMemoryMB: number;
    maxCachedIndexes: number;
  } {
    let totalPendingVectors = 0;

    for (const [, entry] of this.indexCache.entries()) {
      totalPendingVectors += entry.pendingVectors.size;
    }

    const lruStats = this.indexCache.getStats();

    return {
      totalUsers: this.indexCache.size,
      totalPendingVectors,
      activeBatchJobs: this.batchJobs.size,
      cacheHitRate: 0, // TODO: Implement hit rate tracking
      averageBatchSize: totalPendingVectors / Math.max(1, this.indexCache.size),
      averageProcessingTime: 0, // TODO: Implement timing tracking
      memoryUsageMB: lruStats.memoryBytes / 1024 / 1024,
      maxMemoryMB: this.maxMemoryBytes / 1024 / 1024,
      maxCachedIndexes: this.maxCachedIndexes,
    };
  }

  /**
   * Remove a vector from the index
   */
  removeVector(userAddress: string, vectorId: number): void {
    try {
      const cacheEntry = this.indexCache.get(userAddress);
      if (!cacheEntry?.index) {
        throw new Error(`No index found for user ${userAddress}`);
      }

      // Remove from pending vectors if exists
      cacheEntry.pendingVectors.delete(vectorId);
      cacheEntry.metadata.delete(vectorId);

      // Note: hnswlib-wasm doesn't support deletion, mark for rebuild
      cacheEntry.isDirty = true;
      cacheEntry.lastModified = new Date();

      console.log(`🗑️ Vector ${vectorId} removed from index`);
    } catch (error) {
      throw this.createVectorError('INDEX_ERROR', `Failed to remove vector: ${error}`, error);
    }
  }

  /**
   * Clear user index and cache
   */
  clearUserIndex(userAddress: string): void {
    this.indexCache.delete(userAddress);
    this.batchJobs.delete(userAddress);
    console.log(`🧹 Cleared index cache for user ${userAddress}`);
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.batchProcessor) {
      clearInterval(this.batchProcessor);
    }
    // LRU cache cleanup is handled internally, but we should destroy it
    this.indexCache.destroy();
    this.batchJobs.clear();
    console.log('🛑 HnswWasmService destroyed');
  }

  // ==================== PRIVATE METHODS ====================

  private async createCacheEntry(dimensions: number): Promise<IndexCacheEntry> {
    await this.ensureInitialized();

    const index = new this.hnswlib!.HierarchicalNSW(this.indexConfig.spaceType, dimensions, '');
    index.initIndex(this.indexConfig.maxElements, this.indexConfig.m, this.indexConfig.efConstruction, this.indexConfig.randomSeed);

    return {
      index,
      lastModified: new Date(),
      pendingVectors: new Map(),
      isDirty: false,
      version: 1,
      metadata: new Map(),
      dimensions,
      vectors: new Map(),
    };
  }

  private scheduleBatchJob(userAddress: string, vectorId: number, vector: number[]): void {
    let batchJob = this.batchJobs.get(userAddress);
    if (!batchJob) {
      batchJob = {
        userAddress,
        vectors: new Map(),
        scheduledAt: new Date()
      };
      this.batchJobs.set(userAddress, batchJob);
    }

    batchJob.vectors.set(vectorId, vector);
  }

  private startBatchProcessor(): void {
    this.batchProcessor = setInterval(async () => {
      await this.processBatchJobs();
    }, this.config.batchDelayMs);
  }

  // Note: Cache cleanup is now handled by LRUCache internally

  private async processBatchJobs(): Promise<void> {
    const now = Date.now();
    const jobsToProcess: string[] = [];

    for (const [userAddress, job] of this.batchJobs.entries()) {
      const timeSinceScheduled = now - job.scheduledAt.getTime();
      const cacheEntry = this.indexCache.get(userAddress);

      if (timeSinceScheduled >= this.config.batchDelayMs ||
          (cacheEntry && cacheEntry.pendingVectors.size >= this.config.maxBatchSize)) {
        jobsToProcess.push(userAddress);
      }
    }

    for (const userAddress of jobsToProcess) {
      try {
        await this.flushPendingVectors(userAddress);
      } catch (error) {
        console.error(`❌ Error processing batch job for user ${userAddress}:`, error);
      }
    }
  }

  private async flushPendingVectors(userAddress: string): Promise<void> {
    await this.ensureInitialized();

    const cacheEntry = this.indexCache.get(userAddress);
    if (!cacheEntry || cacheEntry.pendingVectors.size === 0) {
      return;
    }

    console.log(`⚡ Flushing ${cacheEntry.pendingVectors.size} pending vectors for user ${userAddress}`);

    try {
      // Create index if it doesn't exist
      if (!cacheEntry.index) {
        const newEntry = await this.createCacheEntry(cacheEntry.dimensions);
        cacheEntry.index = newEntry.index;
      }

      // Prepare vectors array for batch insertion
      const vectors: number[][] = [];
      const labels: number[] = [];

      for (const [vectorId, vector] of cacheEntry.pendingVectors.entries()) {
        vectors.push(vector);
        labels.push(vectorId);
      }

      // Add all pending vectors to the index in batch
      if (vectors.length > 0) {
        // Convert to Float32Array[] as required by hnswlib-wasm
        const float32Vectors = vectors.map(v =>
          v instanceof Float32Array ? v : new Float32Array(v)
        );
        cacheEntry.index.addItems(float32Vectors, true);
      }

      // Save to Walrus
      await this.saveIndexToWalrus(cacheEntry.index, userAddress);

      // Clear pending vectors
      cacheEntry.pendingVectors.clear();
      cacheEntry.isDirty = false;
      cacheEntry.lastModified = new Date();
      cacheEntry.version++;

      // Remove batch job
      this.batchJobs.delete(userAddress);

      console.log(`✅ Successfully flushed vectors for user ${userAddress} (version ${cacheEntry.version})`);
    } catch (error) {
      console.error(`❌ Error flushing vectors for user ${userAddress}:`, error);
      throw error;
    }
  }

  private async saveIndexToWalrus(index: HierarchicalNSW, userAddress: string): Promise<string> {
    await this.ensureInitialized();

    try {
      // Serialize index to Emscripten filesystem
      const indexName = `index_${userAddress}_${Date.now()}`;
      await index.writeIndex(indexName);

      // Sync to IndexedDB
      await this.hnswlib!.EmscriptenFileSystemManager.syncFS(false, () => {});

      // Read serialized data from filesystem
      const serialized = (this.hnswlib!.EmscriptenFileSystemManager as any).readFile(indexName) as Uint8Array;

      // Upload to Walrus via StorageService
      const metadata: MemoryMetadata = {
        contentType: 'application/hnsw-index-wasm',
        contentSize: serialized.byteLength,
        contentHash: '', // TODO: Calculate hash
        category: 'vector-index',
        topic: 'hnsw-wasm',
        importance: 8,
        embeddingDimension: this.indexConfig.dimension,
        createdTimestamp: Date.now(),
        customMetadata: {
          'user-address': userAddress,
          'version': '1.0',
          'wasm': 'true'
        }
      };

      const result = await this.storageService.upload(serialized, metadata);

      console.log(`💾 Index saved to Walrus: ${result.blobId}`);
      return result.blobId;
    } catch (error) {
      console.error('❌ Failed to save index to Walrus:', error);
      throw error;
    }
  }

  private applyMetadataFilter(
    ids: number[],
    distances: number[],
    metadata: Map<number, any>,
    filter: (metadata: any) => boolean
  ): { ids: number[]; distances: number[] } {
    const filteredIds: number[] = [];
    const filteredDistances: number[] = [];

    for (let i = 0; i < ids.length; i++) {
      const vectorId = ids[i];
      const vectorMetadata = metadata.get(vectorId);

      if (!vectorMetadata || filter(vectorMetadata)) {
        filteredIds.push(vectorId);
        filteredDistances.push(distances[i]);
      }
    }

    return { ids: filteredIds, distances: filteredDistances };
  }

  // Note: cleanupCache is now handled by LRUCache internally

  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Vector must be a non-empty array');
    }

    if (vector.some(v => typeof v !== 'number' || !isFinite(v))) {
      throw new Error('Vector must contain only finite numbers');
    }

    if (vector.length !== this.indexConfig.dimension) {
      throw new Error(`Vector dimension mismatch: expected ${this.indexConfig.dimension}, got ${vector.length}`);
    }
  }

  private createVectorError(code: VectorError['code'], message: string, details?: any): VectorError {
    const error = new Error(message) as VectorError;
    error.code = code;
    error.details = details;
    return error;
  }
}

export default HnswWasmService;
