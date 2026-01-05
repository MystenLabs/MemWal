/**
 * LRUCache - Memory-efficient LRU Cache with TTL and size limits
 *
 * Features:
 * - Least Recently Used eviction
 * - Time-to-live (TTL) expiration
 * - Maximum entry count limit
 * - Optional memory size estimation
 * - Automatic cleanup interval
 */

export interface LRUCacheOptions<V> {
  /** Maximum number of entries (default: 100) */
  maxSize?: number;
  /** Time-to-live in milliseconds (default: 30 minutes) */
  ttlMs?: number;
  /** Cleanup interval in milliseconds (default: 60 seconds) */
  cleanupIntervalMs?: number;
  /** Optional function to estimate memory size of a value */
  sizeEstimator?: (value: V) => number;
  /** Maximum total memory in bytes (optional, requires sizeEstimator) */
  maxMemoryBytes?: number;
  /** Callback when entry is evicted */
  onEvict?: (key: string, value: V, reason: 'lru' | 'ttl' | 'memory' | 'manual') => void;
}

interface CacheEntry<V> {
  value: V;
  lastAccessed: number;
  createdAt: number;
  size?: number;
}

export class LRUCache<V> {
  private cache: Map<string, CacheEntry<V>> = new Map();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly sizeEstimator?: (value: V) => number;
  private readonly maxMemoryBytes?: number;
  private readonly onEvict?: (key: string, value: V, reason: 'lru' | 'ttl' | 'memory' | 'manual') => void;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private currentMemoryBytes: number = 0;

  constructor(options: LRUCacheOptions<V> = {}) {
    this.maxSize = options.maxSize ?? 100;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000; // 30 minutes
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 1000; // 1 minute
    this.sizeEstimator = options.sizeEstimator;
    this.maxMemoryBytes = options.maxMemoryBytes;
    this.onEvict = options.onEvict;

    this.startCleanup();
  }

  /**
   * Get value from cache (updates last accessed time)
   */
  get(key: string): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.delete(key, 'ttl');
      return undefined;
    }

    // Update last accessed time
    entry.lastAccessed = Date.now();
    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: string, value: V): void {
    const now = Date.now();

    // Calculate size if estimator provided
    const size = this.sizeEstimator ? this.sizeEstimator(value) : undefined;

    // If key exists, remove old entry first
    if (this.cache.has(key)) {
      this.delete(key, 'manual');
    }

    // Evict if necessary before adding
    this.evictIfNeeded(size);

    // Add new entry
    const entry: CacheEntry<V> = {
      value,
      lastAccessed: now,
      createdAt: now,
      size,
    };

    this.cache.set(key, entry);

    if (size) {
      this.currentMemoryBytes += size;
    }
  }

  /**
   * Check if key exists (without updating access time)
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.delete(key, 'ttl');
      return false;
    }

    return true;
  }

  /**
   * Delete entry from cache
   */
  delete(key: string, reason: 'lru' | 'ttl' | 'memory' | 'manual' = 'manual'): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    if (entry.size) {
      this.currentMemoryBytes -= entry.size;
    }

    this.cache.delete(key);

    if (this.onEvict) {
      this.onEvict(key, entry.value, reason);
    }

    return true;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    if (this.onEvict) {
      for (const [key, entry] of this.cache.entries()) {
        this.onEvict(key, entry.value, 'manual');
      }
    }
    this.cache.clear();
    this.currentMemoryBytes = 0;
  }

  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get current memory usage (if sizeEstimator provided)
   */
  get memoryBytes(): number {
    return this.currentMemoryBytes;
  }

  /**
   * Get all keys
   */
  keys(): IterableIterator<string> {
    return this.cache.keys();
  }

  /**
   * Get all entries
   */
  entries(): IterableIterator<[string, V]> {
    const self = this;
    return (function* () {
      for (const [key, entry] of self.cache.entries()) {
        yield [key, entry.value] as [string, V];
      }
    })();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    memoryBytes: number;
    maxMemoryBytes?: number;
    ttlMs: number;
    oldestEntry?: number;
    newestEntry?: number;
  } {
    let oldestEntry: number | undefined;
    let newestEntry: number | undefined;

    for (const entry of this.cache.values()) {
      if (!oldestEntry || entry.createdAt < oldestEntry) {
        oldestEntry = entry.createdAt;
      }
      if (!newestEntry || entry.createdAt > newestEntry) {
        newestEntry = entry.createdAt;
      }
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      memoryBytes: this.currentMemoryBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      ttlMs: this.ttlMs,
      oldestEntry,
      newestEntry,
    };
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }

  // ==================== Private Methods ====================

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.cleanupIntervalMs);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.delete(key, 'ttl');
    }

    if (expiredKeys.length > 0) {
      console.debug(`[LRUCache] Cleaned up ${expiredKeys.length} expired entries`);
    }
  }

  private evictIfNeeded(newEntrySize?: number): void {
    // Evict by count
    while (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    // Evict by memory (if configured)
    if (this.maxMemoryBytes && newEntrySize) {
      while (this.currentMemoryBytes + newEntrySize > this.maxMemoryBytes && this.cache.size > 0) {
        this.evictLRU('memory');
      }
    }
  }

  private evictLRU(reason: 'lru' | 'memory' = 'lru'): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey, reason);
    }
  }
}

/**
 * Estimate memory size of common JavaScript values
 */
export function estimateSize(value: unknown): number {
  if (value === null || value === undefined) {
    return 8;
  }

  if (typeof value === 'boolean') {
    return 4;
  }

  if (typeof value === 'number') {
    return 8;
  }

  if (typeof value === 'string') {
    return value.length * 2; // UTF-16
  }

  if (Array.isArray(value)) {
    let size = 24; // Array overhead
    for (const item of value) {
      size += estimateSize(item);
    }
    return size;
  }

  if (value instanceof Float32Array) {
    return 24 + value.length * 4;
  }

  if (value instanceof Float64Array) {
    return 24 + value.length * 8;
  }

  if (ArrayBuffer.isView(value)) {
    return 24 + (value as any).byteLength;
  }

  if (typeof value === 'object') {
    let size = 24; // Object overhead
    for (const key of Object.keys(value as object)) {
      size += key.length * 2; // Key
      size += estimateSize((value as Record<string, unknown>)[key]); // Value
    }
    return size;
  }

  return 8; // Default
}

/**
 * Estimate size of HNSW index cache entry
 */
export function estimateIndexCacheSize(entry: {
  vectors: Map<number, number[]>;
  metadata: Map<number, unknown>;
  pendingVectors?: Map<number, number[]>;
}): number {
  let size = 100; // Base overhead

  // Vectors: each vector is Float64 array
  for (const vector of entry.vectors.values()) {
    size += 24 + vector.length * 8; // Array + Float64 values
  }

  // Pending vectors
  if (entry.pendingVectors) {
    for (const vector of entry.pendingVectors.values()) {
      size += 24 + vector.length * 8;
    }
  }

  // Metadata (rough estimate)
  size += entry.metadata.size * 200; // Average 200 bytes per metadata entry

  return size;
}

export default LRUCache;
