/**
 * Consolidated Namespaces Unit Tests
 *
 * Tests the new consolidated namespace structure:
 * - pdw.ai (embeddings + classify + chat)
 * - pdw.security (encryption + permissions + context)
 * - pdw.blockchain (tx + wallet)
 * - pdw.storage (storage + cache)
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

// Create typed mock functions
function createMockFn<T>(returnValue: T): jest.Mock<() => T> {
  const fn = jest.fn() as jest.Mock<() => T>;
  fn.mockReturnValue(returnValue);
  return fn;
}

function createAsyncMockFn<T>(returnValue: T): jest.Mock<() => Promise<T>> {
  const fn = jest.fn() as jest.Mock<() => Promise<T>>;
  fn.mockResolvedValue(returnValue);
  return fn;
}

// Mock the services for unit testing
const mockServices = {
  config: {
    userAddress: '0x1234567890abcdef',
    signer: {
      getSigner: () => ({})
    }
  },
  embedding: {
    embedText: createAsyncMockFn({ vector: [0.1, 0.2, 0.3] }),
    embedBatch: createAsyncMockFn([{ vector: [0.1, 0.2] }, { vector: [0.3, 0.4] }])
  },
  classifier: {
    shouldSaveMemory: createAsyncMockFn(true),
    classifyMemory: createAsyncMockFn({
      category: 'general',
      importance: 7,
      topic: 'test',
      summary: 'Test summary'
    })
  },
  chat: {
    createSession: createMockFn('session-123'),
    getSession: createMockFn({ id: 'session-123', messages: [] }),
    sendMessage: createAsyncMockFn('Test response'),
    deleteSession: jest.fn()
  },
  encryption: {
    encrypt: createAsyncMockFn({
      encryptedObject: new Uint8Array([1, 2, 3]),
      keyId: new Uint8Array([4, 5, 6]),
      nonce: new Uint8Array([7, 8, 9])
    }),
    decrypt: createAsyncMockFn(new Uint8Array([1, 2, 3])),
    computeKeyId: createMockFn(new Uint8Array([1, 2, 3, 4])),
    createSessionKey: createAsyncMockFn({ keyId: '123', expiry: Date.now() + 3600000 }),
    getSessionKey: createMockFn({ keyId: '123', expiry: Date.now() + 3600000 })
  },
  context: {
    createContext: createAsyncMockFn({ contextId: 'ctx-123', appId: 'test-app' }),
    getContext: createAsyncMockFn({ contextId: 'ctx-123', appId: 'test-app' }),
    listContexts: createAsyncMockFn([]),
    grantAccess: createAsyncMockFn({ success: true }),
    revokeAccess: createAsyncMockFn({ success: true }),
    checkAccess: createAsyncMockFn(true),
    listPermissions: createAsyncMockFn([])
  },
  tx: {
    buildMemoryTransaction: createMockFn({}),
    buildBatchMemoryTransaction: createMockFn({}),
    executeTransaction: createAsyncMockFn({ status: 'success', digest: 'tx-123' }),
    estimateGas: createAsyncMockFn(BigInt(1000000)),
    waitForTransaction: createAsyncMockFn({ status: 'success' })
  },
  wallet: {
    getAddress: createMockFn('0x1234'),
    getBalance: createAsyncMockFn(BigInt(1000000000)),
    getFormattedBalance: createAsyncMockFn('1.0 SUI'),
    getOwnedObjects: createAsyncMockFn([]),
    signMessage: createAsyncMockFn(new Uint8Array([1, 2, 3]))
  },
  storage: {
    uploadBlob: createAsyncMockFn({ blobId: 'blob-123' }),
    retrieveFromWalrusOnly: createAsyncMockFn({
      content: new Uint8Array([1, 2, 3]),
      metadata: {}
    }),
    uploadMemoryPackage: createAsyncMockFn({ blobId: 'mp-123' }),
    retrieveMemoryPackage: createAsyncMockFn({
      memoryPackage: { content: 'test', contentType: 'text/plain' },
      isEncrypted: false
    })
  },
  batchService: {
    getCache: createMockFn(null),
    setCache: jest.fn(),
    hasCache: createMockFn(false),
    deleteCache: createMockFn(true),
    clearCache: jest.fn(),
    getCacheStats: createMockFn({
      size: 0,
      totalAccess: 0,
      hitRate: 0
    })
  }
};

describe('Consolidated Namespaces', () => {
  describe('AINamespace', () => {
    let AINamespace: any;

    beforeAll(async () => {
      const module = await import('../../src/client/namespaces/consolidated/AINamespace.js');
      AINamespace = module.AINamespace;
    });

    it('should create AINamespace instance', () => {
      const ai = new AINamespace(mockServices as any);
      expect(ai).toBeDefined();
    });

    it('should expose chat sub-namespace', () => {
      const ai = new AINamespace(mockServices as any);
      expect(ai.chat).toBeDefined();
    });

    it('should generate embeddings', async () => {
      const ai = new AINamespace(mockServices as any);
      const embedding = await ai.embed('test text');
      expect(embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('should generate batch embeddings', async () => {
      const ai = new AINamespace(mockServices as any);
      const embeddings = await ai.embedBatch(['text1', 'text2']);
      expect(embeddings).toHaveLength(2);
    });

    it('should calculate similarity', () => {
      const ai = new AINamespace(mockServices as any);
      const similarity = ai.similarity([1, 0, 0], [1, 0, 0]);
      expect(similarity).toBeCloseTo(1.0);
    });

    it('should classify content', async () => {
      const ai = new AINamespace(mockServices as any);
      const category = await ai.classify('test content');
      expect(category).toBe('general');
    });

    it('should check if content should be saved', async () => {
      const ai = new AINamespace(mockServices as any);
      const shouldSave = await ai.shouldSave('important information');
      expect(shouldSave).toBe(true);
    });

    it('should return full classification', async () => {
      const ai = new AINamespace(mockServices as any);
      const result = await ai.classifyFull('test content');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('importance');
      expect(result).toHaveProperty('topic');
      expect(result).toHaveProperty('summary');
    });
  });

  describe('SecurityNamespace', () => {
    let SecurityNamespace: any;

    beforeAll(async () => {
      const module = await import('../../src/client/namespaces/consolidated/SecurityNamespace.js');
      SecurityNamespace = module.SecurityNamespace;
    });

    it('should create SecurityNamespace instance', () => {
      const security = new SecurityNamespace(mockServices as any);
      expect(security).toBeDefined();
    });

    it('should expose context sub-namespace', () => {
      const security = new SecurityNamespace(mockServices as any);
      expect(security.context).toBeDefined();
    });

    it('should expose permissions sub-namespace', () => {
      const security = new SecurityNamespace(mockServices as any);
      expect(security.permissions).toBeDefined();
    });

    it('should encrypt data', async () => {
      const security = new SecurityNamespace(mockServices as any);
      const result = await security.encrypt(new Uint8Array([1, 2, 3]));
      expect(result).toHaveProperty('encryptedObject');
      expect(result).toHaveProperty('keyId');
    });

    it('should decrypt data', async () => {
      const security = new SecurityNamespace(mockServices as any);
      const decrypted = await security.decrypt({
        encryptedContent: new Uint8Array([1, 2, 3]),
        memoryCapId: 'cap-123'
      });
      expect(decrypted).toBeInstanceOf(Uint8Array);
    });

    it('should compute key ID', () => {
      const security = new SecurityNamespace(mockServices as any);
      const keyId = security.computeKeyId('0x1234', new Uint8Array([1, 2, 3]));
      expect(keyId).toBeInstanceOf(Uint8Array);
    });

    it('should create context', async () => {
      const security = new SecurityNamespace(mockServices as any);
      const ctx = await security.context.create('test-app');
      expect(ctx).toHaveProperty('contextId');
    });

    it('should grant permissions', async () => {
      const security = new SecurityNamespace(mockServices as any);
      const result = await security.permissions.grant('test-app', ['read', 'write']);
      expect(result.success).toBe(true);
    });
  });

  describe('BlockchainNamespace', () => {
    let BlockchainNamespace: any;

    beforeAll(async () => {
      const module = await import('../../src/client/namespaces/consolidated/BlockchainNamespace.js');
      BlockchainNamespace = module.BlockchainNamespace;
    });

    it('should create BlockchainNamespace instance', () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      expect(blockchain).toBeDefined();
    });

    it('should expose tx sub-namespace', () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      expect(blockchain.tx).toBeDefined();
    });

    it('should expose wallet sub-namespace', () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      expect(blockchain.wallet).toBeDefined();
    });

    it('should get wallet address', () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const address = blockchain.wallet.getAddress();
      expect(address).toBe('0x1234');
    });

    it('should get wallet balance', async () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const balance = await blockchain.wallet.getBalance();
      expect(balance).toBe(BigInt(1000000000));
    });

    it('should get formatted balance', async () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const balance = await blockchain.wallet.getFormattedBalance();
      expect(balance).toBe('1.0 SUI');
    });

    it('should build memory transaction', () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const tx = blockchain.tx.build('create', { content: 'test' });
      expect(tx).toBeDefined();
    });

    it('should execute transaction', async () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const result = await blockchain.tx.execute({});
      expect(result.status).toBe('success');
    });

    it('should estimate gas', async () => {
      const blockchain = new BlockchainNamespace(mockServices as any);
      const gas = await blockchain.tx.estimateGas({});
      expect(gas).toBe(BigInt(1000000));
    });
  });

  describe('StorageNamespace', () => {
    let StorageNamespace: any;

    beforeAll(async () => {
      const module = await import('../../src/client/namespaces/consolidated/StorageNamespace.js');
      StorageNamespace = module.StorageNamespace;
    });

    it('should create StorageNamespace instance', () => {
      const storage = new StorageNamespace(mockServices as any);
      expect(storage).toBeDefined();
    });

    it('should expose cache sub-namespace', () => {
      const storage = new StorageNamespace(mockServices as any);
      expect(storage.cache).toBeDefined();
    });

    it('should upload data', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const result = await storage.upload('test data');
      expect(result).toHaveProperty('blobId');
    });

    it('should upload Uint8Array', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const result = await storage.upload(new Uint8Array([1, 2, 3]));
      expect(result.blobId).toBe('blob-123');
    });

    it('should upload JSON object', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const result = await storage.upload({ key: 'value' });
      expect(result.contentType).toBe('application/json');
    });

    it('should download data', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const data = await storage.download('blob-123');
      expect(data).toBeInstanceOf(Uint8Array);
    });

    it('should check if blob exists', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const exists = await storage.exists('blob-123');
      expect(exists).toBe(true);
    });

    it('should get blob metadata', async () => {
      const storage = new StorageNamespace(mockServices as any);
      const metadata = await storage.getMetadata('blob-123');
      expect(metadata).toHaveProperty('blobId');
      expect(metadata).toHaveProperty('exists');
    });

    it('should cache set operations', () => {
      const storage = new StorageNamespace(mockServices as any);
      storage.cache.set('key', 'value');
      expect(mockServices.batchService.setCache).toHaveBeenCalledWith('key', 'value', undefined);
    });

    it('should get cache stats', () => {
      const storage = new StorageNamespace(mockServices as any);
      const stats = storage.cache.stats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('hitRate');
    });
  });
});

describe('Namespace Integration', () => {
  it('should export all consolidated namespaces from index', async () => {
    const index = await import('../../src/client/namespaces/consolidated/index.js');

    expect(index.AINamespace).toBeDefined();
    expect(index.SecurityNamespace).toBeDefined();
    expect(index.BlockchainNamespace).toBeDefined();
    expect(index.StorageNamespace).toBeDefined();
  });

  it('should export all required types', async () => {
    const index = await import('../../src/client/namespaces/consolidated/index.js');

    // Type exports are compile-time, but we can verify the module exports properly
    expect(typeof index.AINamespace).toBe('function');
    expect(typeof index.SecurityNamespace).toBe('function');
    expect(typeof index.BlockchainNamespace).toBe('function');
    expect(typeof index.StorageNamespace).toBe('function');
  });
});
