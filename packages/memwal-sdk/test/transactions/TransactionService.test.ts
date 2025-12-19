/**
 * TransactionService Integration Tests
 * 
 * Tests transaction building and execution methods for memory and access control operations.
 * Based on established Jest patterns with comprehensive mocking and error handling.
 */

require('dotenv').config({ path: '.env.test' });

const { TransactionService } = require('../../dist/transactions/TransactionService');
const { Transaction } = require('@mysten/sui/transactions');

describe('TransactionService', () => {
  let transactionService: any;
  let mockSuiClient: any;
  let testConfig: any;
  let mockSigner: any;
  const testAddress = '0xc5e67f46e1b99b580da3a6cc69acf187d0c08dbe568f8f5a78959079c9d82a15';
  const testPackageId = '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66';

  // Real Walrus blob IDs from Suiscan testnet account
  const realBlobIds = [
    '0x0e9058ca720598c364352f37d0aa4d2b15961242354f361f3df4f2a020f4b237', // 12b
    '0x0fc3708e2b08c54410ba2d114dc2ad142a11432feaf2e5e468322ec5c3e7ca0f', // 445556b
    '0x15f25a0cc3a7c7cc7034c2fe4cd6f0b8878bccdb77cd2cd129c1c64d3b30a920', // 445556b
    '0x189be71333f2ee345b024f2fb7ffed7e4ad8ff4c99475c8a7b15c8246795ca65', // 445556b
  ];

  beforeAll(async () => {
    // Test configuration
    testConfig = {
      packageId: testPackageId,
      apiUrl: 'https://testnet-api.example.com',
    };

    // Mock SuiClient with comprehensive method stubs
    mockSuiClient = {
      signAndExecuteTransaction: jest.fn(),
      dryRunTransactionBlock: jest.fn(),
    };

    // Mock signer
    mockSigner = {
      signTransaction: jest.fn(),
      getAddress: jest.fn().mockResolvedValue(testAddress),
    };

    // Create service instance
    transactionService = new TransactionService(mockSuiClient, testConfig);
  });

  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('Memory Transaction Building', () => {
    test('should build create memory record transaction', () => {
      const options = {
        category: 'personal',
        vectorId: 123,
        blobId: realBlobIds[0],
        contentType: 'text/plain',
        contentSize: 12,
        contentHash: 'hash123',
        topic: 'test topic',
        importance: 5,
        embeddingBlobId: realBlobIds[1],
        gasBudget: 1000000,
      };

      const tx = transactionService.buildCreateMemoryRecord(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build update memory metadata transaction', () => {
      const options = {
        memoryId: 'memory123',
        metadataBlobId: realBlobIds[2],
        embeddingDimension: 1536,
      };

      const tx = transactionService.buildUpdateMemoryMetadata(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build delete memory record transaction', () => {
      const options = {
        memoryId: 'memory123',
      };

      const tx = transactionService.buildDeleteMemoryRecord(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build create memory index transaction', () => {
      const options = {
        indexBlobId: realBlobIds[0],
        graphBlobId: realBlobIds[1],
      };

      const tx = transactionService.buildCreateMemoryIndex(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build update memory index transaction', () => {
      const options = {
        indexId: 'index123',
        newIndexBlobId: realBlobIds[2],
        newGraphBlobId: realBlobIds[3],
      };

      const tx = transactionService.buildUpdateMemoryIndex(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });
  });

  describe('Access Control Transaction Building', () => {
    test('should build grant access transaction', () => {
      const options = {
        contentId: 'content123',
        recipient: testAddress,
        permissions: 1,
        expirationTime: Date.now() + 86400000,
      };

      const tx = transactionService.buildGrantAccess(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build revoke access transaction', () => {
      const options = {
        contentId: 'content123',
        recipient: testAddress,
      };

      const tx = transactionService.buildRevokeAccess(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });

    test('should build register content transaction', () => {
      const options = {
        contentHash: 'contenthash123',
        encryptionKey: 'enckey123',
        accessPolicy: ['read', 'write'],
      };

      const tx = transactionService.buildRegisterContent(options);

      expect(tx).toBeInstanceOf(Transaction);
      expect(tx).toBeDefined();
    });
  });

  describe('Transaction Execution', () => {
    test('should execute transaction successfully', async () => {
      const mockResult = {
        digest: 'digest123',
        effects: {
          status: { status: 'success' },
          gasUsed: { computationCost: '150000' },
        },
        objectChanges: [
          {
            type: 'created',
            objectId: 'obj123',
            objectType: '0x123::memory::Memory',
          },
        ],
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.status).toBe('success');
      expect(result.digest).toBe('digest123');
      expect(result.gasUsed).toBe(150000);
      expect(result.createdObjects).toHaveLength(1);
    });

    test('should handle failed transaction execution', async () => {
      const mockResult = {
        digest: 'failed123',
        effects: {
          status: { status: 'failure', error: 'Insufficient gas' },
        },
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.status).toBe('failure');
      expect(result.error).toBe('Insufficient gas');
    });

    test('should handle execution error with exception', async () => {
      mockSuiClient.signAndExecuteTransaction.mockRejectedValue(new Error('Network timeout'));

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.status).toBe('failure');
      expect(result.error).toBe('Network timeout');
    });
  });

  describe('Convenience Methods', () => {
    test('should create memory record with convenience method', async () => {
      const mockResult = {
        digest: 'digest123',
        effects: { status: { status: 'success' } },
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const options = {
        category: 'personal',
        vectorId: 123,
        blobId: realBlobIds[0],
        contentType: 'text/plain',
        contentSize: 12,
        contentHash: 'hash123',
        topic: 'test topic',
        importance: 5,
        embeddingBlobId: realBlobIds[1],
      };

      const result = await transactionService.createMemoryRecord(options, mockSigner);

      expect(result.status).toBe('success');
      expect(result.digest).toBe('digest123');
    });

    test('should grant access with convenience method', async () => {
      const mockResult = {
        digest: 'accessdigest',
        effects: { status: { status: 'success' } },
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const options = {
        contentId: 'content123',
        recipient: testAddress,
        permissions: 1,
        expirationTime: Date.now() + 86400000,
      };

      const result = await transactionService.grantAccess(options, mockSigner);

      expect(result.status).toBe('success');
      expect(result.digest).toBe('accessdigest');
    });
  });

  describe('Utility Methods', () => {
    test('should get recommended gas budget for single operation', () => {
      const gasBudget = transactionService.getRecommendedGasBudget();
      expect(gasBudget).toBe(1500000); // 1M base + 500K for 1 operation
    });

    test('should get recommended gas budget for multiple operations', () => {
      const gasBudget = transactionService.getRecommendedGasBudget(3);
      expect(gasBudget).toBe(2500000); // 1M base + 1.5M for 3 operations
    });

    test('should estimate gas cost for transaction', async () => {
      const mockDryRunResult = {
        effects: {
          gasUsed: { computationCost: '250000' },
        },
      };

      mockSuiClient.dryRunTransactionBlock.mockResolvedValue(mockDryRunResult);

      const tx = new Transaction();
      const mockBuild = jest.fn().mockResolvedValue('built-tx');
      tx.build = mockBuild;

      const gasEstimate = await transactionService.estimateGas(tx, mockSigner);

      expect(gasEstimate).toBe(250000);
    });

    test('should handle gas estimation error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockSuiClient.dryRunTransactionBlock.mockRejectedValue(new Error('Estimation failed'));

      const tx = new Transaction();
      const gasEstimate = await transactionService.estimateGas(tx, mockSigner);

      expect(gasEstimate).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();
      
      consoleSpy.mockRestore();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing effects in transaction result', async () => {
      const mockResult = {
        digest: 'digest123',
        // Missing effects field
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.status).toBe('failure');
      expect(result.gasUsed).toBeUndefined();
    });

    test('should handle object changes with missing objectType', async () => {
      const mockResult = {
        digest: 'digest123',
        effects: { status: { status: 'success' } },
        objectChanges: [
          {
            type: 'created',
            objectId: 'obj123',
            // Missing objectType
          },
        ],
      };

      mockSuiClient.signAndExecuteTransaction.mockResolvedValue(mockResult);

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.createdObjects).toEqual([
        {
          objectId: 'obj123',
          objectType: 'unknown',
        },
      ]);
    });

    test('should handle string error in execution', async () => {
      mockSuiClient.signAndExecuteTransaction.mockRejectedValue('String error');

      const tx = new Transaction();
      const result = await transactionService.executeTransaction(tx, mockSigner);

      expect(result.status).toBe('failure');
      expect(result.error).toBe('String error');
    });
  });
});

console.log('✅ TransactionService comprehensive tests created successfully');
console.log('📋 Tests cover: transaction building, execution, convenience methods, utilities, error handling');