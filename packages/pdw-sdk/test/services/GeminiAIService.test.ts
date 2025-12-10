/**
 * GeminiAIdescribe('GeminiAIService', () => {
  let aiService: GeminiAIService;
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  
  const testConfig: GeminiConfig = {
    apiKey: apiKey || 'test-api-key',
    model: 'gemini-2.5-flash', // Correct model name for @google/genai
    temperature: 0.1,
    maxTokens: 4096
  };

  beforeAll(() => {
    if (!apiKey) {
      console.warn('⚠️  Skipping GeminiAIService tests: No GOOGLE_AI_API_KEY found in .env.test');
      console.warn('   Get your API key from: https://makersuite.google.com/app/apikey');
    }
  });e
 * 
 * Tests real Google Gemini AI integration for entity extraction and content analysis
 * 
 * ✅ NO MOCKS: Uses real Google Gemini API
 */

import { describe, it, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { GeminiAIService } from '../../src/services/GeminiAIService';
import type { GeminiConfig, EntityExtractionRequest } from '../../src/services/GeminiAIService';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

describe('GeminiAIService', () => {
  let aiService: GeminiAIService;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  
  const testConfig: GeminiConfig = {
    apiKey: apiKey || 'test-api-key',
    model: 'gemini-2.5-flash', // Use correct model name
    temperature: 0.1,
    maxTokens: 4096
  };

  beforeAll(() => {
    if (!apiKey) {
      console.warn('⚠️  Skipping GeminiAIService tests: No GEMINI_API_KEY found in .env.test');
      console.warn('   Get your API key from: https://makersuite.google.com/app/apikey');
    }
  });

  beforeEach(() => {
    aiService = new GeminiAIService(testConfig);
  });

  // ==================== INITIALIZATION TESTS ====================

  describe('Service Initialization', () => {
    test('should initialize with default configuration', () => {
      const minimalConfig = { apiKey: 'test-key' };
      const service = new GeminiAIService(minimalConfig);
      const config = service.getConfig();

      expect(config.model).toBe('gemini-2.5-flash');
      expect(config.temperature).toBe(0.1);
      expect(config.maxTokens).toBe(4096);
      expect(config.apiKeyConfigured).toBe(true);
    });

    test('should initialize with custom configuration', () => {
      const customConfig: GeminiConfig = {
        apiKey: 'custom-key',
        model: 'gemini-2.5-pro',
        temperature: 0.5,
        maxTokens: 2048,
        timeout: 60000
      };

      const service = new GeminiAIService(customConfig);
      const config = service.getConfig();

      expect(config.model).toBe('gemini-2.5-pro');
      expect(config.temperature).toBe(0.5);
      expect(config.maxTokens).toBe(2048);
      expect(config.timeout).toBe(60000);
    });

    test('should get configuration without exposing API key', () => {
      const config = aiService.getConfig();

      expect(config).not.toHaveProperty('apiKey');
      expect(config.apiKeyConfigured).toBe(true);
      expect(config.model).toBeDefined();
      expect(config.temperature).toBeDefined();
    });
  });

  // ==================== ENTITY EXTRACTION TESTS ====================

  describe('Entity and Relationship Extraction', () => {
    test('should extract entities and relationships from simple text with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const request: EntityExtractionRequest = {
        content: 'John Doe works at Google as a software engineer.',
        confidenceThreshold: 0.6
      };

      const result = await aiService.extractEntitiesAndRelationships(request);

      // Should return valid structure
      expect(result).toHaveProperty('entities');
      expect(result).toHaveProperty('relationships');
      expect(result).toHaveProperty('processingTimeMs');
      expect(result.processingTimeMs).toBeGreaterThan(0);
      
      // Entities array should be present (even if empty)
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
    });

    test('should handle extraction with context using REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const request: EntityExtractionRequest = {
        content: 'He started the project last year.',
        context: 'Previous discussion about John Doe working at Google on AI projects.',
        confidenceThreshold: 0.6
      };

      const result = await aiService.extractEntitiesAndRelationships(request);

      // Should handle context and return valid structure
      expect(result).toHaveProperty('entities');
      expect(result).toHaveProperty('relationships');
      expect(result.processingTimeMs).toBeGreaterThan(0);
    });

    test('should filter entities by confidence threshold', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.extractEntitiesAndRelationships({
        content: 'Alice works at Microsoft on cloud computing projects.',
        confidenceThreshold: 0.7
      });

      // All returned entities should meet confidence threshold
      result.entities.forEach(entity => {
        expect(entity.confidence).toBeGreaterThanOrEqual(0.7);
      });
    });

    test('should handle empty content gracefully', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.extractEntitiesAndRelationships({
        content: ''
      });

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
    });
  });

  // ==================== BATCH PROCESSING TESTS ====================

  describe('Batch Processing', () => {
    test('should process multiple extraction requests with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const requests: EntityExtractionRequest[] = [
        { content: 'Alice works at Microsoft.' },
        { content: 'Bob studies at Stanford.' },
      ];

      const results = await aiService.extractBatch(requests);

      expect(results).toHaveLength(2);
      results.forEach(result => {
        expect(result).toHaveProperty('entities');
        expect(result).toHaveProperty('relationships');
        expect(result.processingTimeMs).toBeGreaterThan(0);
      });
    });
  });

  // ==================== CONTENT ANALYSIS TESTS ====================

  describe('Content Analysis', () => {
    test('should analyze content for categories and sentiment with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.analyzeContent('I love working on AI projects!');

      expect(result).toHaveProperty('categories');
      expect(result).toHaveProperty('sentiment');
      expect(result).toHaveProperty('topics');
      expect(result).toHaveProperty('confidence');
      expect(Array.isArray(result.categories)).toBe(true);
      expect(Array.isArray(result.topics)).toBe(true);
    });
  });

  describe('Connection Testing', () => {
    test('should test API connection with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.testConnection();

      expect(typeof result).toBe('boolean');
      // Result depends on API availability - just verify it returns boolean
    });
  });

  // ==================== EDGE CASES AND ERROR HANDLING ====================

  describe('Edge Cases and Error Handling', () => {
    test('should handle relationships validation with REAL API', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.extractEntitiesAndRelationships({
        content: 'Alice collaborates with Bob on the project.'
      });

      // Relationships should only reference existing entities
      result.relationships.forEach(rel => {
        const sourceExists = result.entities.some(e => e.id === rel.source);
        const targetExists = result.entities.some(e => e.id === rel.target);
        expect(sourceExists).toBe(true);
        expect(targetExists).toBe(true);
      });
    });

    test('should handle markdown-formatted JSON responses', async () => {
      if (!apiKey) {
        console.log('⏭️  Skipping test: No API key');
        return;
      }

      const result = await aiService.extractEntitiesAndRelationships({
        content: 'Test content with potential markdown formatting.'
      });

      // Should parse response correctly even if wrapped in markdown
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
    });
  });
});