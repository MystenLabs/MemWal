/**
 * IndexManager - Hybrid Index Persistence Manager
 *
 * Provides intelligent index management with:
 * - Option 1: Full rebuild from Blockchain + Walrus (fallback)
 * - Option 2: Binary serialization to/from Walrus (fast)
 * - Hybrid: Combines both with incremental sync
 * - On-chain MemoryIndex object for versioned index tracking
 *
 * Flow:
 * 1. Initialize: Check for MemoryIndex on-chain → Load blob from Walrus
 * 2. Save: Upload to Walrus → Create/Update MemoryIndex on-chain
 *
 * @module services/IndexManager
 */

import type { VectorService } from './VectorService';
import type { StorageService } from './StorageService';
import type { EmbeddingService } from './EmbeddingService';
import type { TransactionService } from './TransactionService';
import type { MemoryIndex } from './ViewService';

/**
 * Index state stored in localStorage/persistent storage
 */
export interface IndexState {
  /** Blob ID of the saved index on Walrus */
  blobId: string;
  /** Graph blob ID on Walrus (for knowledge graph) */
  graphBlobId?: string;
  /** Timestamp when index was last saved */
  lastSyncTimestamp: number;
  /** Number of vectors in the index at save time */
  vectorCount: number;
  /** Index version for optimistic locking (matches on-chain version) */
  version: number;
  /** Dimension of vectors in the index */
  dimension: number;
  /** On-chain MemoryIndex object ID (if created) */
  onChainIndexId?: string;
}

/**
 * Serialized index package stored on Walrus
 */
export interface SerializedIndexPackage {
  /** Package format version */
  formatVersion: '1.0';
  /** Space ID (user address) */
  spaceId: string;
  /** Index version */
  version: number;
  /** Vector dimension */
  dimension: number;
  /** Timestamp of serialization */
  timestamp: number;
  /** Serialized HNSW index as base64 (if supported) */
  indexBinary?: string;
  /** All vectors with their IDs for reconstruction */
  vectors: Array<{
    vectorId: number;
    vector: number[];
  }>;
  /** Metadata for each vector */
  metadata: Array<[number, any]>;
  /** HNSW config used */
  hnswConfig: {
    maxElements: number;
    m: number;
    efConstruction: number;
  };
}

/**
 * Progress callback for long operations
 */
export type IndexProgressCallback = (
  stage: 'loading' | 'rebuilding' | 'syncing' | 'saving' | 'complete',
  progress: number,
  message: string
) => void;

/**
 * Options for IndexManager initialization
 */
export interface IndexManagerOptions {
  /** Auto-save interval in ms (default: 5 minutes) */
  autoSaveInterval?: number;
  /** Enable auto-save (default: true) */
  enableAutoSave?: boolean;
  /** Storage key prefix for localStorage */
  storageKeyPrefix?: string;
  /** Progress callback */
  onProgress?: IndexProgressCallback;
  /** TransactionService for on-chain operations (optional) */
  transactionService?: TransactionService;
  /** Callback to get MemoryIndex from blockchain */
  getMemoryIndexFromChain?: (userAddress: string) => Promise<MemoryIndex | null>;
  /** Callback to execute transaction (for create/update MemoryIndex) */
  executeTransaction?: (tx: any, signer: any) => Promise<{ digest: string; effects?: any; error?: string }>;
}

/**
 * IndexManager - Manages HNSW index persistence with hybrid restore strategy
 *
 * Strategy:
 * 1. Try to load from Walrus cache (fast, ~500ms)
 * 2. If failed, rebuild from blockchain + Walrus (slow but complete)
 * 3. Sync any new memories since last save
 * 4. Auto-save periodically
 *
 * Memory Optimization:
 * - Removed duplicate vectorCache - now uses VectorService.getAllCachedVectors()
 * - Vectors are only stored once in VectorService's HnswWasmService LRU cache
 */
export class IndexManager {
  private vectorService: VectorService;
  private storageService: StorageService;
  private embeddingService: EmbeddingService;
  private options: Required<Omit<IndexManagerOptions, 'transactionService' | 'getMemoryIndexFromChain' | 'executeTransaction'>> & {
    transactionService?: TransactionService;
    getMemoryIndexFromChain?: (userAddress: string) => Promise<MemoryIndex | null>;
    executeTransaction?: (tx: any, signer: any) => Promise<{ digest: string; effects?: any; error?: string }>;
  };
  private autoSaveTimer?: ReturnType<typeof setInterval>;
  private indexStates: Map<string, IndexState> = new Map();
  // Note: vectorCache removed - now using VectorService.getAllCachedVectors() to avoid duplication

  // Storage adapter (can be replaced for non-browser environments)
  private storage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };

  constructor(
    vectorService: VectorService,
    storageService: StorageService,
    embeddingService: EmbeddingService,
    options: IndexManagerOptions = {}
  ) {
    this.vectorService = vectorService;
    this.storageService = storageService;
    this.embeddingService = embeddingService;

    this.options = {
      autoSaveInterval: options.autoSaveInterval ?? 5 * 60 * 1000, // 5 minutes
      enableAutoSave: options.enableAutoSave ?? true,
      storageKeyPrefix: options.storageKeyPrefix ?? 'pdw_index_',
      onProgress: options.onProgress ?? (() => {}),
      transactionService: options.transactionService,
      getMemoryIndexFromChain: options.getMemoryIndexFromChain,
      executeTransaction: options.executeTransaction,
    };

    // Default to localStorage in browser, no-op in Node
    this.storage = typeof localStorage !== 'undefined'
      ? localStorage
      : {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        };
  }

  /**
   * Set custom storage adapter (for React Native, Node.js, etc.)
   */
  setStorageAdapter(adapter: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  }): void {
    this.storage = adapter;
  }

  /**
   * Initialize index for a user with hybrid restore strategy
   *
   * @param spaceId - User address / space identifier
   * @param getMemoriesFromChain - Function to fetch memories from blockchain
   * @param getMemoryContent - Function to fetch memory content from Walrus
   */
  async initialize(
    spaceId: string,
    getMemoriesFromChain: () => Promise<Array<{
      id: string;
      blobId: string;
      vectorId?: number;
      category?: string;
      importance?: number;
      topic?: string;
      createdAt?: number;
    }>>,
    getMemoryContent: (blobId: string) => Promise<{
      content: string;
      embedding?: number[];
      metadata?: any;
    }>
  ): Promise<{
    restored: boolean;
    method: 'cache' | 'rebuild' | 'empty';
    vectorCount: number;
    syncedCount: number;
    timeMs: number;
  }> {
    const startTime = Date.now();
    let method: 'cache' | 'rebuild' | 'empty' = 'empty';
    let vectorCount = 0;
    let syncedCount = 0;

    this.options.onProgress('loading', 0, 'Starting index initialization...');

    // Step 0: Check for on-chain MemoryIndex first (source of truth)
    let onChainIndex: MemoryIndex | null = null;
    if (this.options.getMemoryIndexFromChain) {
      try {
        this.options.onProgress('loading', 5, 'Checking on-chain MemoryIndex...');
        onChainIndex = await this.options.getMemoryIndexFromChain(spaceId);

        if (onChainIndex) {
          console.log(`📍 Found on-chain MemoryIndex: ${onChainIndex.id} (v${onChainIndex.version})`);
          console.log(`   Index blob: ${onChainIndex.indexBlobId}`);
          console.log(`   Graph blob: ${onChainIndex.graphBlobId}`);
        }
      } catch (error) {
        console.warn('⚠️ Failed to fetch on-chain MemoryIndex:', error);
      }
    }

    // Step 1: Try to load from on-chain index or localStorage cache
    // Priority: on-chain index > localStorage cache
    let cachedState = this.loadIndexState(spaceId);

    // If on-chain index is newer, use it instead of localStorage
    if (onChainIndex && onChainIndex.indexBlobId) {
      const onChainVersion = onChainIndex.version;
      const localVersion = cachedState?.version || 0;

      if (onChainVersion > localVersion || !cachedState) {
        console.log(`🔄 On-chain index (v${onChainVersion}) is newer than local (v${localVersion}), using on-chain`);
        cachedState = {
          blobId: onChainIndex.indexBlobId,
          graphBlobId: onChainIndex.graphBlobId,
          lastSyncTimestamp: 0, // Will sync all memories
          vectorCount: 0,
          version: onChainVersion,
          dimension: 3072,
          onChainIndexId: onChainIndex.id,
        };
      }
    }

    if (cachedState) {
      try {
        this.options.onProgress('loading', 10, 'Found cached index, loading from Walrus...');
        await this.loadFromWalrus(spaceId, cachedState.blobId);

        // Restore on-chain index ID if available
        if (onChainIndex) {
          const state = this.indexStates.get(spaceId);
          if (state) {
            state.onChainIndexId = onChainIndex.id;
            this.indexStates.set(spaceId, state);
          }
        }

        method = 'cache';
        vectorCount = this.vectorService.getIndexStats(spaceId)?.currentElements || 0;

        this.options.onProgress('loading', 50, `Loaded ${vectorCount} vectors from cache`);

        // Step 2: Sync new memories since last save (with timeout)
        this.options.onProgress('syncing', 60, 'Checking for new memories...');
        try {
          // Add 30 second timeout for sync operation
          const syncPromise = this.syncNewMemories(
            spaceId,
            cachedState.lastSyncTimestamp,
            getMemoriesFromChain,
            getMemoryContent
          );
          const timeoutPromise = new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error('Sync timeout after 30s')), 30000)
          );
          syncedCount = await Promise.race([syncPromise, timeoutPromise]);

          if (syncedCount > 0) {
            vectorCount += syncedCount;
            this.options.onProgress('syncing', 90, `Synced ${syncedCount} new memories`);
          }
        } catch (syncError: any) {
          console.warn('⚠️ Sync skipped:', syncError.message);
          // Continue without sync - index is still usable from cache
        }

        this.options.onProgress('complete', 100, 'Index ready');
      } catch (error) {
        console.warn('⚠️ Failed to load cached index, falling back to rebuild:', error);
        // Fall through to rebuild
        method = 'rebuild';
      }
    }

    // Step 3: Full rebuild if no cache or cache failed (Option 1 - slow but complete)
    if (method !== 'cache') {
      this.options.onProgress('rebuilding', 10, 'No cache found, rebuilding from blockchain...');

      try {
        // Add 60 second timeout for full rebuild
        const rebuildPromise = this.fullRebuild(
          spaceId,
          getMemoriesFromChain,
          getMemoryContent
        );
        const timeoutPromise = new Promise<{ memoriesCount: number }>((_, reject) =>
          setTimeout(() => reject(new Error('Rebuild timeout after 60s')), 60000)
        );
        const result = await Promise.race([rebuildPromise, timeoutPromise]);

        method = result.memoriesCount > 0 ? 'rebuild' : 'empty';
        vectorCount = result.memoriesCount;
      } catch (rebuildError: any) {
        console.warn('⚠️ Rebuild failed or timed out:', rebuildError.message);
        method = 'empty';
        vectorCount = 0;
      }
    }

    // Step 4: Mark as dirty if vectors were synced or rebuilt (save will happen when saveIndex is called)
    // Note: We don't auto-save here because we don't have a signer
    // The caller should call saveIndexWithSigner() when ready to persist

    // Step 5: Start auto-save if enabled
    if (this.options.enableAutoSave) {
      this.startAutoSave(spaceId);
    }

    this.options.onProgress('complete', 100, 'Index initialization complete');

    return {
      restored: method === 'cache',
      method,
      vectorCount,
      syncedCount,
      timeMs: Date.now() - startTime,
    };
  }

  /**
   * Load index from Walrus (Option 2)
   */
  private async loadFromWalrus(spaceId: string, blobId: string): Promise<void> {
    // Download serialized index from Walrus
    const result = await this.storageService.retrieveMemoryPackage(blobId);

    // Parse the index package - it may be in memoryPackage or need to be extracted from content
    let pkg: SerializedIndexPackage;

    console.log('📥 Loading index from Walrus, parsing format...');
    console.log('  memoryPackage keys:', result.memoryPackage ? Object.keys(result.memoryPackage) : 'null');

    if (result.memoryPackage?.formatVersion === '1.0') {
      // Direct format match - SerializedIndexPackage at top level
      console.log('  Format: Direct SerializedIndexPackage');
      pkg = result.memoryPackage;
    } else if (result.memoryPackage?.content) {
      // Index was wrapped in memory package format
      // content could be a string (JSON) or already parsed object
      const content = result.memoryPackage.content;
      console.log('  Content type:', typeof content);

      if (typeof content === 'string') {
        // Parse JSON string
        try {
          pkg = JSON.parse(content);
          console.log('  Parsed content from JSON string');
        } catch (parseErr) {
          console.error('  Failed to parse content string:', parseErr);
          throw new Error('Failed to parse index package from memory package content');
        }
      } else if (typeof content === 'object' && content !== null) {
        // Already parsed object
        pkg = content as SerializedIndexPackage;
        console.log('  Content is already an object');
      } else {
        throw new Error('Invalid content type in memory package');
      }
    } else {
      // Try to parse raw content
      console.log('  Trying raw content parse...');
      try {
        const contentString = new TextDecoder().decode(result.content);
        const parsed = JSON.parse(contentString);

        // Check if it's wrapped in memory package format
        if (parsed.content && typeof parsed.content === 'string') {
          pkg = JSON.parse(parsed.content);
        } else if (parsed.formatVersion === '1.0') {
          pkg = parsed;
        } else {
          throw new Error('Unknown format');
        }
      } catch (err) {
        console.error('  Raw parse failed:', err);
        throw new Error('Invalid index package format - could not parse content');
      }
    }

    // Validate format version
    if (pkg.formatVersion !== '1.0') {
      throw new Error(`Unsupported index format version: ${pkg.formatVersion}`);
    }

    console.log(`✅ Parsed index package: ${pkg.vectors?.length || 0} vectors, version ${pkg.version}`);

    // Create new index with same config
    await this.vectorService.createIndex(spaceId, pkg.dimension, {
      maxElements: pkg.hnswConfig.maxElements,
      m: pkg.hnswConfig.m,
      efConstruction: pkg.hnswConfig.efConstruction,
    });

    // Restore vectors and metadata (VectorService caches vectors internally)
    const metadataMap = new Map<number, any>(pkg.metadata);

    for (const { vectorId, vector } of pkg.vectors) {
      await this.vectorService.addVector(spaceId, vectorId, vector, metadataMap.get(vectorId));
    }

    // Update index state
    this.indexStates.set(spaceId, {
      blobId,
      lastSyncTimestamp: pkg.timestamp,
      vectorCount: pkg.vectors.length,
      version: pkg.version,
      dimension: pkg.dimension,
    });

    console.log(`✅ Loaded index from Walrus: ${pkg.vectors.length} vectors`);
  }

  /**
   * Full rebuild from blockchain + Walrus (Option 1)
   */
  private async fullRebuild(
    spaceId: string,
    getMemoriesFromChain: () => Promise<Array<{
      id: string;
      blobId: string;
      vectorId?: number;
      category?: string;
      importance?: number;
      topic?: string;
      createdAt?: number;
    }>>,
    getMemoryContent: (blobId: string) => Promise<{
      content: string;
      embedding?: number[];
      metadata?: any;
    }>
  ): Promise<{ memoriesCount: number }> {
    // Get all memories from blockchain
    this.options.onProgress('rebuilding', 15, 'Fetching memories from blockchain...');
    const memories = await getMemoriesFromChain();

    if (memories.length === 0) {
      console.log('No memories found on blockchain');
      return { memoriesCount: 0 };
    }

    this.options.onProgress('rebuilding', 20, `Found ${memories.length} memories, rebuilding index...`);

    // Determine dimension from first memory with embedding
    let dimension = 3072; // Default

    // Create index
    await this.vectorService.createIndex(spaceId, dimension, {
      maxElements: Math.max(10000, memories.length * 2),
      m: 16,
      efConstruction: 200,
    });

    // Process each memory (VectorService caches vectors internally)
    let processed = 0;
    const batchSize = 10;

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (memory) => {
          try {
            // Fetch content from Walrus
            const content = await getMemoryContent(memory.blobId);

            let embedding = content.embedding;

            // Generate embedding if not stored
            if (!embedding || embedding.length === 0) {
              const result = await this.embeddingService.embedText({ text: content.content });
              embedding = result.vector;
            }

            // Update dimension if needed
            if (processed === 0 && embedding.length !== dimension) {
              dimension = embedding.length;
            }

            const vectorId = memory.vectorId ?? Date.now() % 4294967295;

            // Add to index (VectorService caches vector internally)
            await this.vectorService.addVector(spaceId, vectorId, embedding, {
              blobId: memory.blobId,
              memoryId: memory.id,
              category: memory.category,
              importance: memory.importance,
              topic: memory.topic,
              timestamp: memory.createdAt || Date.now(),
            });

            processed++;
          } catch (error) {
            console.warn(`Failed to rebuild memory ${memory.id}:`, error);
          }
        })
      );

      const progress = 20 + Math.floor((processed / memories.length) * 70);
      this.options.onProgress('rebuilding', progress, `Processed ${processed}/${memories.length} memories`);
    }

    console.log(`✅ Rebuilt index: ${processed} vectors`);

    return { memoriesCount: processed };
  }

  /**
   * Sync new memories since last save (incremental update)
   */
  private async syncNewMemories(
    spaceId: string,
    lastSyncTimestamp: number,
    getMemoriesFromChain: () => Promise<Array<{
      id: string;
      blobId: string;
      vectorId?: number;
      category?: string;
      importance?: number;
      topic?: string;
      createdAt?: number;
    }>>,
    getMemoryContent: (blobId: string) => Promise<{
      content: string;
      embedding?: number[];
      metadata?: any;
    }>
  ): Promise<number> {
    // Get all memories
    const allMemories = await getMemoriesFromChain();

    // Filter to only new memories
    const newMemories = allMemories.filter(
      (m) => (m.createdAt || 0) > lastSyncTimestamp
    );

    if (newMemories.length === 0) {
      console.log('✅ Index is up to date');
      return 0;
    }

    console.log(`🔄 Syncing ${newMemories.length} new memories...`);

    let synced = 0;

    for (const memory of newMemories) {
      try {
        const content = await getMemoryContent(memory.blobId);

        let embedding = content.embedding;

        if (!embedding || embedding.length === 0) {
          const result = await this.embeddingService.embedText({ text: content.content });
          embedding = result.vector;
        }

        const vectorId = memory.vectorId ?? Date.now() % 4294967295;

        // Add to index (VectorService caches vector internally)
        await this.vectorService.addVector(spaceId, vectorId, embedding, {
          blobId: memory.blobId,
          memoryId: memory.id,
          category: memory.category,
          importance: memory.importance,
          topic: memory.topic,
          timestamp: memory.createdAt || Date.now(),
        });

        synced++;
      } catch (error) {
        console.warn(`Failed to sync memory ${memory.id}:`, error);
      }
    }

    return synced;
  }

  /**
   * Save index to Walrus
   */
  async saveIndex(spaceId: string): Promise<string | null> {
    const stats = this.vectorService.getIndexStats(spaceId);
    if (!stats || stats.currentElements === 0) {
      console.log('No vectors to save');
      return null;
    }

    // Get all vectors and metadata
    const allVectors = this.vectorService.getAllVectors(spaceId);

    // Get vectors from VectorService cache (single source of truth)
    const vectorMap = this.vectorService.getAllCachedVectors(spaceId);

    if (vectorMap.size === 0) {
      console.warn('Vector cache is empty, cannot save index');
      return null;
    }

    // Build serialized package
    const currentState = this.indexStates.get(spaceId);
    const pkg: SerializedIndexPackage = {
      formatVersion: '1.0',
      spaceId,
      version: (currentState?.version || 0) + 1,
      dimension: currentState?.dimension || 3072,
      timestamp: Date.now(),
      vectors: allVectors
        .filter(({ vectorId }) => vectorMap.has(vectorId))
        .map(({ vectorId }) => ({
          vectorId,
          vector: vectorMap.get(vectorId)!,
        })),
      metadata: allVectors.map(({ vectorId, metadata }) => [vectorId, metadata]),
      hnswConfig: {
        maxElements: stats.maxElements || 10000,
        m: 16,
        efConstruction: 200,
      },
    };

    // Upload to Walrus as JSON package
    const result = await this.storageService.uploadMemoryPackage(
      {
        content: JSON.stringify(pkg),
        embedding: [],
        metadata: {
          category: 'vector-index',
          type: 'hnsw-index-package',
          spaceId,
          version: pkg.version,
        },
        identity: spaceId,
      },
      {
        signer: null as any, // Will be provided by caller
        epochs: 5, // Longer retention for index
        deletable: true,
      }
    );

    // Update state
    const state: IndexState = {
      blobId: result.blobId,
      lastSyncTimestamp: pkg.timestamp,
      vectorCount: pkg.vectors.length,
      version: pkg.version,
      dimension: pkg.dimension,
    };

    this.indexStates.set(spaceId, state);
    this.saveIndexState(spaceId, state);

    console.log(`💾 Index saved to Walrus: ${result.blobId} (${pkg.vectors.length} vectors)`);

    return result.blobId;
  }

  /**
   * Save index with signer (public API)
   *
   * This method:
   * 1. Uploads index to Walrus
   * 2. Creates or updates MemoryIndex on-chain (if transactionService is available)
   * 3. Updates local state
   *
   * @param spaceId - User address
   * @param signer - Wallet signer for transactions
   * @returns Blob ID of saved index
   */
  async saveIndexWithSigner(
    spaceId: string,
    signer: any
  ): Promise<string | null> {
    const stats = this.vectorService.getIndexStats(spaceId);
    if (!stats || stats.currentElements === 0) {
      console.log('No vectors to save');
      return null;
    }

    const allVectors = this.vectorService.getAllVectors(spaceId);

    // Get vectors from VectorService cache (single source of truth)
    const vectorMap = this.vectorService.getAllCachedVectors(spaceId);

    if (vectorMap.size === 0) {
      console.warn('Vector cache is empty, cannot save index');
      return null;
    }

    const currentState = this.indexStates.get(spaceId);
    const newVersion = (currentState?.version || 0) + 1;

    const pkg: SerializedIndexPackage = {
      formatVersion: '1.0',
      spaceId,
      version: newVersion,
      dimension: currentState?.dimension || 3072,
      timestamp: Date.now(),
      vectors: allVectors
        .filter(({ vectorId }) => vectorMap.has(vectorId))
        .map(({ vectorId }) => ({
          vectorId,
          vector: vectorMap.get(vectorId)!,
        })),
      metadata: allVectors.map(({ vectorId, metadata }) => [vectorId, metadata]),
      hnswConfig: {
        maxElements: stats.maxElements || 10000,
        m: 16,
        efConstruction: 200,
      },
    };

    // Step 1: Upload index to Walrus
    const result = await this.storageService.uploadMemoryPackage(
      {
        content: JSON.stringify(pkg),
        embedding: [],
        metadata: {
          category: 'vector-index',
          type: 'hnsw-index-package',
          spaceId,
          version: pkg.version,
        },
        identity: spaceId,
      },
      {
        signer,
        epochs: 5,
        deletable: true,
      }
    );

    console.log(`💾 Index uploaded to Walrus: ${result.blobId} (${pkg.vectors.length} vectors)`);

    // Step 2: Create or update MemoryIndex on-chain
    // SerialTransactionExecutor handles gas coin management and prevents equivocation
    let onChainIndexId = currentState?.onChainIndexId;
    const graphBlobId = currentState?.graphBlobId || ''; // Empty for now, could be knowledge graph

    if (this.options.transactionService && this.options.executeTransaction) {
      try {
        if (!onChainIndexId) {
          // Create new MemoryIndex on-chain
          console.log('📝 Creating new MemoryIndex on-chain...');
          const tx = this.options.transactionService.buildCreateMemoryIndex({
            indexBlobId: result.blobId,
            graphBlobId: graphBlobId,
          });

          const txResult = await this.options.executeTransaction(tx, signer);

          if (txResult.digest && !txResult.error) {
            console.log(`✅ MemoryIndex created on-chain: ${txResult.digest}`);

            // Extract created object ID from transaction effects
            if (txResult.effects?.created?.[0]?.reference?.objectId) {
              onChainIndexId = txResult.effects.created[0].reference.objectId;
              console.log(`   Object ID: ${onChainIndexId}`);
            }
          } else {
            console.warn('⚠️ Failed to create on-chain MemoryIndex:', txResult.error);
          }
        } else {
          // Update existing MemoryIndex on-chain
          console.log(`📝 Updating MemoryIndex on-chain (v${currentState?.version} → v${newVersion})...`);
          const tx = this.options.transactionService.buildUpdateMemoryIndex({
            indexId: onChainIndexId,
            expectedVersion: currentState?.version || 1,
            newIndexBlobId: result.blobId,
            newGraphBlobId: graphBlobId,
          });

          const txResult = await this.options.executeTransaction(tx, signer);

          if (txResult.digest && !txResult.error) {
            console.log(`✅ MemoryIndex updated on-chain: ${txResult.digest}`);
          } else {
            console.warn('⚠️ Failed to update on-chain MemoryIndex:', txResult.error);
          }
        }
      } catch (error: any) {
        console.warn('⚠️ Failed to sync MemoryIndex on-chain:', error.message);
      }
    }

    // Step 3: Update local state
    const state: IndexState = {
      blobId: result.blobId,
      graphBlobId: graphBlobId,
      lastSyncTimestamp: pkg.timestamp,
      vectorCount: pkg.vectors.length,
      version: newVersion,
      dimension: pkg.dimension,
      onChainIndexId: onChainIndexId,
    };

    this.indexStates.set(spaceId, state);
    this.saveIndexState(spaceId, state);

    console.log(`💾 Index saved: ${result.blobId} (${pkg.vectors.length} vectors, v${newVersion})`);

    return result.blobId;
  }

  /**
   * Add vector and cache it for serialization
   * Note: VectorService now handles caching internally, this method is kept for API compatibility
   */
  async addVectorWithCache(
    spaceId: string,
    vectorId: number,
    vector: number[],
    metadata?: any
  ): Promise<void> {
    // VectorService.addVector now caches vectors internally
    await this.vectorService.addVector(spaceId, vectorId, vector, metadata);
  }

  /**
   * Start auto-save interval
   */
  private startAutoSave(spaceId: string): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(async () => {
      const stats = this.vectorService.getIndexStats(spaceId);
      if (stats?.isDirty) {
        try {
          console.log('🔄 Auto-saving index...');
          await this.saveIndex(spaceId);
        } catch (error) {
          console.error('Auto-save failed:', error);
        }
      }
    }, this.options.autoSaveInterval);

    console.log(`🔄 Auto-save enabled (every ${this.options.autoSaveInterval / 1000}s)`);
  }

  /**
   * Stop auto-save
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
      console.log('Auto-save disabled');
    }
  }

  /**
   * Load index state from localStorage
   */
  private loadIndexState(spaceId: string): IndexState | null {
    const key = `${this.options.storageKeyPrefix}${spaceId}`;
    const data = this.storage.getItem(key);

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as IndexState;
    } catch {
      return null;
    }
  }

  /**
   * Save index state to localStorage
   */
  private saveIndexState(spaceId: string, state: IndexState): void {
    const key = `${this.options.storageKeyPrefix}${spaceId}`;
    this.storage.setItem(key, JSON.stringify(state));
  }

  /**
   * Clear cached index state
   */
  clearIndexState(spaceId: string): void {
    const key = `${this.options.storageKeyPrefix}${spaceId}`;
    this.storage.removeItem(key);
    this.indexStates.delete(spaceId);
    // Note: VectorService cache is managed by HnswWasmService LRU cache
    console.log(`Cleared index state for ${spaceId}`);
  }

  /**
   * Get current index state
   */
  getIndexState(spaceId: string): IndexState | null {
    return this.indexStates.get(spaceId) || this.loadIndexState(spaceId);
  }

  /**
   * Force a full rebuild (useful for troubleshooting)
   */
  async forceRebuild(
    spaceId: string,
    getMemoriesFromChain: () => Promise<Array<{
      id: string;
      blobId: string;
      vectorId?: number;
      category?: string;
      importance?: number;
      topic?: string;
      createdAt?: number;
    }>>,
    getMemoryContent: (blobId: string) => Promise<{
      content: string;
      embedding?: number[];
      metadata?: any;
    }>
  ): Promise<{ memoriesCount: number }> {
    // Clear existing state
    this.clearIndexState(spaceId);

    // Full rebuild
    return this.fullRebuild(spaceId, getMemoriesFromChain, getMemoryContent);
  }

  /**
   * Get statistics
   */
  getStats(spaceId: string): {
    indexState: IndexState | null;
    vectorCacheSize: number;
    isAutoSaveEnabled: boolean;
  } {
    return {
      indexState: this.getIndexState(spaceId),
      vectorCacheSize: this.vectorService.getAllCachedVectors(spaceId).size,
      isAutoSaveEnabled: !!this.autoSaveTimer,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.stopAutoSave();
    this.indexStates.clear();
    // Note: VectorService cleanup is handled by its own cleanup() method
  }
}
