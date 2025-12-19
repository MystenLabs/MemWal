/**
 * KnowledgeGraphManager - Integration layer for memory-graph processing
 * 
 * Orchestrates knowledge graph updates as memories are processed,
 * provides intelligent graph queries, and manages graph persistence.
 */

import { GraphService, KnowledgeGraph, Entity, Relationship, GraphExtractionResult } from './GraphService';
import { Memory, ProcessedMemory } from '../embedding/types';

export interface GraphMemoryMapping {
  memoryId: string;
  entityIds: string[];
  relationshipIds: string[];
  extractionDate: Date;
  confidence: number;
}

export interface GraphUpdateResult {
  success: boolean;
  entitiesAdded: number;
  relationshipsAdded: number;
  entitiesUpdated: number;
  relationshipsUpdated: number;
  processingTimeMs: number;
  extractionResult?: GraphExtractionResult;
  error?: string;
}

export interface GraphSearchQuery {
  keywords?: string[];
  entityTypes?: string[];
  relationshipTypes?: string[];
  memoryIds?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  similarToMemory?: string;
  maxResults?: number;
}

export interface GraphSearchResult {
  entities: Entity[];
  relationships: Relationship[];
  relatedMemories: string[];
  searchPaths?: Array<{
    score: number;
    entities: string[];
    relationships: string[];
  }>;
  totalResults: number;
  queryTimeMs: number;
}

export interface KnowledgeGraphStats {
  totalGraphs: number;
  totalEntities: number;
  totalRelationships: number;
  averageConnections: number;
  topEntityTypes: Array<{ type: string; count: number }>;
  topRelationshipTypes: Array<{ type: string; count: number }>;
  memoryMappings: number;
  lastUpdate: Date;
}

/**
 * High-level knowledge graph manager integrating with memory processing
 */
export class KnowledgeGraphManager {
  private graphService: GraphService;
  private memoryMappings = new Map<string, GraphMemoryMapping[]>(); // userId -> mappings
  private graphCache = new Map<string, { graph: KnowledgeGraph; lastUpdated: Date }>();
  
  private stats = {
    totalUpdates: 0,
    successfulUpdates: 0,
    failedUpdates: 0,
    averageProcessingTime: 0,
    totalEntitiesCreated: 0,
    totalRelationshipsCreated: 0
  };

  constructor(graphService?: GraphService) {
    this.graphService = graphService || new GraphService();
  }

  // ==================== MEMORY INTEGRATION ====================

  /**
   * Process memory and update knowledge graph
   */
  async processMemoryForGraph(
    memory: ProcessedMemory,
    userIdParam?: string,
    options: {
      forceReprocess?: boolean;
      skipCache?: boolean;
      confidenceThreshold?: number;
    } = {}
  ): Promise<GraphUpdateResult> {
    const startTime = Date.now();
    this.stats.totalUpdates++;

    try {
      // Extract userId from memory or use provided parameter
      const userId = userIdParam || memory.userId;
      if (!userId) {
        return {
          success: false,
          entitiesAdded: 0,
          relationshipsAdded: 0,
          entitiesUpdated: 0,
          relationshipsUpdated: 0,
          processingTimeMs: Date.now() - startTime,
          error: 'No userId provided'
        };
      }

      // Check if already processed
      if (!options.forceReprocess && this.isMemoryProcessed(userId, memory.id)) {
        return {
          success: true,
          entitiesAdded: 0,
          relationshipsAdded: 0,
          entitiesUpdated: 0,
          relationshipsUpdated: 0,
          processingTimeMs: Date.now() - startTime
        };
      }

      // Extract entities and relationships from memory content
      const extractionResult = await this.graphService.extractEntitiesAndRelationships(
        memory.content,
        memory.id,
        { confidenceThreshold: options.confidenceThreshold }
      );

      // Check if extraction returned valid result
      if (!extractionResult) {
        return {
          success: false,
          entitiesAdded: 0,
          relationshipsAdded: 0,
          entitiesUpdated: 0,
          relationshipsUpdated: 0,
          processingTimeMs: Date.now() - startTime,
          error: 'Extraction returned no result'
        };
      }

      // Skip if extraction failed or confidence too low
      const minConfidence = options.confidenceThreshold || 0.3;
      if ((extractionResult.confidence || 0) < minConfidence) {
        console.log(`Skipping memory ${memory.id} due to low confidence: ${extractionResult.confidence}`);
        return {
          success: false,
          entitiesAdded: 0,
          relationshipsAdded: 0,
          entitiesUpdated: 0,
          relationshipsUpdated: 0,
          processingTimeMs: Date.now() - startTime,
          error: 'Extraction confidence below threshold'
        };
      }

      // Get or create user's knowledge graph
      let graph = await this.getUserGraph(userId);
      if (!graph) {
        graph = this.graphService.createGraph(userId);
      }

      // Count entities/relationships before update
      const entitiesBefore = graph.entities.length;
      const relationshipsBefore = graph.relationships.length;

      // Add extracted data to graph
      const updatedGraph = this.graphService.addToGraph(
        graph,
        extractionResult.entities,
        extractionResult.relationships,
        memory.id
      );

      // Calculate changes
      const entitiesAdded = updatedGraph.entities.length - entitiesBefore;
      const relationshipsAdded = updatedGraph.relationships.length - relationshipsBefore;
      const entitiesUpdated = entitiesAdded > 0 ? 0 : extractionResult.entities.length; // Estimate
      const relationshipsUpdated = relationshipsAdded > 0 ? 0 : extractionResult.relationships.length; // Estimate

      // Update cached graph
      this.updateUserGraph(userId, updatedGraph);

      // Track memory mapping
      this.addMemoryMapping(userId, {
        memoryId: memory.id,
        entityIds: extractionResult.entities.map(e => e.id),
        relationshipIds: extractionResult.relationships.map(r => 
          r.id || this.generateRelationshipId(r)
        ),
        extractionDate: new Date(),
        confidence: extractionResult.confidence
      });

      // Update statistics
      this.stats.successfulUpdates++;
      this.stats.totalEntitiesCreated += entitiesAdded;
      this.stats.totalRelationshipsCreated += relationshipsAdded;
      this.updateAverageProcessingTime(Date.now() - startTime);

      return {
        success: true,
        entitiesAdded,
        relationshipsAdded,
        entitiesUpdated,
        relationshipsUpdated,
        processingTimeMs: Date.now() - startTime,
        extractionResult
      };

    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error processing memory for graph:', error);
      }
      this.stats.failedUpdates++;
      
      return {
        success: false,
        entitiesAdded: 0,
        relationshipsAdded: 0,
        entitiesUpdated: 0,
        relationshipsUpdated: 0,
        processingTimeMs: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Process multiple memories for graph updates (alias for compatibility)
   */
  async processBatchMemoriesForGraph(
    userId: string,
    memories: Memory[],
    options: {
      batchSize?: number;
      delayMs?: number;
      onProgress?: (completed: number, total: number) => void;
    } = {}
  ): Promise<GraphUpdateResult[]> {
    // Convert Memory to ProcessedMemory
    const processedMemories = memories.map(m => ({
      ...m,
      userId: m.userId || userId,
      category: m.category || 'general',
      createdAt: m.createdAt || (m.metadata?.createdAt as Date) || new Date()
    })) as ProcessedMemory[];
    
    return this.processMemoriesForGraphBatch(processedMemories, userId, options);
  }

  /**
   * Process multiple memories for graph updates
   */
  async processMemoriesForGraphBatch(
    memories: ProcessedMemory[],
    userId: string,
    options: {
      batchSize?: number;
      delayMs?: number;
      onProgress?: (completed: number, total: number) => void;
    } = {}
  ): Promise<GraphUpdateResult[]> {
    const batchSize = options.batchSize || 5;
    const delayMs = options.delayMs || 1000;
    const results: GraphUpdateResult[] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      
      const batchPromises = batch.map(memory =>
        this.processMemoryForGraph(memory, userId)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Progress callback
      if (options.onProgress) {
        options.onProgress(i + batch.length, memories.length);
      }

      // Delay between batches
      if (i + batchSize < memories.length) {
        await this.delay(delayMs);
      }
    }

    return results;
  }

  // ==================== GRAPH QUERIES ====================

  /**
   * Search knowledge graph with complex queries
   */
  async searchGraph(
    userId: string,
    query: GraphSearchQuery
  ): Promise<GraphSearchResult> {
    const startTime = Date.now();

    try {
      const graph = await this.getUserGraph(userId);
      if (!graph) {
        return {
          entities: [],
          relationships: [],
          relatedMemories: [],
          totalResults: 0,
          queryTimeMs: Date.now() - startTime
        };
      }

      let entities = graph.entities;
      let relationships = graph.relationships;

      // Filter by entity types
      if (query.entityTypes && query.entityTypes.length > 0) {
        entities = entities.filter(e => query.entityTypes!.includes(e.type));
      }

      // Filter by relationship types
      if (query.relationshipTypes && query.relationshipTypes.length > 0) {
        relationships = relationships.filter(r => 
          query.relationshipTypes!.includes(r.type || r.label)
        );
      }

      // Keyword search
      if (query.keywords && query.keywords.length > 0) {
        const keywords = query.keywords.map(k => k.toLowerCase());
        
        entities = entities.filter(e =>
          keywords.some(keyword =>
            e.label.toLowerCase().includes(keyword) ||
            JSON.stringify(e.properties || {}).toLowerCase().includes(keyword)
          )
        );
        
        relationships = relationships.filter(r =>
          keywords.some(keyword =>
            r.label.toLowerCase().includes(keyword) ||
            JSON.stringify(r.properties || {}).toLowerCase().includes(keyword)
          )
        );
      }

      // Filter by memory IDs
      if (query.memoryIds && query.memoryIds.length > 0) {
        entities = entities.filter(e =>
          e.sourceMemoryIds && 
          e.sourceMemoryIds.some(memId => query.memoryIds!.includes(memId))
        );
        
        relationships = relationships.filter(r =>
          r.sourceMemoryIds && 
          r.sourceMemoryIds.some(memId => query.memoryIds!.includes(memId))
        );
      }

      // Date range filter
      if (query.dateRange) {
        const { start, end } = query.dateRange;
        
        entities = entities.filter(e => 
          e.createdAt && e.createdAt >= start && e.createdAt <= end
        );
        
        relationships = relationships.filter(r =>
          r.createdAt && r.createdAt >= start && r.createdAt <= end
        );
      }

      // Apply result limit
      if (query.maxResults) {
        entities = entities.slice(0, Math.floor(query.maxResults / 2));
        relationships = relationships.slice(0, Math.floor(query.maxResults / 2));
      }

      // Collect related memories
      const relatedMemories = new Set<string>();
      entities.forEach(e => e.sourceMemoryIds?.forEach(id => relatedMemories.add(id)));
      relationships.forEach(r => r.sourceMemoryIds?.forEach(id => relatedMemories.add(id)));

      // Find search paths if similarity query
      let searchPaths: Array<{ score: number; entities: string[]; relationships: string[] }> = [];
      if (query.similarToMemory) {
        // Find entities from the reference memory
        const referenceEntities = entities.filter(e => 
          e.sourceMemoryIds?.includes(query.similarToMemory!)
        );
        
        if (referenceEntities.length > 0) {
          const relatedResult = this.graphService.findRelatedEntities(
            graph,
            referenceEntities.map(e => e.id),
            { maxHops: 2, includeWeights: true }
          );
          
          searchPaths = relatedResult.paths || [];
        }
      }

      return {
        entities,
        relationships,
        relatedMemories: Array.from(relatedMemories),
        searchPaths,
        totalResults: entities.length + relationships.length,
        queryTimeMs: Date.now() - startTime
      };

    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error searching graph:', error);
      }
      
      return {
        entities: [],
        relationships: [],
        relatedMemories: [],
        totalResults: 0,
        queryTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Find memories connected to a specific entity or concept
   */
  async findMemoriesRelatedToEntity(
    userId: string,
    entityId: string,
    options: {
      maxHops?: number;
      includeRelationships?: boolean;
    } = {}
  ): Promise<{
    memories: string[];
    connectedEntities: Entity[];
    pathways: Array<{ memory: string; entities: string[]; score: number }>;
  }> {
    try {
      const graph = await this.getUserGraph(userId);
      if (!graph) {
        return { memories: [], connectedEntities: [], pathways: [] };
      }

      // Find related entities through graph traversal
      const relatedResult = this.graphService.findRelatedEntities(
        graph,
        [entityId],
        { 
          maxHops: options.maxHops || 2,
          includeWeights: true
        }
      );

      // Collect memories from all related entities
      const memories = new Set<string>();
      const pathways: Array<{ memory: string; entities: string[]; score: number }> = [];

      for (const entity of relatedResult.entities) {
        if (entity.sourceMemoryIds) {
          for (const memoryId of entity.sourceMemoryIds) {
            memories.add(memoryId);
            
            // Track pathway
            pathways.push({
              memory: memoryId,
              entities: [entityId, entity.id],
              score: entity.confidence || 0.5
            });
          }
        }
      }

      return {
        memories: Array.from(memories),
        connectedEntities: relatedResult.entities,
        pathways
      };

    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error finding related memories:', error);
      }
      return { memories: [], connectedEntities: [], pathways: [] };
    }
  }

  // ==================== GRAPH MANAGEMENT ====================

  /**
   * Get user's knowledge graph
   */
  async getUserGraph(userId: string): Promise<KnowledgeGraph | null> {
    try {
      // Check cache first
      const cached = this.graphCache.get(userId);
      if (cached) {
        return cached.graph;
      }

      // Try to get from service cache
      const graph = this.graphService.getUserGraph(userId);
      if (graph) {
        this.graphCache.set(userId, { graph, lastUpdated: new Date() });
        return graph;
      }

      return null;
      
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error getting user graph:', error);
      }
      return null;
    }
  }

  /**
   * Update user's knowledge graph
   */
  updateUserGraph(userId: string, graph: KnowledgeGraph): void {
    this.graphService.setUserGraph(userId, graph);
    this.graphCache.set(userId, { graph, lastUpdated: new Date() });
  }

  /**
   * Clear user's knowledge graph
   */
  clearUserGraph(userId: string): void {
    this.graphCache.delete(userId);
    this.memoryMappings.delete(userId);
    // Note: GraphService doesn't have a clear method, but we clear our caches
  }

  /**
   * Record a memory mapping (public method for tests)
   */
  recordMemoryMapping(mapping: GraphMemoryMapping): void {
    // Extract userId from first part of memoryId or use a default
    // Assuming memoryId format doesn't include userId, store all in a global list
    const globalKey = '__all__';
    const mappings = this.memoryMappings.get(globalKey) || [];
    mappings.push(mapping);
    this.memoryMappings.set(globalKey, mappings);
  }

  /**
   * Get memory mappings by memory ID (public method for tests)
   */
  getMemoryMappings(memoryId: string): GraphMemoryMapping[] {
    // Search all mappings for this memory ID
    const allMappings: GraphMemoryMapping[] = [];
    
    for (const mappings of this.memoryMappings.values()) {
      allMappings.push(...mappings.filter(m => m.memoryId === memoryId));
    }
    
    return allMappings;
  }

  /**
   * Get statistics for a specific user's graph
   */
  getGraphStatistics(userId: string): {
    totalEntities: number;
    totalRelationships: number;
    sourceMemoriesCount: number;
    entityTypeDistribution: Record<string, number>;
    relationshipTypeDistribution: Record<string, number>;
    averageEntityConfidence: number;
    averageRelationshipConfidence: number;
  } {
    const graph = this.graphService.getUserGraph(userId);
    
    if (!graph) {
      return {
        totalEntities: 0,
        totalRelationships: 0,
        sourceMemoriesCount: 0,
        entityTypeDistribution: {},
        relationshipTypeDistribution: {},
        averageEntityConfidence: 0,
        averageRelationshipConfidence: 0
      };
    }

    // Entity type distribution
    const entityTypeDistribution: Record<string, number> = {};
    graph.entities.forEach(entity => {
      entityTypeDistribution[entity.type] = (entityTypeDistribution[entity.type] || 0) + 1;
    });

    // Relationship type distribution
    const relationshipTypeDistribution: Record<string, number> = {};
    graph.relationships.forEach(rel => {
      const type = rel.type || rel.label;
      relationshipTypeDistribution[type] = (relationshipTypeDistribution[type] || 0) + 1;
    });

    // Average confidences
    const avgEntityConfidence = graph.entities.length > 0
      ? graph.entities.reduce((sum, e) => sum + (e.confidence || 0), 0) / graph.entities.length
      : 0;

    const avgRelationshipConfidence = graph.relationships.length > 0
      ? graph.relationships.reduce((sum, r) => sum + (r.confidence || 0), 0) / graph.relationships.length
      : 0;

    return {
      totalEntities: graph.entities.length,
      totalRelationships: graph.relationships.length,
      sourceMemoriesCount: graph.metadata.sourceMemories?.length || 0,
      entityTypeDistribution,
      relationshipTypeDistribution,
      averageEntityConfidence: avgEntityConfidence,
      averageRelationshipConfidence: avgRelationshipConfidence
    };
  }

  /**
   * Get comprehensive statistics
   */
  getKnowledgeGraphStats(): KnowledgeGraphStats {
    const allGraphs = Array.from(this.graphCache.values()).map(cached => cached.graph);
    
    // Aggregate statistics
    const totalEntities = allGraphs.reduce((sum, graph) => sum + graph.entities.length, 0);
    const totalRelationships = allGraphs.reduce((sum, graph) => sum + graph.relationships.length, 0);

    // Entity type distribution
    const entityTypeCounts = new Map<string, number>();
    allGraphs.forEach(graph => {
      graph.entities.forEach(entity => {
        entityTypeCounts.set(entity.type, (entityTypeCounts.get(entity.type) || 0) + 1);
      });
    });

    // Relationship type distribution
    const relationshipTypeCounts = new Map<string, number>();
    allGraphs.forEach(graph => {
      graph.relationships.forEach(rel => {
        const type = rel.type || rel.label;
        relationshipTypeCounts.set(type, (relationshipTypeCounts.get(type) || 0) + 1);
      });
    });

    // Get top types
    const topEntityTypes = Array.from(entityTypeCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([type, count]) => ({ type, count }));

    const topRelationshipTypes = Array.from(relationshipTypeCounts.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([type, count]) => ({ type, count }));

    // Calculate average connections
    const totalConnections = allGraphs.reduce((sum, graph) => {
      const connections = new Map<string, number>();
      graph.relationships.forEach(rel => {
        connections.set(rel.source, (connections.get(rel.source) || 0) + 1);
        connections.set(rel.target, (connections.get(rel.target) || 0) + 1);
      });
      return sum + Array.from(connections.values()).reduce((s, c) => s + c, 0);
    }, 0);

    const averageConnections = totalEntities > 0 ? totalConnections / totalEntities : 0;

    // Count memory mappings
    const totalMappings = Array.from(this.memoryMappings.values())
      .reduce((sum, mappings) => sum + mappings.length, 0);

    return {
      totalGraphs: allGraphs.length,
      totalEntities,
      totalRelationships,
      averageConnections,
      topEntityTypes,
      topRelationshipTypes,
      memoryMappings: totalMappings,
      lastUpdate: new Date() // TODO: Track actual last update
    };
  }

  // ==================== PRIVATE METHODS ====================

  private isMemoryProcessed(userId: string, memoryId: string): boolean {
    const mappings = this.memoryMappings.get(userId) || [];
    return mappings.some(mapping => mapping.memoryId === memoryId);
  }

  private addMemoryMapping(userId: string, mapping: GraphMemoryMapping): void {
    const mappings = this.memoryMappings.get(userId) || [];
    mappings.push(mapping);
    this.memoryMappings.set(userId, mappings);
  }

  private generateRelationshipId(relationship: Relationship): string {
    const content = `${relationship.source}_${relationship.target}_${relationship.label}`;
    return content.toLowerCase().replace(/[^\w]/g, '_');
  }

  private updateAverageProcessingTime(processingTime: number): void {
    this.stats.averageProcessingTime = 
      (this.stats.averageProcessingTime + processingTime) / this.stats.totalUpdates;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default KnowledgeGraphManager;