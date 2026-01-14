/**
 * Batch Processing Module
 * 
 * Comprehensive batch processing and caching system for the PDW SDK.
 * Provides intelligent batching, memory caching, and performance optimization.
 */

export { BatchingService } from './BatchingService';
export { MemoryProcessingCache } from './MemoryProcessingCache';
export { BatchManager } from './BatchManager';

export type {
  BatchItem,
  BatchProcessor,
  CacheConfig,
  CacheItem,
  CacheMetrics
} from './BatchingService';

export type {
  MemoryCacheConfig,
  CachedMemory,
  CachedEmbedding,
  MemoryCacheStats
} from './MemoryProcessingCache';

export type {
  BatchManagerConfig,
  BatchManagerStats,
  BatchJobStatus
} from './BatchManager';