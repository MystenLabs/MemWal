/**
 * Index Namespace - Vector Indexing Operations
 *
 * Delegates to MemoryIndexService for HNSW-based vector indexing with
 * full Walrus persistence support via HnswWasmService.
 *
 * Features:
 * - O(log N) vector similarity search via HNSW
 * - Walrus storage persistence for durability
 * - IndexedDB caching for offline support
 * - Automatic batching for optimal performance
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Index statistics
 */
export interface IndexStats {
  totalVectors: number;
  dimension: number;
  spaceType: string;
  maxElements: number;
  currentCount: number;
}

/**
 * Index configuration
 */
export interface IndexConfig {
  dimension?: number;
  maxElements?: number;
  efConstruction?: number;
  m?: number;
}

/**
 * Index Namespace
 *
 * Handles HNSW vector indexing and fast similarity search with Walrus persistence
 */
export class IndexNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get the underlying service (prefer MemoryIndexService over VectorService)
   */
  private getService() {
    if (this.services.memoryIndex) {
      return { type: 'memoryIndex' as const, service: this.services.memoryIndex };
    }
    if (this.services.vector) {
      return { type: 'vector' as const, service: this.services.vector };
    }
    throw new Error('No indexing service configured. Enable local indexing in config.');
  }

  /**
   * Create a new vector index
   *
   * Note: MemoryIndexService auto-initializes indices on first use.
   * This method is provided for explicit initialization or VectorService compatibility.
   *
   * @param spaceId - Index space identifier (e.g., userAddress)
   * @param dimension - Vector dimension (default: 3072)
   * @param config - Optional HNSW config (used by VectorService)
   */
  async create(spaceId: string, dimension: number = 3072, config?: IndexConfig): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      // MemoryIndexService auto-creates indices on first indexMemory() call
      // The HNSW config is set at service construction time
      console.log(`Index ${spaceId} will be created on first vector add (dimension: ${dimension})`);
    } else {
      await service.createIndex(spaceId, dimension, config);
    }
  }

  /**
   * Add vector to index
   *
   * Delegates to: MemoryIndexService or VectorService
   *
   * @param spaceId - Index space identifier
   * @param vectorId - Vector ID (unique number)
   * @param vector - Vector array
   * @param metadata - Optional metadata
   */
  async add(spaceId: string, vectorId: number, vector: number[], metadata?: any): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      // MemoryIndexService uses batched add internally via HnswWasmService
      await service.indexMemory(
        spaceId,
        vectorId.toString(),
        metadata?.blobId || '',
        metadata?.content || '',
        metadata || {},
        vector
      );
    } else {
      await service.addVector(spaceId, vectorId, vector, metadata);
    }
  }

  /**
   * Search vectors in index
   *
   * Delegates to: MemoryIndexService or VectorService
   *
   * @param spaceId - Index space identifier
   * @param queryVector - Query vector
   * @param options - Search options (k, threshold, etc.)
   * @returns Search results with IDs and similarities
   */
  async search(
    spaceId: string,
    queryVector: number[],
    options?: { k?: number; threshold?: number; efSearch?: number }
  ): Promise<Array<{ vectorId: number; memoryId: string; similarity: number; distance: number }>> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      const results = await service.searchMemories({
        vector: queryVector,
        userAddress: spaceId,
        k: options?.k || 10,
        threshold: options?.threshold
      });

      return results.map((r: any) => ({
        vectorId: parseInt(r.memoryId) || 0,
        memoryId: r.memoryId,
        similarity: r.similarity || r.relevanceScore || 0,
        distance: 1 - (r.similarity || r.relevanceScore || 0)
      }));
    } else {
      const result = await service.searchVectors(spaceId, queryVector, options);
      return result.results.map((r: any) => ({
        vectorId: r.vectorId,
        memoryId: r.memoryId,
        similarity: r.similarity,
        distance: r.distance
      }));
    }
  }

  /**
   * Get index statistics
   *
   * Returns stats about the index size and configuration
   *
   * @param spaceId - Index space identifier
   * @returns Index statistics
   */
  getStats(spaceId: string): IndexStats {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      const stats = service.getIndexStats(spaceId);
      // MemoryIndexService.getIndexStats returns: { totalMemories, categoryCounts, indexSize, ... }
      return {
        totalVectors: stats.totalMemories || 0,
        dimension: 3072, // Default dimension (set at service construction)
        spaceType: 'cosine',
        maxElements: 10000, // Default max (set at service construction)
        currentCount: stats.indexSize || stats.totalMemories || 0
      };
    } else {
      const entry = (service as any).indexCache?.get(spaceId);
      if (!entry) {
        throw new Error(`Index ${spaceId} not found`);
      }
      const currentCount = entry.index.getCurrentCount?.() || 0;
      return {
        totalVectors: currentCount,
        dimension: 3072,
        spaceType: 'cosine',
        maxElements: 10000,
        currentCount
      };
    }
  }

  /**
   * Save index to Walrus storage
   *
   * Persists the HNSW index binary to Walrus for durability.
   * Uses HnswWasmService.saveIndex() which properly serializes the index.
   *
   * @param spaceId - Index space identifier (userAddress)
   * @returns Blob ID of saved index on Walrus, or null if no index exists
   */
  async save(spaceId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      // MemoryIndexService.saveIndex() saves to persistent storage
      await service.saveIndex(spaceId);
      console.log(`Index saved for space: ${spaceId}`);
    } else {
      // VectorService has limited persistence support
      await service.saveIndex(spaceId);
    }
  }

  /**
   * Load index from Walrus storage
   *
   * Loads a previously saved HNSW index from Walrus.
   * Uses HnswWasmService.loadIndex() which properly deserializes the binary.
   *
   * @param spaceId - Index space identifier (userAddress)
   * @param blobId - Blob ID of the saved index on Walrus
   */
  async load(spaceId: string, blobId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      // MemoryIndexService.loadIndex(userAddress, indexBlobId?)
      await service.loadIndex(spaceId, blobId);
      console.log(`Index loaded from Walrus: ${blobId}`);
    } else {
      await service.loadIndex(spaceId, blobId);
    }
  }

  /**
   * Clear index and remove all vectors
   *
   * @param spaceId - Index space identifier
   */
  clear(spaceId: string): void {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      service.clearUserIndex(spaceId);
    } else {
      (service as any).indexCache?.delete(spaceId);
    }
  }

  /**
   * Force flush pending vectors
   *
   * Immediately processes all batched vectors for the given space.
   *
   * @param spaceId - Index space identifier
   */
  async flush(spaceId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      await service.flush(spaceId);
    }
    // VectorService handles flushing automatically
  }

  /**
   * Optimize index for better search performance
   *
   * For MemoryIndexService, this triggers a flush and potential rebuild.
   *
   * @param spaceId - Index space identifier
   */
  async optimize(spaceId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      // Flush pending vectors first
      await service.flush(spaceId);
      console.log(`Index ${spaceId} optimized (flushed pending vectors)`);
    } else {
      console.log(`Index ${spaceId} uses automatic optimization via batching`);
    }
  }
}
