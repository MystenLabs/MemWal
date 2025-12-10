/**
 * Memory Service
 * 
 * Handles all memory-related operations including CRUD, search, context retrieval,
 * HNSW vector search, metadata embeddings, and Walrus Quilts integration.
 */

import type {
  ClientWithCoreApi,
  PDWConfig,
  MemoryCreateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryContext,
  MemoryContextOptions,
  MemoryStatsResponse,
  Thunk,
  AsyncThunk
} from '../types';
import { PDWApiClient } from '../api/client';
import { Transaction } from '@mysten/sui/transactions';
import * as memoryContract from '../generated/pdw/memory';

export class MemoryService {
  private apiClient: PDWApiClient;

  constructor(
    private client: ClientWithCoreApi,
    private config: PDWConfig
  ) {
    this.apiClient = new PDWApiClient(config.apiUrl!);
  }

  // ==================== TOP-LEVEL METHODS ====================

  /**
   * Create a new memory with full processing pipeline
   */
  async createMemory(options: MemoryCreateOptions): Promise<string> {
    const response = await this.apiClient.createMemory(options);
    
    if (!response.success) {
      throw new Error(response.message || 'Failed to create memory');
    }

    return response.data!.memoryId;
  }

  /**
   * Search memories using HNSW vector similarity with advanced options
   */
  async searchMemories(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const response = await this.apiClient.searchMemories(options);
    
    if (!response.success) {
      throw new Error(response.message || 'Failed to search memories');
    }

    return response.data!.results;
  }

  /**
   * Advanced memory search with similarity scoring and filtering
   */
  async searchMemoriesAdvanced(options: {
    query: string;
    userAddress: string;
    category?: string;
    k?: number;
    threshold?: number; // Similarity threshold (0.0-1.0)
    includeMetadata?: boolean;
    includeEmbeddings?: boolean;
    timeRange?: {
      start?: Date;
      end?: Date;
    };
  }): Promise<{
    results: MemorySearchResult[];
    searchMetadata: {
      queryTime: number;
      totalResults: number;
      filteredResults: number;
      averageSimilarity: number;
      categories: Record<string, number>;
    };
  }> {
    const startTime = Date.now();
    
    // First get results from backend
    const searchOptions: MemorySearchOptions = {
      query: options.query,
      userAddress: options.userAddress,
      category: options.category,
      k: options.k || 20, // Get more results initially for filtering
      threshold: options.threshold || 0.7
    };

    const response = await this.apiClient.searchMemories(searchOptions);
    
    if (!response.success) {
      throw new Error(response.message || 'Failed to search memories');
    }

    let results = response.data!.results;
    const totalResults = results.length;

    // Apply similarity threshold filtering
    if (options.threshold) {
      results = results.filter(memory => 
        (memory.similarity_score || 0) >= options.threshold!
      );
    }

    // Apply time range filtering
    if (options.timeRange) {
      results = results.filter(memory => {
        const memoryTime = new Date(memory.timestamp);
        const afterStart = !options.timeRange!.start || memoryTime >= options.timeRange!.start;
        const beforeEnd = !options.timeRange!.end || memoryTime <= options.timeRange!.end;
        return afterStart && beforeEnd;
      });
    }

    // Limit final results
    results = results.slice(0, options.k || 10);

    // Calculate metadata
    const similarities = results.map(r => r.similarity_score || 0).filter(s => s > 0);
    const averageSimilarity = similarities.length > 0 
      ? similarities.reduce((sum, sim) => sum + sim, 0) / similarities.length 
      : 0;

    const categories: Record<string, number> = {};
    results.forEach(memory => {
      categories[memory.category] = (categories[memory.category] || 0) + 1;
    });

    const queryTime = Date.now() - startTime;

    return {
      results,
      searchMetadata: {
        queryTime,
        totalResults,
        filteredResults: results.length,
        averageSimilarity,
        categories
      }
    };
  }

  /**
   * Get memory context for AI chat integration
   */
  async getMemoryContext(query: string, userAddress: string, k?: number): Promise<MemoryContext> {
    const response = await this.apiClient.getMemoryContext({
      query_text: query,
      user_address: userAddress,
      k,
    });
    
    if (!response.success) {
      throw new Error(response.message || 'Failed to get memory context');
    }

    return response.data!;
  }

  // ==================== TRANSACTION BUILDERS ====================

  get tx() {
    return {
      /**
       * Create transaction for memory record on blockchain
       */
      createMemoryRecord: async (options: {
        category: string;
        vectorId: number | bigint;
        blobId: string;
        metadata: {
          contentType: string;
          contentSize: number | bigint;
          contentHash: string;
          category: string;
          topic: string;
          importance: number;
          embeddingBlobId: string;
          embeddingDimension: number | bigint;
          createdTimestamp: number | bigint;
          updatedTimestamp: number | bigint;
          customMetadata?: Record<string, string>;
        };
      }) => {
        const tx = new Transaction();
        
        // Create the memory record with inline metadata
        const memoryRecord = memoryContract.createMemoryRecord({
          package: this.config.packageId,
          arguments: {
            category: Array.from(new TextEncoder().encode(options.category)),
            vectorId: options.vectorId,
            blobId: Array.from(new TextEncoder().encode(options.blobId)),
            contentType: Array.from(new TextEncoder().encode(options.metadata.contentType)),
            contentSize: options.metadata.contentSize,
            contentHash: Array.from(new TextEncoder().encode(options.metadata.contentHash)),
            topic: Array.from(new TextEncoder().encode(options.metadata.topic)),
            importance: options.metadata.importance,
            embeddingBlobId: Array.from(new TextEncoder().encode(options.metadata.embeddingBlobId))
          }
        });
        
        tx.add(memoryRecord);
        return tx;
      },

      /**
       * Create transaction to delete memory
       */
      deleteMemory: async (memoryId: string) => {
        const tx = new Transaction();
        
        const deleteCall = memoryContract.deleteMemoryRecord({
          package: this.config.packageId,
          arguments: {
            memory: memoryId
          }
        });
        
        tx.add(deleteCall);
        return tx;
      },

      /**
       * Create transaction to update memory metadata
       */
      updateMemoryMetadata: async (memoryId: string, metadata: {
        newTopic: string;
        newImportance: number;
      }) => {
        const tx = new Transaction();
        
        const updateCall = memoryContract.updateMemoryMetadata({
          package: this.config.packageId,
          arguments: {
            memory: memoryId,
            newTopic: Array.from(new TextEncoder().encode(metadata.newTopic)),
            newImportance: metadata.newImportance
          }
        });
        
        tx.add(updateCall);
        return tx;
      },

      /**
       * Create memory index transaction
       */
      createMemoryIndex: async (options: {
        indexBlobId: string;
        graphBlobId: string;
      }) => {
        const tx = new Transaction();
        
        const indexCall = memoryContract.createMemoryIndex({
          package: this.config.packageId,
          arguments: {
            indexBlobId: Array.from(new TextEncoder().encode(options.indexBlobId)),
            graphBlobId: Array.from(new TextEncoder().encode(options.graphBlobId))
          }
        });
        
        tx.add(indexCall);
        return tx;
      },

      /**
       * Update memory index transaction
       */
      updateMemoryIndex: async (options: {
        memoryIndex: string;
        expectedVersion: number | bigint;
        newIndexBlobId: string;
        newGraphBlobId: string;
      }) => {
        const tx = new Transaction();
        
        const updateCall = memoryContract.updateMemoryIndex({
          package: this.config.packageId,
          arguments: {
            memoryIndex: options.memoryIndex,
            expectedVersion: options.expectedVersion,
            newIndexBlobId: Array.from(new TextEncoder().encode(options.newIndexBlobId)),
            newGraphBlobId: Array.from(new TextEncoder().encode(options.newGraphBlobId))
          }
        });
        
        tx.add(updateCall);
        return tx;
      },
    };
  }

  // ==================== MOVE CALL BUILDERS ====================

  get call() {
    return {
      /**
       * Move call for memory record creation
       */
      createMemoryRecord: (options: {
        category: string;
        vectorId: number | bigint;
        blobId: string;
        contentType: string;
        contentSize: number | bigint;
        contentHash: string;
        topic: string;
        importance: number;
        embeddingBlobId: string;
      }): Thunk => {
        return memoryContract.createMemoryRecord({
          package: this.config.packageId,
          arguments: {
            category: Array.from(new TextEncoder().encode(options.category)),
            vectorId: options.vectorId,
            blobId: Array.from(new TextEncoder().encode(options.blobId)),
            contentType: Array.from(new TextEncoder().encode(options.contentType)),
            contentSize: options.contentSize,
            contentHash: Array.from(new TextEncoder().encode(options.contentHash)),
            topic: Array.from(new TextEncoder().encode(options.topic)),
            importance: options.importance,
            embeddingBlobId: Array.from(new TextEncoder().encode(options.embeddingBlobId))
          }
        });
      },

      /**
       * Move call for memory deletion
       */
      deleteMemory: (memoryId: string): Thunk => {
        return memoryContract.deleteMemoryRecord({
          package: this.config.packageId,
          arguments: {
            memory: memoryId
          }
        });
      },

      /**
       * Move call for memory metadata updates
       */
      updateMemoryMetadata: (memoryId: string, options: {
        newTopic: string;
        newImportance: number;
      }): Thunk => {
        return memoryContract.updateMemoryMetadata({
          package: this.config.packageId,
          arguments: {
            memory: memoryId,
            newTopic: Array.from(new TextEncoder().encode(options.newTopic)),
            newImportance: options.newImportance
          }
        });
      },

      /**
       * Move call for memory index creation
       */
      createMemoryIndex: (options: {
        indexBlobId: string;
        graphBlobId: string;
      }): Thunk => {
        return memoryContract.createMemoryIndex({
          package: this.config.packageId,
          arguments: {
            indexBlobId: Array.from(new TextEncoder().encode(options.indexBlobId)),
            graphBlobId: Array.from(new TextEncoder().encode(options.graphBlobId))
          }
        });
      },

      /**
       * Move call for memory index updates
       */
      updateMemoryIndex: (options: {
        memoryIndex: string;
        expectedVersion: number | bigint;
        newIndexBlobId: string;
        newGraphBlobId: string;
      }): Thunk => {
        return memoryContract.updateMemoryIndex({
          package: this.config.packageId,
          arguments: {
            memoryIndex: options.memoryIndex,
            expectedVersion: options.expectedVersion,
            newIndexBlobId: Array.from(new TextEncoder().encode(options.newIndexBlobId)),
            newGraphBlobId: Array.from(new TextEncoder().encode(options.newGraphBlobId))
          }
        });
      },

      /**
       * Move call for adding custom metadata
       */
      addCustomMetadata: (options: {
        memory: string;
        key: string;
        value: string;
      }): Thunk => {
        return memoryContract.addCustomMetadata({
          package: this.config.packageId,
          arguments: {
            memory: options.memory,
            key: Array.from(new TextEncoder().encode(options.key)),
            value: Array.from(new TextEncoder().encode(options.value))
          }
        });
      },
    };
  }

  // ==================== VIEW METHODS ====================

  get view() {
    return {
      /**
       * Get all memories for a user (from backend API)
       */
      getUserMemories: async (userAddress: string) => {
        const response = await this.apiClient.getUserMemories(userAddress);
        
        if (!response.success) {
          throw new Error(response.message || 'Failed to get user memories');
        }

        return response.data!.memories;
      },

      /**
       * Get memory object from blockchain
       */
      getMemory: async (memoryId: string) => {
        try {
          const memoryObject = await this.client.core.getObject(memoryId);
          return memoryObject;
        } catch (error) {
          throw new Error(`Failed to get memory ${memoryId}: ${error}`);
        }
      },

      /**
       * Get memory index information from blockchain
       */
      getMemoryIndex: async (indexId: string) => {
        try {
          const indexObject = await this.client.core.getObject(indexId);
          return indexObject;
        } catch (error) {
          throw new Error(`Failed to get memory index ${indexId}: ${error}`);
        }
      },

      /**
       * Get memory statistics from backend
       */
      getMemoryStats: async (userAddress: string) => {
        const response = await this.apiClient.getMemoryStats(userAddress);
        
        if (!response.success) {
          throw new Error(response.message || 'Failed to get memory stats');
        }

        return response.data!;
      },

      /**
       * Get batch processing statistics
       */
      getBatchStats: async () => {
        const response = await this.apiClient.getBatchStats();
        
        if (!response.success) {
          throw new Error(response.message || 'Failed to get batch stats');
        }

        return response.data!;
      },

      /**
       * Get memory blob ID from blockchain
       */
      getMemoryBlobId: async (memoryId: string) => {
        // This would use memoryContract.getMemoryBlobId but it's a view function
        // For now, we'll get the full object and extract the blob ID
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.blob_id;
      },

      /**
       * Get memory category from blockchain
       */
      getMemoryCategory: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.category;
      },

      /**
       * Get memory vector ID from blockchain
       */
      getMemoryVectorId: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.vector_id;
      },

      /**
       * Get memory metadata from blockchain
       */
      getMemoryMetadata: async (memoryId: string) => {
        const memoryObject = await this.view.getMemory(memoryId);
        return memoryObject?.data?.content?.fields?.metadata;
      },

      /**
       * Get index blob ID from memory index
       */
      getIndexBlobId: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.index_blob_id;
      },

      /**
       * Get graph blob ID from memory index
       */
      getGraphBlobId: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.graph_blob_id;
      },

      /**
       * Get memory index version
       */
      getIndexVersion: async (indexId: string) => {
        const indexObject = await this.view.getMemoryIndex(indexId);
        return indexObject?.data?.content?.fields?.version;
      },
    };
  }

  // ==================== ENHANCED METHODS ====================

  /**
   * Delete memory with both backend and blockchain cleanup
   */
  async deleteMemoryRecord(memoryId: string, userAddress: string, signer?: any) {
    // Delete from backend first
    const response = await this.apiClient.deleteMemory(memoryId, userAddress);
    
    if (!response.success) {
      throw new Error(response.message || 'Failed to delete memory from backend');
    }

    // If signer is provided, also delete from blockchain
    if (signer) {
      const tx = await this.tx.deleteMemory(memoryId);
      const result = await signer.signAndExecuteTransaction({
        transaction: tx,
        client: this.client,
      });
      return result;
    }

    return response;
  }

  /**
   * Force flush batch processing for a user
   */
  async forceFlushUser(userAddress: string) {
    // This would be a backend operation
    const url = `/memories/force-flush/${encodeURIComponent(userAddress)}`;
    const response = await fetch(`${this.apiClient['baseUrl']}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to flush user data: ${response.statusText}`);
    }
    
    return response.json();
  }

  // ==================== ADVANCED MEMORY FEATURES ====================

  /**
   * Generate embeddings for text content using backend AI service
   */
  async generateEmbeddings(options: {
    text: string;
    type?: 'content' | 'metadata' | 'query';
    userAddress: string;
  }): Promise<{
    embeddings: number[]; // 768-dimensional vector
    dimension: number;
    model: string;
    processingTime: number;
  }> {
    const startTime = Date.now();
    
    // This would call the backend embedding service
    const response = await fetch(`${this.apiClient['baseUrl']}/embeddings/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: options.text,
        type: options.type || 'content',
        userAddress: options.userAddress
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to generate embeddings: ${response.statusText}`);
    }

    const result = await response.json();
    
    return {
      embeddings: result.embeddings,
      dimension: result.dimension || 768,
      model: result.model || 'text-embedding-004',
      processingTime: Date.now() - startTime
    };
  }

  /**
   * Perform HNSW vector similarity search
   */
  async vectorSearch(options: {
    queryVector: number[];
    userAddress: string;
    k?: number;
    efSearch?: number; // HNSW search parameter for quality vs speed
    category?: string;
    minSimilarity?: number;
  }): Promise<{
    results: Array<{
      memoryId: string;
      vectorId: number;
      similarity: number;
      distance: number;
      metadata?: any;
    }>;
    searchStats: {
      searchTime: number;
      nodesVisited: number;
      exactMatches: number;
      approximateMatches: number;
    };
  }> {
    const startTime = Date.now();
    
    // This would call the backend HNSW search service
    const response = await fetch(`${this.apiClient['baseUrl']}/memories/vector-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryVector: options.queryVector,
        userAddress: options.userAddress,
        k: options.k || 10,
        efSearch: options.efSearch || 50,
        category: options.category,
        minSimilarity: options.minSimilarity || 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`Vector search failed: ${response.statusText}`);
    }

    const result = await response.json();
    
    return {
      results: result.results || [],
      searchStats: {
        searchTime: Date.now() - startTime,
        nodesVisited: result.stats?.nodesVisited || 0,
        exactMatches: result.stats?.exactMatches || 0,
        approximateMatches: result.stats?.approximateMatches || 0
      }
    };
  }

  /**
   * Create memory with enhanced metadata embeddings
   */
  async createMemoryWithEmbeddings(options: {
    content: string;
    category: string;
    topic?: string;
    importance?: number; // 1-10 scale
    userAddress: string;
    signer?: any;
    customMetadata?: Record<string, string>;
    generateEmbeddings?: boolean;
  }): Promise<{
    memoryId: string;
    embeddings?: {
      content: number[];
      metadata: number[];
    };
    processingStats: {
      totalTime: number;
      embeddingTime: number;
      storageTime: number;
      blockchainTime: number;
    };
  }> {
    const startTime = Date.now();
    const stats = {
      totalTime: 0,
      embeddingTime: 0,
      storageTime: 0,
      blockchainTime: 0
    };

    let embeddings;
    
    // Generate embeddings if requested
    if (options.generateEmbeddings !== false) {
      const embeddingStartTime = Date.now();
      
      // Content embeddings
      const contentEmbeddings = await this.generateEmbeddings({
        text: options.content,
        type: 'content',
        userAddress: options.userAddress
      });

      // Metadata embeddings (from topic + category + importance)
      const metadataText = `${options.category} ${options.topic || ''} importance:${options.importance || 5}`.trim();
      const metadataEmbeddings = await this.generateEmbeddings({
        text: metadataText,
        type: 'metadata', 
        userAddress: options.userAddress
      });

      embeddings = {
        content: contentEmbeddings.embeddings,
        metadata: metadataEmbeddings.embeddings
      };

      stats.embeddingTime = Date.now() - embeddingStartTime;
    }

    // Create memory via backend API
    const storageStartTime = Date.now();
    const memoryId = await this.createMemory({
      content: options.content,
      category: options.category,
      userAddress: options.userAddress,
      topic: options.topic,
      importance: options.importance,
      customMetadata: options.customMetadata,
      signer: options.signer
    });
    stats.storageTime = Date.now() - storageStartTime;

    // If signer provided, also create blockchain record
    if (options.signer && embeddings) {
      const blockchainStartTime = Date.now();
      
      // This would create the blockchain record with embeddings
      // For now, we'll simulate this
      stats.blockchainTime = Date.now() - blockchainStartTime;
    }

    stats.totalTime = Date.now() - startTime;

    return {
      memoryId,
      embeddings,
      processingStats: stats
    };
  }

  /**
   * Smart memory retrieval with context awareness
   */
  async getMemoryWithContext(options: {
    memoryId: string;
    userAddress: string;
    includeRelated?: boolean;
    relatedCount?: number;
    contextRadius?: number; // Similarity threshold for related memories
  }): Promise<{
    memory: MemorySearchResult;
    relatedMemories?: MemorySearchResult[];
    contextGraph?: {
      nodes: Array<{ id: string; label: string; category: string }>;
      edges: Array<{ from: string; to: string; similarity: number }>;
    };
  }> {
    // Get the primary memory
    const memory = await this.view.getMemory(options.memoryId);
    
    if (!memory) {
      throw new Error(`Memory ${options.memoryId} not found`);
    }

    let relatedMemories;
    let contextGraph;

    if (options.includeRelated) {
      // Find related memories using similarity search
      const searchResults = await this.searchMemoriesAdvanced({
        query: memory.content || '',
        userAddress: options.userAddress,
        k: options.relatedCount || 5,
        threshold: options.contextRadius || 0.7
      });

      relatedMemories = searchResults.results.filter(r => r.id !== options.memoryId);

      // Build context graph
      if (relatedMemories.length > 0) {
        const nodes = [
          { 
            id: options.memoryId, 
            label: memory.content?.substring(0, 50) + '...' || 'Memory',
            category: memory.category || 'unknown'
          },
          ...relatedMemories.map(m => ({
            id: m.id,
            label: m.content?.substring(0, 50) + '...' || 'Related Memory',
            category: m.category
          }))
        ];

        const edges = relatedMemories.map(m => ({
          from: options.memoryId,
          to: m.id,
          similarity: m.similarity_score || 0
        }));

        contextGraph = { nodes, edges };
      }
    }

    return {
      memory: memory as MemorySearchResult,
      relatedMemories,
      contextGraph
    };
  }

  /**
   * Batch process multiple memories with embeddings
   */
  async batchProcessMemories(options: {
    memories: Array<{
      content: string;
      category: string;
      topic?: string;
      importance?: number;
    }>;
    userAddress: string;
    batchSize?: number;
    generateEmbeddings?: boolean;
  }): Promise<{
    results: Array<{
      success: boolean;
      memoryId?: string;
      error?: string;
    }>;
    batchStats: {
      totalProcessed: number;
      successful: number;
      failed: number;
      totalTime: number;
      averageTimePerMemory: number;
    };
  }> {
    const startTime = Date.now();
    const batchSize = options.batchSize || 10;
    const results: Array<{ success: boolean; memoryId?: string; error?: string }> = [];

    // Process in batches
    for (let i = 0; i < options.memories.length; i += batchSize) {
      const batch = options.memories.slice(i, i + batchSize);
      
      // Process batch in parallel
      const batchPromises = batch.map(async (memory) => {
        try {
          const result = await this.createMemoryWithEmbeddings({
            ...memory,
            userAddress: options.userAddress,
            generateEmbeddings: options.generateEmbeddings
          });
          
          return { success: true, memoryId: result.memoryId };
        } catch (error) {
          return { 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const totalTime = Date.now() - startTime;
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;

    return {
      results,
      batchStats: {
        totalProcessed: results.length,
        successful,
        failed,
        totalTime,
        averageTimePerMemory: totalTime / results.length
      }
    };
  }
}