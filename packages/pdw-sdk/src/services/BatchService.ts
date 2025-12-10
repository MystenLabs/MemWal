/**
 * BatchService - Unified Batch Processing & Caching
 * 
 * Consolidated service combining intelligent batch processing, caching,
 * and coordination for all PDW SDK operations.
 * 
 * Replaces: BatchingService + BatchManager
 */

import EventEmitter from 'eventemitter3';
import type { BatchConfig, BatchStats } from '../core';

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
  timestamp: Date;
  expiresAt?: Date;
  accessCount: number;
  lastAccessed: Date;
}

export interface BatchServiceConfig {
  embedding?: {
    batchSize?: number;
    delayMs?: number;
  };
  indexing?: {
    batchSize?: number;
    delayMs?: number;
  };
  storage?: {
    batchSize?: number;
    delayMs?: number;
  };
  cache?: CacheConfig;
  enableMetrics?: boolean;
}

/**
 * BatchService provides unified batch processing including:
 * - Intelligent batching with configurable delays and sizes
 * - LRU cache with TTL support
 * - Event-driven batch coordination
 * - Performance metrics and monitoring
 */
export class BatchService extends EventEmitter {
  private queues: Map<string, BatchItem[]> = new Map();
  private processors: Map<string, BatchProcessor> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private cache: Map<string, CacheItem> = new Map();
  private stats: Map<string, BatchStats> = new Map();
  
  constructor(private config: BatchServiceConfig = {}) {
    super();
    this.setupCleanupTimer();
  }

  /**
   * Register a batch processor for a specific operation type
   */
  registerProcessor<T>(type: string, processor: BatchProcessor<T>): void {
    this.processors.set(type, processor);
    this.queues.set(type, []);
    this.stats.set(type, {
      totalBatches: 0,
      totalItems: 0,
      averageBatchSize: 0,
      totalProcessingTime: 0,
      averageProcessingTime: 0,
      successCount: 0,
      errorCount: 0,
      lastProcessed: new Date(),
      pendingBatches: 0,
      processedToday: 0
    });
  }

  /**
   * Add item to batch queue
   */
  async addToBatch<T>(type: string, item: BatchItem<T>): Promise<void> {
    const queue = this.queues.get(type);
    const processor = this.processors.get(type);
    
    if (!queue || !processor) {
      throw new Error(`No processor registered for type: ${type}`);
    }

    queue.push(item);
    this.emit('itemAdded', { type, item, queueSize: queue.length });

    // Check if we should process immediately
    const config = this.getBatchConfig(type);
    if (queue.length >= config.batchSize) {
      await this.processBatch(type);
    } else {
      this.scheduleProcessing(type, config.delayMs);
    }
  }

  /**
   * Process batch immediately
   */
  async processBatch(type: string): Promise<void> {
    const queue = this.queues.get(type);
    const processor = this.processors.get(type);
    const stats = this.stats.get(type);
    
    if (!queue || !processor || !stats || queue.length === 0) {
      return;
    }

    // Clear any pending timer
    const timer = this.timers.get(type);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(type);
    }

    // Take items from queue
    const items = queue.splice(0);
    const startTime = Date.now();

    try {
      await processor.process(items);
      
      // Update stats
      stats.totalBatches++;
      stats.totalItems += items.length;
      stats.successCount += items.length;
      stats.averageBatchSize = stats.totalItems / stats.totalBatches;
      
      const processingTime = Date.now() - startTime;
      stats.totalProcessingTime += processingTime;
      stats.averageProcessingTime = stats.totalProcessingTime / stats.totalBatches;
      stats.lastProcessed = new Date();

      this.emit('batchProcessed', {
        type,
        itemCount: items.length,
        processingTime,
        success: true
      });

    } catch (error) {
      // Update error stats
      stats.errorCount += items.length;
      
      this.emit('batchError', {
        type,
        itemCount: items.length,
        error,
        success: false
      });
      
      throw error;
    }
  }

  /**
   * Cache operations
   */
  setCache<T>(key: string, value: T, ttlMs?: number): void {
    const now = new Date();
    const item: CacheItem<T> = {
      key,
      value,
      timestamp: now,
      expiresAt: ttlMs ? new Date(now.getTime() + ttlMs) : undefined,
      accessCount: 0,
      lastAccessed: now
    };

    this.cache.set(key, item);
    this.enforceMaxCacheSize();
  }

  getCache<T>(key: string): T | null {
    const item = this.cache.get(key) as CacheItem<T> | undefined;
    
    if (!item) {
      return null;
    }

    // Check expiration
    if (item.expiresAt && item.expiresAt < new Date()) {
      this.cache.delete(key);
      return null;
    }

    // Update access stats
    item.accessCount++;
    item.lastAccessed = new Date();

    return item.value;
  }

  hasCache(key: string): boolean {
    return this.getCache(key) !== null;
  }

  deleteCache(key: string): boolean {
    return this.cache.delete(key);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get batch statistics
   */
  getStats(type?: string): BatchStats | Map<string, BatchStats> {
    if (type) {
      return this.stats.get(type) || {
        totalBatches: 0,
        totalItems: 0,
        averageBatchSize: 0,
        totalProcessingTime: 0,
        averageProcessingTime: 0,
        successCount: 0,
        errorCount: 0,
        lastProcessed: new Date(),
        pendingBatches: 0,
        processedToday: 0
      };
    }
    return new Map(this.stats);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    totalAccess: number;
    hitRate: number;
    oldestItem?: Date;
    newestItem?: Date;
  } {
    const items = Array.from(this.cache.values());
    const totalAccess = items.reduce((sum, item) => sum + item.accessCount, 0);
    
    return {
      size: this.cache.size,
      totalAccess,
      hitRate: totalAccess > 0 ? totalAccess / (totalAccess + 1) : 0, // Simplified calculation
      oldestItem: items.length > 0 ? new Date(Math.min(...items.map(i => i.timestamp.getTime()))) : undefined,
      newestItem: items.length > 0 ? new Date(Math.max(...items.map(i => i.timestamp.getTime()))) : undefined
    };
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Process remaining items
    for (const type of this.queues.keys()) {
      await this.processBatch(type);
    }

    // Clear timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Clear cache
    this.clearCache();
  }

  // Private helper methods
  private getBatchConfig(type: string) {
    const defaults = { batchSize: 10, delayMs: 1000 };
    
    switch (type) {
      case 'embedding':
        return { ...defaults, ...this.config.embedding };
      case 'indexing':
        return { ...defaults, ...this.config.indexing };
      case 'storage':
        return { ...defaults, ...this.config.storage };
      default:
        return defaults;
    }
  }

  private scheduleProcessing(type: string, delayMs: number): void {
    // Clear existing timer
    const existingTimer = this.timers.get(type);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new processing
    const timer = setTimeout(() => {
      this.processBatch(type).catch(error => {
        this.emit('error', error);
      });
    }, delayMs);

    this.timers.set(type, timer);
  }

  private enforceMaxCacheSize(): void {
    const maxSize = this.config.cache?.maxSize || 1000;
    
    if (this.cache.size <= maxSize) {
      return;
    }

    // Remove oldest items (LRU)
    const items = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.lastAccessed.getTime() - b.lastAccessed.getTime());
    
    const itemsToRemove = items.slice(0, this.cache.size - maxSize);
    for (const [key] of itemsToRemove) {
      this.cache.delete(key);
    }
  }

  private setupCleanupTimer(): void {
    const cleanupInterval = this.config.cache?.cleanupIntervalMs || 60000; // 1 minute
    
    setInterval(() => {
      const now = new Date();
      for (const [key, item] of this.cache.entries()) {
        if (item.expiresAt && item.expiresAt < now) {
          this.cache.delete(key);
        }
      }
    }, cleanupInterval);
  }
}