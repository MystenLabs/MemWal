/**
 * BatchingService - Intelligent Batch Processing & Caching
 * 
 * Provides advanced batching capabilities with intelligent scheduling,
 * cache management, and performance optimization for the PDW SDK.
 */

import { BatchConfig, BatchJob, BatchStats } from '../embedding/types';

export interface BatchItem<T = any> {
  id: string;
  data: T;
  timestamp: Date;
  priority?: number;
  metadata?: any;
}

export interface BatchProcessor<T = any> {
  process(items: BatchItem<T>[]): Promise<void>;
}

export interface CacheConfig {
  maxSize?: number;
  ttlMs?: number;
  cleanupIntervalMs?: number;
  enableMetrics?: boolean;
}

export interface CacheItem<T = any> {
  key: string;
  value: T;
  createdAt: Date;
  accessedAt: Date;
  accessCount: number;
  size?: number;
}

export interface CacheMetrics {
  totalItems: number;
  totalSize: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  averageAccessCount: number;
  oldestItem?: Date;
  newestItem?: Date;
}

/**
 * Advanced batching service with intelligent scheduling and caching
 */
export class BatchingService<T = any> {
  private batches = new Map<string, BatchItem<T>[]>();
  private processors = new Map<string, BatchProcessor<T>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private cache = new Map<string, CacheItem<T>>();
  private metrics = {
    hitCount: 0,
    missCount: 0,
    totalProcessed: 0,
    averageProcessingTime: 0
  };

  private readonly batchConfig: Required<BatchConfig>;
  private readonly cacheConfig: Required<CacheConfig>;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    batchConfig: Partial<BatchConfig> = {},
    cacheConfig: Partial<CacheConfig> = {}
  ) {
    this.batchConfig = {
      maxBatchSize: batchConfig.maxBatchSize || 50,
      batchDelayMs: batchConfig.batchDelayMs || 5000,
      maxCacheSize: batchConfig.maxCacheSize || 1000,
      cacheTtlMs: batchConfig.cacheTtlMs || 30 * 60 * 1000 // 30 minutes
    };

    this.cacheConfig = {
      maxSize: cacheConfig.maxSize || this.batchConfig.maxCacheSize,
      ttlMs: cacheConfig.ttlMs || this.batchConfig.cacheTtlMs,
      cleanupIntervalMs: cacheConfig.cleanupIntervalMs || 5 * 60 * 1000, // 5 minutes
      enableMetrics: cacheConfig.enableMetrics !== false
    };

    this.startCacheCleanup();
  }

  /**
   * Register a batch processor for a specific batch type
   */
  registerProcessor(batchType: string, processor: BatchProcessor<T>): void {
    this.processors.set(batchType, processor);
  }

  /**
   * Add item to batch for processing
   */
  addToBatch(
    batchType: string,
    item: BatchItem<T>,
    options: {
      forceImmediate?: boolean;
      highPriority?: boolean;
    } = {}
  ): void {
    // Get or create batch
    let batch = this.batches.get(batchType);
    if (!batch) {
      batch = [];
      this.batches.set(batchType, batch);
    }

    // Add item to batch
    batch.push({
      ...item,
      priority: options.highPriority ? 1 : (item.priority || 0)
    });

    // Sort by priority (higher priority first)
    batch.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    console.debug(`Added item to batch ${batchType}. Size: ${batch.length}`);

    // Schedule processing
    this.scheduleBatchProcessing(batchType, options.forceImmediate);
  }

  /**
   * Process batch immediately
   */
  async processBatchNow(batchType: string): Promise<void> {
    const batch = this.batches.get(batchType);
    if (!batch || batch.length === 0) {
      return;
    }

    const processor = this.processors.get(batchType);
    if (!processor) {
      console.warn(`No processor registered for batch type: ${batchType}`);
      return;
    }

    const startTime = Date.now();

    try {
      console.log(`Processing batch ${batchType} with ${batch.length} items`);

      // Process the batch
      await processor.process([...batch]);

      // Clear batch and timer
      this.batches.delete(batchType);
      const timer = this.timers.get(batchType);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(batchType);
      }

      // Update metrics
      this.metrics.totalProcessed += batch.length;
      const processingTime = Date.now() - startTime;
      this.metrics.averageProcessingTime = 
        (this.metrics.averageProcessingTime + processingTime) / 2;

      console.log(`Successfully processed batch ${batchType} in ${processingTime}ms`);
    } catch (error) {
      console.error(`Error processing batch ${batchType}:`, error);
      throw error;
    }
  }

  /**
   * Get cached value
   */
  getFromCache<R = T>(key: string): R | undefined {
    const item = this.cache.get(key) as CacheItem<R> | undefined;
    
    if (!item) {
      this.metrics.missCount++;
      return undefined;
    }

    // Check TTL
    const now = Date.now();
    if (now - item.createdAt.getTime() > this.cacheConfig.ttlMs) {
      this.cache.delete(key);
      this.metrics.missCount++;
      return undefined;
    }

    // Update access info
    item.accessedAt = new Date();
    item.accessCount++;
    this.metrics.hitCount++;

    return item.value;
  }

  /**
   * Set cached value
   */
  setInCache<R = T>(key: string, value: R, metadata?: any): void {
    // Check cache size limit
    if (this.cache.size >= this.cacheConfig.maxSize) {
      this.evictOldestItems(Math.floor(this.cacheConfig.maxSize * 0.1)); // Evict 10%
    }

    const now = new Date();
    const item: CacheItem<R> = {
      key,
      value,
      createdAt: now,
      accessedAt: now,
      accessCount: 1,
      size: this.calculateSize(value)
    };

    this.cache.set(key, item as any);
  }

  /**
   * Remove from cache
   */
  removeFromCache(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear entire cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get batch statistics
   */
  getBatchStats(): BatchStats & {
    cache: CacheMetrics;
    processing: {
      totalProcessed: number;
      averageProcessingTime: number;
    };
  } {
    const activeBatches = Array.from(this.batches.entries());
    const totalPendingItems = activeBatches.reduce((sum, [, batch]) => sum + batch.length, 0);

    return {
      totalUsers: activeBatches.length,
      totalPendingVectors: totalPendingItems, // Generic pending items
      activeBatchJobs: this.timers.size,
      cacheHitRate: this.getCacheHitRate(),
      averageBatchSize: activeBatches.length > 0 
        ? totalPendingItems / activeBatches.length 
        : 0,
      averageProcessingTime: this.metrics.averageProcessingTime,
      cache: this.getCacheMetrics(),
      processing: {
        totalProcessed: this.metrics.totalProcessed,
        averageProcessingTime: this.metrics.averageProcessingTime
      }
    };
  }

  /**
   * Get pending batch info
   */
  getPendingBatches(): Array<{
    batchType: string;
    itemCount: number;
    oldestItem: Date;
    scheduledProcessing: Date | null;
  }> {
    return Array.from(this.batches.entries()).map(([batchType, batch]) => {
      const oldestItem = batch.reduce((oldest, item) => 
        item.timestamp < oldest ? item.timestamp : oldest, 
        batch[0]?.timestamp || new Date()
      );

      return {
        batchType,
        itemCount: batch.length,
        oldestItem,
        scheduledProcessing: null // TODO: Track scheduled processing time
      };
    });
  }

  /**
   * Force process all pending batches
   */
  async processAllBatches(): Promise<void> {
    const batchTypes = Array.from(this.batches.keys());
    
    for (const batchType of batchTypes) {
      try {
        await this.processBatchNow(batchType);
      } catch (error) {
        console.error(`Failed to process batch ${batchType}:`, error);
      }
    }
  }

  /**
   * Cleanup and destroy service
   */
  destroy(): void {
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Clear data
    this.batches.clear();
    this.processors.clear();
    this.cache.clear();

    console.log('BatchingService destroyed');
  }

  // ==================== PRIVATE METHODS ====================

  private scheduleBatchProcessing(batchType: string, forceImmediate = false): void {
    const batch = this.batches.get(batchType);
    if (!batch) return;

    // Clear existing timer
    const existingTimer = this.timers.get(batchType);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Process immediately if conditions met
    if (forceImmediate || batch.length >= this.batchConfig.maxBatchSize) {
      setImmediate(() => this.processBatchNow(batchType));
      return;
    }

    // Schedule delayed processing
    const timer = setTimeout(
      () => this.processBatchNow(batchType),
      this.batchConfig.batchDelayMs
    );
    
    this.timers.set(batchType, timer);
  }

  private startCacheCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredItems();
    }, this.cacheConfig.cleanupIntervalMs);
  }

  private cleanupExpiredItems(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now - item.createdAt.getTime() > this.cacheConfig.ttlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.debug(`Cleaned up ${cleaned} expired cache items`);
    }
  }

  private evictOldestItems(count: number): void {
    const items = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.accessedAt.getTime() - b.accessedAt.getTime())
      .slice(0, count);

    for (const [key] of items) {
      this.cache.delete(key);
    }

    console.debug(`Evicted ${items.length} oldest cache items`);
  }

  private getCacheHitRate(): number {
    const totalRequests = this.metrics.hitCount + this.metrics.missCount;
    return totalRequests > 0 ? this.metrics.hitCount / totalRequests : 0;
  }

  private getCacheMetrics(): CacheMetrics {
    const items = Array.from(this.cache.values());
    
    return {
      totalItems: items.length,
      totalSize: items.reduce((sum, item) => sum + (item.size || 0), 0),
      hitCount: this.metrics.hitCount,
      missCount: this.metrics.missCount,
      hitRate: this.getCacheHitRate(),
      averageAccessCount: items.length > 0 
        ? items.reduce((sum, item) => sum + item.accessCount, 0) / items.length 
        : 0,
      oldestItem: items.length > 0 
        ? items.reduce((oldest, item) => 
            item.createdAt < oldest ? item.createdAt : oldest, 
            items[0].createdAt
          )
        : undefined,
      newestItem: items.length > 0
        ? items.reduce((newest, item) => 
            item.createdAt > newest ? item.createdAt : newest, 
            items[0].createdAt
          )
        : undefined
    };
  }

  private calculateSize(value: any): number {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
}

export default BatchingService;