/**
 * Search Namespace - All Search Methods
 *
 * Provides comprehensive search capabilities:
 * - Vector similarity search
 * - Semantic search (AI-enhanced)
 * - Keyword search (metadata)
 * - Hybrid search (combined)
 * - Temporal search (date-based)
 * - Category filtering
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

/**
 * Search result item
 *
 * NOTE: `content` is empty by default for privacy. Content is stored encrypted
 * on Walrus and not in the index. Use `pdw.search.withContent()` or
 * `pdw.memory.get(blobId)` to retrieve decrypted content.
 */
export interface SearchResult {
  id: string;
  /** Empty by default - use withContent() to fetch from Walrus */
  content: string;
  score: number;
  similarity: number;
  category?: string;
  importance?: number;
  topic?: string;
  /** Use this to fetch content: pdw.memory.get(blobId) */
  blobId: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

/**
 * Vector search options
 */
export interface VectorSearchOptions {
  limit?: number;
  threshold?: number; // Minimum similarity score
  category?: string;
  includeEmbeddings?: boolean;
  /**
   * Fetch content from Walrus for each result (slower but includes content)
   * @default false
   */
  fetchContent?: boolean;
}

/**
 * Semantic search options
 */
export interface SemanticSearchOptions extends VectorSearchOptions {
  rerank?: boolean; // Use AI to rerank results
}

/**
 * Keyword search options
 */
export interface KeywordSearchOptions {
  limit?: number;
  category?: string;
  fields?: string[]; // Which metadata fields to search
  caseSensitive?: boolean;
}

/**
 * Hybrid search options
 */
export interface HybridSearchOptions {
  limit?: number;
  vectorWeight?: number; // 0-1, weight for vector search
  keywordWeight?: number; // 0-1, weight for keyword search
  category?: string;
}

/**
 * Date range for temporal search
 */
export interface DateRange {
  start: Date | string;
  end?: Date | string;
}

/**
 * Search Namespace
 *
 * Handles all types of search operations
 */
export class SearchNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Vector similarity search
   *
   * Searches memories by semantic similarity using embeddings.
   *
   * NOTE: Content is NOT included by default for privacy (content is encrypted on Walrus).
   * Use `fetchContent: true` option or call `pdw.memory.get(blobId)` to get content.
   *
   * @param query - Text query to search for
   * @param options - Search options
   * @returns Sorted array of results by similarity (content empty unless fetchContent=true)
   *
   * @example
   * ```typescript
   * // Fast search (no content)
   * const results = await pdw.search.vector('programming');
   *
   * // Search with content (slower - fetches from Walrus)
   * const results = await pdw.search.vector('programming', { fetchContent: true });
   *
   * // Or fetch content for specific result
   * const memory = await pdw.memory.get(results[0].blobId);
   * ```
   */
  async vector(query: string, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 10, threshold = 0.7, category, fetchContent = false } = options;

    try {
      // Generate query embedding
      if (!this.services.embedding) {
        throw new Error('Embedding service not configured. Please provide geminiApiKey in config.');
      }

      const embResult = await this.services.embedding.embedText({
        text: query
      });

      // Search using local HNSW index (VectorService)
      if (!this.services.vector) {
        throw new Error('Vector service not configured. Enable local indexing in config.');
      }

      const spaceId = this.services.config.userAddress;

      // Search in local HNSW index
      const searchResult = await this.services.vector.searchVectors(spaceId, embResult.vector, {
        k: limit
      });

      // Filter by threshold and category
      let results = searchResult.results.filter((r: any) => r.similarity >= threshold);

      if (category) {
        results = results.filter((r: any) =>
          r.metadata?.category === category
        );
      }

      // Convert to SearchResult format
      // Option A+: Content may be available from local index when encryption is OFF
      const searchResults: SearchResult[] = results.map((r: any) => {
        // blobId must be a valid Walrus blob ID, not a vectorId
        // Only use metadata.blobId if it's a non-empty string that looks like a Walrus blobId
        const rawBlobId = r.metadata?.blobId;
        const isValidBlobId = rawBlobId && typeof rawBlobId === 'string' && rawBlobId.length > 10 && !/^\d+$/.test(rawBlobId);
        const blobId = isValidBlobId ? rawBlobId : (r.metadata?.memoryObjectId || '');

        return {
          id: r.memoryId || r.vectorId.toString(),
          content: r.metadata?.content || r.content || '', // ✅ Get content from index metadata if available
          score: r.similarity,
          similarity: r.similarity,
          category: r.metadata?.category,
          importance: r.metadata?.importance || 5,
          topic: r.metadata?.topic,
          blobId,
          metadata: r.metadata || {},
          timestamp: r.metadata?.timestamp || Date.now()
        };
      });

      // Optionally fetch content from Walrus
      if (fetchContent) {
        await this.populateContent(searchResults);
      }

      return searchResults;
    } catch (error) {
      throw new Error(`Vector search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Semantic search (AI-enhanced)
   *
   * Uses AI to understand query intent and rerank results
   *
   * @param query - Natural language query
   * @param options - Search options
   * @returns Semantically relevant results
   */
  async semantic(query: string, options: SemanticSearchOptions = {}): Promise<SearchResult[]> {
    try {
      if (!this.services.query) {
        throw new Error('Query service not available');
      }

      // Use QueryService for semantic search
      const results = await this.services.query.semanticSearch(
        {
          query,
          userAddress: this.services.config.userAddress,
          queryType: 'semantic',
          k: options.limit || 10,
          threshold: options.threshold || 0.6
        },
        {
          expandQuery: options.rerank ?? true // Use expandQuery instead of rerank
        }
      );

      return results.map((r: any) => ({
        id: r.id,
        content: r.content || '',
        score: r.similarity_score || 0,
        similarity: r.similarity_score || 0,
        category: r.category,
        importance: r.metadata?.importance,
        blobId: r.blobId || r.id,
        metadata: r.metadata || {},
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      }));
    } catch (error) {
      throw new Error(`Semantic search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Keyword search (metadata-based)
   *
   * Searches in metadata fields using keywords
   *
   * @param query - Keyword to search for
   * @param options - Search options
   * @returns Matching memories
   */
  async keyword(query: string, options: KeywordSearchOptions = {}): Promise<SearchResult[]> {
    try {
      const { limit = 10, category, fields = ['content', 'topic'], caseSensitive = false } = options;

      // Use QueryService for keyword search
      const results = await this.services.query.keywordSearch({
        query,
        userAddress: this.services.config.userAddress,
        queryType: 'keyword',
        categories: category ? [category] : undefined,
        limit
      });

      return results.map((r: any) => ({
        id: r.id,
        content: r.content || '',
        score: 1.0, // Keyword match = binary
        similarity: 1.0,
        category: r.category,
        importance: r.metadata?.importance,
        blobId: r.blobId || r.id,
        metadata: r.metadata || {},
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      }));
    } catch (error) {
      throw new Error(`Keyword search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Hybrid search (vector + keyword)
   *
   * Combines vector similarity and keyword matching
   *
   * @param query - Search query
   * @param options - Hybrid search options
   * @returns Ranked results from both methods
   */
  async hybrid(query: string, options: HybridSearchOptions = {}): Promise<SearchResult[]> {
    try {
      const {
        limit = 10,
        vectorWeight = 0.7,
        keywordWeight = 0.3,
        category
      } = options;

      // Use QueryService for hybrid search
      const results = await this.services.query.hybridSearch({
        query,
        userAddress: this.services.config.userAddress,
        queryType: 'hybrid',
        limit,
        categories: category ? [category] : undefined
      });

      return results.map((r: any) => ({
        id: r.id,
        content: r.content || '',
        score: r.similarity_score || 0,
        similarity: r.similarity_score || 0,
        category: r.category,
        importance: r.metadata?.importance,
        blobId: r.blobId || r.id,
        metadata: r.metadata || {},
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      }));
    } catch (error) {
      throw new Error(`Hybrid search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search by category
   *
   * First tries local vector index (for recently created memories),
   * then queries blockchain for on-chain Memory objects.
   * Combines results and deduplicates by blobId.
   *
   * @param category - Category to filter by
   * @param options - Additional options
   * @returns Memories in category
   */
  async byCategory(category: string, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    try {
      const limit = options.limit || 50;
      const results: SearchResult[] = [];
      const seenIds = new Set<string>();

      // 1. First check local vector index (includes recently created memories)
      // Use VectorService.getVectorsByCategory() method
      if (this.services.vector) {
        try {
          const spaceId = this.services.config.userAddress;
          const localResults = this.services.vector.getVectorsByCategory(spaceId, category);

          for (const { vectorId, metadata } of localResults) {
            // blobId must be a valid Walrus blob ID, not a vectorId
            const rawBlobId = metadata?.blobId;
            const isValidBlobId = rawBlobId && typeof rawBlobId === 'string' && rawBlobId.length > 10 && !/^\d+$/.test(rawBlobId);
            const blobId = isValidBlobId ? rawBlobId : (metadata?.memoryObjectId || '');
            const id = blobId || metadata?.memoryId || vectorId?.toString();

            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              results.push({
                id,
                content: metadata?.content || '',
                score: 1.0,
                similarity: 1.0,
                category: metadata?.category,
                importance: metadata?.importance || 5,
                topic: metadata?.topic,
                blobId,
                metadata: metadata || {},
                timestamp: metadata?.timestamp || Date.now()
              });
            }
          }
        } catch (localError) {
          // Local index access failed, continue with on-chain query
          console.log('Local index search skipped:', localError);
        }
      }

      // 2. Query on-chain Memory objects
      const viewService = this.services.viewService;
      if (viewService) {
        try {
          const response = await viewService.getUserMemories(
            this.services.config.userAddress,
            { limit, category }
          );

          for (const m of response.data) {
            const id = m.id || m.blobId;
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              results.push({
                id,
                content: '',
                score: 1.0,
                similarity: 1.0,
                category: m.category,
                importance: m.importance || 5,
                topic: m.topic,
                blobId: m.blobId || id,
                metadata: {
                  category: m.category,
                  importance: m.importance,
                  topic: m.topic
                },
                timestamp: m.createdAt || Date.now()
              });
            }
          }
        } catch (viewError) {
          console.log('On-chain query failed:', viewError);
        }
      }

      return results.slice(0, limit);
    } catch (error) {
      throw new Error(`Category search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search by date range
   *
   * @param dateRange - Start and end dates
   * @param options - Additional options
   * @returns Memories within date range
   */
  async byDate(dateRange: DateRange, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    try {
      const start = typeof dateRange.start === 'string'
        ? new Date(dateRange.start)
        : dateRange.start;

      const end = dateRange.end
        ? (typeof dateRange.end === 'string' ? new Date(dateRange.end) : dateRange.end)
        : new Date();

      // Use QueryService for temporal search
      const results = await this.services.query.temporalSearch({
        userAddress: this.services.config.userAddress,
        queryType: 'temporal',
        dateRange: { start, end },
        limit: options.limit || 50,
        categories: options.category ? [options.category] : undefined
      });

      return results.map((r: any) => ({
        id: r.id,
        content: r.content || '',
        score: 1.0,
        similarity: 1.0,
        category: r.category,
        importance: r.metadata?.importance,
        blobId: r.blobId || r.id,
        metadata: r.metadata || {},
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      }));
    } catch (error) {
      throw new Error(`Temporal search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search by importance range
   *
   * @param min - Minimum importance (1-10)
   * @param max - Maximum importance (1-10)
   * @param options - Additional options
   * @returns Memories within importance range
   */
  async byImportance(
    min: number,
    max: number = 10,
    options: VectorSearchOptions = {}
  ): Promise<SearchResult[]> {
    const memoriesResult = await this.services.viewService?.getUserMemories(
      this.services.config.userAddress
    );
    const allMemories = memoriesResult?.data || [];

    const filtered = allMemories.filter((m: any) => {
      const importance = m.importance || m.metadata?.importance || 5;
      return importance >= min && importance <= max;
    });

    const limit = options.limit || 50;
    return filtered.slice(0, limit).map((m: any) => ({
      id: m.id || m.blobId,
      content: m.content || '',
      score: 1.0,
      similarity: 1.0,
      category: m.category || m.metadata?.category,
      importance: m.importance || m.metadata?.importance,
      blobId: m.blobId || m.id,
      metadata: m.metadata,
      timestamp: m.timestamp || Date.now()
    }));
  }

  /**
   * Advanced search with complex filters
   *
   * @param query - Search query or filters
   * @returns Filtered and ranked results
   */
  async advanced(query: {
    text?: string;
    category?: string;
    importance?: { min: number; max: number };
    dateRange?: DateRange;
    limit?: number;
  }): Promise<SearchResult[]> {
    try {
      // Combine multiple search strategies
      let results: SearchResult[] = [];

      // Start with vector search if text provided
      if (query.text) {
        results = await this.vector(query.text, {
          limit: query.limit || 50,
          category: query.category
        });
      } else {
        // Get all memories
        const memoriesResult = await this.services.viewService?.getUserMemories(
          this.services.config.userAddress
        );
        const memories = memoriesResult?.data || [];

        results = memories.map((m: any) => ({
          id: m.id || m.blobId,
          content: m.content || '',
          score: 1.0,
          similarity: 1.0,
          category: m.category || m.metadata?.category,
          importance: m.importance || m.metadata?.importance,
          blobId: m.blobId || m.id,
          metadata: m.metadata,
          timestamp: m.timestamp || Date.now()
        }));
      }

      // Apply filters
      if (query.importance) {
        results = results.filter(r =>
          (r.importance || 5) >= query.importance!.min &&
          (r.importance || 5) <= query.importance!.max
        );
      }

      if (query.dateRange) {
        const start = typeof query.dateRange.start === 'string'
          ? new Date(query.dateRange.start).getTime()
          : query.dateRange.start.getTime();

        const end = query.dateRange.end
          ? (typeof query.dateRange.end === 'string'
            ? new Date(query.dateRange.end).getTime()
            : query.dateRange.end.getTime())
          : Date.now();

        results = results.filter(r =>
          r.timestamp >= start && r.timestamp <= end
        );
      }

      return results.slice(0, query.limit || 50);
    } catch (error) {
      throw new Error(`Advanced search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Graph-based search
   *
   * Search using knowledge graph relationships
   *
   * @param query - Entity or concept to search
   * @param options - Search options
   * @returns Related memories via graph connections
   */
  async graph(query: string, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    try {
      if (!this.services.query) {
        throw new Error('Query service not available');
      }

      // Use QueryService.graphSearch - returns { memories, graphResults }
      const result = await this.services.query.graphSearch({
        query,
        userAddress: this.services.config.userAddress,
        queryType: 'graph',
        limit: options.limit || 10
      });

      // Extract memories array from result
      const memories = result.memories || [];

      return memories.map((r: any) => ({
        id: r.id,
        content: r.content || '',
        score: r.similarity_score || 0,
        similarity: r.similarity_score || 0,
        category: r.category,
        importance: r.metadata?.importance,
        blobId: r.blobId || r.id,
        metadata: r.metadata || {},
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now()
      }));
    } catch (error) {
      throw new Error(`Graph search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Search with embedding vectors included
   *
   * Same as vector search but includes embedding vectors in results
   *
   * @param query - Search query
   * @param options - Search options
   * @returns Results with embedding vectors
   */
  async withEmbeddings(query: string, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    return this.vector(query, {
      ...options,
      includeEmbeddings: true
    });
  }

  /**
   * Multi-vector search
   *
   * Search using multiple query vectors/texts
   *
   * @param queries - Array of query texts
   * @param options - Search options
   * @returns Combined and deduplicated results
   */
  async multiVector(queries: string[], options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    try {
      const allResults: SearchResult[] = [];
      const seenIds = new Set<string>();

      // Search for each query
      for (const query of queries) {
        const results = await this.vector(query, {
          ...options,
          limit: Math.ceil((options.limit || 10) / queries.length)
        });

        // Deduplicate
        results.forEach(r => {
          if (!seenIds.has(r.id)) {
            allResults.push(r);
            seenIds.add(r.id);
          }
        });
      }

      // Sort by score and limit
      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, options.limit || 10);
    } catch (error) {
      throw new Error(`Multi-vector search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Rerank search results using AI
   *
   * Takes existing results and reranks them using AI for better relevance
   *
   * @param results - Initial search results
   * @param query - Original query for context
   * @param options - Rerank options
   * @returns Reranked results
   */
  async rerank(
    results: SearchResult[],
    query: string,
    options: { limit?: number } = {}
  ): Promise<SearchResult[]> {
    try {
      if (!this.services.classifier) {
        throw new Error('Classifier service not configured. Need geminiApiKey for AI reranking.');
      }

      // Simple reranking: boost results by importance and category match
      const queryLower = query.toLowerCase();

      const scored = results.map(r => {
        let boost = 0;

        // Importance boost
        boost += ((r.importance || 5) - 5) * 0.02;

        // Content relevance boost (simple keyword match)
        if (r.content.toLowerCase().includes(queryLower)) {
          boost += 0.1;
        }

        // Topic relevance boost
        if (r.topic?.toLowerCase().includes(queryLower)) {
          boost += 0.05;
        }

        return {
          ...r,
          score: Math.min(1.0, r.score + boost)
        };
      });

      // Sort by new score
      scored.sort((a, b) => b.score - a.score);

      return scored.slice(0, options.limit || results.length);
    } catch (error) {
      throw new Error(`Rerank failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Populate content for search results by fetching from Walrus
   *
   * Fetches and decrypts content for each result in parallel.
   * Modifies results in-place.
   *
   * @param results - Search results to populate
   */
  private async populateContent(results: SearchResult[]): Promise<void> {
    // Option A+: Skip Walrus fetch for results that already have content from local index
    const resultsNeedingFetch = results.filter(r => !r.content && r.blobId);
    const resultsWithLocalContent = results.length - resultsNeedingFetch.length;

    if (resultsWithLocalContent > 0) {
      console.log(`📦 ${resultsWithLocalContent}/${results.length} results already have content from local index (skipping Walrus fetch)`);
    }

    if (resultsNeedingFetch.length === 0) {
      console.log('✅ All content available locally - no Walrus fetch needed!');
      return;
    }

    console.log(`🐳 Fetching content from Walrus for ${resultsNeedingFetch.length} results...`);

    const fetchPromises = resultsNeedingFetch.map(async (result) => {
      try {
        if (result.blobId) {
          const memoryPackage = await this.services.storage.retrieveMemoryPackage(result.blobId);
          if (memoryPackage.memoryPackage?.content) {
            result.content = memoryPackage.memoryPackage.content;
          }
        }
      } catch (error) {
        // Log but don't fail - content fetch is best-effort
        console.warn(`Failed to fetch content for ${result.blobId}:`, error);
      }
    });

    await Promise.all(fetchPromises);
  }

  /**
   * Search and fetch content in one call
   *
   * Convenience method that combines vector search with content fetching.
   *
   * @param query - Search query
   * @param options - Search options
   * @returns Results with content populated
   *
   * @example
   * ```typescript
   * const results = await pdw.search.withContent('programming');
   * console.log(results[0].content); // "I love TypeScript..."
   * ```
   */
  async withContent(query: string, options: VectorSearchOptions = {}): Promise<SearchResult[]> {
    return this.vector(query, { ...options, fetchContent: true });
  }

  // ==========================================================================
  // Knowledge Graph Methods (from GraphNamespace)
  // ==========================================================================

  /**
   * Get all entities from knowledge graph
   *
   * @param options - Filter options
   * @returns Array of entities
   *
   * @example
   * ```typescript
   * const entities = await pdw.search.entities({ type: 'PERSON' });
   * ```
   */
  async entities(options: {
    type?: string;
    minConfidence?: number;
    limit?: number;
  } = {}): Promise<Array<{
    id: string;
    name: string;
    type: string;
    confidence: number;
  }>> {
    try {
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        { limit: options.limit || 100 }
      );

      let entities = graphData.entities;

      if (options.type) {
        entities = entities.filter((e: any) => e.type === options.type);
      }

      if (options.minConfidence) {
        entities = entities.filter((e: any) => (e.confidence || 0) >= options.minConfidence!);
      }

      return entities.map((e: any) => ({
        id: e.id,
        name: e.label || '',
        type: e.type,
        confidence: e.confidence || 0
      }));
    } catch (error) {
      throw new Error(`Get entities failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all relationships from knowledge graph
   *
   * @param options - Filter options
   * @returns Array of relationships
   *
   * @example
   * ```typescript
   * const rels = await pdw.search.relationships({ type: 'WORKS_AT' });
   * ```
   */
  async relationships(options: {
    type?: string;
    sourceId?: string;
    targetId?: string;
    minConfidence?: number;
    limit?: number;
  } = {}): Promise<Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    confidence: number;
  }>> {
    try {
      const graphData = await this.services.storage.searchKnowledgeGraph(
        this.services.config.userAddress,
        {
          searchText: options.sourceId || options.targetId || '',
          limit: options.limit || 100
        }
      );

      let relationships = graphData.relationships;

      if (options.type) {
        relationships = relationships.filter((r: any) => r.type === options.type);
      }

      if (options.sourceId) {
        relationships = relationships.filter((r: any) => r.source === options.sourceId);
      }

      if (options.targetId) {
        relationships = relationships.filter((r: any) => r.target === options.targetId);
      }

      if (options.minConfidence) {
        relationships = relationships.filter((r: any) =>
          (r.confidence || 0) >= options.minConfidence!
        );
      }

      return relationships.map((r: any) => ({
        id: `${r.source}-${r.target}`,
        source: r.source,
        target: r.target,
        type: r.type || 'related',
        confidence: r.confidence || 0
      }));
    } catch (error) {
      throw new Error(`Get relationships failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ==========================================================================
  // Index Management (from IndexNamespace)
  // ==========================================================================

  /**
   * Index management operations
   *
   * Access via pdw.search.index.*
   */
  get index(): IndexSubNamespace {
    if (!this._indexSubNamespace) {
      this._indexSubNamespace = new IndexSubNamespace(this.services);
    }
    return this._indexSubNamespace;
  }

  private _indexSubNamespace?: IndexSubNamespace;
}

/**
 * Index sub-namespace for HNSW index management
 */
class IndexSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Get the underlying index service
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
   * Save index to Walrus storage
   *
   * Persists the HNSW index binary to Walrus for durability.
   *
   * @param spaceId - Index space identifier (userAddress)
   * @returns Blob ID of saved index on Walrus, or null if no index exists
   *
   * @example
   * ```typescript
   * const blobId = await pdw.search.index.save(userAddress);
   * console.log('Index saved to Walrus:', blobId);
   * ```
   */
  async save(spaceId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      await service.saveIndex(spaceId);
      console.log(`Index saved for space: ${spaceId}`);
    } else {
      await service.saveIndex(spaceId);
    }
  }

  /**
   * Load index from Walrus storage
   *
   * Loads a previously saved HNSW index from Walrus.
   *
   * @param spaceId - Index space identifier (userAddress)
   * @param blobId - Blob ID of the saved index on Walrus
   *
   * @example
   * ```typescript
   * await pdw.search.index.load(userAddress, 'blobId123');
   * ```
   */
  async load(spaceId: string, blobId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      await service.loadIndex(spaceId, blobId);
      console.log(`Index loaded from Walrus: ${blobId}`);
    } else {
      await service.loadIndex(spaceId, blobId);
    }
  }

  /**
   * Get index statistics
   *
   * @param spaceId - Index space identifier
   * @returns Index statistics
   *
   * @example
   * ```typescript
   * const stats = pdw.search.index.stats(userAddress);
   * console.log('Total vectors:', stats.totalVectors);
   * ```
   */
  stats(spaceId: string): {
    totalVectors: number;
    dimension: number;
    spaceType: string;
    maxElements: number;
    currentCount: number;
  } {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      const stats = service.getIndexStats(spaceId);
      return {
        totalVectors: stats.totalMemories || 0,
        dimension: 3072,
        spaceType: 'cosine',
        maxElements: 10000,
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
   * @param spaceId - Index space identifier
   */
  async flush(spaceId: string): Promise<void> {
    const { type, service } = this.getService();

    if (type === 'memoryIndex') {
      await service.flush(spaceId);
    }
  }
}
