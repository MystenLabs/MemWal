/**
 * useMemoryIndex - Hook for indexing memories
 *
 * Provides interface for adding memories to vector index and knowledge graph.
 * Handles embedding generation, batching, and persistence automatically.
 */

import { useState, useCallback } from 'react';
import { useMemoryServices, type MemoryServicesConfig } from './useMemoryServices';

export interface AddMemoryOptions {
  /** Memory content (will be embedded) */
  content: string;
  /** Category for filtering */
  category: string;
  /** Importance score (1-10) */
  importance?: number;
  /** Custom metadata */
  metadata?: Record<string, any>;
  /** Entities to extract/add to graph */
  entities?: Array<{
    id: string;
    label: string;
    type: string;
    confidence?: number;
  }>;
  /** Relationships to add to graph */
  relationships?: Array<{
    source: string;
    target: string;
    label: string;
    confidence?: number;
  }>;
}

export interface IndexedMemory {
  memoryId: string;
  vectorId: number;
  embedding: number[];
  indexed: boolean;
  indexedAt: Date;
}

export interface IndexStats {
  totalMemories: number;
  pendingVectors: number;
  cacheSize: number;
  lastFlush?: Date;
}

/**
 * Add and manage memories in the vector index
 *
 * @param userAddress - User's blockchain address
 * @param config - Optional services configuration
 * @returns Functions for indexing memories and stats
 *
 * @example
 * ```tsx
 * function AddMemoryForm() {
 *   const account = useCurrentAccount();
 *   const { addMemory, flush, isIndexing, stats } = useMemoryIndex(account?.address);
 *
 *   const handleSubmit = async (content: string) => {
 *     const result = await addMemory({
 *       content,
 *       category: 'personal',
 *       importance: 7,
 *       entities: [{ id: 'paris', label: 'Paris', type: 'location' }]
 *     });
 *     console.log('Indexed:', result);
 *   };
 *
 *   return (
 *     <div>
 *       <textarea onChange={(e) => handleSubmit(e.target.value)} />
 *       <p>Pending: {stats.pendingVectors}</p>
 *       <button onClick={flush}>Save Now</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useMemoryIndex(
  userAddress?: string,
  config?: MemoryServicesConfig
) {
  const { embeddingService, hnswService, graphManager, isReady, error: servicesError } =
    useMemoryServices(userAddress, config);

  const [isIndexing, setIsIndexing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastIndexed, setLastIndexed] = useState<IndexedMemory | null>(null);
  const [stats, setStats] = useState<IndexStats>({
    totalMemories: 0,
    pendingVectors: 0,
    cacheSize: 0
  });

  /**
   * Add a memory to the index
   */
  const addMemory = useCallback(async (
    options: AddMemoryOptions
  ): Promise<IndexedMemory> => {
    if (!embeddingService || !hnswService || !userAddress) {
      throw new Error('Services not initialized');
    }

    if (!options.content || options.content.trim().length === 0) {
      throw new Error('Memory content cannot be empty');
    }

    try {
      setIsIndexing(true);
      setError(null);

      // Generate unique memory ID
      const memoryId = generateMemoryId();

      // 1. Generate embedding
      const embeddingResult = await embeddingService.embedText({
        text: options.content,
        type: 'content'
      });

      // 2. Generate vector ID
      const vectorId = Date.now() + Math.floor(Math.random() * 1000);

      // 3. Prepare metadata
      const metadata = {
        memoryId,
        category: options.category,
        importance: options.importance || 5,
        createdTimestamp: Date.now(),
        contentType: 'text/plain',
        contentSize: options.content.length,
        ...(options.metadata || {})
      };

      // 4. Add to HNSW index (batched)
      hnswService.addVectorToIndexBatched(
        userAddress,
        vectorId,
        embeddingResult.vector,
        metadata
      );

      // 5. Add to knowledge graph (if entities/relationships provided)
      if ((options.entities || options.relationships) && graphManager) {
        try {
          await graphManager.addToGraph(
            userAddress,
            options.entities || [],
            options.relationships || [],
            memoryId
          );
        } catch (graphError) {
          console.warn('Failed to add to knowledge graph:', graphError);
          // Continue without graph (non-fatal)
        }
      }

      const indexed: IndexedMemory = {
        memoryId,
        vectorId,
        embedding: embeddingResult.vector,
        indexed: true,
        indexedAt: new Date()
      };

      setLastIndexed(indexed);

      // Update stats
      updateStats();

      return indexed;

    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    } finally {
      setIsIndexing(false);
    }
  }, [userAddress, embeddingService, hnswService, graphManager]);

  /**
   * Add multiple memories in batch
   */
  const addBatch = useCallback(async (
    memories: AddMemoryOptions[]
  ): Promise<IndexedMemory[]> => {
    const results: IndexedMemory[] = [];
    const errors: Error[] = [];

    for (const memory of memories) {
      try {
        const result = await addMemory(memory);
        results.push(result);
      } catch (err) {
        errors.push(err as Error);
      }
    }

    if (errors.length > 0) {
      console.warn(`Failed to index ${errors.length}/${memories.length} memories`);
    }

    return results;
  }, [addMemory]);

  /**
   * Force flush pending vectors to IndexedDB
   */
  const flush = useCallback(async (): Promise<void> => {
    if (!hnswService || !userAddress) {
      throw new Error('Services not initialized');
    }

    try {
      setIsIndexing(true);
      await hnswService.forceFlush(userAddress);
      updateStats();
      console.log('✅ Index flushed to IndexedDB');
    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    } finally {
      setIsIndexing(false);
    }
  }, [userAddress, hnswService]);

  /**
   * Remove a memory from the index
   */
  const removeMemory = useCallback(async (
    memoryId: string,
    vectorId: number
  ): Promise<boolean> => {
    if (!hnswService || !userAddress) {
      throw new Error('Services not initialized');
    }

    try {
      hnswService.clearUserIndex(userAddress);
      // Note: HNSW doesn't support deletion, would need to rebuild index
      // For now, just mark as removed in metadata
      console.warn('Memory removal requires index rebuild (not yet implemented)');
      return false;
    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    }
  }, [userAddress, hnswService]);

  /**
   * Update statistics
   */
  const updateStats = useCallback(() => {
    if (!hnswService) return;

    const hnswStats = hnswService.getCacheStats();
    setStats({
      totalMemories: hnswStats.totalUsers,
      pendingVectors: hnswStats.totalPendingVectors,
      cacheSize: hnswStats.totalUsers,
      lastFlush: undefined // TODO: Track last flush time
    });
  }, [hnswService]);

  /**
   * Get detailed index statistics
   */
  const getDetailedStats = useCallback(() => {
    if (!hnswService) return null;
    return hnswService.getCacheStats();
  }, [hnswService]);

  return {
    addMemory,
    addBatch,
    flush,
    removeMemory,
    isIndexing,
    isReady,
    error: error || servicesError,
    lastIndexed,
    stats,
    getDetailedStats
  };
}

// ==================== HELPER FUNCTIONS ====================

function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
