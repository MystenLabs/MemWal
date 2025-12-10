/**
 * useMemorySearch - Hook for searching memories with vector similarity
 *
 * Provides high-level interface for semantic memory search combining:
 * - Vector similarity (HNSW)
 * - Knowledge graph expansion
 * - Metadata filtering
 * - Relevance scoring
 */

import { useState, useCallback } from 'react';
import { useMemoryServices, type MemoryServicesConfig } from './useMemoryServices';
import type { HNSWSearchResult } from '../embedding/types';

export interface SearchOptions {
  /** Number of results to return */
  k?: number;
  /** Similarity threshold (0-1) */
  threshold?: number;
  /** Search mode */
  mode?: 'semantic' | 'hybrid' | 'exact';
  /** Filter by categories */
  categories?: string[];
  /** Date range filter */
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  /** Importance range filter */
  importanceRange?: {
    min?: number;
    max?: number;
  };
  /** Include knowledge graph expansion */
  includeGraph?: boolean;
  /** Boost recent memories */
  boostRecent?: boolean;
  /** Result diversity factor (0-1) */
  diversityFactor?: number;
}

export interface SearchResult {
  /** Vector search results */
  vectorResults: {
    ids: number[];
    distances: number[];
    similarities: number[];
  };
  /** Graph search results (if enabled) */
  graphResults?: {
    entities: any[];
    relationships: any[];
    relatedMemories: string[];
  };
  /** Search metadata */
  metadata: {
    queryTime: number;
    totalResults: number;
    mode: string;
  };
}

/**
 * Search memories using semantic vector similarity
 *
 * @param userAddress - User's blockchain address
 * @param config - Optional services configuration
 * @returns Search function and state
 *
 * @example
 * ```tsx
 * function SearchComponent() {
 *   const account = useCurrentAccount();
 *   const { search, results, isSearching, error } = useMemorySearch(account?.address);
 *
 *   const handleSearch = async () => {
 *     const results = await search('memories about Paris', {
 *       k: 10,
 *       categories: ['travel'],
 *       includeGraph: true
 *     });
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleSearch} disabled={isSearching}>
 *         Search
 *       </button>
 *       {results && <ResultsList results={results} />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useMemorySearch(
  userAddress?: string,
  config?: MemoryServicesConfig
) {
  const { embeddingService, hnswService, graphManager, isReady, error: servicesError } =
    useMemoryServices(userAddress, config);

  const [results, setResults] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastQuery, setLastQuery] = useState<string>('');

  /**
   * Search memories by text query
   */
  const search = useCallback(async (
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchResult> => {
    console.log('🔍 [useMemorySearch] search() called', {
      query,
      hasEmbeddingService: !!embeddingService,
      hasHnswService: !!hnswService,
      userAddress,
      options
    });

    if (!embeddingService || !hnswService || !userAddress) {
      const error = new Error('Services not initialized');
      console.error('❌ [useMemorySearch] Services not initialized', {
        embeddingService: !!embeddingService,
        hnswService: !!hnswService,
        userAddress
      });
      throw error;
    }

    try {
      setIsSearching(true);
      setError(null);
      setLastQuery(query);

      const startTime = performance.now();
      console.log('⏱️ [useMemorySearch] Starting search at', new Date().toISOString());

      // 1. Generate query embedding
      const embeddingResult = await embeddingService.embedText({
        text: query,
        type: 'query'
      });

      // 2. Determine search parameters based on mode
      const k = options.k || 10;
      const efSearch = options.mode === 'exact' ? k * 4 :
                      options.mode === 'hybrid' ? k * 2 : k;

      // 3. Create metadata filter
      const filter = createMetadataFilter(options);

      // 4. Search HNSW index
      let vectorResults;
      try {
        vectorResults = await hnswService.searchVectors(
          userAddress,
          embeddingResult.vector,
          {
            k: Math.min(k * 2, 100), // Get more candidates for filtering
            efSearch,
            filter
          }
        );
      } catch (searchError: any) {
        // Handle "No index found" gracefully - return empty results
        if (searchError.message?.includes('No index found')) {
          console.info(`No memories indexed yet for user ${userAddress}`);
          const searchResult: SearchResult = {
            vectorResults: {
              ids: [],
              distances: [],
              similarities: []
            },
            metadata: {
              queryTime: performance.now() - startTime,
              totalResults: 0,
              mode: options.mode || 'semantic'
            }
          };
          setResults(searchResult);
          return searchResult;
        }
        // Re-throw other errors
        throw searchError;
      }

      // 5. Apply threshold filtering
      let filteredIds = vectorResults.ids;
      let filteredDistances = vectorResults.distances;
      // Compute similarities if not provided
      let filteredSimilarities = vectorResults.similarities ||
        vectorResults.distances.map(d => 1 / (1 + d));

      if (options.threshold) {
        const filtered = applyThreshold(
          vectorResults.ids,
          vectorResults.distances,
          filteredSimilarities,
          options.threshold
        );
        filteredIds = filtered.ids;
        filteredDistances = filtered.distances;
        filteredSimilarities = filtered.similarities;
      }

      // Limit to requested k
      filteredIds = filteredIds.slice(0, k);
      filteredDistances = filteredDistances.slice(0, k);
      filteredSimilarities = filteredSimilarities.slice(0, k);

      // 6. Optional: Expand with knowledge graph
      let graphResults;
      if (options.includeGraph && graphManager) {
        try {
          const graphSearchResult = await graphManager.searchGraph(userAddress, {
            keywords: query.split(' ').filter(w => w.length > 2),
            maxResults: k
          });

          graphResults = {
            entities: graphSearchResult.entities,
            relationships: graphSearchResult.relationships,
            relatedMemories: graphSearchResult.relatedMemories
          };
        } catch (graphError) {
          console.warn('Graph search failed:', graphError);
          // Continue without graph results
        }
      }

      const queryTime = performance.now() - startTime;

      const searchResult: SearchResult = {
        vectorResults: {
          ids: filteredIds,
          distances: filteredDistances,
          similarities: filteredSimilarities
        },
        graphResults,
        metadata: {
          queryTime,
          totalResults: filteredIds.length + (graphResults?.entities.length || 0),
          mode: options.mode || 'semantic'
        }
      };

      setResults(searchResult);
      return searchResult;

    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    } finally {
      setIsSearching(false);
    }
  }, [userAddress, embeddingService, hnswService, graphManager]);

  /**
   * Search by pre-computed embedding vector
   */
  const searchByVector = useCallback(async (
    vector: number[],
    options: Omit<SearchOptions, 'includeGraph'> = {}
  ): Promise<HNSWSearchResult> => {
    if (!hnswService || !userAddress) {
      throw new Error('Services not initialized');
    }

    try {
      setIsSearching(true);
      setError(null);

      const k = options.k || 10;
      const filter = createMetadataFilter(options);

      const vectorResults = await hnswService.searchVectors(
        userAddress,
        vector,
        {
          k,
          efSearch: 50,
          filter
        }
      );

      return vectorResults;

    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    } finally {
      setIsSearching(false);
    }
  }, [userAddress, hnswService]);

  /**
   * Clear current search results
   */
  const clearResults = useCallback(() => {
    setResults(null);
    setError(null);
    setLastQuery('');
  }, []);

  return {
    search,
    searchByVector,
    results,
    isSearching,
    isReady,
    error: error || servicesError,
    lastQuery,
    clearResults
  };
}

// ==================== HELPER FUNCTIONS ====================

function createMetadataFilter(options: SearchOptions) {
  if (!options.categories && !options.dateRange && !options.importanceRange) {
    return undefined;
  }

  return (metadata: any) => {
    // Category filter
    if (options.categories && options.categories.length > 0) {
      if (!options.categories.includes(metadata.category)) {
        return false;
      }
    }

    // Date range filter
    if (options.dateRange) {
      const created = new Date(metadata.createdTimestamp || 0);
      if (options.dateRange.start && created < options.dateRange.start) {
        return false;
      }
      if (options.dateRange.end && created > options.dateRange.end) {
        return false;
      }
    }

    // Importance range filter
    if (options.importanceRange) {
      const importance = metadata.importance || 5;
      if (options.importanceRange.min && importance < options.importanceRange.min) {
        return false;
      }
      if (options.importanceRange.max && importance > options.importanceRange.max) {
        return false;
      }
    }

    return true;
  };
}

function applyThreshold(
  ids: number[],
  distances: number[],
  similarities: number[],
  threshold: number
) {
  const filteredIds: number[] = [];
  const filteredDistances: number[] = [];
  const filteredSimilarities: number[] = [];

  for (let i = 0; i < ids.length; i++) {
    if (similarities[i] >= threshold) {
      filteredIds.push(ids[i]);
      filteredDistances.push(distances[i]);
      filteredSimilarities.push(similarities[i]);
    }
  }

  return {
    ids: filteredIds,
    distances: filteredDistances,
    similarities: filteredSimilarities
  };
}
