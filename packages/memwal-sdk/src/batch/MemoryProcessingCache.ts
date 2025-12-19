/**
 * MemoryProcessingCache - Specialized caching for memory processing
 * 
 * Optimized caching service for memory data with intelligent eviction,
 * embedding similarity, and memory-specific optimization patterns.
 */

import { 
  Memory, 
  ProcessedMemory, 
  EmbeddingResult, 
  MemoryMetadata, 
  SimilarityResult 
} from '../embedding/types';
import { BatchingService, CacheConfig } from './BatchingService';

export interface MemoryCacheConfig extends CacheConfig {
  embeddingCacheSize?: number;
  memoryCacheSize?: number;
  metadataCacheSize?: number;
  similarityThreshold?: number;
  enableSimilarityIndex?: boolean;
}

export interface CachedMemory extends Memory {
  cachedAt: Date;
  accessCount: number;
  lastAccessed: Date;
  embedding?: number[];
  processingState?: 'pending' | 'processing' | 'completed' | 'failed';
  errorInfo?: {
    lastError: string;
    errorCount: number;
    lastErrorAt: Date;
  };
}

export interface CachedEmbedding {
  content: string;
  embedding: number[];
  model: string;
  createdAt: Date;
  accessCount: number;
  contentHash: string;
}

export interface MemoryCacheStats {
  memories: {
    total: number;
    byState: Record<string, number>;
    averageAccessCount: number;
  };
  embeddings: {
    total: number;
    uniqueContent: number;
    averageReuseCount: number;
  };
  performance: {
    hitRateMemories: number;
    hitRateEmbeddings: number;
    averageRetrievalTime: number;
  };
  similarity: {
    indexSize: number;
    averageSimilarityScore: number;
    queryCount: number;
  };
}

/**
 * Specialized caching service for memory processing operations
 */
export class MemoryProcessingCache {
  private memoryCache = new Map<string, CachedMemory>();
  private embeddingCache = new Map<string, CachedEmbedding>();
  private metadataCache = new Map<string, MemoryMetadata>();
  private similarityIndex = new Map<string, Set<string>>(); // Content hash -> similar memory IDs
  private batchingService: BatchingService;

  private readonly config: Required<MemoryCacheConfig>;
  private metrics = {
    memoryHits: 0,
    memoryMisses: 0,
    embeddingHits: 0,
    embeddingMisses: 0,
    totalQueries: 0,
    averageRetrievalTime: 0
  };

  constructor(config: Partial<MemoryCacheConfig> = {}) {
    this.config = {
      maxSize: config.maxSize || 5000,
      ttlMs: config.ttlMs || 60 * 60 * 1000, // 1 hour
      cleanupIntervalMs: config.cleanupIntervalMs || 10 * 60 * 1000, // 10 minutes
      enableMetrics: config.enableMetrics !== false,
      embeddingCacheSize: config.embeddingCacheSize || 1000,
      memoryCacheSize: config.memoryCacheSize || 3000,
      metadataCacheSize: config.metadataCacheSize || 1000,
      similarityThreshold: config.similarityThreshold || 0.85,
      enableSimilarityIndex: config.enableSimilarityIndex !== false
    };

    this.batchingService = new BatchingService(
      {
        maxBatchSize: 50,
        batchDelayMs: 3000,
        maxCacheSize: this.config.maxSize
      },
      {
        maxSize: this.config.maxSize,
        ttlMs: this.config.ttlMs,
        enableMetrics: true
      }
    );
  }

  // ==================== MEMORY CACHING ====================

  /**
   * Cache processed memory
   */
  cacheMemory(memory: Memory, processed?: Partial<ProcessedMemory>): void {
    const cachedMemory: CachedMemory = {
      ...memory,
      ...processed,
      cachedAt: new Date(),
      accessCount: 0,
      lastAccessed: new Date(),
      processingState: processed?.embedding ? 'completed' : 'pending'
    };

    // Check memory cache size
    if (this.memoryCache.size >= this.config.memoryCacheSize) {
      this.evictLeastAccessedMemories(Math.floor(this.config.memoryCacheSize * 0.1));
    }

    this.memoryCache.set(memory.id, cachedMemory);

    // Update similarity index if enabled and embedding available
    if (this.config.enableSimilarityIndex && processed?.embedding) {
      this.updateSimilarityIndex(memory.id, memory.content, processed.embedding);
    }
  }

  /**
   * Get cached memory
   */
  getCachedMemory(memoryId: string): CachedMemory | undefined {
    const memory = this.memoryCache.get(memoryId);
    
    if (memory) {
      memory.lastAccessed = new Date();
      memory.accessCount++;
      this.metrics.memoryHits++;
      return memory;
    }

    this.metrics.memoryMisses++;
    return undefined;
  }

  /**
   * Update memory processing state
   */
  updateMemoryState(
    memoryId: string, 
    state: CachedMemory['processingState'], 
    error?: string
  ): void {
    const memory = this.memoryCache.get(memoryId);
    if (memory) {
      memory.processingState = state;
      memory.lastAccessed = new Date();

      if (error) {
        memory.errorInfo = {
          lastError: error,
          errorCount: (memory.errorInfo?.errorCount || 0) + 1,
          lastErrorAt: new Date()
        };
      }
    }
  }

  /**
   * Get memories by processing state
   */
  getMemoriesByState(state: CachedMemory['processingState']): CachedMemory[] {
    return Array.from(this.memoryCache.values())
      .filter(memory => memory.processingState === state);
  }

  // ==================== EMBEDDING CACHING ====================

  /**
   * Cache embedding result
   */
  cacheEmbedding(content: string, embedding: number[], model: string): string {
    const contentHash = this.hashContent(content);
    
    const cachedEmbedding: CachedEmbedding = {
      content,
      embedding,
      model,
      createdAt: new Date(),
      accessCount: 1,
      contentHash
    };

    // Check embedding cache size
    if (this.embeddingCache.size >= this.config.embeddingCacheSize) {
      this.evictLeastUsedEmbeddings(Math.floor(this.config.embeddingCacheSize * 0.1));
    }

    this.embeddingCache.set(contentHash, cachedEmbedding);
    return contentHash;
  }

  /**
   * Get cached embedding
   */
  getCachedEmbedding(content: string): CachedEmbedding | undefined {
    const contentHash = this.hashContent(content);
    const cached = this.embeddingCache.get(contentHash);

    if (cached) {
      cached.accessCount++;
      this.metrics.embeddingHits++;
      return cached;
    }

    this.metrics.embeddingMisses++;
    return undefined;
  }

  /**
   * Find similar content by embedding
   */
  findSimilarContent(
    content: string, 
    threshold?: number
  ): Array<{ content: string; similarity: number; embedding: number[] }> {
    const similarityThreshold = threshold || this.config.similarityThreshold;
    const results: Array<{ content: string; similarity: number; embedding: number[] }> = [];

    const targetEmbedding = this.getCachedEmbedding(content);
    if (!targetEmbedding) return results;

    for (const cached of this.embeddingCache.values()) {
      if (cached.contentHash === targetEmbedding.contentHash) continue;

      const similarity = this.calculateCosineSimilarity(
        targetEmbedding.embedding, 
        cached.embedding
      );

      if (similarity >= similarityThreshold) {
        results.push({
          content: cached.content,
          similarity,
          embedding: cached.embedding
        });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  // ==================== METADATA CACHING ====================

  /**
   * Cache memory metadata
   */
  cacheMetadata(memoryId: string, metadata: MemoryMetadata): void {
    // Check metadata cache size
    if (this.metadataCache.size >= this.config.metadataCacheSize) {
      this.evictRandomMetadata(Math.floor(this.config.metadataCacheSize * 0.1));
    }

    this.metadataCache.set(memoryId, metadata);
  }

  /**
   * Get cached metadata
   */
  getCachedMetadata(memoryId: string): MemoryMetadata | undefined {
    return this.metadataCache.get(memoryId);
  }

  // ==================== BATCH PROCESSING ====================

  /**
   * Add memory to processing batch
   */
  addToProcessingBatch(memory: Memory, priority: 'low' | 'normal' | 'high' = 'normal'): void {
    const priorityMap = { low: 0, normal: 1, high: 2 };
    
    this.batchingService.addToBatch('memory-processing', {
      id: memory.id,
      data: memory,
      timestamp: new Date(),
      priority: priorityMap[priority],
      metadata: { type: 'memory', priority }
    });

    // Cache as pending
    this.cacheMemory(memory);
    this.updateMemoryState(memory.id, 'pending');
  }

  /**
   * Process memory batch
   */
  async processMemoryBatch(): Promise<void> {
    await this.batchingService.processAllBatches();
  }

  // ==================== SIMILARITY INDEX ====================

  /**
   * Find similar memories by content
   */
  findSimilarMemories(
    memoryId: string, 
    limit: number = 10
  ): Array<{ memoryId: string; similarity: number; memory?: CachedMemory }> {
    if (!this.config.enableSimilarityIndex) return [];

    const memory = this.getCachedMemory(memoryId);
    if (!memory?.embedding) return [];

    const results: Array<{ memoryId: string; similarity: number; memory?: CachedMemory }> = [];

    for (const [id, cachedMemory] of this.memoryCache.entries()) {
      if (id === memoryId || !cachedMemory.embedding) continue;

      const similarity = this.calculateCosineSimilarity(
        memory.embedding,
        cachedMemory.embedding
      );

      if (similarity >= this.config.similarityThreshold) {
        results.push({ memoryId: id, similarity, memory: cachedMemory });
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ==================== STATISTICS & MONITORING ====================

  /**
   * Get comprehensive cache statistics
   */
  getStats(): MemoryCacheStats {
    const memories = Array.from(this.memoryCache.values());
    const embeddings = Array.from(this.embeddingCache.values());

    // Group memories by state
    const stateGroups = memories.reduce((groups, memory) => {
      const state = memory.processingState || 'unknown';
      groups[state] = (groups[state] || 0) + 1;
      return groups;
    }, {} as Record<string, number>);

    return {
      memories: {
        total: memories.length,
        byState: stateGroups,
        averageAccessCount: memories.length > 0 
          ? memories.reduce((sum, m) => sum + m.accessCount, 0) / memories.length 
          : 0
      },
      embeddings: {
        total: embeddings.length,
        uniqueContent: new Set(embeddings.map(e => e.contentHash)).size,
        averageReuseCount: embeddings.length > 0
          ? embeddings.reduce((sum, e) => sum + e.accessCount, 0) / embeddings.length
          : 0
      },
      performance: {
        hitRateMemories: this.getHitRate(this.metrics.memoryHits, this.metrics.memoryMisses),
        hitRateEmbeddings: this.getHitRate(this.metrics.embeddingHits, this.metrics.embeddingMisses),
        averageRetrievalTime: this.metrics.averageRetrievalTime
      },
      similarity: {
        indexSize: this.similarityIndex.size,
        averageSimilarityScore: 0, // TODO: Calculate from recent queries
        queryCount: this.metrics.totalQueries
      }
    };
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.memoryCache.clear();
    this.embeddingCache.clear();
    this.metadataCache.clear();
    this.similarityIndex.clear();
    
    // Reset metrics
    Object.keys(this.metrics).forEach(key => {
      (this.metrics as any)[key] = 0;
    });
  }

  /**
   * Cleanup and destroy cache
   */
  destroy(): void {
    this.clearAll();
    this.batchingService.destroy();
  }

  // ==================== PRIVATE METHODS ====================

  private updateSimilarityIndex(memoryId: string, content: string, embedding: number[]): void {
    const contentHash = this.hashContent(content);
    
    if (!this.similarityIndex.has(contentHash)) {
      this.similarityIndex.set(contentHash, new Set());
    }
    
    this.similarityIndex.get(contentHash)!.add(memoryId);
  }

  private evictLeastAccessedMemories(count: number): void {
    const memories = Array.from(this.memoryCache.entries())
      .sort(([, a], [, b]) => a.accessCount - b.accessCount)
      .slice(0, count);

    for (const [id] of memories) {
      this.memoryCache.delete(id);
    }
  }

  private evictLeastUsedEmbeddings(count: number): void {
    const embeddings = Array.from(this.embeddingCache.entries())
      .sort(([, a], [, b]) => a.accessCount - b.accessCount)
      .slice(0, count);

    for (const [hash] of embeddings) {
      this.embeddingCache.delete(hash);
    }
  }

  private evictRandomMetadata(count: number): void {
    const keys = Array.from(this.metadataCache.keys()).slice(0, count);
    for (const key of keys) {
      this.metadataCache.delete(key);
    }
  }

  private hashContent(content: string): string {
    // Simple hash function - replace with crypto hash if needed
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  private calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private getHitRate(hits: number, misses: number): number {
    const total = hits + misses;
    return total > 0 ? hits / total : 0;
  }
}

export default MemoryProcessingCache;