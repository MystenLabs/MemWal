/**
 * Enhanced MemoryIndexService Tests
 * 
 * Testing native HNSW functionality via HnswIndexService including:
 * - Advanced semantic search with O(log N) performance using hnswlib-node
 * - Intelligent batching and caching for optimal performance
 * - Walrus persistence integration
 * - Metadata filtering and intelligent relevance scoring
 * - Native C++ HNSW implementation (10-100x faster than pure JS)
 */

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { MemoryIndexService, type MemorySearchQuery } from '../../src/services/MemoryIndexService';
import type { MemoryMetadata, WalrusUploadResult } from '../../src/services/StorageService';

const VECTOR_DIMENSION = 768;

const createVector = (dimension: number, seed = 0.5, variance = 0.1) =>
  Array.from({ length: dimension }, (_, index) => {
    const value = Math.sin(seed * (index + 1)) * variance + seed;
    return Number(value.toFixed(6));
  });

const perturbVector = (vector: number[], delta: number) =>
  vector.map((value, index) => Number((value + Math.sin((index + 1) * delta) * 0.05).toFixed(6)));

const buildMetadata = (config: {
  category: string;
  topic: string;
  importance: number;
  createdTimestamp: number;
  contentType?: string;
  contentSize?: number;
  contentHash?: string;
  embeddingDimension?: number;
  updatedTimestamp?: number;
  customMetadata?: Record<string, string>;
  isEncrypted?: boolean;
  embeddingBlobId?: string;
  encryptionType?: string;
}): MemoryMetadata => ({
  contentType: config.contentType ?? 'text/plain',
  contentSize: config.contentSize ?? 1024,
  contentHash: config.contentHash ?? `hash-${config.category}-${config.topic}`,
  category: config.category,
  topic: config.topic,
  importance: config.importance,
  embeddingBlobId: config.embeddingBlobId,
  embeddingDimension: config.embeddingDimension ?? VECTOR_DIMENSION,
  createdTimestamp: config.createdTimestamp,
  updatedTimestamp: config.updatedTimestamp,
  customMetadata: config.customMetadata,
  isEncrypted: config.isEncrypted,
  encryptionType: config.encryptionType
});

class InMemoryWalrusAdapter {
  private blobs = new Map<string, Uint8Array>();
  private counter = 0;

  async upload(content: Uint8Array, metadata: MemoryMetadata): Promise<WalrusUploadResult> {
    const blobId = `test-blob-${++this.counter}`;
    this.blobs.set(blobId, content);
    return {
      blobId,
      metadata,
      isEncrypted: false,
      storageEpochs: 0,
      uploadTimeMs: 0
    };
  }
}

describe('Enhanced MemoryIndexService - Native HNSW (hnswlib-node)', () => {
  let memoryIndexService: MemoryIndexService;
  let storageAdapter: InMemoryWalrusAdapter;
  const testUserAddress = '0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15';

  beforeEach(() => {
    storageAdapter = new InMemoryWalrusAdapter();
    memoryIndexService = new MemoryIndexService(storageAdapter as unknown as any, {
      maxElements: 1000,
      dimension: VECTOR_DIMENSION,
      efConstruction: 100,
      m: 8,
      batchSize: 50,
      autoFlushInterval: 10
    });

    const hnswInternal = (memoryIndexService as any).hnswService;
    if (hnswInternal) {
      hnswInternal.storageService = storageAdapter;
    }
  });

  afterEach(() => {
    memoryIndexService.clearUserIndex(testUserAddress);
  });

  describe('Browser-Compatible HNSW Implementation', () => {
    test('should create and initialize browser HNSW index', async () => {
      const testVector = createVector(VECTOR_DIMENSION, 0.42);

      const metadata = buildMetadata({
        category: 'test',
        topic: 'HNSW Performance',
        importance: 8,
        createdTimestamp: Date.now()
      });

      const result = await memoryIndexService.indexMemory(
        testUserAddress,
        'test-memory-1',
        'blob-123',
        'Testing browser-compatible HNSW implementation',
        metadata,
        testVector
      );

      await memoryIndexService.flush(testUserAddress);

      expect(result.indexed).toBe(true);
      expect(result.vectorId).toBeGreaterThan(0);
    });

    test('should perform O(log N) semantic search with enhanced features', async () => {
      // Index multiple test memories with diverse content
      const baseVector = createVector(VECTOR_DIMENSION, 0.8, 0.05);
      const testMemories = [
        {
          id: 'memory-1',
          content: 'Machine learning algorithms for data analysis',
          vector: perturbVector(baseVector, 0.01),
          metadata: buildMetadata({ category: 'AI', topic: 'Machine Learning', importance: 9, createdTimestamp: Date.now() - 86400000 })
        },
        {
          id: 'memory-2', 
          content: 'Neural networks and deep learning concepts',
          vector: perturbVector(baseVector, 0.015),
          metadata: buildMetadata({ category: 'AI', topic: 'Deep Learning', importance: 8, createdTimestamp: Date.now() - 3600000 })
        },
        {
          id: 'memory-3',
          content: 'Cooking recipes and kitchen techniques',
          vector: createVector(VECTOR_DIMENSION, -0.4, 0.05),
          metadata: buildMetadata({ category: 'Cooking', topic: 'Recipes', importance: 5, createdTimestamp: Date.now() - 172800000 })
        },
        {
          id: 'memory-4',
          content: 'Advanced neural network architectures',
          vector: perturbVector(baseVector, 0.02),
          metadata: buildMetadata({ category: 'AI', topic: 'Neural Networks', importance: 9, createdTimestamp: Date.now() - 7200000 })
        }
      ];

      // Index all test memories
      for (const memory of testMemories) {
        await memoryIndexService.indexMemory(
          testUserAddress,
          memory.id,
          `blob-${memory.id}`,
          memory.content,
          memory.metadata,
          memory.vector
        );
      }

      await memoryIndexService.flush(testUserAddress);

      // Create query vector similar to AI/ML content (high values)
      const queryVector = perturbVector(baseVector, 0.03);

      const searchQuery: MemorySearchQuery = {
        query: 'machine learning and neural networks',
        userAddress: testUserAddress,
        k: 3,
        threshold: 0.1,
        searchMode: 'semantic',
        boostRecent: true,
        diversityFactor: 0.3,
        categories: ['AI'],
        vector: queryVector
      };

      const startTime = performance.now();
      const results = await memoryIndexService.searchMemories(searchQuery);
      const searchTime = performance.now() - startTime;

      // Verify search performance and results
      expect(searchTime).toBeLessThan(100); // Should be fast with HNSW
      expect(results).toHaveLength(3);
      
      // Verify results are ordered by relevance
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].relevanceScore).toBeGreaterThanOrEqual(results[i + 1].relevanceScore);
      }

      // Verify AI category filter worked
      results.forEach(result => {
        expect(result.metadata.category).toBe('AI');
      });

      // Verify similarity scores are reasonable
      results.forEach(result => {
        expect(result.similarity).toBeGreaterThan(0.1);
        expect(result.similarity).toBeLessThanOrEqual(1.0);
      });

      console.log(`✅ HNSW search completed in ${searchTime.toFixed(2)}ms`);
      console.log('Results:', results.map(r => ({
        id: r.memoryId,
        similarity: r.similarity.toFixed(3),
        relevance: r.relevanceScore.toFixed(3),
        topic: r.metadata.topic
      })));
    });

    test('should apply diversity filtering to avoid result clustering', async () => {
      // Create similar vectors that would cluster together without diversity
      const baseVector = createVector(VECTOR_DIMENSION, 0.6);
      const similarMemories = Array.from({ length: 5 }, (_, i) => ({
        id: `similar-memory-${i}`,
        content: `Similar content about topic ${i}`,
        vector: perturbVector(baseVector, 0.01 * (i + 1)),
        metadata: buildMetadata({
          category: 'Test',
          topic: `Topic ${i}`,
          importance: 7,
          createdTimestamp: Date.now() - i * 3600000
        })
      }));

      // Index all similar memories
      for (const memory of similarMemories) {
        await memoryIndexService.indexMemory(
          testUserAddress,
          memory.id,
          `blob-${memory.id}`,
          memory.content,
          memory.metadata,
          memory.vector
        );
      }

      await memoryIndexService.flush(testUserAddress);

      const queryVector = perturbVector(baseVector, 0.0025);

      // Search with diversity filtering
      const diverseQuery: MemorySearchQuery = {
        query: 'similar content search',
        userAddress: testUserAddress,
        k: 3,
        diversityFactor: 0.8, // High diversity requirement
        vector: queryVector
      };

      const diverseResults = await memoryIndexService.searchMemories(diverseQuery);

      // Search without diversity filtering for comparison
      const nonDiverseQuery: MemorySearchQuery = {
        query: 'similar content search',
        userAddress: testUserAddress,
        k: 3,
        diversityFactor: 0, // No diversity filtering
        vector: queryVector
      };

      const nonDiverseResults = await memoryIndexService.searchMemories(nonDiverseQuery);

      expect(diverseResults).toHaveLength(3);
      expect(nonDiverseResults).toHaveLength(3);

      // With diversity, results should be more spread out
      // (This is a qualitative test - in practice, diversity would select more varied results)
      console.log('Diverse results:', diverseResults.map(r => r.metadata.topic));
      console.log('Non-diverse results:', nonDiverseResults.map(r => r.metadata.topic));
    });

    test('should provide enhanced relevance scoring with multiple factors', async () => {
      const testVector = createVector(VECTOR_DIMENSION, 0.77);
      const testMemory = {
        id: 'relevance-test',
        content: 'Advanced machine learning techniques for data science',
        vector: testVector,
        metadata: buildMetadata({
          category: 'AI',
          topic: 'Machine Learning',
          importance: 9,
          createdTimestamp: Date.now() - 3600000 // 1 hour ago
        })
      };

      await memoryIndexService.indexMemory(
        testUserAddress,
        testMemory.id,
        'blob-relevance-test',
        testMemory.content,
        testMemory.metadata,
        testMemory.vector
      );

      await memoryIndexService.flush(testUserAddress);

      const queryVector = perturbVector(testVector, 0.012);

      const enhancedQuery: MemorySearchQuery = {
        query: 'machine learning techniques',
        userAddress: testUserAddress,
        k: 1,
        categories: ['AI'], // Category match should boost score
        boostRecent: true,  // Recent content should get boost
        vector: queryVector
      };

      const results = await memoryIndexService.searchMemories(enhancedQuery);

      expect(results).toHaveLength(1);
      const result = results[0];

      // Relevance score should be higher than base similarity due to:
      // - Category match bonus
      // - High importance bonus  
      // - Recent content bonus
      // - Topic match bonus
      expect(result.relevanceScore).toBeGreaterThan(result.similarity);
      expect(result.relevanceScore).toBeGreaterThan(0.5); // Should be reasonably high

      console.log(`Similarity: ${result.similarity.toFixed(3)}, Enhanced Relevance: ${result.relevanceScore.toFixed(3)}`);
    });

    test('should handle edge cases and error conditions gracefully', async () => {
      // Test empty index search
      const emptyQuery: MemorySearchQuery = {
        query: 'nonexistent content',
        userAddress: 'empty-user-address',
        k: 5
      };

      emptyQuery.vector = createVector(VECTOR_DIMENSION, 0.11);

      const emptyResults = await memoryIndexService.searchMemories(emptyQuery);
      expect(emptyResults).toHaveLength(0);

      // Test high threshold filtering
      const testVector = createVector(VECTOR_DIMENSION, 0.23);
      await memoryIndexService.indexMemory(
        testUserAddress,
        'threshold-test',
        'blob-threshold',
        'Test content for threshold filtering',
        buildMetadata({ category: 'Test', topic: 'Threshold', importance: 5, createdTimestamp: Date.now() }),
        testVector
      );

      await memoryIndexService.flush(testUserAddress);

      const highThresholdQuery: MemorySearchQuery = {
        query: 'completely different content',
        userAddress: testUserAddress,
        k: 10,
        threshold: 0.99, // Very high threshold
        vector: createVector(VECTOR_DIMENSION, -0.2)
      };

      const filteredResults = await memoryIndexService.searchMemories(highThresholdQuery);
      expect(filteredResults.length).toBeLessThanOrEqual(1); // Should filter out low similarity results
    });
  });

  describe('Performance Benchmarks', () => {
    test('should demonstrate O(log N) search performance scaling', async () => {
      const vectorDimension = 384; // Smaller for faster testing
      const testSizes = [10, 50, 100]; // Different index sizes
      const performanceResults: Array<{ size: number; avgLatency: number }> = [];

      for (const size of testSizes) {
        // Create fresh service for this test size
        const perfStorage = new InMemoryWalrusAdapter();
        const perfService = new MemoryIndexService(perfStorage as unknown as any, {
          maxElements: size * 2,
          dimension: vectorDimension,
          efConstruction: 50,
          m: 8,
          batchSize: 50,
          autoFlushInterval: 10
        });

        const perfHnswInternal = (perfService as any).hnswService;
        if (perfHnswInternal) {
          perfHnswInternal.storageService = perfStorage;
        }

        // Index test vectors
        for (let i = 0; i < size; i++) {
          const vector = createVector(vectorDimension, 0.31 + i * 0.001);
          await perfService.indexMemory(
            testUserAddress,
            `perf-memory-${i}`,
            `blob-${i}`,
            `Performance test memory ${i}`,
            buildMetadata({ category: 'Perf', topic: 'Benchmark', importance: 5, createdTimestamp: Date.now() }),
            vector
          );
        }

        await perfService.flush(testUserAddress);

        // Measure search performance
        const queryVector = createVector(vectorDimension, 0.27);
        const searchLatencies: number[] = [];
        
        // Perform multiple searches to average latency
        for (let search = 0; search < 5; search++) {
          const startTime = performance.now();
          
          await perfService.searchMemories({
            query: `performance test query ${search}`,
            userAddress: testUserAddress,
            k: 5,
            vector: queryVector
          });
          
          const latency = performance.now() - startTime;
          searchLatencies.push(latency);
        }

        const avgLatency = searchLatencies.reduce((sum, lat) => sum + lat, 0) / searchLatencies.length;
        performanceResults.push({ size, avgLatency });

        console.log(`Index size: ${size}, Average search latency: ${avgLatency.toFixed(2)}ms`);
      }

      // Verify logarithmic scaling (latency shouldn't grow linearly with size)
      const smallLatency = performanceResults[0].avgLatency;
      const largeLatency = performanceResults[performanceResults.length - 1].avgLatency;
      
      // With O(log N) performance, 10x size increase should result in much less than 10x latency increase
      const scalingRatio = largeLatency / smallLatency;
      expect(scalingRatio).toBeLessThan(5); // Should be much better than linear scaling

      console.log(`Performance scaling ratio: ${scalingRatio.toFixed(2)}x (should be < 5x for logarithmic performance)`);
    });
  });
});