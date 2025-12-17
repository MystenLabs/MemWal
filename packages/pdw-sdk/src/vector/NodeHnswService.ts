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
  IHnswBatchStats,
  WalrusBackupConfig
} from './IHnswService';

// Dynamic import types for hnswlib-node
type HierarchicalNSW = any;

interface IndexCacheEntry {
  index: HierarchicalNSW;
  lastModified: Date;
  fileModifiedTime: number; // File mtime in ms for staleness check
  pendingVectors: Map<number, number[]>;
  isDirty: boolean;
  version: number;
  metadata: Map<number, any>;
  dimensions: number;
  walrusBlobId?: string; // Walrus blob ID if backed up
}

/**
 * Node.js HNSW vector indexing service using native bindings
 */
export class NodeHnswService implements IHnswService {
  private hnswlib: any = null;
  private readonly indexCache = new Map<string, IndexCacheEntry>();
  private readonly indexConfig: Required<IHnswIndexConfig>;
  private readonly indexDirectory: string;
  private readonly walrusConfig?: WalrusBackupConfig;
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
      dimension: config.indexConfig?.dimension || 3072,
      maxElements: config.indexConfig?.maxElements || 10000,
      efConstruction: config.indexConfig?.efConstruction || 200,
      m: config.indexConfig?.m || 16,
      randomSeed: config.indexConfig?.randomSeed || 42,
      spaceType: config.indexConfig?.spaceType || 'cosine'
    };

    this.indexDirectory = config.indexDirectory || './.pdw-indexes';
    this.walrusConfig = config.walrusBackup;
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
      // hnswlib-node exports as default in ESM
      this.hnswlib = hnswModule.default || hnswModule;

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

  /**
   * Check if cached index is stale (file on disk is newer)
   * Returns true if index should be reloaded
   */
  private async isIndexStale(userAddress: string): Promise<boolean> {
    const entry = this.indexCache.get(userAddress);
    if (!entry) return false;

    try {
      const fs = await import('fs/promises');
      const indexPath = this.getIndexPath(userAddress);
      const stats = await fs.stat(indexPath);
      const fileMtime = stats.mtimeMs;

      // If file on disk is newer than our cached version, index is stale
      if (fileMtime > entry.fileModifiedTime) {
        console.log(`[NodeHnswService] Index stale for ${userAddress} (file: ${fileMtime}, cache: ${entry.fileModifiedTime})`);
        return true;
      }
      return false;
    } catch {
      // File doesn't exist or error - not stale
      return false;
    }
  }

  /**
   * Reload index from disk if it's stale (modified by another process)
   */
  async reloadIfStale(userAddress: string): Promise<boolean> {
    const isStale = await this.isIndexStale(userAddress);
    if (isStale) {
      console.log(`[NodeHnswService] Reloading stale index for ${userAddress}`);
      this.indexCache.delete(userAddress);
      return await this.loadIndex(userAddress);
    }
    return false;
  }

  async getOrCreateIndex(userAddress: string): Promise<void> {
    await this.initialize();

    // Check if cached index is stale and reload if needed
    if (this.indexCache.has(userAddress)) {
      await this.reloadIfStale(userAddress);
      if (this.indexCache.has(userAddress)) {
        return;
      }
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
      fileModifiedTime: Date.now(),
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

      // Preserve existing walrus blob ID if present
      const existingMeta: Record<string, any> = {};
      try {
        const existingContent = await fs.readFile(metadataPath, 'utf-8');
        Object.assign(existingMeta, JSON.parse(existingContent));
      } catch {
        // No existing metadata file
      }

      await fs.writeFile(metadataPath, JSON.stringify({
        version: entry.version,
        dimensions: entry.dimensions,
        metadata: metadataObj,
        walrusBlobId: existingMeta.walrusBlobId,
        walrusSyncTime: existingMeta.walrusSyncTime
      }));

      // Update fileModifiedTime to match the file we just saved
      const stats = await fs.stat(indexPath);
      entry.fileModifiedTime = stats.mtimeMs;
      entry.isDirty = false;
      console.log(`[NodeHnswService] Saved index for ${userAddress} (mtime: ${entry.fileModifiedTime})`);

      // Auto-sync to Walrus if enabled
      if (this.walrusConfig?.enabled && this.walrusConfig.autoSync !== false) {
        // Run sync in background to not block saveIndex
        this.syncToWalrus(userAddress).catch(err => {
          console.error('[NodeHnswService] Auto-sync to Walrus failed:', err);
        });
      }
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

      // Check if index file exists and get its modification time
      let fileModifiedTime: number;
      try {
        const stats = await fs.stat(indexPath);
        fileModifiedTime = stats.mtimeMs;
      } catch {
        return false;
      }

      // Load index
      const HierarchicalNSW = this.hnswlib.HierarchicalNSW;
      const index = new HierarchicalNSW(this.indexConfig.spaceType, this.indexConfig.dimension);
      // readIndex is async - must await to properly initialize index before use
      await index.readIndex(indexPath, false);

      // Load metadata
      const metadataPath = indexPath + '.meta.json';
      let metadata = new Map<number, any>();
      let version = 1;
      let dimensions = this.indexConfig.dimension;
      let walrusBlobId: string | undefined;

      try {
        const metaContent = await fs.readFile(metadataPath, 'utf-8');
        const metaObj = JSON.parse(metaContent);
        version = metaObj.version || 1;
        dimensions = metaObj.dimensions || this.indexConfig.dimension;
        walrusBlobId = metaObj.walrusBlobId;
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
        fileModifiedTime,
        pendingVectors: new Map(),
        isDirty: false,
        version,
        metadata,
        dimensions,
        walrusBlobId
      });

      console.log(`[NodeHnswService] Loaded index for ${userAddress} (mtime: ${fileModifiedTime})`);
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

  // ==================== Walrus Backup Methods ====================

  /**
   * Sync index to Walrus storage
   * @returns Walrus blob ID if successful, null if Walrus backup is disabled
   */
  async syncToWalrus(userAddress: string): Promise<string | null> {
    if (!this.walrusConfig?.enabled) {
      console.log('[NodeHnswService] Walrus backup disabled, skipping sync');
      return null;
    }

    const entry = this.indexCache.get(userAddress);
    if (!entry) {
      console.warn(`[NodeHnswService] No index found for ${userAddress}, nothing to sync`);
      return null;
    }

    try {
      const fs = await import('fs/promises');
      const indexPath = this.getIndexPath(userAddress);

      // Read the index file
      const indexBuffer = await fs.readFile(indexPath);

      // Read metadata
      const metadataPath = indexPath + '.meta.json';
      let metadataBuffer: Buffer;
      try {
        metadataBuffer = await fs.readFile(metadataPath);
      } catch {
        metadataBuffer = Buffer.from('{}');
      }

      // Combine index + metadata into a single package
      const packageData = {
        index: indexBuffer.toString('base64'),
        metadata: metadataBuffer.toString('utf-8'),
        version: entry.version,
        dimensions: entry.dimensions,
        spaceType: this.indexConfig.spaceType,
        timestamp: Date.now()
      };

      const packageBuffer = Buffer.from(JSON.stringify(packageData));

      // Upload to Walrus
      const publisherUrl = this.walrusConfig.publisherUrl;
      const epochs = this.walrusConfig.epochs || 3;

      console.log(`[NodeHnswService] Uploading index to Walrus (${packageBuffer.length} bytes)...`);

      const response = await fetch(`${publisherUrl}/v1/blobs?epochs=${epochs}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: packageBuffer
      });

      if (!response.ok) {
        throw new Error(`Walrus upload failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json() as any;

      // Handle both newlyCreated and alreadyCertified responses
      const blobId = result.newlyCreated?.blobObject?.blobId ||
                     result.alreadyCertified?.blobId ||
                     result.blobId;

      if (!blobId) {
        throw new Error('No blobId in Walrus response');
      }

      // Update cache with blob ID
      entry.walrusBlobId = blobId;

      // Save blob ID to metadata file for persistence
      const metaContent = JSON.parse(metadataBuffer.toString('utf-8') || '{}');
      metaContent.walrusBlobId = blobId;
      metaContent.walrusSyncTime = Date.now();
      await fs.writeFile(metadataPath, JSON.stringify(metaContent, null, 2));

      console.log(`[NodeHnswService] Index synced to Walrus: ${blobId}`);
      return blobId;
    } catch (error) {
      console.error('[NodeHnswService] Walrus sync failed:', error);
      throw error;
    }
  }

  /**
   * Load index from Walrus storage
   * @returns true if index was loaded successfully
   */
  async loadFromWalrus(userAddress: string, blobId: string): Promise<boolean> {
    if (!this.walrusConfig?.enabled) {
      console.log('[NodeHnswService] Walrus backup disabled');
      return false;
    }

    await this.initialize();

    try {
      const aggregatorUrl = this.walrusConfig.aggregatorUrl;

      console.log(`[NodeHnswService] Loading index from Walrus: ${blobId}`);

      // Download from Walrus
      const response = await fetch(`${aggregatorUrl}/v1/blobs/${blobId}`);

      if (!response.ok) {
        throw new Error(`Walrus download failed: ${response.status} ${response.statusText}`);
      }

      const packageBuffer = await response.arrayBuffer();
      const packageData = JSON.parse(Buffer.from(packageBuffer).toString('utf-8'));

      // Validate package
      if (!packageData.index || !packageData.dimensions) {
        throw new Error('Invalid index package from Walrus');
      }

      // Decode index data
      const indexBuffer = Buffer.from(packageData.index, 'base64');

      // Write to filesystem
      const fs = await import('fs/promises');
      const indexPath = this.getIndexPath(userAddress);

      // Ensure directory exists
      const path = await import('path');
      await fs.mkdir(path.dirname(indexPath), { recursive: true });

      await fs.writeFile(indexPath, indexBuffer);

      // Write metadata
      const metadataPath = indexPath + '.meta.json';
      const metaContent = {
        version: packageData.version || 1,
        dimensions: packageData.dimensions,
        metadata: JSON.parse(packageData.metadata || '{}').metadata || {},
        walrusBlobId: blobId,
        walrusLoadTime: Date.now()
      };
      await fs.writeFile(metadataPath, JSON.stringify(metaContent, null, 2));

      // Load into memory
      const loaded = await this.loadIndex(userAddress);

      if (loaded) {
        const entry = this.indexCache.get(userAddress);
        if (entry) {
          entry.walrusBlobId = blobId;
        }
        console.log(`[NodeHnswService] Index loaded from Walrus successfully`);
      }

      return loaded;
    } catch (error) {
      console.error('[NodeHnswService] Failed to load from Walrus:', error);
      return false;
    }
  }

  /**
   * Get the Walrus blob ID for a user's index (if backed up)
   */
  getWalrusBlobId(userAddress: string): string | null {
    const entry = this.indexCache.get(userAddress);
    return entry?.walrusBlobId || null;
  }

  /**
   * Check if Walrus backup is enabled
   */
  isWalrusEnabled(): boolean {
    return this.walrusConfig?.enabled === true;
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
