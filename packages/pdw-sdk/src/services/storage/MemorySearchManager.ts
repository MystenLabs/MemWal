/**
 * MemorySearchManager - Memory Indexing and Search Operations
 *
 * Handles HNSW vector indexing and semantic search for memories.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - Automatic memory indexing with embeddings
 * - Semantic search via HNSW
 * - Metadata-based filtering
 * - Category and temporal search
 */

import type { MemoryIndexService, MemorySearchQuery } from '../MemoryIndexService';
import type { EmbeddingService } from '../EmbeddingService';

export interface MemoryMetadata {
  contentType: string;
  contentSize: number;
  contentHash: string;
  category: string;
  topic: string;
  importance: number;
  embeddingBlobId?: string;
  embeddingDimension: number;
  createdTimestamp: number;
  updatedTimestamp?: number;
  customMetadata?: Record<string, string>;
  isEncrypted?: boolean;
  encryptionType?: string;
}

export interface MetadataSearchQuery {
  query?: string;
  vector?: number[];
  filters?: {
    category?: string | string[];
    topic?: string | string[];
    importance?: { min?: number; max?: number };
    contentType?: string | string[];
    dateRange?: { start?: Date; end?: Date };
    tags?: string[];
    contentSize?: { min?: number; max?: number };
  };
  k?: number;
  threshold?: number;
  includeContent?: boolean;
  useCache?: boolean;
}

export interface MetadataSearchResult {
  blobId: string;
  content?: string | Uint8Array;
  metadata: MemoryMetadata;
  similarity: number;
  relevanceScore: number;
}

export interface IndexingResult {
  vectorId: number;
  blobId: string;
  memoryId: string;
}

/**
 * MemorySearchManager - Manages memory indexing and semantic search
 *
 * Coordinates between:
 * - EmbeddingService for vector generation
 * - MemoryIndexService for HNSW indexing
 * - Metadata filtering and relevance scoring
 */
export class MemorySearchManager {
  private memoryIndexService?: MemoryIndexService;
  private embeddingService?: EmbeddingService;

  constructor() {
    // Services will be initialized via initializeSearch()
  }

  /**
   * Initialize search capabilities
   */
  initializeSearch(
    embeddingService: EmbeddingService,
    memoryIndexService?: MemoryIndexService
  ) {
    this.embeddingService = embeddingService;
    this.memoryIndexService = memoryIndexService;

    if (this.memoryIndexService) {
      this.memoryIndexService.initialize(embeddingService, undefined as any);
    }

    console.log('✅ MemorySearchManager: Search capabilities initialized');
  }

  /**
   * Index a memory for semantic search
   *
   * @param userAddress - Owner address
   * @param memoryId - Unique memory identifier
   * @param blobId - Walrus blob ID
   * @param textContent - Content for embedding generation
   * @param metadata - Memory metadata
   * @returns Indexing result with vector ID
   */
  async indexMemory(
    userAddress: string,
    memoryId: string,
    blobId: string,
    textContent: string,
    metadata: MemoryMetadata
  ): Promise<IndexingResult> {
    if (!this.embeddingService || !this.memoryIndexService) {
      throw new Error('Search capabilities not initialized. Call initializeSearch() first.');
    }

    const indexResult = await this.memoryIndexService.indexMemory(
      userAddress,
      memoryId,
      blobId,
      textContent,
      metadata
    );

    console.log(`✅ Indexed memory ${memoryId} → vector ${indexResult.vectorId}`);

    return {
      vectorId: indexResult.vectorId,
      blobId,
      memoryId
    };
  }

  /**
   * Search memories by metadata with semantic understanding
   *
   * @param userAddress - Owner address
   * @param searchQuery - Search query with filters
   * @returns Array of matching memories with relevance scores
   */
  async searchByMetadata(
    userAddress: string,
    searchQuery: MetadataSearchQuery
  ): Promise<MetadataSearchResult[]> {
    if (!this.embeddingService || !this.memoryIndexService) {
      throw new Error('Search capabilities not initialized. Call initializeSearch() first.');
    }

    try {
      console.log(`🔍 Searching memories for user ${userAddress}`);

      // Convert to MemoryIndexService query format
      const memoryQuery: MemorySearchQuery = {
        query: searchQuery.query,
        vector: searchQuery.vector,
        userAddress,
        k: searchQuery.k || 10,
        threshold: searchQuery.threshold,
        categories: searchQuery.filters?.category
          ? (Array.isArray(searchQuery.filters.category)
              ? searchQuery.filters.category
              : [searchQuery.filters.category])
          : undefined,
        dateRange: searchQuery.filters?.dateRange,
        importanceRange: searchQuery.filters?.importance,
        tags: searchQuery.filters?.tags,
        includeContent: searchQuery.includeContent
      };

      const results = await this.memoryIndexService.searchMemories(memoryQuery);

      // Convert to MetadataSearchResult format
      const metadataResults: MetadataSearchResult[] = results.map(result => ({
        blobId: result.blobId,
        content: result.content,
        metadata: result.metadata,
        similarity: result.similarity,
        relevanceScore: result.relevanceScore
      }));

      console.log(`✅ Found ${metadataResults.length} matching memories`);
      return metadataResults;

    } catch (error) {
      console.error('❌ Metadata search failed:', error);
      throw error;
    }
  }

  /**
   * Get all indexed memories for a user with optional filtering
   */
  async getUserMemoriesWithMetadata(
    userAddress: string,
    filters?: MetadataSearchQuery['filters']
  ): Promise<MetadataSearchResult[]> {
    if (!this.memoryIndexService) {
      throw new Error('Memory indexing not initialized. Call initializeSearch() first.');
    }

    // Convert filters to MemoryIndexService format
    const indexFilters = filters ? {
      categories: filters.category
        ? (Array.isArray(filters.category) ? filters.category : [filters.category])
        : undefined,
      dateRange: filters.dateRange,
      importanceRange: filters.importance
    } : undefined;

    const memories = await this.memoryIndexService.getUserMemories(userAddress, indexFilters);

    // Convert to MetadataSearchResult format
    return memories.map(memory => ({
      blobId: memory.blobId,
      metadata: memory.metadata,
      similarity: memory.similarity,
      relevanceScore: memory.relevanceScore
    }));
  }

  /**
   * Search by category with additional filtering
   */
  async searchByCategory(
    userAddress: string,
    category: string,
    additionalFilters?: Omit<MetadataSearchQuery['filters'], 'category'>
  ): Promise<MetadataSearchResult[]> {
    return this.searchByMetadata(userAddress, {
      filters: {
        category,
        ...additionalFilters
      },
      k: 50,
      includeContent: false
    });
  }

  /**
   * Search memories within time range
   */
  async searchByTimeRange(
    userAddress: string,
    startDate: Date,
    endDate: Date,
    additionalFilters?: Omit<MetadataSearchQuery['filters'], 'dateRange'>
  ): Promise<MetadataSearchResult[]> {
    return this.searchByMetadata(userAddress, {
      filters: {
        dateRange: { start: startDate, end: endDate },
        ...additionalFilters
      },
      k: 100,
      includeContent: false
    });
  }

  /**
   * Get search analytics and statistics
   */
  getSearchAnalytics(userAddress: string): {
    totalMemories: number;
    categoryCounts: Record<string, number>;
    averageImportance: number;
    timeRange: { earliest: Date; latest: Date } | null;
    topTags: Array<{ tag: string; count: number }>;
  } {
    if (!this.memoryIndexService) {
      return {
        totalMemories: 0,
        categoryCounts: {},
        averageImportance: 0,
        timeRange: null,
        topTags: []
      };
    }

    const stats = this.memoryIndexService.getIndexStats(userAddress);

    return {
      totalMemories: stats.totalMemories,
      categoryCounts: stats.categoryCounts,
      averageImportance: stats.averageImportance,
      timeRange: stats.oldestMemory && stats.newestMemory ? {
        earliest: stats.oldestMemory,
        latest: stats.newestMemory
      } : null,
      topTags: [] // TODO: Implement tag extraction
    };
  }

  /**
   * Get service statistics
   */
  getServiceStats() {
    return this.memoryIndexService?.getServiceStats() || {
      totalUsers: 0,
      totalMemories: 0,
      averageMemoriesPerUser: 0
    };
  }

  /**
   * Calculate relevance score combining similarity, importance, and recency
   */
  private calculateRelevanceScore(
    similarity: number,
    metadata: MemoryMetadata,
    query: MetadataSearchQuery
  ): number {
    let score = similarity * 0.6; // Base similarity weight

    // Boost by importance
    score += (metadata.importance || 5) * 0.1;

    // Recent content boost
    const ageInDays = (Date.now() - (metadata.createdTimestamp || 0)) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, (30 - ageInDays) / 30) * 0.2;
    score += recencyBoost;

    // Category exact match boost
    if (query.filters?.category && metadata.category === query.filters.category) {
      score += 0.1;
    }

    return Math.min(1.0, score);
  }

  /**
   * Check if memory matches filters
   */
  private matchesFilters(
    metadata: MemoryMetadata,
    filters: NonNullable<MetadataSearchQuery['filters']>
  ): boolean {
    // Category filter
    if (filters.category) {
      const categories = Array.isArray(filters.category) ? filters.category : [filters.category];
      if (!categories.includes(metadata.category)) return false;
    }

    // Topic filter
    if (filters.topic) {
      const topics = Array.isArray(filters.topic) ? filters.topic : [filters.topic];
      if (!topics.includes(metadata.topic)) return false;
    }

    // Importance range
    if (filters.importance) {
      const importance = metadata.importance || 5;
      if (filters.importance.min && importance < filters.importance.min) return false;
      if (filters.importance.max && importance > filters.importance.max) return false;
    }

    // Content type filter
    if (filters.contentType) {
      const contentTypes = Array.isArray(filters.contentType)
        ? filters.contentType
        : [filters.contentType];
      if (!contentTypes.includes(metadata.contentType)) return false;
    }

    // Content size filter
    if (filters.contentSize) {
      const size = metadata.contentSize || 0;
      if (filters.contentSize.min && size < filters.contentSize.min) return false;
      if (filters.contentSize.max && size > filters.contentSize.max) return false;
    }

    // Custom tag filtering
    if (filters.tags && filters.tags.length > 0) {
      const metadataText = JSON.stringify(metadata).toLowerCase();
      const hasMatchingTag = filters.tags.some(tag =>
        metadataText.includes(tag.toLowerCase())
      );
      if (!hasMatchingTag) return false;
    }

    return true;
  }
}
