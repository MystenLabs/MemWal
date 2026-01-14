/**
 * KnowledgeGraphManager - Knowledge Graph Operations
 *
 * Handles entity extraction, relationship mapping, and graph querying.
 * Extracted from StorageService for better separation of concerns.
 *
 * Features:
 * - AI-powered entity/relationship extraction
 * - In-memory graph storage with Walrus persistence
 * - Graph traversal and querying
 * - Batch extraction from multiple memories
 */

import type { GraphService, KnowledgeGraph, Entity, Relationship, GraphExtractionResult } from '../../graph/GraphService';
import type { EmbeddingService } from '../EmbeddingService';

export interface GraphCache {
  graph: KnowledgeGraph;
  lastSaved: Date;
  isDirty: boolean;
}

export interface GraphQueryOptions {
  keywords?: string[];
  entityTypes?: string[];
  relationshipTypes?: string[];
  searchText?: string;
  maxHops?: number;
  limit?: number;
}

export interface GraphInitConfig {
  confidenceThreshold?: number;
  maxHops?: number;
  deduplicationThreshold?: number;
  geminiApiKey?: string;
}

/**
 * KnowledgeGraphManager - Manages knowledge graph operations
 *
 * Coordinates:
 * - GraphService for entity/relationship extraction
 * - In-memory graph storage and caching
 * - Walrus persistence for cross-device sync
 */
export class KnowledgeGraphManager {
  private graphService?: GraphService;
  private knowledgeGraphs = new Map<string, KnowledgeGraph>();
  private graphCache = new Map<string, GraphCache>();

  constructor() {
    // GraphService will be initialized via initializeKnowledgeGraph()
  }

  /**
   * Initialize knowledge graph capabilities
   */
  async initializeKnowledgeGraph(
    embeddingService?: EmbeddingService,
    graphConfig?: GraphInitConfig
  ) {
    try {
      if (!this.graphService) {
        const { GraphService } = await import('../../graph/GraphService');

        this.graphService = new GraphService({
          enableEmbeddings: !!embeddingService,
          confidenceThreshold: graphConfig?.confidenceThreshold || 0.7,
          maxHops: graphConfig?.maxHops || 3,
          deduplicationThreshold: graphConfig?.deduplicationThreshold || 0.85,
          geminiApiKey: graphConfig?.geminiApiKey,
          ...graphConfig
        }, embeddingService);

        console.log('✅ KnowledgeGraphManager: Graph capabilities initialized');
        console.log('   📊 Storage: In-memory with Walrus persistence');
        console.log('   🔗 AI extraction: Entity/relationship detection');
      }

      return this.graphService;
    } catch (error) {
      console.error('❌ Failed to initialize Knowledge Graph:', error);
      throw error;
    }
  }

  /**
   * Extract entities and relationships from text content
   */
  async extractKnowledgeGraph(
    content: string,
    memoryId: string,
    options: {
      confidenceThreshold?: number;
      includeEmbeddings?: boolean;
    } = {}
  ): Promise<GraphExtractionResult> {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    try {
      console.log(`🔍 Extracting knowledge graph from memory ${memoryId}`);

      const result = await this.graphService.extractEntitiesAndRelationships(
        content,
        memoryId,
        options
      );

      console.log(`✅ Extracted ${result.entities.length} entities and ${result.relationships.length} relationships`);
      console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`   Processing time: ${result.processingTimeMs}ms`);

      return result;
    } catch (error) {
      console.error('❌ Knowledge graph extraction failed:', error);
      throw error;
    }
  }

  /**
   * Get or load user's knowledge graph
   */
  async getUserKnowledgeGraph(userAddress: string): Promise<KnowledgeGraph> {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    // Check in-memory cache first
    let graph = this.knowledgeGraphs.get(userAddress);

    if (!graph) {
      // Create new graph if none found
      graph = this.graphService.createGraph(userAddress);
      this.knowledgeGraphs.set(userAddress, graph);
      this.graphCache.set(userAddress, {
        graph,
        lastSaved: new Date(),
        isDirty: false
      });
    }

    return graph;
  }

  /**
   * Add extraction results to user's knowledge graph
   */
  addToUserGraph(
    userAddress: string,
    entities: Entity[],
    relationships: Relationship[],
    sourceMemoryId: string
  ): KnowledgeGraph {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    const userGraph = this.knowledgeGraphs.get(userAddress);
    if (!userGraph) {
      throw new Error(`No graph found for user ${userAddress}`);
    }

    const updatedGraph = this.graphService.addToGraph(
      userGraph,
      entities,
      relationships,
      sourceMemoryId
    );

    this.knowledgeGraphs.set(userAddress, updatedGraph);
    this.graphCache.set(userAddress, {
      graph: updatedGraph,
      lastSaved: new Date(),
      isDirty: true
    });

    return updatedGraph;
  }

  /**
   * Search knowledge graph with semantic queries
   */
  async searchKnowledgeGraph(
    userAddress: string,
    query: GraphQueryOptions
  ) {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    try {
      console.log(`🔍 Searching knowledge graph for user ${userAddress}`);

      const userGraph = await this.getUserKnowledgeGraph(userAddress);

      const results = this.graphService.queryGraph(userGraph, {
        entityTypes: query.entityTypes,
        relationshipTypes: query.relationshipTypes,
        searchText: query.searchText || query.keywords?.join(' '),
        limit: query.limit || 50
      });

      console.log(`✅ Found ${results.entities.length} entities and ${results.relationships.length} relationships`);

      return results;
    } catch (error) {
      console.error('❌ Knowledge graph search failed:', error);
      throw error;
    }
  }

  /**
   * Find related entities using graph traversal
   */
  async findRelatedEntities(
    userAddress: string,
    seedEntityIds: string[],
    options: {
      maxHops?: number;
      relationshipTypes?: string[];
      includeWeights?: boolean;
    } = {}
  ) {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    try {
      console.log(`🔗 Finding related entities for user ${userAddress}`);
      console.log(`   Seed entities: ${seedEntityIds.join(', ')}`);

      const userGraph = await this.getUserKnowledgeGraph(userAddress);
      const results = this.graphService.findRelatedEntities(userGraph, seedEntityIds, options);

      console.log(`✅ Found ${results.entities.length} related entities`);

      return results;
    } catch (error) {
      console.error('❌ Failed to find related entities:', error);
      throw error;
    }
  }

  /**
   * Batch extract knowledge graphs from multiple memories
   */
  async extractKnowledgeGraphBatch(
    memories: Array<{ id: string; content: string }>,
    userAddress: string,
    options: {
      batchSize?: number;
      delayMs?: number;
      confidenceThreshold?: number;
    } = {}
  ): Promise<GraphExtractionResult[]> {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    try {
      console.log(`📊 Batch extracting knowledge graphs from ${memories.length} memories`);

      const results = await this.graphService.extractFromMemoriesBatch(memories, {
        batchSize: options.batchSize || 5,
        delayMs: options.delayMs || 1000
      });

      // Aggregate all results into user's knowledge graph
      let userGraph = await this.getUserKnowledgeGraph(userAddress);
      let totalEntities = 0;
      let totalRelationships = 0;

      for (const result of results) {
        if (result.confidence > (options.confidenceThreshold || 0.5)) {
          userGraph = this.graphService.addToGraph(
            userGraph,
            result.entities,
            result.relationships,
            result.extractedFromMemory
          );
          totalEntities += result.entities.length;
          totalRelationships += result.relationships.length;
        }
      }

      // Update cached graph
      this.knowledgeGraphs.set(userAddress, userGraph);
      this.graphCache.set(userAddress, {
        graph: userGraph,
        lastSaved: new Date(),
        isDirty: true
      });

      console.log(`✅ Batch extraction complete: ${totalEntities} entities, ${totalRelationships} relationships added`);

      return results;
    } catch (error) {
      console.error('❌ Batch knowledge graph extraction failed:', error);
      throw error;
    }
  }

  /**
   * Get graph statistics
   */
  getGraphStatistics(userAddress: string) {
    if (!this.graphService) {
      throw new Error('Knowledge Graph not initialized. Call initializeKnowledgeGraph() first.');
    }

    const graph = this.knowledgeGraphs.get(userAddress);
    if (!graph) {
      return {
        totalEntities: 0,
        totalRelationships: 0,
        entityTypes: {},
        relationshipTypes: {},
        averageConnections: 0,
        graphDensity: 0,
        extractionStats: null,
        lastUpdated: null
      };
    }

    return this.graphService.getGraphStats(graph);
  }

  /**
   * Get analytics about the knowledge graph
   */
  getKnowledgeGraphAnalytics(userAddress: string) {
    const graph = this.knowledgeGraphs.get(userAddress);

    if (!graph) {
      return {
        totalEntities: 0,
        totalRelationships: 0,
        entityTypes: {},
        relationshipTypes: {},
        connectedComponents: 0,
        averageConnections: 0,
        lastUpdated: null
      };
    }

    // Analyze entity types
    const entityTypes: Record<string, number> = {};
    graph.entities.forEach((entity: any) => {
      entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
    });

    // Analyze relationship types
    const relationshipTypes: Record<string, number> = {};
    graph.relationships.forEach((rel: any) => {
      relationshipTypes[rel.type || rel.label] = (relationshipTypes[rel.type || rel.label] || 0) + 1;
    });

    // Calculate average connections
    const connectionCounts = new Map();
    graph.relationships.forEach((rel: any) => {
      connectionCounts.set(rel.source, (connectionCounts.get(rel.source) || 0) + 1);
      connectionCounts.set(rel.target, (connectionCounts.get(rel.target) || 0) + 1);
    });

    const averageConnections = connectionCounts.size > 0
      ? Array.from(connectionCounts.values()).reduce((sum, count) => sum + count, 0) / connectionCounts.size
      : 0;

    return {
      totalEntities: graph.entities.length,
      totalRelationships: graph.relationships.length,
      entityTypes,
      relationshipTypes,
      connectedComponents: connectionCounts.size,
      averageConnections: Math.round(averageConnections * 100) / 100,
      lastUpdated: graph.metadata.lastUpdated
    };
  }

  /**
   * Check if graph needs to be saved
   */
  isGraphDirty(userAddress: string): boolean {
    return this.graphCache.get(userAddress)?.isDirty || false;
  }

  /**
   * Mark graph as saved
   */
  markGraphAsSaved(userAddress: string) {
    const cacheEntry = this.graphCache.get(userAddress);
    if (cacheEntry) {
      cacheEntry.lastSaved = new Date();
      cacheEntry.isDirty = false;
    }
  }

  /**
   * Get all user addresses with cached graphs
   */
  getCachedUsers(): string[] {
    return Array.from(this.knowledgeGraphs.keys());
  }

  /**
   * Clear graph cache for a user
   */
  clearUserGraph(userAddress: string) {
    this.knowledgeGraphs.delete(userAddress);
    this.graphCache.delete(userAddress);
  }

  /**
   * Serialize graph for storage
   */
  serializeGraph(userAddress: string): string | null {
    const graph = this.knowledgeGraphs.get(userAddress);
    if (!graph) return null;

    return JSON.stringify(graph, null, 2);
  }
}
