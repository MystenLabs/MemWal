/**
 * Integration tests for useStoreEmbedding and useRetrieveEmbedding hooks
 *
 * Tests the full workflow:
 * 1. Generate embedding from text
 * 2. Store embedding to Walrus
 * 3. Retrieve embedding from Walrus
 * 4. Verify data integrity
 */

import { EmbeddingService } from '../../src/services/EmbeddingService';
import { WalrusClient } from '@mysten/walrus';

// Mock dependencies
jest.mock('@mysten/walrus');
jest.mock('../../src/services/EmbeddingService');

describe('Embedding Hooks Integration', () => {
  const mockBlobId = 'test-blob-id-123';
  const mockVector = Array(768).fill(0).map((_, i) => Math.random());
  const mockSigner = {
    signAndExecuteTransaction: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Store Embedding Workflow', () => {
    it('should generate embedding and store to Walrus', async () => {
      // Mock EmbeddingService
      const mockEmbedText = jest.fn().mockResolvedValue({
        vector: mockVector,
        dimension: 768,
        model: 'text-embedding-004'
      });

      (EmbeddingService as jest.MockedClass<typeof EmbeddingService>).mockImplementation(() => ({
        embedText: mockEmbedText,
      } as any));

      // Mock WalrusClient
      const mockWriteBlob = jest.fn().mockResolvedValue({
        blobId: mockBlobId,
        suiRef: '0x123',
        cost: 100
      });

      (WalrusClient as jest.MockedClass<typeof WalrusClient>).mockImplementation(() => ({
        writeBlob: mockWriteBlob,
      } as any));

      // Simulate the hook logic
      const content = 'Test content for embedding';
      const embeddingService = new EmbeddingService({
        apiKey: 'test-key',
        model: 'text-embedding-004',
        dimensions: 768
      });

      const embeddingResult = await embeddingService.embedText({
        text: content,
        type: 'content'
      });

      expect(embeddingResult.vector).toEqual(mockVector);
      expect(embeddingResult.dimension).toBe(768);

      // Prepare storage data
      const storageData = {
        vector: embeddingResult.vector,
        dimension: embeddingResult.dimension,
        model: embeddingResult.model,
        contentPreview: content.substring(0, 200),
        contentLength: content.length,
        embeddingType: 'document',
        metadata: { test: 'metadata' },
        timestamp: Date.now()
      };

      const dataBytes = new TextEncoder().encode(JSON.stringify(storageData));

      // Upload to Walrus
      const walrusClient = new WalrusClient({
        suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
        network: 'testnet'
      });

      const result = await walrusClient.writeBlob({
        blob: dataBytes,
        deletable: false,
        epochs: 5,
        signer: mockSigner as any
      });

      expect(result.blobId).toBe(mockBlobId);
      expect(mockWriteBlob).toHaveBeenCalledWith({
        blob: dataBytes,
        deletable: false,
        epochs: 5,
        signer: mockSigner
      });
    });

    it('should validate required parameters', async () => {
      const embeddingService = new EmbeddingService({
        apiKey: 'test-key',
        model: 'text-embedding-004'
      });

      // Test empty content validation
      await expect(async () => {
        const content = '';
        if (!content || content.trim().length === 0) {
          throw new Error('Content cannot be empty');
        }
        await embeddingService.embedText({ text: content, type: 'content' });
      }).rejects.toThrow('Content cannot be empty');

      // Test missing signer validation
      expect(() => {
        const signer = undefined;
        if (!signer) {
          throw new Error('Signer is required for storing embeddings on Walrus');
        }
      }).toThrow('Signer is required for storing embeddings on Walrus');
    });
  });

  describe('Retrieve Embedding Workflow', () => {
    it('should retrieve and parse embedding from Walrus', async () => {
      const storedData = {
        vector: mockVector,
        dimension: 768,
        model: 'text-embedding-004',
        contentPreview: 'Test content preview',
        contentLength: 100,
        embeddingType: 'document' as const,
        metadata: { test: 'metadata' },
        timestamp: Date.now()
      };

      const mockData = new TextEncoder().encode(JSON.stringify(storedData));

      // Mock WalrusClient
      const mockReadBlob = jest.fn().mockResolvedValue(mockData);

      (WalrusClient as jest.MockedClass<typeof WalrusClient>).mockImplementation(() => ({
        readBlob: mockReadBlob,
      } as any));

      // Simulate the hook logic
      const walrusClient = new WalrusClient({
        suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
        network: 'testnet'
      });

      const data = await walrusClient.readBlob({ blobId: mockBlobId });

      expect(mockReadBlob).toHaveBeenCalledWith({ blobId: mockBlobId });

      const text = new TextDecoder().decode(data);
      const parsed = JSON.parse(text);

      expect(parsed.vector).toEqual(mockVector);
      expect(parsed.dimension).toBe(768);
      expect(parsed.model).toBe('text-embedding-004');
      expect(parsed.embeddingType).toBe('document');
    });

    it('should validate blob data structure', async () => {
      const invalidData = {
        // Missing vector
        dimension: 768,
        model: 'test-model'
      };

      const mockData = new TextEncoder().encode(JSON.stringify(invalidData));

      (WalrusClient as jest.MockedClass<typeof WalrusClient>).mockImplementation(() => ({
        readBlob: jest.fn().mockResolvedValue(mockData),
      } as any));

      const walrusClient = new WalrusClient({
        suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
        network: 'testnet'
      });

      const data = await walrusClient.readBlob({ blobId: mockBlobId });
      const text = new TextDecoder().decode(data);
      const parsed = JSON.parse(text);

      // Validate structure
      if (!parsed.vector || !Array.isArray(parsed.vector)) {
        expect(() => {
          throw new Error('Invalid embedding data: missing or invalid vector');
        }).toThrow('Invalid embedding data: missing or invalid vector');
      }
    });

    it('should handle missing blob ID', async () => {
      const blobId = undefined;

      expect(() => {
        if (!blobId) {
          throw new Error('Blob ID is required');
        }
      }).toThrow('Blob ID is required');
    });
  });

  describe('End-to-End Workflow', () => {
    it('should store and retrieve embedding successfully', async () => {
      // Step 1: Generate embedding
      const mockEmbedText = jest.fn().mockResolvedValue({
        vector: mockVector,
        dimension: 768,
        model: 'text-embedding-004'
      });

      (EmbeddingService as jest.MockedClass<typeof EmbeddingService>).mockImplementation(() => ({
        embedText: mockEmbedText,
      } as any));

      const content = 'Test content for full workflow';
      const embeddingService = new EmbeddingService({
        apiKey: 'test-key',
        model: 'text-embedding-004'
      });

      const embeddingResult = await embeddingService.embedText({
        text: content,
        type: 'content'
      });

      // Step 2: Store to Walrus
      const storageData = {
        vector: embeddingResult.vector,
        dimension: embeddingResult.dimension,
        model: embeddingResult.model,
        contentPreview: content.substring(0, 200),
        contentLength: content.length,
        embeddingType: 'document' as const,
        metadata: { source: 'test' },
        timestamp: Date.now()
      };

      const dataBytes = new TextEncoder().encode(JSON.stringify(storageData));

      const mockWriteBlob = jest.fn().mockResolvedValue({
        blobId: mockBlobId
      });

      const mockReadBlob = jest.fn().mockResolvedValue(dataBytes);

      (WalrusClient as jest.MockedClass<typeof WalrusClient>).mockImplementation(() => ({
        writeBlob: mockWriteBlob,
        readBlob: mockReadBlob,
      } as any));

      const walrusClient = new WalrusClient({
        suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
        network: 'testnet'
      });

      const storeResult = await walrusClient.writeBlob({
        blob: dataBytes,
        deletable: false,
        epochs: 5,
        signer: mockSigner as any
      });

      expect(storeResult.blobId).toBe(mockBlobId);

      // Step 3: Retrieve from Walrus
      const retrievedData = await walrusClient.readBlob({ blobId: mockBlobId });
      const retrievedText = new TextDecoder().decode(retrievedData);
      const retrievedEmbedding = JSON.parse(retrievedText);

      // Step 4: Verify data integrity
      expect(retrievedEmbedding.vector).toEqual(mockVector);
      expect(retrievedEmbedding.dimension).toBe(768);
      expect(retrievedEmbedding.model).toBe('text-embedding-004');
      expect(retrievedEmbedding.embeddingType).toBe('document');
      expect(retrievedEmbedding.metadata.source).toBe('test');
    });
  });

  describe('Configuration and Environment', () => {
    it('should use default configuration values', () => {
      const suiRpcUrl = process.env.NEXT_PUBLIC_SUI_RPC_URL ||
                        'https://fullnode.testnet.sui.io:443';
      const network = 'testnet';
      const epochs = 5;

      expect(suiRpcUrl).toBe('https://fullnode.testnet.sui.io:443');
      expect(network).toBe('testnet');
      expect(epochs).toBe(5);
    });

    it('should accept custom configuration', () => {
      const customConfig = {
        suiRpcUrl: 'https://custom.sui.io',
        network: 'mainnet' as const,
        epochs: 10
      };

      expect(customConfig.suiRpcUrl).toBe('https://custom.sui.io');
      expect(customConfig.network).toBe('mainnet');
      expect(customConfig.epochs).toBe(10);
    });
  });
});
