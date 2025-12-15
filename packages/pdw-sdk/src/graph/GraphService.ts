/**
 * GraphService - Knowledge Graph Extraction and Management
 * 
 * Ports sophisticated knowledge graph logic from the backend with AI-powered
 * entity/relationship extraction, graph traversal, and intelligent updates.
 */

import { EmbeddingService } from '../services/EmbeddingService';
import { GeminiAIService, type GeminiConfig } from '../services/GeminiAIService';

export interface Entity {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, any>;
  confidence?: number;
  sourceMemoryIds?: string[];
  createdAt?: Date;
  lastUpdated?: Date;
}

export interface Relationship {
  id?: string;
  source: string;
  target: string;
  label: string;
  type?: string;
  properties?: Record<string, any>;
  confidence?: number;
  sourceMemoryIds?: string[];
  createdAt?: Date;
  lastUpdated?: Date;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relationships: Relationship[];
  metadata: {
    version: string;
    createdAt: Date;
    lastUpdated: Date;
    totalEntities: number;
    totalRelationships: number;
    sourceMemories: string[];
  };
}

export interface GraphExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
  confidence: number;
  processingTimeMs: number;
  extractedFromMemory: string;
}

export interface GraphQueryResult {
  entities: Entity[];
  relationships: Relationship[];
  paths?: Array<{
    entities: string[];
    relationships: string[];
    score: number;
  }>;
  totalResults: number;
}

export interface GraphConfig {
  extractionModel?: string;
  confidenceThreshold?: number;
  maxHops?: number;
  enableEmbeddings?: boolean;
  deduplicationThreshold?: number;
  geminiApiKey?: string;
  geminiConfig?: Partial<GeminiConfig>;
  useMockAI?: boolean; // For testing purposes
}

/**
 * Advanced knowledge graph service with AI extraction and intelligent management
 */
export class GraphService {
  private embeddingService?: EmbeddingService;
  private geminiAI?: GeminiAIService;
  private readonly config: Required<GraphConfig>;
  private graphs = new Map<string, KnowledgeGraph>(); // User graphs cache
  
  private extractionStats = {
    totalExtractions: 0,
    averageEntities: 0,
    averageRelationships: 0,
    averageConfidence: 0,
    processingTime: 0
  };

  constructor(
    config: Partial<GraphConfig> = {},
    embeddingService?: EmbeddingService
  ) {
    this.config = {
      extractionModel: config.extractionModel || process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
      confidenceThreshold: config.confidenceThreshold || 0.7,
      maxHops: config.maxHops || 3,
      enableEmbeddings: config.enableEmbeddings !== false,
      deduplicationThreshold: config.deduplicationThreshold || 0.85,
      geminiApiKey: config.geminiApiKey || process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || '',
      geminiConfig: config.geminiConfig || {},
      useMockAI: config.useMockAI || false
    };

    this.embeddingService = embeddingService;

    // Initialize Gemini AI service if API key is provided and not using mock
    if (this.config.geminiApiKey && !this.config.useMockAI) {
      try {
        this.geminiAI = new GeminiAIService({
          apiKey: this.config.geminiApiKey,
          model: this.config.extractionModel,
          ...this.config.geminiConfig
        });
      } catch (error) {
        console.warn('Failed to initialize Gemini AI service, falling back to mock:', error);
        this.config.useMockAI = true;
      }
    }
  }

  // ==================== GRAPH CREATION & MANAGEMENT ====================

  /**
   * Create empty knowledge graph
   */
  createGraph(userId?: string): KnowledgeGraph {
    const graph: KnowledgeGraph = {
      entities: [],
      relationships: [],
      metadata: {
        version: '1.0',
        createdAt: new Date(),
        lastUpdated: new Date(),
        totalEntities: 0,
        totalRelationships: 0,
        sourceMemories: []
      }
    };

    if (userId) {
      this.graphs.set(userId, graph);
    }

    return graph;
  }

  /**
   * Get cached graph for user
   */
  getUserGraph(userId: string): KnowledgeGraph | undefined {
    return this.graphs.get(userId);
  }

  /**
   * Cache graph for user
   */
  setUserGraph(userId: string, graph: KnowledgeGraph): void {
    this.graphs.set(userId, graph);
  }

  // ==================== ENTITY & RELATIONSHIP EXTRACTION ====================

  /**
   * Extract entities and relationships from memory content using AI
   */
  async extractEntitiesAndRelationships(
    content: string, 
    memoryId: string,
    options: {
      includeEmbeddings?: boolean;
      confidenceThreshold?: number;
    } = {}
  ): Promise<GraphExtractionResult> {
    const startTime = Date.now();

    try {
      // Use real Gemini AI if available, otherwise fall back to mock
      let entities: Entity[] = [];
      let relationships: Relationship[] = [];
      
      if (this.geminiAI && !this.config.useMockAI) {
        // Use real Gemini AI service
        const aiResult = await this.geminiAI.extractEntitiesAndRelationships({
          content,
          confidenceThreshold: options.confidenceThreshold || this.config.confidenceThreshold
        });
        
        // Convert AI service format to GraphService format
        entities = aiResult.entities.map(e => ({
          id: e.id,
          label: e.label,
          type: e.type,
          confidence: e.confidence,
          properties: e.properties,
          sourceMemoryIds: [memoryId],
          createdAt: new Date(),
          lastUpdated: new Date()
        }));
        
        relationships = aiResult.relationships.map(r => ({
          id: this.generateRelationshipId(r),
          source: r.source,
          target: r.target,
          label: r.label,
          type: r.type,
          confidence: r.confidence,
          sourceMemoryIds: [memoryId],
          createdAt: new Date(),
          lastUpdated: new Date()
        }));
        
      } else {
        // Fall back to mock implementation
        console.warn('Using mock AI extraction - configure Gemini API key for real AI processing');
        const response = await this.mockGeminiResponse(content);
        const extracted = this.parseExtractionResponse(response, memoryId);
        entities = extracted.entities;
        relationships = extracted.relationships;
      }

      const processingTime = Date.now() - startTime;

      // Filter by confidence threshold
      const confidenceThreshold = options.confidenceThreshold || this.config.confidenceThreshold;
      entities = entities.filter(e => (e.confidence || 0) >= confidenceThreshold);
      relationships = relationships.filter(r => (r.confidence || 0) >= confidenceThreshold);

      // Calculate overall confidence
      const confidence = this.calculateExtractionConfidence(entities, relationships);

      // Update statistics
      this.updateExtractionStats(entities, relationships, confidence, processingTime);

      return {
        entities,
        relationships,
        confidence,
        processingTimeMs: processingTime,
        extractedFromMemory: memoryId
      };

    } catch (error) {
      console.error('Entity extraction failed:', error);
      
      return {
        entities: [],
        relationships: [],
        confidence: 0,
        processingTimeMs: Date.now() - startTime,
        extractedFromMemory: memoryId
      };
    }
  }

  /**
   * Extract entities from multiple memories in batch
   */
  async extractFromMemoriesBatch(
    memories: Array<{ id: string; content: string }>,
    options: {
      batchSize?: number;
      delayMs?: number;
    } = {}
  ): Promise<GraphExtractionResult[]> {
    const batchSize = options.batchSize || 5;
    const delayMs = options.delayMs || 1000;
    const results: GraphExtractionResult[] = [];

    // Process in batches to avoid rate limiting
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      
      const batchPromises = batch.map(memory =>
        this.extractEntitiesAndRelationships(memory.content, memory.id)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Delay between batches
      if (i + batchSize < memories.length) {
        await this.delay(delayMs);
      }
    }

    return results;
  }

  // ==================== GRAPH OPERATIONS ====================

  /**
   * Add extracted data to knowledge graph with intelligent deduplication
   */
  addToGraph(
    graph: KnowledgeGraph,
    newEntities: Entity[],
    newRelationships: Relationship[],
    sourceMemoryId?: string
  ): KnowledgeGraph {
    try {
      const updatedGraph = { ...graph };
      const now = new Date();

      // Filter out null/undefined entities
      const validNewEntities = newEntities.filter(e => e != null && e.id && e.label);
      const validNewRelationships = newRelationships.filter(r => r != null && r.source && r.target && r.label);

      // Track existing entities for deduplication
      const existingEntities = new Map(graph.entities.map(e => [e.id, e]));
      
      // Process entities with intelligent merging
      const processedEntities = [...graph.entities];
      const addedEntityIds = new Set<string>();

      for (const newEntity of validNewEntities) {
        const existing = existingEntities.get(newEntity.id);
        
        if (existing) {
          // Merge with existing entity
          const merged = this.mergeEntities(existing, newEntity, sourceMemoryId);
          const index = processedEntities.findIndex(e => e.id === existing.id);
          processedEntities[index] = merged;
        } else {
          // Check for similar entities (fuzzy matching)
          const similar = this.findSimilarEntity(newEntity, processedEntities);
          
          if (similar && this.calculateEntitySimilarity(newEntity, similar) > this.config.deduplicationThreshold) {
            // Merge with similar entity
            const merged = this.mergeEntities(similar, newEntity, sourceMemoryId);
            const index = processedEntities.findIndex(e => e.id === similar.id);
            processedEntities[index] = merged;
            addedEntityIds.add(similar.id);
          } else {
            // Add as new entity
            const entityWithMetadata = {
              ...newEntity,
              createdAt: now,
              lastUpdated: now,
              sourceMemoryIds: sourceMemoryId ? [sourceMemoryId] : []
            };
            processedEntities.push(entityWithMetadata);
            addedEntityIds.add(newEntity.id);
          }
        }
      }

      // Process relationships with deduplication
      const processedRelationships = [...graph.relationships];
      const relationshipKey = (r: Relationship) => `${r.source}|${r.target}|${r.label}`;
      const existingRelationshipKeys = new Set(graph.relationships.map(relationshipKey));

      for (const newRel of validNewRelationships) {
        const key = relationshipKey(newRel);
        
        if (!existingRelationshipKeys.has(key)) {
          // Verify entities exist
          const sourceExists = processedEntities.some(e => e.id === newRel.source);
          const targetExists = processedEntities.some(e => e.id === newRel.target);
          
          if (sourceExists && targetExists) {
            const relationshipWithMetadata = {
              ...newRel,
              id: this.generateRelationshipId(newRel),
              createdAt: now,
              lastUpdated: now,
              sourceMemoryIds: sourceMemoryId ? [sourceMemoryId] : []
            };
            processedRelationships.push(relationshipWithMetadata);
          }
        } else {
          // Update existing relationship
          const existingIndex = processedRelationships.findIndex(r => relationshipKey(r) === key);
          if (existingIndex >= 0) {
            const existing = processedRelationships[existingIndex];
            processedRelationships[existingIndex] = {
              ...existing,
              lastUpdated: now,
              confidence: Math.max(existing.confidence || 0, newRel.confidence || 0),
              sourceMemoryIds: [
                ...(existing.sourceMemoryIds || []),
                ...(sourceMemoryId ? [sourceMemoryId] : [])
              ]
            };
          }
        }
      }

      // Update graph metadata
      updatedGraph.entities = processedEntities;
      updatedGraph.relationships = processedRelationships;
      updatedGraph.metadata = {
        ...graph.metadata,
        lastUpdated: now,
        totalEntities: processedEntities.length,
        totalRelationships: processedRelationships.length,
        sourceMemories: sourceMemoryId 
          ? [...new Set([...graph.metadata.sourceMemories, sourceMemoryId])]
          : graph.metadata.sourceMemories
      };

      return updatedGraph;
      
    } catch (error) {
      // Only log detailed errors in development mode
      if (process.env.NODE_ENV === 'development') {
        console.error('Error adding to graph:', error);
      }
      return graph; // Return original graph on error
    }
  }

  /**
   * Find related entities using graph traversal
   */
  findRelatedEntities(
    graph: KnowledgeGraph,
    seedEntityIds: string[],
    options: {
      maxHops?: number;
      relationshipTypes?: string[];
      includeWeights?: boolean;
    } = {}
  ): GraphQueryResult {
    const maxHops = options.maxHops || this.config.maxHops;
    const relationshipTypes = options.relationshipTypes;

    try {
      // BFS traversal to find related entities
      const visited = new Set<string>(seedEntityIds);
      const relatedEntityIds = new Set<string>(seedEntityIds);
      const discoveredRelationships = new Set<string>();
      const paths: Array<{ entities: string[]; relationships: string[]; score: number }> = [];

      let currentHop = 0;
      let frontier = seedEntityIds;

      while (currentHop < maxHops && frontier.length > 0) {
        const nextFrontier: string[] = [];

        for (const entityId of frontier) {
          // Find relationships involving this entity
          const relationships = graph.relationships.filter(r => {
            const isInvolved = (r.source === entityId || r.target === entityId);
            const typeMatch = !relationshipTypes || relationshipTypes.includes(r.type || r.label);
            return isInvolved && typeMatch;
          });

          for (const relationship of relationships) {
            const neighborId = relationship.source === entityId ? relationship.target : relationship.source;

            if (!visited.has(neighborId)) {
              visited.add(neighborId);
              relatedEntityIds.add(neighborId);
              nextFrontier.push(neighborId);
              discoveredRelationships.add(relationship.id || this.generateRelationshipId(relationship));

              // Track path
              if (options.includeWeights) {
                paths.push({
                  entities: [entityId, neighborId],
                  relationships: [relationship.id || this.generateRelationshipId(relationship)],
                  score: relationship.confidence || 0.5
                });
              }
            }
          }
        }

        frontier = nextFrontier;
        currentHop++;
      }

      // Get entity and relationship objects
      const relatedEntities = graph.entities.filter(e => relatedEntityIds.has(e.id));
      const relatedRelationships = graph.relationships.filter(r => 
        discoveredRelationships.has(r.id || this.generateRelationshipId(r))
      );

      return {
        entities: relatedEntities,
        relationships: relatedRelationships,
        paths: options.includeWeights ? paths : undefined,
        totalResults: relatedEntities.length
      };

    } catch (error) {
      console.error('Error finding related entities:', error);
      return {
        entities: [],
        relationships: [],
        totalResults: 0
      };
    }
  }

  /**
   * Query graph by entity type or relationship patterns
   */
  queryGraph(
    graph: KnowledgeGraph,
    query: {
      entityTypes?: string[];
      relationshipTypes?: string[];
      searchText?: string;
      limit?: number;
    }
  ): GraphQueryResult {
    try {
      // Handle null/undefined graph
      if (!graph || !graph.entities || !graph.relationships) {
        return {
          entities: [],
          relationships: [],
          totalResults: 0
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

      // Text search in labels and properties
      if (query.searchText) {
        const searchLower = query.searchText.toLowerCase();
        
        entities = entities.filter(e => 
          e.label.toLowerCase().includes(searchLower) ||
          JSON.stringify(e.properties || {}).toLowerCase().includes(searchLower)
        );
        
        relationships = relationships.filter(r =>
          r.label.toLowerCase().includes(searchLower) ||
          JSON.stringify(r.properties || {}).toLowerCase().includes(searchLower)
        );
      }

      // Apply limit
      if (query.limit) {
        entities = entities.slice(0, query.limit);
        relationships = relationships.slice(0, query.limit);
      }

      return {
        entities,
        relationships,
        totalResults: entities.length + relationships.length
      };

    } catch (error) {
      // Only log detailed errors in development mode
      if (process.env.NODE_ENV === 'development') {
        console.error('Error querying graph:', error);
      }
      return {
        entities: [],
        relationships: [],
        totalResults: 0
      };
    }
  }

  // ==================== STATISTICS & MONITORING ====================

  /**
   * Get graph statistics
   */
  getGraphStats(graph: KnowledgeGraph) {
    const entityTypes = new Map<string, number>();
    const relationshipTypes = new Map<string, number>();
    
    // Count entity types
    for (const entity of graph.entities) {
      entityTypes.set(entity.type, (entityTypes.get(entity.type) || 0) + 1);
    }

    // Count relationship types
    for (const relationship of graph.relationships) {
      const type = relationship.type || relationship.label;
      relationshipTypes.set(type, (relationshipTypes.get(type) || 0) + 1);
    }

    // Calculate connectivity metrics
    const entityConnections = new Map<string, number>();
    for (const rel of graph.relationships) {
      entityConnections.set(rel.source, (entityConnections.get(rel.source) || 0) + 1);
      entityConnections.set(rel.target, (entityConnections.get(rel.target) || 0) + 1);
    }

    const avgConnections = graph.entities.length > 0 
      ? Array.from(entityConnections.values()).reduce((sum, count) => sum + count, 0) / graph.entities.length 
      : 0;

    return {
      totalEntities: graph.entities.length,
      totalRelationships: graph.relationships.length,
      entityTypes: Object.fromEntries(entityTypes),
      relationshipTypes: Object.fromEntries(relationshipTypes),
      averageConnections: avgConnections,
      graphDensity: graph.entities.length > 0 
        ? (graph.relationships.length * 2) / (graph.entities.length * (graph.entities.length - 1))
        : 0,
      extractionStats: this.extractionStats,
      lastUpdated: graph.metadata.lastUpdated
    };
  }

  // ==================== PRIVATE METHODS ====================

  private buildExtractionPrompt(content: string): string {
    return `
Extract entities and relationships from the following text. Focus on meaningful entities (people, places, concepts, organizations) and clear relationships between them.

Format your response as valid JSON with "entities" and "relationships" arrays.

For entities:
- "id": unique identifier using meaningful names with underscores (e.g., "john_doe", "machine_learning")
- "label": display name (e.g., "John Doe", "Machine Learning")  
- "type": entity type (person, concept, organization, location, event, skill, technology, etc.)
- "confidence": confidence score 0.0-1.0

For relationships:
- "source": source entity id
- "target": target entity id
- "label": relationship description (e.g., "works at", "uses", "located in")
- "confidence": confidence score 0.0-1.0

TEXT:
${content}

JSON:`;
  }

  private async mockGeminiResponse(content: string): Promise<string> {
    // Mock response for development - replace with actual AI service
    const entities = this.extractEntitiesHeuristic(content);
    const relationships = this.extractRelationshipsHeuristic(content, entities);
    
    return JSON.stringify({
      entities: entities.map(e => ({
        id: e.id,
        label: e.label,
        type: e.type,
        confidence: 0.8
      })),
      relationships: relationships.map(r => ({
        source: r.source,
        target: r.target,
        label: r.label,
        confidence: 0.7
      }))
    });
  }

  private extractEntitiesHeuristic(content: string): Entity[] {
    const entities: Entity[] = [];
    
    // Simple heuristic extraction (replace with actual AI)
    const words = content.split(/\s+/);
    const capitalizedWords = words.filter(word => 
      /^[A-Z][a-z]+/.test(word) && word.length > 2
    );

    for (const word of capitalizedWords.slice(0, 5)) {
      entities.push({
        id: word.toLowerCase().replace(/[^\w]/g, '_'),
        label: word,
        type: 'concept',
        confidence: 0.6
      });
    }

    return entities;
  }

  private extractRelationshipsHeuristic(content: string, entities: Entity[]): Relationship[] {
    const relationships: Relationship[] = [];
    
    // Simple relationship extraction
    if (entities.length >= 2) {
      relationships.push({
        source: entities[0].id,
        target: entities[1].id,
        label: 'related to',
        confidence: 0.5
      });
    }

    return relationships;
  }

  private parseExtractionResponse(response: string, memoryId: string): { entities: Entity[]; relationships: Relationship[] } {
    try {
      const parsed = JSON.parse(response);
      
      if (!parsed.entities || !Array.isArray(parsed.entities) ||
          !parsed.relationships || !Array.isArray(parsed.relationships)) {
        throw new Error('Invalid response format');
      }

      const entities: Entity[] = parsed.entities.map((e: any) => ({
        id: this.sanitizeId(e.id || `entity_${Math.random().toString(36).substring(2, 10)}`),
        label: e.label || 'Unnamed Entity',
        type: e.type || 'concept',
        confidence: e.confidence || 0.5,
        sourceMemoryIds: [memoryId]
      }));

      const idMap = new Map<string, string>();
      parsed.entities.forEach((e: any, i: number) => {
        idMap.set(e.id || '', entities[i].id);
      });

      const relationships: Relationship[] = parsed.relationships
        .filter((r: any) => r.source && r.target && idMap.has(r.source) && idMap.has(r.target))
        .map((r: any) => ({
          source: idMap.get(r.source) || '',
          target: idMap.get(r.target) || '',
          label: r.label || 'related to',
          confidence: r.confidence || 0.5,
          sourceMemoryIds: [memoryId]
        }));

      return { entities, relationships };
      
    } catch (error) {
      console.error('Failed to parse extraction response:', error);
      return { entities: [], relationships: [] };
    }
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^\w_-]/g, '_').toLowerCase();
  }

  private calculateExtractionConfidence(entities: Entity[], relationships: Relationship[]): number {
    if (entities.length === 0 && relationships.length === 0) return 0;
    
    const entityConfidences = entities.map(e => e.confidence || 0.5);
    const relationshipConfidences = relationships.map(r => r.confidence || 0.5);
    
    const allConfidences = [...entityConfidences, ...relationshipConfidences];
    return allConfidences.reduce((sum, conf) => sum + conf, 0) / allConfidences.length;
  }

  private mergeEntities(existing: Entity, newEntity: Entity, sourceMemoryId?: string): Entity {
    return {
      ...existing,
      label: newEntity.label || existing.label,
      type: newEntity.type || existing.type,
      confidence: Math.max(existing.confidence || 0, newEntity.confidence || 0),
      properties: { ...existing.properties, ...newEntity.properties },
      sourceMemoryIds: [
        ...(existing.sourceMemoryIds || []),
        ...(sourceMemoryId ? [sourceMemoryId] : [])
      ],
      lastUpdated: new Date()
    };
  }

  private findSimilarEntity(entity: Entity, entities: Entity[]): Entity | undefined {
    for (const existing of entities) {
      if (this.calculateEntitySimilarity(entity, existing) > this.config.deduplicationThreshold) {
        return existing;
      }
    }
    return undefined;
  }

  private calculateEntitySimilarity(a: Entity, b: Entity): number {
    // Simple similarity based on label and type
    const labelSimilarity = this.stringSimilarity(a.label.toLowerCase(), b.label.toLowerCase());
    const typeSimilarity = a.type === b.type ? 1.0 : 0.0;
    
    return (labelSimilarity * 0.8) + (typeSimilarity * 0.2);
  }

  private stringSimilarity(a: string, b: string): number {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }
    
    return matrix[b.length][a.length];
  }

  private generateRelationshipId(relationship: Relationship): string {
    const content = `${relationship.source}_${relationship.target}_${relationship.label}`;
    return this.sanitizeId(content);
  }

  private updateExtractionStats(entities: Entity[], relationships: Relationship[], confidence: number, processingTime: number): void {
    this.extractionStats.totalExtractions++;
    this.extractionStats.averageEntities = 
      (this.extractionStats.averageEntities + entities.length) / this.extractionStats.totalExtractions;
    this.extractionStats.averageRelationships = 
      (this.extractionStats.averageRelationships + relationships.length) / this.extractionStats.totalExtractions;
    this.extractionStats.averageConfidence = 
      (this.extractionStats.averageConfidence + confidence) / this.extractionStats.totalExtractions;
    this.extractionStats.processingTime = 
      (this.extractionStats.processingTime + processingTime) / this.extractionStats.totalExtractions;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== SERVICE MANAGEMENT ====================

  /**
   * Test AI service connectivity
   */
  async testAIConnection(): Promise<{ connected: boolean; usingMock: boolean; service: string }> {
    if (this.config.useMockAI || !this.geminiAI) {
      return { connected: false, usingMock: true, service: 'mock' };
    }

    try {
      const connected = await this.geminiAI.testConnection();
      return { connected, usingMock: false, service: 'gemini' };
    } catch (error) {
      console.error('AI connection test failed:', error);
      return { connected: false, usingMock: false, service: 'gemini' };
    }
  }

  /**
   * Get service configuration (without sensitive data)
   */
  getConfig(): Omit<Required<GraphConfig>, 'geminiApiKey'> & { aiConfigured: boolean } {
    return {
      extractionModel: this.config.extractionModel,
      confidenceThreshold: this.config.confidenceThreshold,
      maxHops: this.config.maxHops,
      enableEmbeddings: this.config.enableEmbeddings,
      deduplicationThreshold: this.config.deduplicationThreshold,
      geminiConfig: this.config.geminiConfig,
      useMockAI: this.config.useMockAI,
      aiConfigured: !!this.config.geminiApiKey && !this.config.useMockAI
    };
  }

  /**
   * Get extraction statistics
   */
  getExtractionStats() {
    return { ...this.extractionStats };
  }
}

export default GraphService;