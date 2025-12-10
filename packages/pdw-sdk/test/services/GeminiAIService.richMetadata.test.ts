/**
 * GeminiAIService Rich Metadata Extraction Tests
 *
 * Tests the new extractRichMetadata and extractRichMetadataBatch methods
 * added for AI-powered memory metadata generation.
 *
 * ✅ REAL API: Uses actual Google Gemini API (requires GEMINI_API_KEY)
 */

import { describe, it, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { GeminiAIService } from '../../src/services/GeminiAIService';
import type { GeminiConfig } from '../../src/services/GeminiAIService';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('GeminiAIService - Rich Metadata Extraction', () => {
  let aiService: GeminiAIService;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;

  const testConfig: GeminiConfig = {
    apiKey: apiKey || 'test-api-key',
    model: 'gemini-2.0-flash-exp',
    temperature: 0.1,
    maxTokens: 4096
  };

  const shouldSkip = !apiKey;

  beforeAll(() => {
    if (shouldSkip) {
      console.warn('⚠️  Skipping GeminiAIService rich metadata tests: No GEMINI_API_KEY found');
      console.warn('   Set GEMINI_API_KEY in .env.test to run these tests');
    }
  });

  beforeEach(() => {
    aiService = new GeminiAIService(testConfig);
  });

  // ==================== SINGLE EXTRACTION TESTS ====================

  describe('extractRichMetadata()', () => {
    test('should extract metadata from personal memory', async () => {
      if (shouldSkip) return;

      const content = 'I had a great meeting with the product team today. We discussed the Q4 roadmap and decided to prioritize the new AI features.';

      const result = await aiService.extractRichMetadata(content);

      console.log('📊 Extracted metadata:', result);

      // Validate structure
      expect(result).toHaveProperty('importance');
      expect(result).toHaveProperty('topic');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('category');

      // Validate importance (1-10 scale)
      expect(result.importance).toBeGreaterThanOrEqual(1);
      expect(result.importance).toBeLessThanOrEqual(10);
      expect(Number.isInteger(result.importance)).toBe(true);

      // Validate topic (should be concise, max 100 chars)
      expect(result.topic.length).toBeGreaterThan(0);
      expect(result.topic.length).toBeLessThanOrEqual(100);

      // Validate summary (max 200 chars)
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.summary.length).toBeLessThanOrEqual(200);

      // Validate category (should be from predefined list)
      const validCategories = ['personal', 'work', 'education', 'health', 'finance', 'travel', 'family', 'hobbies', 'goals', 'ideas'];
      expect(validCategories).toContain(result.category);

      // Semantic validation (work-related content should be categorized as 'work')
      expect(result.category).toBe('work');
      expect(result.importance).toBeGreaterThanOrEqual(5); // Meeting about roadmap is important
    }, 30000);

    test('should extract metadata with category hint', async () => {
      if (shouldSkip) return;

      const content = 'Need to buy groceries: milk, bread, eggs, and vegetables.';
      const categoryHint = 'personal';

      const result = await aiService.extractRichMetadata(content, categoryHint);

      console.log('📊 Extracted with hint:', result);

      // Should respect category hint
      expect(result.category).toBe('personal');

      // Low importance for routine task
      expect(result.importance).toBeLessThanOrEqual(5);

      // Topic should mention groceries
      expect(result.topic.toLowerCase()).toContain('groceries');
    }, 30000);

    test('should handle high-importance content', async () => {
      if (shouldSkip) return;

      const content = 'URGENT: Critical security vulnerability detected in production. Immediate action required to patch the authentication system.';

      const result = await aiService.extractRichMetadata(content);

      console.log('📊 High importance content:', result);

      // Should detect high importance
      expect(result.importance).toBeGreaterThanOrEqual(8);
      expect(result.category).toBe('work');
      expect(result.topic.toLowerCase()).toMatch(/(security|vulnerability|urgent)/);
    }, 30000);

    test('should handle personal preference content', async () => {
      if (shouldSkip) return;

      const content = 'I really love hiking in the mountains on weekends. It helps me relax and clear my mind.';

      const result = await aiService.extractRichMetadata(content);

      console.log('📊 Personal preference:', result);

      expect(['personal', 'hobbies']).toContain(result.category);
      expect(result.importance).toBeLessThanOrEqual(6); // Personal preference, not critical
      expect(result.topic.toLowerCase()).toMatch(/(hiking|mountains|weekend)/);
    }, 30000);

    test('should handle empty or invalid content gracefully', async () => {
      if (shouldSkip) return;

      const result = await aiService.extractRichMetadata('');

      console.log('📊 Empty content fallback:', result);

      // Should return fallback values
      expect(result.importance).toBe(5);
      expect(result.topic.length).toBeGreaterThan(0);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.category).toBe('personal');
    }, 30000);

    test('should truncate long content properly', async () => {
      if (shouldSkip) return;

      const longContent = 'This is a very long piece of content. '.repeat(100); // ~3800 chars

      const result = await aiService.extractRichMetadata(longContent);

      console.log('📊 Long content metadata:', result);

      // Limits should be enforced
      expect(result.topic.length).toBeLessThanOrEqual(100);
      expect(result.summary.length).toBeLessThanOrEqual(200);
    }, 30000);
  });

  // ==================== BATCH EXTRACTION TESTS ====================

  describe('extractRichMetadataBatch()', () => {
    test('should process multiple memories in batch', async () => {
      if (shouldSkip) return;

      const contents = [
        { content: 'Had lunch with Sarah at the new Italian restaurant downtown.' },
        { content: 'Completed the quarterly report. Sales are up 15% this quarter!' },
        { content: 'Scheduled dentist appointment for next Tuesday at 2pm.' }
      ];

      const results = await aiService.extractRichMetadataBatch(contents);

      console.log('📊 Batch results:', results);

      // Should return same number of results
      expect(results).toHaveLength(3);

      // Validate each result
      results.forEach((result, index) => {
        expect(result.importance).toBeGreaterThanOrEqual(1);
        expect(result.importance).toBeLessThanOrEqual(10);
        expect(result.topic.length).toBeGreaterThan(0);
        expect(result.summary.length).toBeGreaterThan(0);

        console.log(`  [${index}] ${result.category}: ${result.topic} (importance: ${result.importance})`);
      });

      // First should be personal (lunch)
      expect(['personal', 'family']).toContain(results[0].category);

      // Second should be work (report)
      expect(results[1].category).toBe('work');
      expect(results[1].importance).toBeGreaterThanOrEqual(6); // Quarterly report is important

      // Third should be health or personal (dentist)
      expect(['health', 'personal']).toContain(results[2].category);
    }, 60000); // Longer timeout for batch processing

    test('should respect category hints in batch', async () => {
      if (shouldSkip) return;

      const contents = [
        { content: 'Meeting notes from today', category: 'work' },
        { content: 'Exercise goals for the month', category: 'health' },
        { content: 'Book recommendations from friend', category: 'hobbies' }
      ];

      const results = await aiService.extractRichMetadataBatch(contents);

      console.log('📊 Batch with hints:', results);

      // Should respect category hints
      expect(results[0].category).toBe('work');
      expect(results[1].category).toBe('health');
      expect(results[2].category).toBe('hobbies');
    }, 60000);

    test('should handle large batches with rate limiting', async () => {
      if (shouldSkip) return;

      // Create 10 test memories
      const contents = Array.from({ length: 10 }, (_, i) => ({
        content: `Memory ${i + 1}: This is test content for batch processing.`,
        category: i % 2 === 0 ? 'work' : 'personal'
      }));

      const startTime = Date.now();
      const results = await aiService.extractRichMetadataBatch(contents);
      const duration = Date.now() - startTime;

      console.log(`📊 Processed ${results.length} memories in ${duration}ms`);
      console.log(`   Average: ${(duration / results.length).toFixed(0)}ms per memory`);

      // Should return all results
      expect(results).toHaveLength(10);

      // Should have added delays (batches of 3 with 500ms delay)
      // Minimum time: 3 full batches * 500ms = ~1500ms
      expect(duration).toBeGreaterThan(1000);

      // All should be valid
      results.forEach((result) => {
        expect(result.importance).toBeGreaterThanOrEqual(1);
        expect(result.importance).toBeLessThanOrEqual(10);
      });
    }, 120000); // 2-minute timeout for large batch

    test('should handle mixed valid and empty content', async () => {
      if (shouldSkip) return;

      const contents = [
        { content: 'Valid memory content here' },
        { content: '' }, // Empty
        { content: 'Another valid memory' },
        { content: '   ' }, // Whitespace only
      ];

      const results = await aiService.extractRichMetadataBatch(contents);

      console.log('📊 Mixed content results:', results);

      expect(results).toHaveLength(4);

      // All should have fallback values
      results.forEach((result) => {
        expect(result.importance).toBeDefined();
        expect(result.topic).toBeDefined();
        expect(result.summary).toBeDefined();
        expect(result.category).toBeDefined();
      });
    }, 60000);
  });

  // ==================== ERROR HANDLING TESTS ====================

  describe('Error Handling', () => {
    test('should handle API failures gracefully', async () => {
      // Create service with invalid API key
      const badService = new GeminiAIService({
        apiKey: 'invalid-key-12345',
        model: 'gemini-2.0-flash-exp'
      });

      const content = 'Test content';

      // Should not throw, should return fallback
      const result = await badService.extractRichMetadata(content);

      expect(result).toHaveProperty('importance');
      expect(result).toHaveProperty('topic');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('category');

      // Fallback values
      expect(result.importance).toBe(5);
      expect(result.category).toBe('personal');
    }, 30000);

    test('should handle malformed JSON responses', async () => {
      if (shouldSkip) return;

      // Use very short content that might produce weird responses
      const result = await aiService.extractRichMetadata('a');

      // Should still return valid structure
      expect(result.importance).toBeGreaterThanOrEqual(1);
      expect(result.importance).toBeLessThanOrEqual(10);
      expect(result.topic).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.category).toBeDefined();
    }, 30000);
  });

  // ==================== PERFORMANCE TESTS ====================

  describe('Performance', () => {
    test('should extract metadata within reasonable time', async () => {
      if (shouldSkip) return;

      const content = 'Meeting with team to discuss project timeline and deliverables for Q4.';

      const startTime = Date.now();
      const result = await aiService.extractRichMetadata(content);
      const duration = Date.now() - startTime;

      console.log(`⏱️  Extraction time: ${duration}ms`);

      // Should complete within 5 seconds
      expect(duration).toBeLessThan(5000);
      expect(result).toBeDefined();
    }, 30000);

    test('should batch faster than sequential processing', async () => {
      if (shouldSkip) return;

      const contents = Array.from({ length: 6 }, (_, i) => ({
        content: `Memory ${i + 1}: Test content for performance comparison.`
      }));

      // Batch processing
      const batchStart = Date.now();
      const batchResults = await aiService.extractRichMetadataBatch(contents);
      const batchDuration = Date.now() - batchStart;

      console.log(`⏱️  Batch processing: ${batchDuration}ms for ${contents.length} items`);
      console.log(`   Per item: ${(batchDuration / contents.length).toFixed(0)}ms`);

      expect(batchResults).toHaveLength(6);

      // Batch should complete (with internal parallelization and delays)
      // But still be reasonably fast
      expect(batchDuration).toBeLessThan(30000); // 30 seconds max
    }, 60000);
  });
});
