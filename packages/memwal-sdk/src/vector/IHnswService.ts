/**
 * IHnswService - Abstract Interface for HNSW Vector Indexing
 *
 * Provides a common interface for both browser (hnswlib-wasm) and
 * Node.js (hnswlib-node) implementations.
 *
 * Types defined here are specific to IHnswService and its implementations.
 * Legacy types in embedding/types.ts are preserved for backward compatibility.
 */

// ==================== IHnswService Types ====================

/**
 * Configuration for HNSW index
 */
export interface IHnswIndexConfig {
  /** Vector dimension (e.g., 3072 for text-embedding-004) */
  dimension: number;
  /** Maximum number of elements in the index */
  maxElements?: number;
  /** ef parameter during construction (higher = better quality, slower build) */
  efConstruction?: number;
  /** Number of bi-directional links per element */
  m?: number;
  /** Random seed for reproducibility */
  randomSeed?: number;
  /** Distance metric */
  spaceType?: 'cosine' | 'l2' | 'ip';
}

/**
 * Single search result item
 */
export interface IHnswSearchResultItem {
  /** Vector ID in the index */
  vectorId: number;
  /** Distance from query vector (lower = more similar for cosine/l2) */
  distance: number;
  /** Similarity score (higher = more similar, typically 1 - distance for cosine) */
  score: number;
  /** Optional metadata associated with the vector */
  metadata?: Record<string, any>;
}

/**
 * Search options for IHnswService
 */
export interface IHnswSearchOptions {
  /** Number of results to return */
  k?: number;
  /** ef parameter for search (higher = better recall, slower search) */
  ef?: number;
  /** Minimum similarity score threshold (results below this are filtered) */
  minScore?: number;
  /** Maximum distance threshold (results above this are filtered) */
  maxDistance?: number;
  /** Optional metadata filter function */
  filter?: (metadata: Record<string, any>) => boolean;
}

/**
 * Batch processing statistics
 */
export interface IHnswBatchStats {
  /** Number of pending jobs in queue */
  pendingJobs: number;
  /** Number of successfully completed jobs */
  completedJobs: number;
  /** Number of failed jobs */
  failedJobs: number;
  /** Average processing time in milliseconds */
  averageProcessingTime: number;
}

// ==================== IHnswService Interface ====================

/**
 * Common interface for HNSW vector indexing services.
 * Implemented by both BrowserHnswIndexService and NodeHnswService.
 */
export interface IHnswService {
  /**
   * Initialize the service (load WASM/native bindings)
   */
  initialize(): Promise<void>;

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean;

  /**
   * Create or get an index for a user
   */
  getOrCreateIndex(userAddress: string): Promise<void>;

  /**
   * Add a vector to the index
   */
  addVector(
    userAddress: string,
    vectorId: number,
    vector: number[],
    metadata?: Record<string, any>
  ): Promise<void>;

  /**
   * Search for similar vectors
   * @returns Array of search results sorted by similarity (descending)
   */
  search(
    userAddress: string,
    queryVector: number[],
    options?: IHnswSearchOptions
  ): Promise<IHnswSearchResultItem[]>;

  /**
   * Remove a vector from the index
   */
  removeVector(userAddress: string, vectorId: number): Promise<void>;

  /**
   * Get batch processing statistics
   */
  getBatchStats(): IHnswBatchStats;

  /**
   * Flush pending batch operations
   */
  flushBatch(userAddress: string): Promise<void>;

  /**
   * Save index to persistent storage
   */
  saveIndex(userAddress: string): Promise<void>;

  /**
   * Load index from persistent storage
   * @returns true if index was loaded, false if no existing index found
   */
  loadIndex(userAddress: string): Promise<boolean>;

  /**
   * Delete an index
   */
  deleteIndex(userAddress: string): Promise<void>;

  /**
   * Sync index to Walrus storage (optional - returns blobId if Walrus backup is enabled)
   */
  syncToWalrus?(userAddress: string): Promise<string | null>;

  /**
   * Load index from Walrus storage
   * @param blobId - Walrus blob ID containing the index
   * @returns true if index was loaded, false if failed
   */
  loadFromWalrus?(userAddress: string, blobId: string): Promise<boolean>;

  /**
   * Get the latest Walrus blob ID for the index (if backed up)
   */
  getWalrusBlobId?(userAddress: string): string | null;

  /**
   * Destroy the service and cleanup resources
   */
  destroy(): void;
}

// ==================== Factory Configuration ====================

/**
 * Walrus storage configuration for index backup
 */
export interface WalrusBackupConfig {
  /** Enable Walrus backup */
  enabled: boolean;
  /** Walrus aggregator URL */
  aggregatorUrl: string;
  /** Walrus publisher URL */
  publisherUrl: string;
  /** Auto-sync to Walrus after saveIndex() */
  autoSync?: boolean;
  /** Storage epochs (default: 3) */
  epochs?: number;
}

/**
 * Configuration for creating HNSW service via factory
 */
export interface HnswServiceConfig {
  /** HNSW index configuration */
  indexConfig?: Partial<IHnswIndexConfig>;
  /** Batch processing configuration */
  batchConfig?: {
    maxBatchSize?: number;
    batchDelayMs?: number;
    maxCacheSize?: number;
    cacheTtlMs?: number;
  };
  /** Directory for storing indexes (Node.js only) */
  indexDirectory?: string;
  /** Walrus backup configuration (optional) */
  walrusBackup?: WalrusBackupConfig;
  /** Memory management configuration for LRU cache */
  memoryConfig?: {
    /** Maximum number of cached indexes (default: 5) */
    maxCachedIndexes?: number;
    /** TTL for cached indexes in ms (default: 10 minutes) */
    indexTtlMs?: number;
    /** Maximum memory in MB (default: 512MB) */
    maxMemoryMB?: number;
  };
}

// ==================== Environment Detection ====================

/**
 * Check if running in browser environment with required APIs
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

/**
 * Check if running in Node.js environment
 */
export function isNode(): boolean {
  return typeof process !== 'undefined' &&
         process.versions != null &&
         process.versions.node != null;
}
