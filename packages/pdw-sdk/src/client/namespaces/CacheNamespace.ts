/**
 * Cache Namespace - LRU Cache Operations
 *
 * Pure delegation to BatchService cache methods.
 * Provides fast in-memory caching with TTL support.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Cache statistics
 */
export interface CacheStats {
  size: number;
  totalAccess: number;
  hitRate: number;
  oldestItem?: Date;
  newestItem?: Date;
}

/**
 * Cache Namespace
 *
 * Handles in-memory caching operations with TTL and LRU eviction
 */
export class CacheNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get cached value
   *
   * Delegates to: BatchService.getCache()
   *
   * @param key - Cache key
   * @returns Cached value or null if not found/expired
   */
  get<T = any>(key: string): T | null {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    return this.services.batchService.getCache<T>(key);
  }

  /**
   * Set cache value
   *
   * Delegates to: BatchService.setCache()
   *
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Time-to-live in milliseconds (optional)
   */
  set<T = any>(key: string, value: T, ttl?: number): void {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    this.services.batchService.setCache(key, value, ttl);
  }

  /**
   * Check if key exists in cache
   *
   * Delegates to: BatchService.hasCache()
   *
   * @param key - Cache key
   * @returns True if key exists and not expired
   */
  has(key: string): boolean {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    return this.services.batchService.hasCache(key);
  }

  /**
   * Delete cache entry
   *
   * Delegates to: BatchService.deleteCache()
   *
   * @param key - Cache key
   * @returns True if deleted, false if not found
   */
  delete(key: string): boolean {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    return this.services.batchService.deleteCache(key);
  }

  /**
   * Clear all cache entries
   *
   * Delegates to: BatchService.clearCache()
   */
  clear(): void {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    this.services.batchService.clearCache();
  }

  /**
   * Get cache statistics
   *
   * Delegates to: BatchService.getCacheStats()
   *
   * @returns Cache statistics
   */
  stats(): CacheStats {
    if (!this.services.batchService) {
      throw new Error('Batch service (cache) not configured.');
    }

    return this.services.batchService.getCacheStats();
  }
}
