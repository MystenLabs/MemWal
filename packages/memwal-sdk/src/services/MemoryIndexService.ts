/**
 * MemoryIndexService - Enhanced Memory Indexing and Vector Search
 *
 * Hybrid HNSW-powered memory indexing service providing:
 * - O(log N) vector similarity search performance
 * - Advanced clustering and graph-based memory organization
 * - Intelligent semantic search with relevance scoring
 * - Dynamic index optimization and parameter tuning
 * - Multi-dimensional vector space analysis
 *
 * Automatically selects the appropriate HNSW implementation:
 * - Browser: hnswlib-wasm (WebAssembly)
 * - Node.js: hnswlib-node (native bindings)
 */

import { createHnswService, isBrowser, isNode } from '../vector/createHnswService';
import type { IHnswService, IHnswSearchOptions } from '../vector/IHnswService';
import { EmbeddingService } from './EmbeddingService';
import { StorageService, type MemoryMetadata } from './StorageService';

export interface MemoryIndexEntry {
  memoryId: string;
  blobId: string;
  vectorId: number;
  embedding: number[];
  metadata: MemoryMetadata;
  indexedAt: Date;
  lastAccessed?: Date;
}

export interface MemoryIndexOptions {
  maxElements?: number;
  dimension?: number;
  efConstruction?: number;
  m?: number;
  batchSize?: number;
  autoFlushInterval?: number;
  /** Pre-initialized HNSW service instance (shared singleton) */
  hnswService?: IHnswService;
}

export interface MemorySearchQuery {
  query?: string;
  vector?: number[];
  userAddress: string;
  k?: number;
  threshold?: number;
  
  // Memory-specific filters
  categories?: string[];
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  importanceRange?: {
    min?: number;
    max?: number;
  };
  tags?: string[];
  includeContent?: boolean;
  
  // Enhanced search features
  searchMode?: 'semantic' | 'hybrid' | 'exact'; // Search strategy
  boostRecent?: boolean; // Boost recently created memories
  diversityFactor?: number; // Result diversity (0-1)
}

export interface MemorySearchResult {
  memoryId: string;
  blobId: string;
  metadata: MemoryMetadata;
  similarity: number;
  relevanceScore: number;
  content?: string | Uint8Array;
  extractedAt?: Date;
  embedding?: number[]; // Optional embedding vector for advanced similarity operations
  clusterInfo?: {
    clusterId: number;
    clusterCenter: number[];
    intraClusterSimilarity: number;
  };
}

/**
 * Memory-focused indexing service providing high-level memory operations
 * Uses hybrid HNSW implementation (browser: wasm, node: native) for optimal performance
 */
export class MemoryIndexService {
  private hnswService: IHnswService | null = null;
  private hnswServicePromise: Promise<IHnswService> | null = null;
  private embeddingService?: EmbeddingService;
  private storageService?: StorageService;
  private memoryIndex = new Map<string, Map<string, MemoryIndexEntry>>(); // userAddress -> memoryId -> entry
  private nextMemoryId = 1;
  private options: MemoryIndexOptions;

  // Performance tracking
  private indexStats = new Map<string, {
    totalVectors: number;
    avgSimilarity: number;
    searchLatency: number[];
    lastOptimized: Date;
  }>();

  constructor(
    storageService?: StorageService,
    options: MemoryIndexOptions = {}
  ) {
    this.storageService = storageService;
    this.options = options;

    // Use pre-initialized HNSW service if provided (shared singleton pattern)
    if (options.hnswService) {
      this.hnswService = options.hnswService;
      console.log('✅ MemoryIndexService using shared HNSW service instance');
    } else {
      // Initialize HNSW service asynchronously using factory
      this.hnswServicePromise = this.initializeHnswService();

      const envType = isBrowser() ? 'browser (hnswlib-wasm)' : isNode() ? 'Node.js (hnswlib-node)' : 'unknown';
      console.log(`✅ MemoryIndexService initializing with hybrid HNSW (${envType})`);
    }

    console.log(`   Max elements: ${options.maxElements || 10000}`);
    console.log(`   Embedding dimension: ${options.dimension || 768}`);
    console.log(`   HNSW parameters: M=${options.m || 16}, efConstruction=${options.efConstruction || 200}`);
  }

  /**
   * Initialize HNSW service using factory (auto-detects environment)
   */
  private async initializeHnswService(): Promise<IHnswService> {
    try {
      const service = await createHnswService({
        indexConfig: {
          dimension: this.options.dimension || 768, // Default 768 for speed (was 3072)
          maxElements: this.options.maxElements || 10000,
          efConstruction: this.options.efConstruction || 200,
          m: this.options.m || 16
        },
        batchConfig: {
          maxBatchSize: this.options.batchSize || 100,
          batchDelayMs: this.options.autoFlushInterval || 5000
        }
      });

      this.hnswService = service;
      console.log('✅ HNSW service initialized successfully');
      return service;
    } catch (error) {
      console.error('❌ Failed to initialize HNSW service:', error);
      throw error;
    }
  }

  /**
   * Get HNSW service (waits for initialization if needed)
   */
  private async getHnswService(): Promise<IHnswService> {
    if (this.hnswService) {
      return this.hnswService;
    }
    if (this.hnswServicePromise) {
      return this.hnswServicePromise;
    }
    throw new Error('HNSW service not initialized');
  }

  /**
   * Initialize with embedding service
   */
  initialize(embeddingService: EmbeddingService, storageService?: StorageService) {
    this.embeddingService = embeddingService;
    if (storageService) {
      this.storageService = storageService;
    }
    console.log('✅ MemoryIndexService: Embedding service connected');
  }

  /**
   * Index a memory with its content, metadata, and vector embedding
   *
   * @param userAddress - User's wallet address
   * @param memoryId - Unique memory identifier
   * @param blobId - Walrus blob ID for the memory
   * @param content - Memory content (stored in index only if not encrypted)
   * @param metadata - Memory metadata
   * @param embedding - Pre-computed embedding vector (optional)
   * @param options - Indexing options
   * @param options.isEncrypted - If true, content will NOT be stored in index (security)
   * @param options.forceStoreContent - If true, store content even when encrypted (for server-side RAG)
   */
  async indexMemory(
    userAddress: string,
    memoryId: string,
    blobId: string,
    content: string,
    metadata: MemoryMetadata,
    embedding?: number[],
    options?: { isEncrypted?: boolean; forceStoreContent?: boolean }
  ): Promise<{ vectorId: number; indexed: boolean }> {
    try {
      console.log(`📊 Indexing memory ${memoryId} for user ${userAddress}`);
      
      // Generate embedding if not provided
      let memoryEmbedding = embedding;
      if (!memoryEmbedding && this.embeddingService) {
        const embeddingResult = await this.embeddingService.embedText({ text: content });
        memoryEmbedding = embeddingResult.vector;
      }
      
      if (!memoryEmbedding) {
        throw new Error('No embedding provided and no embedding service available');
      }
      
      // Generate vector ID
      const vectorId = this.nextMemoryId++;
      
      // Add to HNSW index with batching
      // Option A+: Store content in index ONLY when encryption is OFF (security consideration)
      const hnswService = await this.getHnswService();
      const isEncrypted = options?.isEncrypted ?? false;

      const vectorMetadata: Record<string, unknown> = {
        memoryId,
        blobId,
        category: metadata.category,
        topic: metadata.topic,
        importance: metadata.importance,
        contentType: metadata.contentType,
        createdTimestamp: metadata.createdTimestamp,
        customMetadata: metadata.customMetadata
      };

      // Store content in index based on encryption and forceStoreContent settings
      const forceStoreContent = options?.forceStoreContent ?? false;
      if (forceStoreContent && content) {
        // Force store content for server-side RAG (user explicitly opted-in)
        vectorMetadata.content = content;
        console.log('   💾 Content stored in local index (forceStoreContent=true for RAG)');
      } else if (!isEncrypted && content) {
        vectorMetadata.content = content;
        console.log('   💾 Content stored in local index (encryption OFF)');
      } else if (isEncrypted) {
        console.log('   🔒 Content NOT stored in index (encryption ON - security)');
      }

      await hnswService.addVector(
        userAddress,
        vectorId,
        memoryEmbedding,
        vectorMetadata
      );

      // Update performance statistics
      this.updateIndexStats(userAddress);
      
      // Store in memory index
      if (!this.memoryIndex.has(userAddress)) {
        this.memoryIndex.set(userAddress, new Map());
      }
      
      const indexEntry: MemoryIndexEntry = {
        memoryId,
        blobId,
        vectorId,
        embedding: memoryEmbedding,
        metadata,
        indexedAt: new Date()
      };
      
      this.memoryIndex.get(userAddress)!.set(memoryId, indexEntry);
      
      console.log(`✅ Memory indexed: ${memoryId} (vector ${vectorId})`);
      console.log(`   Category: ${metadata.category}`);
      console.log(`   Importance: ${metadata.importance}`);
      console.log(`   Embedding dimension: ${memoryEmbedding.length}`);
      
      return { vectorId, indexed: true };
      
    } catch (error) {
      console.error('❌ Failed to index memory:', error);
      throw error;
    }
  }

  /**
   * Enhanced memory search using native HNSW with advanced features
   * Supports semantic search, metadata filtering, and intelligent relevance scoring
   */
  async searchMemories(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const startTime = performance.now();
    
    try {
      console.log(`🔍 Memory search for user ${query.userAddress}`);
      console.log(`   Query: "${query.query || 'vector search'}"`);
      console.log(`   Mode: ${query.searchMode || 'semantic'}, K: ${query.k || 10}`);
      
      // Generate query vector if needed
      let queryVector = query.vector;
      if (!queryVector && query.query && this.embeddingService) {
        const embeddingResult = await this.embeddingService.embedText({ text: query.query });
        queryVector = embeddingResult.vector;
      }
      
      if (!queryVector) {
        throw new Error('No query vector provided and no query text with embedding service');
      }

      const userMemories = this.memoryIndex.get(query.userAddress);
      if (!userMemories || userMemories.size === 0) {
        console.log('   No memories found for user');
        return [];
      }

      // Configure search parameters based on query mode
      const searchK = query.k || 10;
      const efSearch = query.searchMode === 'exact' ? searchK * 4 : 
                      query.searchMode === 'hybrid' ? searchK * 2 : searchK;
      
      // Perform HNSW search using native implementation
      const hnswService = await this.getHnswService();
      const hnswResults = await hnswService.search(
        query.userAddress,
        queryVector,
        {
          k: Math.min(searchK * 3, 100), // Get more candidates for post-filtering
          ef: efSearch,
          filter: this.createMetadataFilter(query)
        }
      );

      // Convert to memory search results with enhanced scoring
      const results: MemorySearchResult[] = [];

      for (const result of hnswResults) {
        const vectorId = result.vectorId;
        const distance = result.distance;
        // Calculate similarity from distance (cosine distance: similarity = 1 - distance)
        const similarity = result.score;

        // Skip results below threshold
        if (query.threshold && similarity < query.threshold) {
          continue;
        }

        // Find memory entry by vector ID
        const memoryEntry = Array.from(userMemories.values()).find(entry => entry.vectorId === vectorId);
        if (!memoryEntry) continue;

        // Enhanced relevance scoring
        let relevanceScore = this.calculateAdvancedRelevanceScore(
          similarity,
          memoryEntry.metadata,
          query,
          queryVector,
          memoryEntry.embedding || []
        );

        // Apply recency boost if requested
        if (query.boostRecent) {
          const recencyBoost = this.calculateRecencyBoost(memoryEntry.metadata.createdTimestamp || 0);
          relevanceScore += recencyBoost * 0.1;
        }

        // Option A+: Get content from HNSW metadata if available (avoids Walrus fetch!)
        // Content is only stored when encryption is OFF (see indexMemory)
        const indexedContent = result.metadata?.content as string | undefined;

        results.push({
          memoryId: memoryEntry.memoryId,
          blobId: memoryEntry.blobId,
          metadata: memoryEntry.metadata,
          similarity,
          relevanceScore,
          content: indexedContent, // ✅ Return content from local index (no Walrus fetch needed!)
          extractedAt: memoryEntry.indexedAt
        });
      }

      // Apply diversity filtering if requested
      let finalResults = results;
      if (query.diversityFactor && query.diversityFactor > 0) {
        finalResults = this.diversifyResults(results, query.diversityFactor);
      }

      // Sort by relevance score and limit results
      finalResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
      finalResults = finalResults.slice(0, searchK);

      // Update search statistics
      const searchLatency = performance.now() - startTime;
      this.updateSearchStats(query.userAddress, searchLatency);

      // Count how many results have content from local index (Option A+)
      const resultsWithLocalContent = finalResults.filter(r => r.content !== undefined).length;

      console.log(`✅ Search completed in ${searchLatency.toFixed(2)}ms`);
      console.log(`   Found ${finalResults.length} results (similarity range: ${finalResults.length > 0 ? finalResults[finalResults.length-1].similarity.toFixed(3) : 'N/A'} - ${finalResults.length > 0 ? finalResults[0].similarity.toFixed(3) : 'N/A'}`);
      if (resultsWithLocalContent > 0) {
        console.log(`   📦 ${resultsWithLocalContent}/${finalResults.length} results have content from local index (no Walrus fetch needed!)`);
      }

      return finalResults;
      
    } catch (error) {
      console.error('❌ Memory search failed:', error);
      throw error;
    }
  }

  /**
   * Get all memories for a user with optional filtering
   */
  async getUserMemories(
    userAddress: string,
    filters?: {
      categories?: string[];
      dateRange?: { start?: Date; end?: Date };
      importanceRange?: { min?: number; max?: number };
      limit?: number;
    }
  ): Promise<MemorySearchResult[]> {
    const userMemories = this.memoryIndex.get(userAddress);
    if (!userMemories) {
      return [];
    }
    
    const results: MemorySearchResult[] = [];
    
    for (const [memoryId, entry] of userMemories) {
      // Apply filters
      if (filters) {
        if (filters.categories && !filters.categories.includes(entry.metadata.category)) {
          continue;
        }
        
        if (filters.importanceRange) {
          const importance = entry.metadata.importance || 5;
          if (filters.importanceRange.min && importance < filters.importanceRange.min) continue;
          if (filters.importanceRange.max && importance > filters.importanceRange.max) continue;
        }
        
        if (filters.dateRange) {
          const created = new Date(entry.metadata.createdTimestamp || 0);
          if (filters.dateRange.start && created < filters.dateRange.start) continue;
          if (filters.dateRange.end && created > filters.dateRange.end) continue;
        }
      }
      
      results.push({
        memoryId: entry.memoryId,
        blobId: entry.blobId,
        metadata: entry.metadata,
        similarity: 1.0, // No similarity for direct listing
        relevanceScore: entry.metadata.importance || 5,
        extractedAt: entry.indexedAt
      });
    }
    
    // Sort by importance and creation time
    results.sort((a, b) => {
      const importanceDiff = (b.metadata.importance || 5) - (a.metadata.importance || 5);
      if (importanceDiff !== 0) return importanceDiff;
      return (b.metadata.createdTimestamp || 0) - (a.metadata.createdTimestamp || 0);
    });
    
    // Apply limit
    if (filters?.limit) {
      return results.slice(0, filters.limit);
    }
    
    return results;
  }

  /**
   * Remove memory from index
   */
  async removeMemory(userAddress: string, memoryId: string): Promise<boolean> {
    try {
      const userMemories = this.memoryIndex.get(userAddress);
      if (!userMemories) {
        return false;
      }
      
      const entry = userMemories.get(memoryId);
      if (!entry) {
        return false;
      }
      
      // Remove from HNSW index (if supported)
      // Note: hnswlib-node doesn't support deletion, so we just mark as removed
      
      // Remove from memory index
      userMemories.delete(memoryId);
      
      console.log(`✅ Memory removed from index: ${memoryId}`);
      return true;
      
    } catch (error) {
      console.error('❌ Failed to remove memory from index:', error);
      return false;
    }
  }

  /**
   * Get index statistics for a user
   */
  getIndexStats(userAddress: string): {
    totalMemories: number;
    categoryCounts: Record<string, number>;
    importanceDistribution: Record<number, number>;
    averageImportance: number;
    oldestMemory: Date | null;
    newestMemory: Date | null;
    indexSize: number;
  } {
    const userMemories = this.memoryIndex.get(userAddress);
    if (!userMemories) {
      return {
        totalMemories: 0,
        categoryCounts: {},
        importanceDistribution: {},
        averageImportance: 0,
        oldestMemory: null,
        newestMemory: null,
        indexSize: 0
      };
    }
    
    const categoryCounts: Record<string, number> = {};
    const importanceDistribution: Record<number, number> = {};
    let totalImportance = 0;
    let oldestMemory: Date | null = null;
    let newestMemory: Date | null = null;
    
    for (const entry of userMemories.values()) {
      // Categories
      categoryCounts[entry.metadata.category] = (categoryCounts[entry.metadata.category] || 0) + 1;
      
      // Importance
      const importance = entry.metadata.importance || 5;
      importanceDistribution[importance] = (importanceDistribution[importance] || 0) + 1;
      totalImportance += importance;
      
      // Dates
      const created = new Date(entry.metadata.createdTimestamp || 0);
      if (!oldestMemory || created < oldestMemory) {
        oldestMemory = created;
      }
      if (!newestMemory || created > newestMemory) {
        newestMemory = created;
      }
    }
    
    return {
      totalMemories: userMemories.size,
      categoryCounts,
      importanceDistribution,
      averageImportance: userMemories.size > 0 ? totalImportance / userMemories.size : 0,
      oldestMemory,
      newestMemory,
      indexSize: userMemories.size
    };
  }

  /**
   * Flush pending operations and save index
   */
  async flush(userAddress: string): Promise<void> {
    const hnswService = await this.getHnswService();
    await hnswService.flushBatch(userAddress);
    console.log(`✅ Memory index flushed for user ${userAddress}`);
  }

  /**
   * Load index from storage (local or Walrus)
   *
   * @param userAddress - User's wallet address
   * @param indexBlobId - Optional Walrus blob ID to load from cloud
   */
  async loadIndex(userAddress: string, indexBlobId?: string): Promise<void> {
    const hnswService = await this.getHnswService();

    // If blobId provided, try to load from Walrus first
    if (indexBlobId && 'loadFromWalrus' in hnswService) {
      console.log(`📥 Attempting to load index from Walrus: ${indexBlobId}`);
      const walrusLoaded = await (hnswService as any).loadFromWalrus(userAddress, indexBlobId);
      if (walrusLoaded) {
        console.log(`✅ Memory index loaded from Walrus for user ${userAddress}`);
        return;
      }
      console.log(`⚠️ Walrus load failed, falling back to local storage`);
    }

    // Fallback to local storage
    const loaded = await hnswService.loadIndex(userAddress);
    if (loaded) {
      console.log(`✅ Memory index loaded from local storage for user ${userAddress}`);
    }
  }

  /**
   * Save index to local storage
   */
  async saveIndex(userAddress: string): Promise<void> {
    const hnswService = await this.getHnswService();
    await hnswService.saveIndex(userAddress);
    console.log(`✅ Memory index saved for user ${userAddress}`);
  }

  /**
   * Sync index to Walrus cloud storage
   *
   * @param userAddress - User's wallet address
   * @returns Walrus blob ID if successful, null if Walrus is disabled
   */
  async syncToWalrus(userAddress: string): Promise<string | null> {
    const hnswService = await this.getHnswService();

    if (!('syncToWalrus' in hnswService)) {
      console.warn('⚠️ HNSW service does not support Walrus sync');
      return null;
    }

    const blobId = await (hnswService as any).syncToWalrus(userAddress);
    if (blobId) {
      console.log(`☁️ Memory index synced to Walrus: ${blobId}`);
    }
    return blobId;
  }

  /**
   * Load index directly from Walrus cloud storage
   *
   * @param userAddress - User's wallet address
   * @param blobId - Walrus blob ID
   * @returns true if successfully loaded
   */
  async loadFromWalrus(userAddress: string, blobId: string): Promise<boolean> {
    const hnswService = await this.getHnswService();

    if (!('loadFromWalrus' in hnswService)) {
      console.warn('⚠️ HNSW service does not support Walrus load');
      return false;
    }

    const loaded = await (hnswService as any).loadFromWalrus(userAddress, blobId);
    if (loaded) {
      console.log(`☁️ Memory index loaded from Walrus: ${blobId}`);
    }
    return loaded;
  }

  /**
   * Get the Walrus blob ID for a user's index (if backed up)
   *
   * @param userAddress - User's wallet address
   * @returns Blob ID or null if not backed up
   */
  getWalrusBlobId(userAddress: string): string | null {
    if (this.hnswService && 'getWalrusBlobId' in this.hnswService) {
      return (this.hnswService as any).getWalrusBlobId(userAddress);
    }
    return null;
  }

  /**
   * Check if Walrus backup is enabled
   */
  isWalrusEnabled(): boolean {
    if (this.hnswService && 'isWalrusEnabled' in this.hnswService) {
      return (this.hnswService as any).isWalrusEnabled();
    }
    return false;
  }

  /**
   * Clear user's index
   */
  async clearUserIndex(userAddress: string): Promise<void> {
    this.memoryIndex.delete(userAddress);
    const hnswService = await this.getHnswService();
    await hnswService.deleteIndex(userAddress);
    console.log(`✅ Memory index cleared for user ${userAddress}`);
  }

  /**
   * Get overall service statistics
   */
  async getServiceStats() {
    const totalMemories = Array.from(this.memoryIndex.values())
      .reduce((sum, userMemories) => sum + userMemories.size, 0);

    let hnswStats = null;
    if (this.hnswService) {
      hnswStats = this.hnswService.getBatchStats();
    }

    return {
      totalUsers: this.memoryIndex.size,
      totalMemories,
      hnswStats,
      hasEmbeddingService: !!this.embeddingService,
      hasStorageService: !!this.storageService
    };
  }

  /**
   * Destroy service and cleanup resources
   */
  destroy(): void {
    if (this.hnswService) {
      this.hnswService.destroy();
    }
    this.hnswService = null;
    this.hnswServicePromise = null;
    this.memoryIndex.clear();
    console.log('✅ MemoryIndexService destroyed');
  }

  // ==================== PRIVATE HELPER METHODS ====================

  private createMemoryFilter(query: MemorySearchQuery) {
    return (metadata: any) => {
      // Category filter
      if (query.categories && query.categories.length > 0) {
        if (!query.categories.includes(metadata.category)) {
          return false;
        }
      }
      
      // Date range filter
      if (query.dateRange) {
        const created = new Date(metadata.createdTimestamp || 0);
        if (query.dateRange.start && created < query.dateRange.start) {
          return false;
        }
        if (query.dateRange.end && created > query.dateRange.end) {
          return false;
        }
      }
      
      // Importance range filter
      if (query.importanceRange) {
        const importance = metadata.importance || 5;
        if (query.importanceRange.min && importance < query.importanceRange.min) {
          return false;
        }
        if (query.importanceRange.max && importance > query.importanceRange.max) {
          return false;
        }
      }
      
      // Tags filter (search in custom metadata)
      if (query.tags && query.tags.length > 0) {
        const metadataText = JSON.stringify(metadata).toLowerCase();
        const hasAnyTag = query.tags.some(tag => 
          metadataText.includes(tag.toLowerCase())
        );
        if (!hasAnyTag) {
          return false;
        }
      }
      
      return true;
    };
  }

  // ==================== HNSW HELPER METHODS ====================

  /**
   * Create metadata filter for HNSW search
   */
  private createMetadataFilter(query: MemorySearchQuery): ((metadata: any) => boolean) | undefined {
    if (!query.categories && !query.dateRange && !query.importanceRange && !query.tags) {
      return undefined;
    }
    
    return (metadata: any) => {
      // Category filter
      if (query.categories && query.categories.length > 0) {
        if (!query.categories.includes(metadata.category)) {
          return false;
        }
      }
      
      // Date range filter
      if (query.dateRange) {
        const created = new Date(metadata.createdTimestamp || 0);
        if (query.dateRange.start && created < query.dateRange.start) {
          return false;
        }
        if (query.dateRange.end && created > query.dateRange.end) {
          return false;
        }
      }
      
      // Importance range filter
      if (query.importanceRange) {
        const importance = metadata.importance || 5;
        if (query.importanceRange.min && importance < query.importanceRange.min) {
          return false;
        }
        if (query.importanceRange.max && importance > query.importanceRange.max) {
          return false;
        }
      }
      
      // Tags filter
      if (query.tags && query.tags.length > 0) {
        const metadataText = JSON.stringify(metadata).toLowerCase();
        const hasAnyTag = query.tags.some(tag => 
          metadataText.includes(tag.toLowerCase())
        );
        if (!hasAnyTag) {
          return false;
        }
      }
      
      return true;
    };
  }

  /**
   * Update index statistics for a user
   */
  private updateIndexStats(userAddress: string): void {
    let stats = this.indexStats.get(userAddress);
    if (!stats) {
      stats = {
        totalVectors: 0,
        avgSimilarity: 0,
        searchLatency: [],
        lastOptimized: new Date()
      };
      this.indexStats.set(userAddress, stats);
    }
    stats.totalVectors++;
  }

  /**
   * Enhanced relevance scoring with multiple factors
   */
  private calculateAdvancedRelevanceScore(
    similarity: number,
    metadata: MemoryMetadata,
    query: MemorySearchQuery,
    queryVector: number[],
    documentVector: number[]
  ): number {
    let score = similarity * 0.7; // Base similarity weight (increased)
    
    // Importance boost
    const importance = metadata.importance || 5;
    score += (importance - 5) * 0.02; // -0.1 to +0.1 boost
    
    // Category exact match boost
    if (query.categories && query.categories.includes(metadata.category)) {
      score += 0.15;
    }
    
    // Topic relevance boost
    if (query.query && metadata.topic) {
      const queryLower = query.query.toLowerCase();
      const topicLower = metadata.topic.toLowerCase();
      if (queryLower.includes(topicLower) || topicLower.includes(queryLower)) {
        score += 0.1;
      }
    }
    
    // Vector quality boost (based on vector magnitude)
    const vectorMagnitude = this.calculateVectorMagnitude(documentVector);
    if (vectorMagnitude > 0.1) { // Well-formed embedding
      score += 0.05;
    }
    
    // Semantic consistency boost (cosine similarity in different metric)
    const semanticConsistency = this.calculateSemanticConsistency(queryVector, documentVector);
    score += semanticConsistency * 0.1;
    
    return Math.min(1.0, Math.max(0.0, score));
  }

  /**
   * Calculate recency boost based on creation timestamp
   */
  private calculateRecencyBoost(createdTimestamp: number): number {
    const now = Date.now();
    const ageInDays = (now - createdTimestamp) / (1000 * 60 * 60 * 24);
    
    // Exponential decay: more recent = higher boost
    if (ageInDays < 1) return 1.0;        // Last day: full boost
    if (ageInDays < 7) return 0.8;        // Last week: 80% boost
    if (ageInDays < 30) return 0.5;       // Last month: 50% boost
    if (ageInDays < 90) return 0.2;       // Last quarter: 20% boost
    return 0.0;                           // Older: no boost
  }

  /**
   * Diversify search results to avoid clustering
   */
  private diversifyResults(results: MemorySearchResult[], diversityFactor: number): MemorySearchResult[] {
    if (diversityFactor <= 0 || results.length <= 1) return results;
    
    const diversified: MemorySearchResult[] = [];
    const remaining = [...results];
    
    // Always include the top result
    if (remaining.length > 0) {
      diversified.push(remaining.shift()!);
    }
    
    while (remaining.length > 0 && diversified.length < results.length * 0.8) {
      let bestIndex = 0;
      let bestScore = 0;
      
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        
        // Calculate diversity score (distance from already selected results)
        let minSimilarity = 1.0;
        for (const selected of diversified) {
          const similarity = candidate.similarity; // Could enhance with actual vector similarity
          minSimilarity = Math.min(minSimilarity, similarity);
        }
        
        // Combine relevance and diversity
        const diversityScore = candidate.relevanceScore * (1 - diversityFactor) + 
                              (1 - minSimilarity) * diversityFactor;
        
        if (diversityScore > bestScore) {
          bestScore = diversityScore;
          bestIndex = i;
        }
      }
      
      diversified.push(remaining.splice(bestIndex, 1)[0]);
    }
    
    return diversified;
  }

  /**
   * Update search performance statistics
   */
  private updateSearchStats(userAddress: string, latency: number): void {
    let stats = this.indexStats.get(userAddress);
    if (!stats) {
      stats = {
        totalVectors: 0,
        avgSimilarity: 0,
        searchLatency: [],
        lastOptimized: new Date()
      };
      this.indexStats.set(userAddress, stats);
    }
    
    stats.searchLatency.push(latency);
    
    // Keep only last 100 latency measurements
    if (stats.searchLatency.length > 100) {
      stats.searchLatency = stats.searchLatency.slice(-100);
    }
  }

  /**
   * Calculate vector magnitude
   */
  private calculateVectorMagnitude(vector: number[]): number {
    let sum = 0;
    for (const val of vector) {
      sum += val * val;
    }
    return Math.sqrt(sum);
  }

  /**
   * Calculate cosine similarity between two vectors
   * Used for semantic consistency scoring
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Calculate semantic consistency score
   */
  private calculateSemanticConsistency(queryVector: number[], documentVector: number[]): number {
    // Calculate angle between vectors (semantic consistency)
    const similarity = this.cosineSimilarity(queryVector, documentVector);
    const angle = Math.acos(Math.max(-1, Math.min(1, similarity)));
    
    // Convert angle to consistency score (0-1, where 1 is perfect alignment)
    return 1 - (angle / Math.PI);
  }
}