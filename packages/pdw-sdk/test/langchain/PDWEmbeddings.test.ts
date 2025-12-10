/**
 * Tests for PDWEmbeddings LangChain adapter
 */

import { PDWEmbeddings } from '../../src/langchain/PDWEmbeddings';

describe('PDWEmbeddings', () => {
  const mockApiKey = 'test-api-key';

  describe('constructor', () => {
    it('should create instance with valid API key', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      expect(embeddings).toBeInstanceOf(PDWEmbeddings);
    });

    it('should throw error without API key', () => {
      expect(() => {
        new PDWEmbeddings({ geminiApiKey: '' });
      }).toThrow('geminiApiKey is required');
    });

    it('should use default model and dimensions', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      const info = embeddings.getModelInfo();

      expect(info.model).toBe('text-embedding-004');
      expect(info.dimensions).toBe(768);
      expect(info.provider).toBe('Google Gemini');
    });

    it('should accept custom model and dimensions', () => {
      const embeddings = new PDWEmbeddings({
        geminiApiKey: mockApiKey,
        model: 'custom-model',
        dimensions: 512
      });

      const info = embeddings.getModelInfo();
      expect(info.model).toBe('custom-model');
      expect(info.dimensions).toBe(512);
    });
  });

  describe('getModelInfo', () => {
    it('should return model information', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      const info = embeddings.getModelInfo();

      expect(info).toEqual({
        model: 'text-embedding-004',
        dimensions: 768,
        provider: 'Google Gemini'
      });
    });
  });

  // Note: embedDocuments and embedQuery tests require real API key
  // and would be integration tests. Skipping for unit tests.
  describe('embedDocuments', () => {
    it('should have embedDocuments method', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      expect(typeof embeddings.embedDocuments).toBe('function');
    });
  });

  describe('embedQuery', () => {
    it('should have embedQuery method', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      expect(typeof embeddings.embedQuery).toBe('function');
    });
  });
});
