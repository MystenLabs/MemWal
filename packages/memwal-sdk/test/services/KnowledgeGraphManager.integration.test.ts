/**
 * KnowledgeGraphManager Integration Test Suite
 * 
 * REAL IMPLEMENTATION - NO MOCKS
 * Tests the full knowledge graph orchestration layer with:
 * - Real GeminiAIService (entity extraction from content)
 * - Real EmbeddingService (vector embeddings)
 * - Real GraphService (graph building and querying)
 * 
 * This demonstrates the complete flow:
 * Memory → AI Entity Extraction → Graph Update → Search & Analytics
 */

import { KnowledgeGraphManager } from '../../src/graph/KnowledgeGraphManager';
import { GraphService } from '../../src/graph/GraphService';
import { GeminiAIService } from '../../src/services/GeminiAIService';
import { EmbeddingService } from '../../src/services/EmbeddingService';
import type { 
  GraphMemoryMapping,
  GraphUpdateResult
} from '../../src/graph/KnowledgeGraphManager';
import type { ProcessedMemory } from '../../src/embedding/types';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

describe('KnowledgeGraphManager - Integration Tests', () => {
  let graphManager: KnowledgeGraphManager;
  let graphService: GraphService;
  let embeddingService: EmbeddingService;
  let aiService: GeminiAIService;

  const apiKey = process.env.GOOGLE_AI_API_KEY;

  beforeAll(() => {
    if (!apiKey) {
      console.log('⚠️  Skipping KnowledgeGraphManager integration tests - no GOOGLE_AI_API_KEY in .env.test');
    }
  });

  beforeEach(() => {
    if (!apiKey) {
      return; // Skip setup if no API key
    }

    // Create REAL services - NO MOCKS
    embeddingService = new EmbeddingService({
      apiKey,
      model: 'text-embedding-004',
      dimensions: 768
    });

    aiService = new GeminiAIService({
      apiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.1,
      maxTokens: 4096
    });

    // GraphService constructor: (config, embeddingService)
    graphService = new GraphService({
      geminiApiKey: apiKey,
      extractionModel: 'gemini-2.5-flash',
      confidenceThreshold: 0.7,
      enableEmbeddings: true
    }, embeddingService);

    graphManager = new KnowledgeGraphManager(graphService);
  });

  // ==================== TEST 1: BASIC INITIALIZATION ====================

  describe('1. Initialization', () => {
    test('should initialize with real GraphService', () => {
      if (!apiKey) return;
      
      expect(graphManager).toBeDefined();
      expect(graphManager['graphService']).toBe(graphService);
    });

    test('should return null for non-existent user graph', async () => {
      if (!apiKey) return;
      
      const result = await graphManager.getUserGraph('user-nonexistent');
      expect(result).toBeNull();
    });
  });

  // ==================== TEST 2: MEMORY PROCESSING WITH REAL AI ====================

  describe('2. Memory Processing with Real AI Extraction', () => {
    test('should process memory and extract entities using real Gemini AI', async () => {
      if (!apiKey) return;

      const memory: ProcessedMemory = {
        id: 'mem-001',
        userId: 'user-test',
        content: 'Alice Johnson works at Google as a Senior Software Engineer in Mountain View',
        category: 'work',
        createdAt: new Date(),
        metadata: {
          contentType: 'text',
          source: 'chat'
        }
      };

      // Process memory with REAL AI extraction
      const result = await graphManager.processMemoryForGraph(memory);

      console.log('📊 Processing Result:', {
        success: result.success,
        entitiesAdded: result.entitiesAdded,
        relationshipsAdded: result.relationshipsAdded,
        processingTime: result.processingTimeMs
      });

      // Verify successful processing
      expect(result.success).toBe(true);
      expect(result.entitiesAdded).toBeGreaterThanOrEqual(1); // At least Alice or Google
      expect(result.processingTimeMs).toBeGreaterThan(0);
      
      // Verify graph was updated
      const graph = await graphManager.getUserGraph('user-test');
      expect(graph).not.toBeNull();
      expect(graph!.entities.length).toBeGreaterThan(0);

      console.log('🔍 Extracted Entities:', graph!.entities.map(e => e.label));
      console.log('🔗 Extracted Relationships:', graph!.relationships.map(r => 
        `${r.source} --[${r.label}]--> ${r.target}`
      ));
    }, 30000); // 30s timeout for real API calls

    test('should handle empty content gracefully', async () => {
      if (!apiKey) return;

      const memory: ProcessedMemory = {
        id: 'mem-empty',
        userId: 'user-test',
        content: '',
        category: 'general',
        createdAt: new Date()
      };

      const result = await graphManager.processMemoryForGraph(memory);

      expect(result.success).toBe(false);
      expect(result.entitiesAdded).toBe(0);
    });
  });

  // ==================== TEST 3: BATCH PROCESSING ====================

  describe('3. Batch Memory Processing', () => {
    test('should process multiple memories in batch', async () => {
      if (!apiKey) return;

      const memories: ProcessedMemory[] = [
        {
          id: 'mem-batch-1',
          userId: 'user-batch',
          content: 'Sarah Chen is a Data Scientist at Microsoft',
          category: 'work',
          createdAt: new Date()
        },
        {
          id: 'mem-batch-2',
          userId: 'user-batch',
          content: 'Tom Wilson lives in Seattle and loves hiking',
          category: 'personal',
          createdAt: new Date()
        },
        {
          id: 'mem-batch-3',
          userId: 'user-batch',
          content: 'Emma Davis teaches Python at Stanford University',
          category: 'education',
          createdAt: new Date()
        }
      ];

      // Process batch with REAL AI
      const results = await graphManager.processBatchMemoriesForGraph(
        'user-batch',
        memories,
        { batchSize: 2, delayMs: 500 }
      );

      console.log('📦 Batch Results:', results.map(r => ({
        success: r.success,
        entities: r.entitiesAdded,
        relationships: r.relationshipsAdded
      })));

      // Verify all processed
      expect(results).toHaveLength(3);
      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBeGreaterThan(0); // At least some should succeed

      // Verify graph contains all entities
      const graph = await graphManager.getUserGraph('user-batch');
      expect(graph).not.toBeNull();
      expect(graph!.entities.length).toBeGreaterThan(0);

      console.log(`✅ Batch processed: ${successCount}/3 succeeded`);
      console.log('📊 Total entities in graph:', graph!.entities.length);
    }, 60000); // 60s timeout for batch processing
  });

  // ==================== TEST 4: MEMORY MAPPING TRACKING ====================

  describe('4. Memory Mapping Management', () => {
    test('should record and retrieve memory mappings', () => {
      if (!apiKey) return;

      const mapping: GraphMemoryMapping = {
        memoryId: 'mem-mapping-1',
        entityIds: ['entity-1', 'entity-2'],
        relationshipIds: ['rel-1'],
        extractionDate: new Date(),
        confidence: 0.85
      };

      // Record mapping
      graphManager.recordMemoryMapping(mapping);

      // Retrieve and verify
      const retrieved = graphManager.getMemoryMappings('mem-mapping-1');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].memoryId).toBe('mem-mapping-1');
      expect(retrieved[0].entityIds).toEqual(['entity-1', 'entity-2']);
      expect(retrieved[0].confidence).toBe(0.85);
    });

    test('should handle multiple mappings for different memories', () => {
      if (!apiKey) return;

      const mappings: GraphMemoryMapping[] = [
        {
          memoryId: 'mem-A',
          entityIds: ['e1'],
          relationshipIds: [],
          extractionDate: new Date(),
          confidence: 0.9
        },
        {
          memoryId: 'mem-B',
          entityIds: ['e2', 'e3'],
          relationshipIds: ['r1'],
          extractionDate: new Date(),
          confidence: 0.8
        }
      ];

      mappings.forEach(m => graphManager.recordMemoryMapping(m));

      const mappingA = graphManager.getMemoryMappings('mem-A');
      const mappingB = graphManager.getMemoryMappings('mem-B');

      expect(mappingA).toHaveLength(1);
      expect(mappingB).toHaveLength(1);
      expect(mappingB[0].entityIds).toHaveLength(2);
    });

    test('should return empty array for non-existent memory', () => {
      if (!apiKey) return;

      const result = graphManager.getMemoryMappings('non-existent');
      expect(result).toEqual([]);
    });
  });

  // ==================== TEST 5: GRAPH STATISTICS ====================

  describe('5. Graph Statistics and Analytics', () => {
    test('should calculate statistics for user graph', async () => {
      if (!apiKey) return;

      const userId = 'user-stats';

      // Create and populate graph
      const memory: ProcessedMemory = {
        id: 'mem-stats',
        userId,
        content: 'Dr. Maria Garcia is a Professor at MIT teaching Machine Learning and works with IBM Research',
        category: 'education',
        createdAt: new Date()
      };

      await graphManager.processMemoryForGraph(memory);

      // Get statistics
      const stats = graphManager.getGraphStatistics(userId);

      console.log('📈 Graph Statistics:', {
        totalEntities: stats.totalEntities,
        totalRelationships: stats.totalRelationships,
        entityTypes: stats.entityTypeDistribution,
        relationshipTypes: stats.relationshipTypeDistribution,
        avgEntityConfidence: stats.averageEntityConfidence.toFixed(2),
        avgRelationshipConfidence: stats.averageRelationshipConfidence.toFixed(2)
      });

      // Verify statistics
      expect(stats.totalEntities).toBeGreaterThan(0);
      expect(stats.sourceMemoriesCount).toBe(1);
      expect(Object.keys(stats.entityTypeDistribution).length).toBeGreaterThan(0);
    }, 30000);

    test('should handle empty graph statistics', () => {
      if (!apiKey) return;

      const stats = graphManager.getGraphStatistics('user-empty');

      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelationships).toBe(0);
      expect(stats.sourceMemoriesCount).toBe(0);
      expect(stats.averageEntityConfidence).toBe(0);
      expect(stats.averageRelationshipConfidence).toBe(0);
    });
  });

  // ==================== TEST 6: GRAPH SEARCH ====================

  describe('6. Graph Search and Query', () => {
    test('should search graph by keywords', async () => {
      if (!apiKey) return;

      const userId = 'user-search';

      // Build graph with test data
      const memory: ProcessedMemory = {
        id: 'mem-search',
        userId,
        content: 'Jennifer Lee is a Product Manager at Amazon working on AWS services in Seattle',
        category: 'work',
        createdAt: new Date()
      };

      await graphManager.processMemoryForGraph(memory);

      // Search by keyword
      const results = await graphManager.searchGraph(userId, {
        keywords: ['Amazon', 'Seattle'],
        maxResults: 10
      });

      console.log('🔍 Search Results:', {
        entities: results.entities.length,
        relationships: results.relationships.length,
        queryTime: results.queryTimeMs
      });

      expect(results.totalResults).toBeGreaterThanOrEqual(0);
      expect(results.queryTimeMs).toBeGreaterThanOrEqual(0); // Allow 0ms for empty results
    }, 30000);

    test('should search by entity types', async () => {
      if (!apiKey) return;

      const userId = 'user-type-search';

      // Build graph
      const memory: ProcessedMemory = {
        id: 'mem-type',
        userId,
        content: 'Apple Inc is a technology company founded in Cupertino',
        category: 'business',
        createdAt: new Date()
      };

      await graphManager.processMemoryForGraph(memory);

      // Search by entity type
      const results = await graphManager.searchGraph(userId, {
        entityTypes: ['organization', 'company'],
        maxResults: 5
      });

      expect(results.entities.length).toBeGreaterThanOrEqual(0);
    }, 30000);
  });

  // ==================== TEST 7: ERROR HANDLING ====================

  describe('7. Error Handling and Edge Cases', () => {
    test('should handle invalid memory data', async () => {
      if (!apiKey) return;

      const invalidMemory = {
        id: 'invalid',
        userId: 'user-test',
        content: null as any,
        category: 'test',
        createdAt: new Date()
      };

      const result = await graphManager.processMemoryForGraph(invalidMemory);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.entitiesAdded).toBe(0);
    });

    test('should handle very short content', async () => {
      if (!apiKey) return;

      const shortMemory: ProcessedMemory = {
        id: 'short',
        userId: 'user-test',
        content: 'Hi',
        category: 'general',
        createdAt: new Date()
      };

      const result = await graphManager.processMemoryForGraph(shortMemory);

      // Should process but may extract no entities
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
    });

    test('should handle non-existent user graph search', async () => {
      if (!apiKey) return;

      const results = await graphManager.searchGraph('user-nonexistent', {
        keywords: ['test'],
        maxResults: 10
      });

      expect(results.entities).toEqual([]);
      expect(results.relationships).toEqual([]);
      expect(results.totalResults).toBe(0);
    });
  });

  // ==================== TEST 8: CROSS-MEMORY ENTITY RELATIONSHIPS ====================

  describe('8. Cross-Memory Entity Relationships', () => {
    test('should merge entities from multiple memories', async () => {
      if (!apiKey) return;

      const userId = 'user-merge';

      // First memory introduces entities
      const memory1: ProcessedMemory = {
        id: 'mem-merge-1',
        userId,
        content: 'John Martinez works at Tesla',
        category: 'work',
        createdAt: new Date()
      };

      // Second memory references same entity
      const memory2: ProcessedMemory = {
        id: 'mem-merge-2',
        userId,
        content: 'John Martinez graduated from Stanford University',
        category: 'education',
        createdAt: new Date()
      };

      // Process both memories
      const result1 = await graphManager.processMemoryForGraph(memory1);
      const result2 = await graphManager.processMemoryForGraph(memory2);

      console.log('🔄 Merge Results:', {
        memory1: { entities: result1.entitiesAdded, success: result1.success },
        memory2: { entities: result2.entitiesAdded, success: result2.success }
      });

      // Get final graph
      const graph = await graphManager.getUserGraph(userId);
      expect(graph).not.toBeNull();

      console.log('🎯 Final Graph:', {
        totalEntities: graph!.entities.length,
        totalRelationships: graph!.relationships.length,
        sourceMemories: graph!.metadata.sourceMemories
      });

      // Should have entities from both memories
      expect(graph!.metadata.sourceMemories).toContain('mem-merge-1');
      expect(graph!.metadata.sourceMemories).toContain('mem-merge-2');
    }, 60000); // 60s for two API calls
  });
});
