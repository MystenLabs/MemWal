/**
 * ClassifierService Tests
 * 
 * Comprehensive test suite for content classification functionality
 * 
 * ✅ NO MOCKS: Uses real EmbeddingService with actual Gemini API
 */

import { describe, it, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { ClassifierService } from '../../src/services/ClassifierService';
import { EmbeddingService } from '../../src/services/EmbeddingService';
import type { ClassificationResult, ClassificationOptions } from '../../src/services/ClassifierService';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('ClassifierService', () => {
  let classifierService: ClassifierService;
  let embeddingService: EmbeddingService | undefined;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;

  beforeAll(() => {
    // Skip tests if no API key is available
    if (!apiKey) {
      console.warn('⚠️  Skipping ClassifierService tests: No GEMINI_API_KEY found in .env.test');
      console.warn('   Get your API key from: https://makersuite.google.com/app/apikey');
    }
  });

  beforeEach(() => {
    if (!apiKey) {
      // Create classifier without embedding service for pattern-only tests
      classifierService = new ClassifierService(
        undefined, // client
        undefined, // config
        undefined, // embeddingService
        undefined  // apiKey
      );
      return;
    }

    // Create REAL embedding service with actual Gemini API
    embeddingService = new EmbeddingService({
      apiKey,
      model: 'text-embedding-004',
      dimensions: 768
    });

    classifierService = new ClassifierService(
      undefined, // client
      undefined, // config
      embeddingService,
      apiKey
    );
  });

  describe('Pattern Matching Tests', () => {
    test('should detect personal information patterns', async () => {
      const testCases = [
        { text: 'My name is John Doe', expectedCategory: 'personal_info', shouldSave: true },
        { text: 'My email is john@example.com', expectedCategory: 'contact', shouldSave: true },
        { text: 'I work at Google', expectedCategory: 'career', shouldSave: true },
        { text: 'I live in San Francisco', expectedCategory: 'location', shouldSave: true },
        { text: 'I am from New York', expectedCategory: 'background', shouldSave: true },
      ];

      for (const testCase of testCases) {
        const result = await classifierService.shouldSaveMemory(testCase.text, { useAI: false });
        
        expect(result.shouldSave).toBe(testCase.shouldSave);
        expect(result.category).toBe(testCase.expectedCategory);
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
        expect(result.reasoning).toContain('Matched pattern');
      }
    });

    test('should detect preference patterns', async () => {
      const testCases = [
        { text: 'I love pizza', expectedCategory: 'preference', shouldSave: true },
        { text: 'I like coffee', expectedCategory: 'preference', shouldSave: true },
        { text: 'I enjoy hiking', expectedCategory: 'preference', shouldSave: true },
        { text: 'I prefer tea over coffee', expectedCategory: 'preference', shouldSave: true },
        { text: 'I hate broccoli', expectedCategory: 'preference', shouldSave: true },
        { text: 'I dislike cold weather', expectedCategory: 'preference', shouldSave: true },
        { text: "I don't like spicy food", expectedCategory: 'preference', shouldSave: true },
        { text: 'My favorite color is blue', expectedCategory: 'preference', shouldSave: true },
      ];

      for (const testCase of testCases) {
        const result = await classifierService.shouldSaveMemory(testCase.text, { useAI: false });
        
        expect(result.shouldSave).toBe(testCase.shouldSave);
        expect(result.category).toBe(testCase.expectedCategory);
        expect(result.confidence).toBeGreaterThan(0.7);
      }
    });

    test('should detect explicit memory requests', async () => {
      const testCases = [
        { text: 'Remember that I have a meeting tomorrow', expectedCategory: 'custom', shouldSave: true },
        { text: "Don't forget that I'm allergic to peanuts", expectedCategory: 'custom', shouldSave: true },
        { text: 'Please remember my anniversary is next week', expectedCategory: 'custom', shouldSave: true },
      ];

      for (const testCase of testCases) {
        const result = await classifierService.shouldSaveMemory(testCase.text, { useAI: false });
        
        expect(result.shouldSave).toBe(testCase.shouldSave);
        expect(result.category).toBe(testCase.expectedCategory);
        expect(result.confidence).toBeGreaterThanOrEqual(0.85); // High confidence for explicit requests
      }
    });

    test('should detect education and career patterns', async () => {
      const testCases = [
        { text: 'I studied computer science', expectedCategory: 'education', shouldSave: true },
        { text: 'I graduated from MIT', expectedCategory: 'education', shouldSave: true },
        { text: 'I have a PhD in physics', expectedCategory: 'personal_info', shouldSave: true },
        { text: 'I own a Tesla', expectedCategory: 'personal_info', shouldSave: true },
      ];

      for (const testCase of testCases) {
        const result = await classifierService.shouldSaveMemory(testCase.text, { useAI: false });
        
        expect(result.shouldSave).toBe(testCase.shouldSave);
        expect(result.category).toBe(testCase.expectedCategory);
        expect(result.confidence).toBeGreaterThan(0.7);
      }
    });

    test('should not save general conversation', async () => {
      const testCases = [
        'Hello, how are you?',
        'What time is it?',
        'The weather is nice today',
        'Can you help me with this?',
        'Thanks for your help',
      ];

      for (const text of testCases) {
        const result = await classifierService.shouldSaveMemory(text, { useAI: false });
        
        expect(result.shouldSave).toBe(false);
        expect(result.confidence).toBeLessThan(0.6);
        expect(result.category).toBe('general');
      }
    });
  });

  describe('Confidence Scoring Tests', () => {
    test('should assign higher confidence to explicit statements', async () => {
      const explicitText = 'My name is Alice Johnson';
      const implicitText = 'I am Alice'; // Less explicit

      const explicitResult = await classifierService.shouldSaveMemory(explicitText, { useAI: false });
      const implicitResult = await classifierService.shouldSaveMemory(implicitText, { useAI: false });

      expect(explicitResult.confidence).toBeGreaterThan(implicitResult.confidence);
      expect(explicitResult.confidence).toBeGreaterThan(0.9);
    });

    test('should respect confidence threshold', async () => {
      const text = 'I like music'; // Should match preference pattern with ~0.85 confidence
      
      // High threshold - should not save (set higher than actual confidence)
      const highThresholdResult = await classifierService.shouldSaveMemory(text, { 
        useAI: false, 
        confidenceThreshold: 0.9 // Higher than expected 0.85
      });
      
      // Low threshold - should save
      const lowThresholdResult = await classifierService.shouldSaveMemory(text, { 
        useAI: false, 
        confidenceThreshold: 0.7 
      });

      expect(highThresholdResult.shouldSave).toBe(false);
      expect(lowThresholdResult.shouldSave).toBe(true);
    });
  });

  describe('Category Classification Tests', () => {
    test('should classify content into correct categories', async () => {
      const testCases = [
        { text: 'My email is test@example.com', expected: 'contact' },
        { text: 'I work at Microsoft', expected: 'career' },
        { text: 'I love chocolate', expected: 'preference' },
        { text: 'I studied at Harvard', expected: 'education' },
        { text: 'I am from Canada', expected: 'background' },
        { text: 'Remember that I need to call mom', expected: 'custom' },
      ];

      for (const testCase of testCases) {
        const category = await classifierService.classifyContent(testCase.text, { useAI: false });
        expect(category).toBe(testCase.expected);
      }
    });
  });

  describe('Pattern Analysis Tests', () => {
    test('should analyze patterns in text correctly', async () => {
      const text = 'My name is John and I love pizza. I work at Google and I enjoy hiking.';
      
      const analysis = await classifierService.analyzePatterns(text);
      
      expect(analysis.patterns).toHaveLength(4); // Should find 4 patterns
      expect(analysis.categories).toContain('personal_info');
      expect(analysis.categories).toContain('preference');
      expect(analysis.categories).toContain('career');
      expect(analysis.matches).toHaveLength(4);
      
      // Check that matches have required properties
      analysis.matches.forEach(match => {
        expect(match).toHaveProperty('pattern');
        expect(match).toHaveProperty('match');
        expect(match).toHaveProperty('category');
        expect(match).toHaveProperty('confidence');
        expect(match.confidence).toBeGreaterThan(0);
      });
    });

    test('should handle text with no patterns', async () => {
      const text = 'Hello, how are you today? The weather is nice.';
      
      const analysis = await classifierService.analyzePatterns(text);
      
      expect(analysis.patterns).toHaveLength(0);
      expect(analysis.categories).toHaveLength(0);
      expect(analysis.matches).toHaveLength(0);
    });
  });

  describe('AI Integration Tests', () => {
    test('should use real embedding-based classification when API key available', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const text = 'I really enjoy exploring new technologies and building innovative solutions';
      const result = await classifierService.shouldSaveMemory(text, { useAI: true });

      // Should get result from real embedding-based classification
      expect(result).toHaveProperty('shouldSave');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('category');
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('should fall back to pattern matching when useAI is false', async () => {
      const text = 'I love ice cream'; // Should match preference pattern
      const result = await classifierService.shouldSaveMemory(text, { useAI: false });

      expect(result.shouldSave).toBe(true);
      expect(result.category).toBe('preference');
      expect(result.reasoning).toContain('Matched pattern');
    });
  });

  describe('Custom Options Tests', () => {
    test('should use custom patterns when provided', async () => {
      const customPatterns = [
        /I coded ([^.!?]+)/i,
        /I built ([^.!?]+)/i,
      ];

      const text = 'I coded a web application yesterday';
      const result = await classifierService.shouldSaveMemory(text, { 
        useAI: false, 
        patterns: customPatterns 
      });

      expect(result.shouldSave).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.reasoning).toContain('Matched pattern');
    });

    test('should handle empty custom patterns', async () => {
      const text = 'I love programming';
      const result = await classifierService.shouldSaveMemory(text, { 
        useAI: false, 
        patterns: [] 
      });

      expect(result.shouldSave).toBe(false);
      expect(result.category).toBe('general');
    });
  });

  describe('Error Handling Tests', () => {
    test('should handle classification errors gracefully', async () => {
      // Create a service without embedding service
      const faultyService = new ClassifierService();
      
      const result = await faultyService.shouldSaveMemory('test text');

      expect(result.shouldSave).toBe(false);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.category).toBe('general');
      expect(result.reasoning).toContain('No significant patterns');
    });

    test('should handle malformed input gracefully', async () => {
      const testCases = ['', '   ', '\n\t', null as any, undefined as any];

      for (const testCase of testCases) {
        const result = await classifierService.shouldSaveMemory(testCase, { useAI: false });
        
        // Should not crash and should return a valid result
        expect(result).toHaveProperty('shouldSave');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('category');
        expect(result).toHaveProperty('reasoning');
      }
    });
  });

  describe('Performance Tests', () => {
    test('should process classification quickly', async () => {
      const text = 'I love coffee and I work at a tech company';
      const startTime = Date.now();
      
      const result = await classifierService.shouldSaveMemory(text, { useAI: false });
      
      const processingTime = Date.now() - startTime;
      expect(processingTime).toBeLessThan(100); // Should be very fast for pattern matching
      expect(result.shouldSave).toBe(true);
    });

    test('should handle large text input', async () => {
      const largeText = 'I love pizza. '.repeat(1000) + 'I work at Google.';
      
      const result = await classifierService.shouldSaveMemory(largeText, { useAI: false });
      
      expect(result.shouldSave).toBe(true);
      expect(['preference', 'career']).toContain(result.category); // Could find either pattern first
    });
  });
});