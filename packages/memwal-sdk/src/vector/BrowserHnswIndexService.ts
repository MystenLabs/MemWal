/**
 * BrowserHnswIndexService - Client-Side HNSW Vector Indexing
 *
 * Browser-compatible HNSW vector indexing with IndexedDB persistence.
 * Uses hnswlib-wasm for WASM-based vector search (10-50x faster than pure JS).
 *
 * Features:
 * - WASM-powered HNSW algorithm for fast vector search
 * - IndexedDB persistence (survives page refresh)
 * - Intelligent batching and caching
 * - Metadata filtering support
 * - Zero backend dependencies
 */

import type {
  HNSWIndexConfig,
  HNSWSearchResult,
  HNSWSearchOptions,
  BatchConfig,
  BatchStats,
  VectorError
} from '../embedding/types';

interface IndexCacheEntry {
  index: any; // hnswlib-wasm HierarchicalNSW instance
  lastModified: Date;
  pendingVectors: Map<number, number[]>;
  isDirty: boolean;
  version: number;
  metadata: Map<number, any>;
}

interface IndexedDBSchema {
  indices: {
    key: string; // userAddress
    value: {
      userAddress: string;
      indexData: ArrayBuffer; // Serialized HNSW index
      metadata: Record<string, any>;
      version: number;
      lastUpdated: number;
    };
  };
  vectors: {
    key: [string, number]; // [userAddress, vectorId]
    value: {
      userAddress: string;
      vectorId: number;
      vector: number[];
      metadata: any;
      timestamp: number;
    };
  };
}

/**
 * Browser-compatible HNSW vector indexing service with IndexedDB persistence
 */
export class BrowserHnswIndexService {
  private readonly indexCache = new Map<string, IndexCacheEntry>();
  private readonly batchJobs = new Map<string, any>();
  private readonly config: Required<BatchConfig>;
  private readonly indexConfig: Required<HNSWIndexConfig>;
  private batchProcessor?: number;
  private cacheCleanup?: number;
  private db?: IDBDatabase;
  private hnswLib?: any; // Will be loaded dynamically

  // Debug mode - enable with DEBUG_HNSW=true in environment
  private readonly debug = typeof process !== 'undefined' && process.env?.DEBUG_HNSW === 'true';

  constructor(
    indexConfig: Partial<HNSWIndexConfig> = {},
    batchConfig: Partial<BatchConfig> = {}
  ) {
    // Default HNSW configuration
    this.indexConfig = {
      dimension: indexConfig.dimension || 768, // Default 768 for speed (was 3072)
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

    this.initializeIndexedDB();
    this.startBatchProcessor();
    this.startCacheCleanup();
  }

  /**
   * Debug logging helper
   */
  private debugLog(message: string, ...args: any[]): void {
    if (this.debug) {
      console.log(`[HNSW DEBUG] ${message}`, ...args);
    }
  }

  /**
   * Initialize IndexedDB for persistence
   */
  private async initializeIndexedDB(): Promise<void> {
    this.debugLog('Initializing IndexedDB...');
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('HnswIndexDB', 1);

      request.onerror = () => {
        console.error('❌ Failed to open IndexedDB');
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ IndexedDB initialized for HNSW indices');
        this.debugLog('IndexedDB instance:', this.db);
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.debugLog('IndexedDB upgrade needed, creating object stores');

        // Indices store
        if (!db.objectStoreNames.contains('indices')) {
          const indicesStore = db.createObjectStore('indices', { keyPath: 'userAddress' });
          indicesStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
          this.debugLog('Created "indices" object store');
        }

        // Vectors store
        if (!db.objectStoreNames.contains('vectors')) {
          const vectorsStore = db.createObjectStore('vectors', { keyPath: ['userAddress', 'vectorId'] });
          vectorsStore.createIndex('userAddress', 'userAddress', { unique: false });
          vectorsStore.createIndex('timestamp', 'timestamp', { unique: false });
          this.debugLog('Created "vectors" object store');
        }
      };
    });
  }

  /**
   * Load hnswlib-wasm dynamically (only when needed)
   * CRITICAL: Must await WASM initialization before using HierarchicalNSW constructor
   */
  private async loadHnswLib(): Promise<any> {
    if (this.hnswLib) {
      this.debugLog('hnswlib-wasm already loaded, returning cached instance');
      return this.hnswLib;
    }

    try {
      this.debugLog('Loading hnswlib-wasm...');
      // Dynamic import for hnswlib-wasm
      const { loadHnswlib } = await import('hnswlib-wasm');
      this.debugLog('hnswlib-wasm module imported, initializing WASM...');

      // CRITICAL: Wait for WASM module initialization
      // Without this, HierarchicalNSW constructor will not be available
      this.hnswLib = await loadHnswlib();

      console.log('✅ hnswlib-wasm loaded and initialized successfully');
      this.debugLog('hnswlib-wasm instance:', this.hnswLib);
      this.debugLog('Available constructors:', Object.keys(this.hnswLib));
      return this.hnswLib;
    } catch (error) {
      console.error('❌ Failed to load hnswlib-wasm:', error);
      throw new Error('hnswlib-wasm is required but not available. Install it with: npm install hnswlib-wasm');
    }
  }

  /**
   * Create a new HNSW index
   */
  async createIndex(
    userAddress: string,
    options: Partial<HNSWIndexConfig> = {}
  ): Promise<{ index: any; serialized: ArrayBuffer }> {
    try {
      this.debugLog(`Creating index for user: ${userAddress}`);
      const hnswLib = await this.loadHnswLib();
      const config = { ...this.indexConfig, ...options };

      console.log(`Creating new HNSW index for user ${userAddress} with dimensions ${config.dimension}`);
      this.debugLog('Index config:', config);

      // Create a new index (hnswlib-wasm API)
      // Note: hnswlib-wasm requires 3 parameters: spaceName, numDimensions, autoSaveFilename
      this.debugLog('Calling HierarchicalNSW constructor...');
      const indexFilename = `hnsw_${userAddress.substring(0, 10)}.dat`;
      const index = new hnswLib.HierarchicalNSW(config.spaceType, config.dimension, indexFilename);
      this.debugLog('Index created, calling initIndex...');
      index.initIndex(config.maxElements, config.m, config.efConstruction, config.randomSeed);
      this.debugLog('Index initialized successfully');

      // Create cache entry
      this.indexCache.set(userAddress, {
        index,
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: false,
        version: 1,
        metadata: new Map()
      });
      this.debugLog(`Index cached for user: ${userAddress}`);

      // Write index to Emscripten FS (hnswlib-wasm uses writeIndex, not serializeIndex)
      await index.writeIndex(indexFilename);
      this.debugLog(`Index written to Emscripten FS: ${indexFilename}`);

      // Return empty buffer for compatibility (actual data is in Emscripten FS)
      return { index, serialized: new ArrayBuffer(0) };
    } catch (error) {
      console.error(`❌ Failed to create index for ${userAddress}:`, error);
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

      // Get or create cache entry
      let cacheEntry = this.indexCache.get(userAddress);
      if (!cacheEntry) {
        console.warn(`No cached index found for user ${userAddress}, will create on flush`);
        // Create empty cache entry
        cacheEntry = {
          index: null,
          lastModified: new Date(),
          pendingVectors: new Map(),
          isDirty: true,
          version: 1,
          metadata: new Map()
        };
        this.indexCache.set(userAddress, cacheEntry);
      }

      // Add to pending queue
      cacheEntry.pendingVectors.set(vectorId, vector);
      if (metadata) {
        cacheEntry.metadata.set(vectorId, metadata);
      }
      cacheEntry.isDirty = true;
      cacheEntry.lastModified = new Date();

      // Schedule batch job
      this.scheduleBatchJob(userAddress, vectorId, vector);

      console.debug(`Vector ${vectorId} queued for batch processing for user ${userAddress}. Pending: ${cacheEntry.pendingVectors.size}`);

      // Process immediately if batch size limit reached
      if (cacheEntry.pendingVectors.size >= this.config.maxBatchSize) {
        console.log(`Batch size limit reached for user ${userAddress}, processing immediately`);
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
    try {
      this.debugLog(`🔍 searchVectors called for user: ${userAddress}`);
      this.debugLog(`Query vector length: ${queryVector.length}, k: ${options.k || 10}`);

      this.validateVector(queryVector);

      let cacheEntry = this.indexCache.get(userAddress);
      this.debugLog(`Cache entry exists: ${!!cacheEntry}, has index: ${!!cacheEntry?.index}`);
      this.debugLog(`Pending vectors: ${cacheEntry?.pendingVectors?.size || 0}`);

      // If no index exists, check if we have pending vectors that need flushing
      if (!cacheEntry?.index && cacheEntry?.pendingVectors && cacheEntry.pendingVectors.size > 0) {
        console.log(`🔍 No index but ${cacheEntry.pendingVectors.size} pending vectors - flushing first...`);
        await this.flushPendingVectors(userAddress);
        cacheEntry = this.indexCache.get(userAddress); // Refresh after flush
        this.debugLog(`After flush - cache entry: ${!!cacheEntry}, has index: ${!!cacheEntry?.index}`);
      }

      if (!cacheEntry?.index) {
        this.debugLog('No index in cache, attempting to load from IndexedDB...');
        // Try to load from IndexedDB
        const loaded = await this.loadIndexFromDB(userAddress);
        this.debugLog(`loadIndexFromDB result: ${loaded}`);

        if (!loaded) {
          // Check one more time for pending vectors (edge case)
          const entry = this.indexCache.get(userAddress);
          if (entry?.pendingVectors && entry.pendingVectors.size > 0) {
            console.log(`🔍 Found ${entry.pendingVectors.size} pending vectors - flushing before search...`);
            await this.flushPendingVectors(userAddress);
            // Reload after flush
            cacheEntry = this.indexCache.get(userAddress);
            this.debugLog(`After second flush - has index: ${!!cacheEntry?.index}`);
          } else {
            // No index exists yet - this is normal for new users with no memories
            console.info(`No index found for user ${userAddress} - returning empty results`);
            this.debugLog('Returning empty search results');
            return {
              ids: [],
              distances: [],
              similarities: []
            };
          }
        } else {
          cacheEntry = this.indexCache.get(userAddress);
          this.debugLog(`Loaded from DB - has index: ${!!cacheEntry?.index}`);
        }
      }

      const { k = 10, efSearch = 50, filter } = options;
      this.debugLog(`Search parameters - k: ${k}, efSearch: ${efSearch}`);

      const entry = this.indexCache.get(userAddress)!;

      // Get index stats before search
      if (entry.index && entry.index.getCurrentCount) {
        const count = entry.index.getCurrentCount();
        console.log(`📊 Index stats - Current count: ${count}, Pending: ${entry.pendingVectors.size}`);
        this.debugLog(`Index current count: ${count}`);

        if (count === 0) {
          console.warn(`⚠️ Index exists but has 0 vectors! This may indicate an indexing problem.`);
        }
      }

      // Set search parameters
      if (entry.index.setEfSearch) {
        entry.index.setEfSearch(efSearch);
        this.debugLog(`Set efSearch to ${efSearch}`);
      }

      let searchIndex = entry.index;

      // If there are pending vectors, create a temporary index for search
      if (entry.pendingVectors.size > 0) {
        this.debugLog(`Creating temporary index with ${entry.pendingVectors.size} pending vectors`);
        searchIndex = await this.cloneIndexWithPending(entry, queryVector.length);
      }

      // Perform search
      this.debugLog('Calling searchKnn...');
      const result = searchIndex.searchKnn(queryVector, k, undefined);
      this.debugLog(`searchKnn returned - neighbors: ${result?.neighbors?.length || 0}`);

      // Apply metadata filter if provided
      let filteredIds = result.neighbors || result.indices || [];
      let filteredDistances = result.distances;

      if (filter && entry.metadata.size > 0) {
        const filtered = this.applyMetadataFilter(filteredIds, filteredDistances, entry.metadata, filter);
        filteredIds = filtered.ids;
        filteredDistances = filtered.distances;
      }

      // Convert distances to similarities (for cosine distance)
      const similarities = this.indexConfig.spaceType === 'cosine'
        ? filteredDistances.map((dist: number) => 1 - dist)
        : filteredDistances.map((dist: number) => 1 / (1 + dist));

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
   * Load index from IndexedDB via Emscripten FS
   */
  async loadIndexFromDB(userAddress: string): Promise<boolean> {
    if (!this.db) {
      await this.initializeIndexedDB();
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['indices'], 'readonly');
      const store = transaction.objectStore('indices');
      const request = store.get(userAddress);

      request.onsuccess = async () => {
        const result = request.result;
        if (!result) {
          resolve(false);
          return;
        }

        try {
          const hnswLib = await this.loadHnswLib();
          const indexFilename = `hnsw_${userAddress.substring(0, 10)}.dat`;

          // Sync from IndexedDB to Emscripten FS
          await hnswLib.EmscriptenFileSystemManager.syncFS(true, () => {
            // Callback when sync completes
          });

          // Check if file exists
          if (!hnswLib.EmscriptenFileSystemManager.checkFileExists(indexFilename)) {
            console.log(`Index file ${indexFilename} not found in Emscripten FS`);
            resolve(false);
            return;
          }

          // Create index and load from file
          const index = new hnswLib.HierarchicalNSW(
            this.indexConfig.spaceType,
            this.indexConfig.dimension,
            indexFilename
          );

          // Read the index from file
          await index.readIndex(indexFilename, this.indexConfig.maxElements);

          // Convert metadata string keys back to numbers (vectorId)
          const metadataEntries = Object.entries(result.metadata || {})
            .map(([k, v]) => [Number(k), v] as [number, any]);

          // Cache the loaded index
          this.indexCache.set(userAddress, {
            index,
            lastModified: new Date(result.lastUpdated),
            pendingVectors: new Map(),
            isDirty: false,
            version: result.version,
            metadata: new Map(metadataEntries)
          });

          console.log(`✅ Successfully loaded index for user ${userAddress} from IndexedDB`);
          resolve(true);
        } catch (error) {
          console.error('Failed to load index:', error);
          reject(error);
        }
      };

      request.onerror = () => reject(new Error('Failed to load index from IndexedDB'));
    });
  }

  /**
   * Save index to IndexedDB via Emscripten FS
   */
  async saveIndexToDB(userAddress: string): Promise<void> {
    const cacheEntry = this.indexCache.get(userAddress);
    if (!cacheEntry?.index) {
      throw new Error(`No index found for user ${userAddress}`);
    }

    if (!this.db) {
      await this.initializeIndexedDB();
    }

    try {
      const hnswLib = await this.loadHnswLib();
      const indexFilename = `hnsw_${userAddress.substring(0, 10)}.dat`;

      // Write index to Emscripten FS
      await cacheEntry.index.writeIndex(indexFilename);

      // Sync from Emscripten FS to IndexedDB
      await hnswLib.EmscriptenFileSystemManager.syncFS(false, () => {
        // Callback when sync completes
      });

      // Store metadata in our IndexedDB (separate from Emscripten's IDBFS)
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction(['indices'], 'readwrite');
        const store = transaction.objectStore('indices');

        const data = {
          userAddress,
          indexData: new ArrayBuffer(0), // Actual data is in Emscripten FS/IDBFS
          metadata: Object.fromEntries(cacheEntry.metadata),
          version: cacheEntry.version,
          lastUpdated: Date.now()
        };

        const request = store.put(data);

        request.onsuccess = () => {
          console.log(`✅ Index saved to IndexedDB for user ${userAddress}`);
          resolve();
        };

        request.onerror = () => reject(new Error('Failed to save index metadata to IndexedDB'));
      });
    } catch (error) {
      console.error(`Failed to save index for user ${userAddress}:`, error);
      throw error;
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
  getCacheStats(): BatchStats {
    const cacheEntries: any[] = [];
    let totalPendingVectors = 0;

    for (const [userAddress, entry] of this.indexCache.entries()) {
      const pendingCount = entry.pendingVectors.size;
      totalPendingVectors += pendingCount;

      cacheEntries.push({
        userAddress,
        pendingVectors: pendingCount,
        lastModified: entry.lastModified,
        isDirty: entry.isDirty,
        hasIndex: !!entry.index
      });
    }

    return {
      totalUsers: this.indexCache.size,
      totalPendingVectors,
      activeBatchJobs: this.batchJobs.size,
      cacheHitRate: 0, // TODO: Implement hit rate tracking
      averageBatchSize: totalPendingVectors / Math.max(1, this.indexCache.size),
      averageProcessingTime: 0 // TODO: Implement timing tracking
    };
  }

  /**
   * Clear user index and cache
   */
  clearUserIndex(userAddress: string): void {
    this.indexCache.delete(userAddress);
    this.batchJobs.delete(userAddress);
    console.log(`Cleared index cache for user ${userAddress}`);
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.batchProcessor) {
      clearInterval(this.batchProcessor);
    }
    if (this.cacheCleanup) {
      clearInterval(this.cacheCleanup);
    }
    this.indexCache.clear();
    this.batchJobs.clear();

    if (this.db) {
      this.db.close();
    }
  }

  // ==================== PRIVATE METHODS ====================

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
    this.batchProcessor = window.setInterval(async () => {
      await this.processBatchJobs();
    }, this.config.batchDelayMs);
  }

  private startCacheCleanup(): void {
    this.cacheCleanup = window.setInterval(() => {
      this.cleanupCache();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

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
        console.error(`Error processing batch job for user ${userAddress}:`, error);
      }
    }
  }

  private async flushPendingVectors(userAddress: string): Promise<void> {
    const cacheEntry = this.indexCache.get(userAddress);
    if (!cacheEntry || cacheEntry.pendingVectors.size === 0) {
      return;
    }

    console.log(`Flushing ${cacheEntry.pendingVectors.size} pending vectors for user ${userAddress}`);

    try {
      // Create index if it doesn't exist
      if (!cacheEntry.index) {
        const { index } = await this.createIndex(userAddress);
        cacheEntry.index = index;
      }

      // Add all pending vectors to the index
      for (const [vectorId, vector] of cacheEntry.pendingVectors.entries()) {
        cacheEntry.index.addPoint(vector, vectorId, false);
      }

      // Save to IndexedDB
      await this.saveIndexToDB(userAddress);

      // Clear pending vectors
      cacheEntry.pendingVectors.clear();
      cacheEntry.isDirty = false;
      cacheEntry.lastModified = new Date();
      cacheEntry.version++;

      // Remove batch job
      this.batchJobs.delete(userAddress);

      console.log(`Successfully flushed vectors for user ${userAddress}`);
    } catch (error) {
      console.error(`Error flushing vectors for user ${userAddress}:`, error);
      throw error;
    }
  }

  private async cloneIndexWithPending(cacheEntry: IndexCacheEntry, dimensions: number): Promise<any> {
    const hnswLib = await this.loadHnswLib();
    const tempFilename = `temp_clone_${Date.now()}.dat`;

    // Save original index to temp file
    await cacheEntry.index.writeIndex(tempFilename);

    // Create clone and load from temp file
    const clonedIndex = new hnswLib.HierarchicalNSW(
      this.indexConfig.spaceType,
      dimensions,
      tempFilename
    );
    clonedIndex.initIndex(
      this.indexConfig.maxElements,
      this.indexConfig.m,
      this.indexConfig.efConstruction,
      this.indexConfig.randomSeed
    );
    await clonedIndex.readIndex(tempFilename, this.indexConfig.maxElements);

    // Add pending vectors
    for (const [vectorId, vector] of cacheEntry.pendingVectors.entries()) {
      clonedIndex.addPoint(vector, vectorId, false);
    }

    return clonedIndex;
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

  private cleanupCache(): void {
    const now = Date.now();
    for (const [userAddress, entry] of this.indexCache.entries()) {
      if (now - entry.lastModified.getTime() > this.config.cacheTtlMs) {
        console.debug(`Removing stale cache entry for user ${userAddress}`);
        this.indexCache.delete(userAddress);
      }
    }
  }

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

export default BrowserHnswIndexService;
