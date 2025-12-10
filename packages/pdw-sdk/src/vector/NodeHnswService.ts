/**
 * NodeHnswService - Node.js HNSW Vector Indexing
 *
 * Provides Node.js-compatible HNSW vector indexing using hnswlib-node.
 * Uses filesystem for persistence instead of IndexedDB.
 *
 * Key Features:
 * - Uses native hnswlib-node bindings (faster than WASM)
 * - Filesystem persistence
 * - Compatible with Next.js API routes and server-side code
 */

import type {
  IHnswService,
  HnswServiceConfig,
  IHnswIndexConfig,
  IHnswSearchOptions,
  IHnswSearchResultItem,
  IHnswBatchStats
} from './IHnswService';

// Dynamic import types for hnswlib-node
type HierarchicalNSW = any;

interface IndexCacheEntry {
  index: HierarchicalNSW;
  lastModified: Date;
  pendingVectors: Map<number, number[]>;
  isDirty: boolean;
  version: number;
  metadata: Map<number, any>;
  dimensions: number;
}

/**
 * Node.js HNSW vector indexing service using native bindings
 */
export class NodeHnswService implements IHnswService {
  private hnswlib: any = null;
  private readonly indexCache = new Map<string, IndexCacheEntry>();
  private readonly indexConfig: Required<IHnswIndexConfig>;
  private readonly indexDirectory: string;
  private batchProcessor?: ReturnType<typeof setInterval>;
  private initPromise: Promise<void> | null = null;
  private _isInitialized = false;

  // Batch stats
  private batchStats: IHnswBatchStats = {
    pendingJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    averageProcessingTime: 0
  };

  constructor(config: HnswServiceConfig = {}) {
    this.indexConfig = {
      dimension: config.indexConfig?.dimension || 768,
      maxElements: config.indexConfig?.maxElements || 10000,
      efConstruction: config.indexConfig?.efConstruction || 200,
      m: config.indexConfig?.m || 16,
      randomSeed: config.indexConfig?.randomSeed || 42,
      spaceType: config.indexConfig?.spaceType || 'cosine'
    };

    this.indexDirectory = config.indexDirectory || './.pdw-indexes';
  }

  /**
   * Initialize hnswlib-node (dynamic import)
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this._doInitialize();
    await this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      console.log('[NodeHnswService] Loading hnswlib-node...');

      // Dynamic import to avoid bundling issues
      const hnswModule = await import('hnswlib-node');
      this.hnswlib = hnswModule;

      // Ensure index directory exists
      const fs = await import('fs/promises');
      const path = await import('path');

      try {
        await fs.mkdir(this.indexDirectory, { recursive: true });
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
      }

      this._isInitialized = true;
      console.log('[NodeHnswService] hnswlib-node loaded successfully');

      // Start batch processor
      this.startBatchProcessor();
    } catch (error) {
      console.error('[NodeHnswService] Failed to load hnswlib-node:', error);
      throw new Error('hnswlib-node is required for server-side vector search. Install with: npm install hnswlib-node');
    }
  }

  isInitialized(): boolean {
    return this._isInitialized;
  }

  private startBatchProcessor(): void {
    this.batchProcessor = setInterval(async () => {
      await this.processPendingBatches();
    }, 5000);
  }

  private async processPendingBatches(): Promise<void> {
    for (const [userAddress, entry] of this.indexCache) {
      if (entry.isDirty && entry.pendingVectors.size > 0) {
        try {
          await this.flushBatch(userAddress);
        } catch (error) {
          console.error(`[NodeHnswService] Batch processing failed for ${userAddress}:`, error);
        }
      }
    }
  }

  private getIndexPath(userAddress: string): string {
    const safeAddress = userAddress.replace(/[^a-zA-Z0-9]/g, '_');
    return `${this.indexDirectory}/${safeAddress}.hnsw`;
  }

  async getOrCreateIndex(userAddress: string): Promise<void> {
    await this.initialize();

    if (this.indexCache.has(userAddress)) {
      return;
    }

    // Try to load existing index
    const loaded = await this.loadIndex(userAddress);
    if (loaded) {
      return;
    }

    // Create new index
    const HierarchicalNSW = this.hnswlib.HierarchicalNSW;
    const index = new HierarchicalNSW(this.indexConfig.spaceType, this.indexConfig.dimension);

    index.initIndex(
      this.indexConfig.maxElements,
      this.indexConfig.m,
      this.indexConfig.efConstruction,
      this.indexConfig.randomSeed
    );

    this.indexCache.set(userAddress, {
      index,
      lastModified: new Date(),
      pendingVectors: new Map(),
      isDirty: false,
      version: 1,
      metadata: new Map(),
      dimensions: this.indexConfig.dimension
    });

    console.log(`[NodeHnswService] Created new index for ${userAddress}`);
  }

  async addVector(
    userAddress: string,
    vectorId: number,
    vector: number[],
    metadata?: Record<string, any>
  ): Promise<void> {
    await this.getOrCreateIndex(userAddress);

    const entry = this.indexCache.get(userAddress);
    if (!entry) {
      throw new Error(`Index not found for ${userAddress}`);
    }

    // Add to pending batch
    entry.pendingVectors.set(vectorId, vector);
    if (metadata) {
      entry.metadata.set(vectorId, metadata);
    }
    entry.isDirty = true;
    this.batchStats.pendingJobs++;

    // Flush if batch is large enough
    if (entry.pendingVectors.size >= 50) {
      await this.flushBatch(userAddress);
    }
  }

  async search(
    userAddress: string,
    queryVector: number[],
    options: IHnswSearchOptions = {}
  ): Promise<IHnswSearchResultItem[]> {
    await this.getOrCreateIndex(userAddress);

    const entry = this.indexCache.get(userAddress);
    if (!entry) {
      return [];
    }

    // Flush pending vectors before search
    if (entry.pendingVectors.size > 0) {
      await this.flushBatch(userAddress);
    }

    const k = options.k || 10;
    const ef = options.ef || 50;

    try {
      entry.index.setEf(ef);
      const result = entry.index.searchKnn(queryVector, k);

      const results: IHnswSearchResultItem[] = [];
      for (let i = 0; i < result.neighbors.length; i++) {
        const vectorId = result.neighbors[i];
        const distance = result.distances[i];
        const score = 1 - distance; // Convert distance to similarity

        results.push({
          vectorId,
          distance,
          score,
          metadata: entry.metadata.get(vectorId)
        });
      }

      return results.filter(r => {
        if (options.minScore && r.score < options.minScore) return false;
        if (options.maxDistance && r.distance > options.maxDistance) return false;
        return true;
      });
    } catch (error) {
      console.error('[NodeHnswService] Search error:', error);
      return [];
    }
  }

  async removeVector(userAddress: string, vectorId: number): Promise<void> {
    const entry = this.indexCache.get(userAddress);
    if (!entry) return;

    try {
      entry.index.markDelete(vectorId);
      entry.metadata.delete(vectorId);
      entry.pendingVectors.delete(vectorId);
      entry.isDirty = true;
    } catch (error) {
      console.warn(`[NodeHnswService] Failed to remove vector ${vectorId}:`, error);
    }
  }

  getBatchStats(): IHnswBatchStats {
    return { ...this.batchStats };
  }

  async flushBatch(userAddress: string): Promise<void> {
    const entry = this.indexCache.get(userAddress);
    if (!entry || entry.pendingVectors.size === 0) return;

    const startTime = Date.now();
    let processed = 0;

    try {
      for (const [vectorId, vector] of entry.pendingVectors) {
        entry.index.addPoint(vector, vectorId);
        processed++;
      }

      entry.pendingVectors.clear();
      entry.isDirty = true;
      entry.version++;

      // Update stats
      const processingTime = Date.now() - startTime;
      this.batchStats.completedJobs += processed;
      this.batchStats.pendingJobs -= processed;
      this.batchStats.averageProcessingTime =
        (this.batchStats.averageProcessingTime + processingTime) / 2;

      // Auto-save
      await this.saveIndex(userAddress);
    } catch (error) {
      this.batchStats.failedJobs++;
      console.error('[NodeHnswService] Flush batch error:', error);
      throw error;
    }
  }

  async saveIndex(userAddress: string): Promise<void> {
    const entry = this.indexCache.get(userAddress);
    if (!entry) return;

    try {
      const indexPath = this.getIndexPath(userAddress);
      entry.index.writeIndex(indexPath);

      // Save metadata separately
      const fs = await import('fs/promises');
      const metadataPath = indexPath + '.meta.json';
      const metadataObj: Record<number, any> = {};
      for (const [k, v] of entry.metadata) {
        metadataObj[k] = v;
      }
      await fs.writeFile(metadataPath, JSON.stringify({
        version: entry.version,
        dimensions: entry.dimensions,
        metadata: metadataObj
      }));

      entry.isDirty = false;
      console.log(`[NodeHnswService] Saved index for ${userAddress}`);
    } catch (error) {
      console.error('[NodeHnswService] Save index error:', error);
      throw error;
    }
  }

  async loadIndex(userAddress: string): Promise<boolean> {
    await this.initialize();

    const indexPath = this.getIndexPath(userAddress);

    try {
      const fs = await import('fs/promises');

      // Check if index file exists
      try {
        await fs.access(indexPath);
      } catch {
        return false;
      }

      // Load index
      const HierarchicalNSW = this.hnswlib.HierarchicalNSW;
      const index = new HierarchicalNSW(this.indexConfig.spaceType, this.indexConfig.dimension);
      index.readIndex(indexPath, this.indexConfig.maxElements);

      // Load metadata
      const metadataPath = indexPath + '.meta.json';
      let metadata = new Map<number, any>();
      let version = 1;
      let dimensions = this.indexConfig.dimension;

      try {
        const metaContent = await fs.readFile(metadataPath, 'utf-8');
        const metaObj = JSON.parse(metaContent);
        version = metaObj.version || 1;
        dimensions = metaObj.dimensions || this.indexConfig.dimension;
        if (metaObj.metadata) {
          for (const [k, v] of Object.entries(metaObj.metadata)) {
            metadata.set(parseInt(k), v);
          }
        }
      } catch {
        // No metadata file, use defaults
      }

      this.indexCache.set(userAddress, {
        index,
        lastModified: new Date(),
        pendingVectors: new Map(),
        isDirty: false,
        version,
        metadata,
        dimensions
      });

      console.log(`[NodeHnswService] Loaded index for ${userAddress}`);
      return true;
    } catch (error) {
      console.warn(`[NodeHnswService] Failed to load index for ${userAddress}:`, error);
      return false;
    }
  }

  async deleteIndex(userAddress: string): Promise<void> {
    this.indexCache.delete(userAddress);

    try {
      const fs = await import('fs/promises');
      const indexPath = this.getIndexPath(userAddress);

      await fs.unlink(indexPath).catch(() => {});
      await fs.unlink(indexPath + '.meta.json').catch(() => {});

      console.log(`[NodeHnswService] Deleted index for ${userAddress}`);
    } catch (error) {
      console.warn('[NodeHnswService] Delete index error:', error);
    }
  }

  destroy(): void {
    if (this.batchProcessor) {
      clearInterval(this.batchProcessor);
      this.batchProcessor = undefined;
    }

    this.indexCache.clear();
    this._isInitialized = false;
    console.log('[NodeHnswService] Service destroyed');
  }
}
