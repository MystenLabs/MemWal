/**
 * Tests for PDWVectorStore LangChain adapter
 */

import { PDWVectorStore } from '../../src/langchain/PDWVectorStore';
import { PDWEmbeddings } from '../../src/langchain/PDWEmbeddings';
import { Document } from '@langchain/core/documents';

describe('PDWVectorStore', () => {
  const mockApiKey = 'test-api-key';
  const mockConfig = {
    userAddress: '0x1234567890abcdef1234567890abcdef12345678',
    packageId: '0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde',
    accessRegistryId: '0x1d0a1936e170e54ff12ef30a042b390a8ef6dae0febcdd62c970a87eebed8659',
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    geminiApiKey: mockApiKey,
  };

  describe('constructor', () => {
    it('should create instance with valid config', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      const vectorStore = new PDWVectorStore(embeddings, mockConfig);

      expect(vectorStore).toBeInstanceOf(PDWVectorStore);
    });

    it('should have correct vectorstore type', () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      const vectorStore = new PDWVectorStore(embeddings, mockConfig);

      expect(vectorStore._vectorstoreType()).toBe('pdw');
    });
  });

  describe('methods', () => {
    let vectorStore: PDWVectorStore;

    beforeEach(() => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      vectorStore = new PDWVectorStore(embeddings, mockConfig);
    });

    it('should have addDocuments method', () => {
      expect(typeof vectorStore.addDocuments).toBe('function');
    });

    it('should have similaritySearch method', () => {
      expect(typeof vectorStore.similaritySearch).toBe('function');
    });

    it('should have similaritySearchWithScore method', () => {
      expect(typeof vectorStore.similaritySearchWithScore).toBe('function');
    });

    it('should have similaritySearchVectorWithScore method', () => {
      expect(typeof vectorStore.similaritySearchVectorWithScore).toBe('function');
    });

    it('should have maxMarginalRelevanceSearch method', () => {
      expect(typeof vectorStore.maxMarginalRelevanceSearch).toBe('function');
    });

    it('should have delete method', () => {
      expect(typeof vectorStore.delete).toBe('function');
    });

    it('should have getStats method', () => {
      expect(typeof vectorStore.getStats).toBe('function');
    });

    it('should have clear method', () => {
      expect(typeof vectorStore.clear).toBe('function');
    });

    it('should have asRetriever method', () => {
      expect(typeof vectorStore.asRetriever).toBe('function');
    });
  });

  describe('addDocuments', () => {
    it('should throw error without wallet options', async () => {
      const embeddings = new PDWEmbeddings({ geminiApiKey: mockApiKey });
      const vectorStore = new PDWVectorStore(embeddings, mockConfig);

      const documents = [
        new Document({ pageContent: 'test', metadata: {} })
      ];

      await expect(vectorStore.addDocuments(documents)).rejects.toThrow(
        'requires options with wallet signing'
      );
    });
  });

  describe('factory methods', () => {
    it('should have static fromDocuments method', () => {
      expect(typeof PDWVectorStore.fromDocuments).toBe('function');
    });

    it('should have static fromTexts method', () => {
      expect(typeof PDWVectorStore.fromTexts).toBe('function');
    });
  });

  // Note: Integration tests would require real API key, wallet, and blockchain
  // Those should be in separate integration test suite
});
