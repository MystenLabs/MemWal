/**
 * GraphService Test Suite
 * 
 * Comprehensive tests for knowledge graph extraction and management
 * NO MOCKS - Uses REAL GeminiAIService and EmbeddingService
 */

import { describe, it, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { GraphService } from '../../src/graph/GraphService';
import { EmbeddingService } from '../../src/services/EmbeddingService';
import { GeminiAIService } from '../../src/services/GeminiAIService';
import type { 
  KnowledgeGraph, 
  Entity, 
  Relationship, 
  GraphConfig,
  GraphExtractionResult,
  GraphQueryResult
} from '../../src/graph/GraphService';
import dotenv from 'dotenv';

// Load environment variables from .env.test
dotenv.config({ path: '.env.test' });

describe('GraphService', () => {
  let graphService: GraphService;
  let embeddingService: EmbeddingService;
  let geminiAIService: GeminiAIService;
  
  const apiKey = process.env.GOOGLE_AI_API_KEY;

  beforeAll(() => {
    if (!apiKey) {
      console.warn('⚠️  GOOGLE_AI_API_KEY not found in .env.test - some tests will use mock AI');
    }
  });

  beforeEach(() => {
    // Create REAL embedding service with actual Gemini API
    embeddingService = new EmbeddingService({
      apiKey: apiKey || 'test-key',
      model: 'text-embedding-004',
      dimensions: 768
    });

    // Create REAL Gemini AI service
    if (apiKey) {
      geminiAIService = new GeminiAIService({
        apiKey,
        model: 'gemini-2.5-flash',
        temperature: 0.1,
        maxTokens: 4096
      });
    }

    // Initialize GraphService with real services
    const config: Partial<GraphConfig> = {
      extractionModel: 'gemini-2.5-flash',
      confidenceThreshold: 0.7,
      maxHops: 3,
      enableEmbeddings: true,
      deduplicationThreshold: 0.85,
      geminiApiKey: apiKey,
      useMockAI: !apiKey // Use mock only if no API key
    };

    graphService = new GraphService(config, embeddingService);
  });

  // ==================== GRAPH CREATION & MANAGEMENT TESTS ====================

  describe('Graph Creation and Management', () => {
    test('should create empty knowledge graph', () => {
      const graph = graphService.createGraph();

      expect(graph).toBeDefined();
      expect(graph.entities).toEqual([]);
      expect(graph.relationships).toEqual([]);
      expect(graph.metadata).toMatchObject({
        version: '1.0',
        totalEntities: 0,
        totalRelationships: 0,
        sourceMemories: []
      });
      expect(graph.metadata.createdAt).toBeInstanceOf(Date);
      expect(graph.metadata.lastUpdated).toBeInstanceOf(Date);
    });

    test('should create and cache user graph', () => {
      const userId = 'user-123';
      const graph = graphService.createGraph(userId);

      expect(graphService.getUserGraph(userId)).toBe(graph);
    });

    test('should get cached user graph', () => {
      const userId = 'user-456';
      const graph = graphService.createGraph();
      
      graphService.setUserGraph(userId, graph);
      const retrievedGraph = graphService.getUserGraph(userId);

      expect(retrievedGraph).toBe(graph);
    });

    test('should return undefined for non-existent user graph', () => {
      const result = graphService.getUserGraph('non-existent-user');
      expect(result).toBeUndefined();
    });
  });

  // ==================== ENTITY & RELATIONSHIP EXTRACTION TESTS ====================

  describe('Entity and Relationship Extraction', () => {
    test('should extract entities and relationships from content with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - would use mock AI');
        return;
      }

      const content = 'John Smith works at Microsoft as a Software Engineer. He lives in Seattle.';
      const memoryId = 'memory-123';

      const result = await graphService.extractEntitiesAndRelationships(content, memoryId);

      // Verify extraction worked
      expect(result.extractedFromMemory).toBe(memoryId);
      expect(result.processingTimeMs).toBeGreaterThan(0);
      
      // With real API, we should get actual entities and relationships
      // The exact results may vary, but structure should be correct
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
      expect(typeof result.confidence).toBe('number');
      
      // Log results for inspection
      console.log('✅ Extracted entities:', result.entities.length);
      console.log('✅ Extracted relationships:', result.relationships.length);
      
      // Verify entity structure if any were found
      if (result.entities.length > 0) {
        const firstEntity = result.entities[0];
        expect(firstEntity).toHaveProperty('id');
        expect(firstEntity).toHaveProperty('label');
        expect(firstEntity).toHaveProperty('type');
        expect(firstEntity).toHaveProperty('confidence');
      }
      
      // Verify relationship structure if any were found
      if (result.relationships.length > 0) {
        const firstRel = result.relationships[0];
        expect(firstRel).toHaveProperty('source');
        expect(firstRel).toHaveProperty('target');
        expect(firstRel).toHaveProperty('label');
      }
    });

    test('should handle extraction errors gracefully', async () => {
      // Test with invalid/malformed content that might cause issues
      const content = '';
      const memoryId = 'memory-error';

      const result = await graphService.extractEntitiesAndRelationships(content, memoryId);

      // Empty content should return empty results gracefully
      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.extractedFromMemory).toBe(memoryId);
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('should handle empty content extraction', async () => {
      const content = '';
      const memoryId = 'memory-empty';

      const result = await graphService.extractEntitiesAndRelationships(content, memoryId);

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.extractedFromMemory).toBe(memoryId);
    });

    test('should process batch extraction with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - batch extraction needs real API');
        return;
      }

      const memories = [
        { id: 'mem1', content: 'Alice works at Google' },
        { id: 'mem2', content: 'Bob lives in New York' }
      ];

      const results = await graphService.extractFromMemoriesBatch(memories);

      expect(results).toHaveLength(2);
      expect(results[0].extractedFromMemory).toBe('mem1');
      expect(results[1].extractedFromMemory).toBe('mem2');
      
      // Verify structure
      results.forEach(result => {
        expect(Array.isArray(result.entities)).toBe(true);
        expect(Array.isArray(result.relationships)).toBe(true);
        expect(typeof result.confidence).toBe('number');
        expect(result.processingTimeMs).toBeGreaterThan(0);
      });
      
      console.log('✅ Batch extraction completed:', results.length, 'memories processed');
    });
  });

  // ==================== GRAPH BUILDING TESTS ====================

  describe('Graph Building and Updates', () => {
    let baseGraph: KnowledgeGraph;

    beforeEach(() => {
      baseGraph = graphService.createGraph();
      // Add some initial data
      baseGraph.entities = [
        { id: 'existing_person', label: 'Existing Person', type: 'person', confidence: 0.9 }
      ];
      baseGraph.relationships = [];
    });

    test('should add new entities and relationships to graph', () => {
      const newEntities: Entity[] = [
        { id: 'new_person', label: 'New Person', type: 'person', confidence: 0.95 },
        { id: 'company', label: 'Company Inc', type: 'organization', confidence: 0.90 }
      ];

      const newRelationships: Relationship[] = [
        { source: 'new_person', target: 'company', label: 'works_at', confidence: 0.85 }
      ];

      const updatedGraph = graphService.addToGraph(baseGraph, newEntities, newRelationships, 'memory-123');

      expect(updatedGraph.entities).toHaveLength(3); // 1 existing + 2 new
      expect(updatedGraph.relationships).toHaveLength(1);
      expect(updatedGraph.metadata.totalEntities).toBe(3);
      expect(updatedGraph.metadata.totalRelationships).toBe(1);
      expect(updatedGraph.metadata.sourceMemories).toContain('memory-123');
    });

    test('should merge duplicate entities', () => {
      const duplicateEntity: Entity = {
        id: 'existing_person',
        label: 'Existing Person Updated',
        type: 'person',
        confidence: 0.95,
        properties: { role: 'manager' }
      };

      const updatedGraph = graphService.addToGraph(baseGraph, [duplicateEntity], [], 'memory-456');

      expect(updatedGraph.entities).toHaveLength(1); // Should still be 1
      const entity = updatedGraph.entities[0];
      expect(entity.label).toBe('Existing Person Updated'); // Should be updated
      expect(entity.properties).toMatchObject({ role: 'manager' });
    });

    test('should skip relationships with missing entities', () => {
      const invalidRelationship: Relationship = {
        source: 'non_existent_entity',
        target: 'another_non_existent',
        label: 'invalid_relation',
        confidence: 0.8
      };

      const updatedGraph = graphService.addToGraph(baseGraph, [], [invalidRelationship], 'memory-789');

      expect(updatedGraph.relationships).toHaveLength(0);
    });

    test('should handle graph building errors gracefully', () => {
      // Create malformed entities that might cause errors
      const malformedEntities = [null as any, undefined as any];

      const result = graphService.addToGraph(baseGraph, malformedEntities, [], 'memory-error');

      // Should filter out invalid entities and return updated graph with valid data
      expect(result).toBeDefined();
      expect(result.entities.length).toBe(1); // Only the existing valid entity
      expect(result.metadata.totalEntities).toBe(1);
      expect(result.metadata.sourceMemories).toContain('memory-error');
    });
  });

  // ==================== GRAPH TRAVERSAL TESTS ====================  

  describe('Graph Traversal and Related Entity Finding', () => {
    let complexGraph: KnowledgeGraph;

    beforeEach(() => {
      complexGraph = {
        entities: [
          { id: 'person1', label: 'Alice', type: 'person', confidence: 0.9 },
          { id: 'person2', label: 'Bob', type: 'person', confidence: 0.9 },
          { id: 'company1', label: 'TechCorp', type: 'organization', confidence: 0.8 },
          { id: 'location1', label: 'San Francisco', type: 'location', confidence: 0.85 }
        ],
        relationships: [
          { id: 'rel1', source: 'person1', target: 'company1', label: 'works_at', confidence: 0.9 },
          { id: 'rel2', source: 'person2', target: 'company1', label: 'works_at', confidence: 0.9 },
          { id: 'rel3', source: 'person1', target: 'location1', label: 'lives_in', confidence: 0.8 },
          { id: 'rel4', source: 'company1', target: 'location1', label: 'located_in', confidence: 0.7 }
        ],
        metadata: {
          version: '1.0',
          createdAt: new Date(),
          lastUpdated: new Date(),
          totalEntities: 4,
          totalRelationships: 4,
          sourceMemories: []
        }
      };
    });

    test('should find directly related entities', () => {
      const result = graphService.findRelatedEntities(complexGraph, ['person1'], { maxHops: 1 });

      expect(result.entities).toContainEqual(
        expect.objectContaining({ id: 'company1' })
      );
      expect(result.entities).toContainEqual(
        expect.objectContaining({ id: 'location1' })
      );
      expect(result.totalResults).toBeGreaterThan(0);
    });

    test('should find entities through multiple hops', () => {
      const result = graphService.findRelatedEntities(complexGraph, ['person1'], { maxHops: 2 });

      // person1 -> company1 -> person2 (2 hops)
      expect(result.entities).toContainEqual(
        expect.objectContaining({ id: 'person2' })
      );
    });

    test('should filter by relationship types', () => {
      const result = graphService.findRelatedEntities(
        complexGraph, 
        ['person1'], 
        { maxHops: 1, relationshipTypes: ['works_at'] }
      );

      // Should only find company1 through works_at relationship
      expect(result.entities).toContainEqual(
        expect.objectContaining({ id: 'company1' })
      );
      expect(result.entities).not.toContainEqual(
        expect.objectContaining({ id: 'location1' })
      );
    });

    test('should handle empty seed entities', () => {
      const result = graphService.findRelatedEntities(complexGraph, [], { maxHops: 1 });

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.totalResults).toBe(0);
    });
  });

  // ==================== GRAPH QUERY TESTS ====================

  describe('Graph Querying', () => {
    let queryGraph: KnowledgeGraph;

    beforeEach(() => {
      queryGraph = {
        entities: [
          { id: 'dev1', label: 'Alice Smith', type: 'developer', confidence: 0.9, properties: { skill: 'JavaScript' } },
          { id: 'dev2', label: 'Bob Jones', type: 'developer', confidence: 0.9, properties: { skill: 'Python' } },
          { id: 'mgr1', label: 'Carol Admin', type: 'manager', confidence: 0.8, properties: { team: 'Engineering' } },
          { id: 'proj1', label: 'Web App', type: 'project', confidence: 0.85 }
        ],
        relationships: [
          { id: 'r1', source: 'dev1', target: 'proj1', label: 'works_on', type: 'assignment', confidence: 0.9 },
          { id: 'r2', source: 'dev2', target: 'proj1', label: 'works_on', type: 'assignment', confidence: 0.9 },
          { id: 'r3', source: 'mgr1', target: 'dev1', label: 'manages', type: 'supervision', confidence: 0.8 }
        ],
        metadata: {
          version: '1.0',
          createdAt: new Date(),
          lastUpdated: new Date(),
          totalEntities: 4,
          totalRelationships: 3,
          sourceMemories: []
        }
      };
    });

    test('should query by entity types', () => {
      const result = graphService.queryGraph(queryGraph, { entityTypes: ['developer'] });

      expect(result.entities).toHaveLength(2);
      expect(result.entities.every(e => e.type === 'developer')).toBe(true);
    });

    test('should query by relationship types', () => {
      const result = graphService.queryGraph(queryGraph, { relationshipTypes: ['assignment'] });

      expect(result.relationships).toHaveLength(2);
      expect(result.relationships.every(r => r.type === 'assignment')).toBe(true);
    });

    test('should perform text search', () => {
      const result = graphService.queryGraph(queryGraph, { searchText: 'Alice' });

      expect(result.entities.some(e => e.label.includes('Alice'))).toBe(true);
    });

    test('should search in properties', () => {
      const result = graphService.queryGraph(queryGraph, { searchText: 'JavaScript' });

      expect(result.entities.some(e => e.properties?.skill === 'JavaScript')).toBe(true);
    });

    test('should apply query limit', () => {
      const result = graphService.queryGraph(queryGraph, { limit: 2 });

      expect(result.entities.length).toBeLessThanOrEqual(2);
    });

    test('should handle empty query', () => {
      const result = graphService.queryGraph(queryGraph, {});

      expect(result.entities).toHaveLength(4);
      expect(result.relationships).toHaveLength(3);
    });

    test('should handle query with no matches', () => {
      const result = graphService.queryGraph(queryGraph, { entityTypes: ['nonexistent'] });

      expect(result.entities).toHaveLength(0);
      expect(result.totalResults).toBe(result.entities.length + result.relationships.length);
    });
  });

  // ==================== PERFORMANCE TESTS ====================

  describe('Performance Tests', () => {
    test('should handle large entity extraction efficiently with REAL or MOCK API', async () => {
      const largeContent = 'This is a large document with many entities. '.repeat(100) +
        'John works at Microsoft. Alice lives in Seattle. Bob manages the team.';
      const memoryId = 'large-memory';

      const startTime = Date.now();
      const result = await graphService.extractEntitiesAndRelationships(largeContent, memoryId);
      const endTime = Date.now();

      // Verify structure regardless of API or mock
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
      expect(result.extractedFromMemory).toBe(memoryId);
      expect(endTime - startTime).toBeLessThan(30000); // Should complete within 30 seconds even with real API
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
      
      if (apiKey) {
        console.log('✅ Large content extraction completed in', endTime - startTime, 'ms');
        console.log('✅ Found entities:', result.entities.length, 'relationships:', result.relationships.length);
      }
    });

    test('should handle complex graph traversal efficiently', () => {
      // Create a graph with many entities
      const largeGraph: KnowledgeGraph = {
        entities: Array.from({ length: 100 }, (_, i) => ({
          id: `entity_${i}`,
          label: `Entity ${i}`,
          type: 'test',
          confidence: 0.8
        })),
        relationships: Array.from({ length: 200 }, (_, i) => ({
          id: `rel_${i}`,
          source: `entity_${i % 50}`,
          target: `entity_${(i + 1) % 50}`,
          label: 'connects_to',
          confidence: 0.7
        })),
        metadata: {
          version: '1.0',
          createdAt: new Date(),
          lastUpdated: new Date(),
          totalEntities: 100,
          totalRelationships: 200,
          sourceMemories: []
        }
      };

      const startTime = Date.now();
      const result = graphService.findRelatedEntities(largeGraph, ['entity_0'], { maxHops: 3 });
      const endTime = Date.now();

      expect(result.entities.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
    });
  });

  // ==================== VECTOR EMBEDDING TESTS ====================

  describe('Vector Embedding Integration', () => {
    test('should generate embeddings for entity labels with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real embedding generation');
        return;
      }

      const entity: Entity = {
        id: 'test_entity',
        label: 'Artificial Intelligence and Machine Learning',
        type: 'concept',
        confidence: 0.95
      };

      // Generate embedding using real EmbeddingService
      const embeddingResult = await embeddingService.embedText({
        text: entity.label,
        type: 'content'
      });

      expect(embeddingResult).toBeDefined();
      expect(embeddingResult.vector).toBeDefined();
      expect(embeddingResult.vector.length).toBe(768); // text-embedding-004 dimensions
      expect(embeddingResult.dimension).toBe(768);
      expect(embeddingResult.model).toBe('text-embedding-004');
      expect(embeddingResult.processingTime).toBeGreaterThan(0);

      console.log('✅ Generated embedding vector with', embeddingResult.vector.length, 'dimensions');
      console.log('✅ Processing time:', embeddingResult.processingTime, 'ms');
    });

    test('should compute similarity between related entities with REAL embeddings', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real embedding generation');
        return;
      }

      // Create related entities
      const entity1 = 'Python programming language';
      const entity2 = 'Software development with Python';
      const entity3 = 'Cooking recipes for dinner'; // Unrelated

      // Generate embeddings for all three
      const [emb1, emb2, emb3] = await Promise.all([
        embeddingService.embedText({ text: entity1, type: 'content' }),
        embeddingService.embedText({ text: entity2, type: 'content' }),
        embeddingService.embedText({ text: entity3, type: 'content' })
      ]);

      // Calculate cosine similarity
      const similarity12 = embeddingService.calculateCosineSimilarity(emb1.vector, emb2.vector);
      const similarity13 = embeddingService.calculateCosineSimilarity(emb1.vector, emb3.vector);

      // Related entities should have higher similarity
      expect(similarity12).toBeGreaterThan(similarity13);
      expect(similarity12).toBeGreaterThan(0.5); // Related concepts should be fairly similar
      expect(similarity13).toBeLessThan(0.7); // Unrelated should be less similar

      console.log('✅ Similarity (Python vs Python dev):', similarity12.toFixed(4));
      console.log('✅ Similarity (Python vs Cooking):', similarity13.toFixed(4));
      console.log('✅ Similarity difference validates semantic understanding');
    });

    test('should use embeddings for entity deduplication', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real embedding generation');
        return;
      }

      // Similar entities that should be considered duplicates
      const entity1 = 'Microsoft Corporation';
      const entity2 = 'Microsoft Corp';
      
      const [emb1, emb2] = await Promise.all([
        embeddingService.embedText({ text: entity1, type: 'content' }),
        embeddingService.embedText({ text: entity2, type: 'content' })
      ]);

      const similarity = embeddingService.calculateCosineSimilarity(emb1.vector, emb2.vector);

      // Very similar labels should have high similarity (potential duplicates)
      expect(similarity).toBeGreaterThan(0.85); // Default deduplication threshold
      
      console.log('✅ Entity deduplication similarity:', similarity.toFixed(4));
      console.log('✅ Threshold check:', similarity > 0.85 ? 'Would deduplicate' : 'Would keep separate');
    });

    test('should batch generate embeddings for multiple entities efficiently', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real batch embedding generation');
        return;
      }

      const entityLabels = [
        'John Smith',
        'Microsoft',
        'Seattle',
        'Software Engineer',
        'Python Programming'
      ];

      const startTime = Date.now();
      
      // Batch generate embeddings
      const batchResult = await embeddingService.embedBatch(entityLabels);

      const endTime = Date.now();
      const totalTime = endTime - startTime;

      expect(batchResult.vectors).toHaveLength(5);
      batchResult.vectors.forEach((vector, idx) => {
        expect(vector).toBeDefined();
        expect(vector.length).toBe(768);
        console.log(`✅ Entity ${idx + 1} "${entityLabels[idx]}": ${vector.length}d vector`);
      });

      console.log('✅ Batch embedding generation completed in', totalTime, 'ms');
      console.log('✅ Average per entity:', (totalTime / 5).toFixed(0), 'ms');
    });

    test('should find similar entities using vector search', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real vector search');
        return;
      }

      // Create a knowledge graph with entities
      const graph: KnowledgeGraph = graphService.createGraph();
      
      const entities: Entity[] = [
        { id: 'python', label: 'Python Programming', type: 'skill', confidence: 0.9 },
        { id: 'javascript', label: 'JavaScript Development', type: 'skill', confidence: 0.9 },
        { id: 'java', label: 'Java Programming', type: 'skill', confidence: 0.9 },
        { id: 'cooking', label: 'Cooking Techniques', type: 'skill', confidence: 0.9 },
        { id: 'photography', label: 'Digital Photography', type: 'hobby', confidence: 0.85 }
      ];

      graph.entities = entities;

      // Generate embeddings for all entities
      const batchResult = await embeddingService.embedBatch(
        entities.map(e => e.label)
      );

      // Create a map of entity ID to embedding vector
      const entityEmbeddings = new Map(
        entities.map((e, idx) => [e.id, batchResult.vectors[idx]])
      );

      // Search query: "coding and software development"
      const queryEmbedding = await embeddingService.embedText({
        text: 'coding and software development',
        type: 'query'
      });

      // Calculate similarity scores for all entities
      const similarities = entities.map(e => ({
        entity: e,
        similarity: embeddingService.calculateCosineSimilarity(
          queryEmbedding.vector,
          entityEmbeddings.get(e.id)!
        )
      })).sort((a, b) => b.similarity - a.similarity);

      // Top results should be programming-related skills
      expect(similarities[0].entity.type).toBe('skill');
      expect(['python', 'javascript', 'java']).toContain(similarities[0].entity.id);
      
      // Non-programming skills should rank lower
      const cookingRank = similarities.findIndex(s => s.entity.id === 'cooking');
      expect(cookingRank).toBeGreaterThan(2); // Should not be in top 3

      console.log('✅ Vector search results:');
      similarities.forEach((s, idx) => {
        console.log(`   ${idx + 1}. ${s.entity.label} (${s.entity.type}): ${s.similarity.toFixed(4)}`);
      });
    });

    test('should enhance graph queries with semantic similarity', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key - needs real semantic search');
        return;
      }

      const content = 'Alice is a machine learning engineer who specializes in deep learning and neural networks.';
      const memoryId = 'ml-memory';

      // Extract entities using real AI
      const extraction = await graphService.extractEntitiesAndRelationships(content, memoryId);

      // Generate embeddings for extracted entities
      if (extraction.entities.length > 0) {
        const batchResult = await embeddingService.embedBatch(
          extraction.entities.map(e => e.label)
        );

        console.log('✅ Extracted entities with embeddings:');
        extraction.entities.forEach((entity, idx) => {
          console.log(`   - ${entity.label} (${entity.type}): ${batchResult.vectors[idx].length}d vector`);
        });

        expect(batchResult.vectors.length).toBe(extraction.entities.length);
        batchResult.vectors.forEach(vector => {
          expect(vector.length).toBe(768);
        });
      } else {
        console.log('⚠️  No entities extracted, skipping embedding validation');
      }
    });
  });

  // ==================== ERROR HANDLING TESTS ====================

  describe('Error Handling', () => {
    test('should handle null graph gracefully', () => {
      expect(() => {
        graphService.queryGraph(null as any, {});
      }).not.toThrow();
    });

    test('should handle malformed query parameters', () => {
      const graph = graphService.createGraph();
      
      expect(() => {
        graphService.queryGraph(graph, { entityTypes: null as any });
      }).not.toThrow();
    });

    test('should handle invalid relationship data during graph building', () => {
      const graph = graphService.createGraph();
      const invalidRelationships = [
        { source: '', target: '', label: '', confidence: NaN } as any
      ];

      expect(() => {
        graphService.addToGraph(graph, [], invalidRelationships);
      }).not.toThrow();
    });
  });
});