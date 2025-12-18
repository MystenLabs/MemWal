/**
 * Simple PDW Client - Easy-to-use API for Personal Data Wallet
 *
 * Provides a simple function-based API without React dependencies.
 * Works in Node.js, browsers, serverless functions, and CLI tools.
 *
 * @example
 * ```typescript
 * import { createPDWClient } from 'personal-data-wallet-sdk';
 * import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
 *
 * const keypair = Ed25519Keypair.fromSecretKey(process.env.PRIVATE_KEY);
 * const pdw = await createPDWClient({
 *   signer: keypair,
 *   userAddress: keypair.getPublicKey().toSuiAddress(),
 *   network: 'testnet',
 *   geminiApiKey: process.env.GEMINI_API_KEY
 * });
 *
 * // Simple API - no hooks needed!
 * await pdw.memory.create('I love TypeScript');
 * const results = await pdw.search.vector('programming');
 * const answer = await pdw.chat.send(sessionId, 'What do I like?');
 * ```
 *
 * @module client/SimplePDWClient
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import type { Keypair } from '@mysten/sui/cryptography';
import type { UnifiedSigner, WalletAdapter } from './signers';
import { KeypairSigner, WalletAdapterSigner } from './signers';
import { StorageService } from '../services/StorageService';
import { EmbeddingService } from '../services/EmbeddingService';
import { MemoryService } from '../services/MemoryService';
import { QueryService } from '../services/QueryService';
import { ClassifierService } from '../services/ClassifierService';
import { VectorService } from '../services/VectorService';
import { BatchService } from '../services/BatchService';
import { MemoryAnalyticsService } from '../retrieval/MemoryAnalyticsService';
import { EncryptionService } from '../services/EncryptionService';
import { PermissionService } from '../access/PermissionService';
import { TransactionService } from '../services/TransactionService';
import { PipelineManager } from '../pipeline/PipelineManager';
import { MemoryNamespace } from './namespaces/MemoryNamespace';
import { SearchNamespace } from './namespaces/SearchNamespace';
import { ClassifyNamespace } from './namespaces/ClassifyNamespace';
import { GraphNamespace } from './namespaces/GraphNamespace';
import { EmbeddingsNamespace } from './namespaces/EmbeddingsNamespace';
import { BatchNamespace } from './namespaces/BatchNamespace';
import { CacheNamespace } from './namespaces/CacheNamespace';
import { IndexNamespace } from './namespaces/IndexNamespace';
import { AnalyticsNamespace } from './namespaces/AnalyticsNamespace';
import { EncryptionNamespace } from './namespaces/EncryptionNamespace';
import { PermissionsNamespace } from './namespaces/PermissionsNamespace';
import { TxNamespace } from './namespaces/TxNamespace';
import { PipelineNamespace } from './namespaces/PipelineNamespace';
import { CapabilityNamespace } from './namespaces/CapabilityNamespace';
import { ContextNamespace } from './namespaces/ContextNamespace';
import { WalletNamespace } from './namespaces/WalletNamespace';
// Consolidated namespaces (new unified API)
import { AINamespace } from './namespaces/consolidated/AINamespace';
import { SecurityNamespace } from './namespaces/consolidated/SecurityNamespace';
import { BlockchainNamespace } from './namespaces/consolidated/BlockchainNamespace';
import { StorageNamespace as ConsolidatedStorageNamespace } from './namespaces/consolidated/StorageNamespace';
import type { PDWConfig, ClientWithCoreApi } from '../types';
import { ClientMemoryManager } from './ClientMemoryManager';
import { ViewService } from '../services/ViewService';
import { CapabilityService } from '../services/CapabilityService';
import { MemoryIndexService } from '../services/MemoryIndexService';
import { IndexManager, type IndexManagerOptions, type IndexProgressCallback } from '../services/IndexManager';
import { createHnswService } from '../vector/createHnswService';
import type { IHnswService } from '../vector/IHnswService';

/**
 * Configuration for Simple PDW Client
 */
export interface SimplePDWConfig {
  /**
   * Signer: Either Keypair (Node.js) or WalletAdapter (browser)
   */
  signer: Keypair | WalletAdapter | UnifiedSigner;

  /**
   * User's Sui address
   * If not provided, will be derived from signer
   */
  userAddress?: string;

  /**
   * Network to use (auto-configures endpoints)
   * @default 'testnet'
   */
  network?: 'testnet' | 'mainnet' | 'devnet';

  /**
   * Gemini API key for AI features (embeddings, chat, classification)
   * @deprecated Use `embedding.apiKey` instead for more flexibility
   */
  geminiApiKey?: string;

  /**
   * Optional: Embedding configuration
   * Allows customizing the embedding provider, model, and dimensions
   */
  embedding?: {
    /**
     * Embedding provider
     * - google: Direct Google AI API
     * - openai: Direct OpenAI API
     * - openrouter: OpenRouter API gateway (recommended - supports multiple models)
     * - cohere: Direct Cohere API
     * @default 'google'
     */
    provider?: 'google' | 'openai' | 'openrouter' | 'cohere';
    /**
     * API key for the embedding provider
     * Falls back to geminiApiKey for backward compatibility
     */
    apiKey?: string;
    /**
     * Model name to use
     * - Google: 'text-embedding-004', 'gemini-embedding-001'
     * - OpenAI: 'text-embedding-3-small', 'text-embedding-3-large'
     * - OpenRouter: 'google/gemini-embedding-001', 'openai/text-embedding-3-small', etc.
     * - Cohere: 'embed-english-v3.0', 'embed-multilingual-v3.0'
     * @default 'text-embedding-004' (for google), 'google/gemini-embedding-001' (for openrouter)
     */
    modelName?: string;
    /**
     * Embedding dimensions
     * @default 768 (for google/openrouter), 1536 (for openai)
     */
    dimensions?: number;
  };

  /**
   * Optional: Detailed Walrus configuration
   */
  walrus?: {
    aggregator?: string;
    publisher?: string;
    network?: 'testnet' | 'mainnet';
  };

  /**
   * Optional: Detailed Sui configuration
   */
  sui?: {
    network?: 'testnet' | 'mainnet' | 'devnet';
    packageId?: string;
    rpcUrl?: string;
  };

  /**
   * Optional: AI model configuration for chat and analysis
   */
  ai?: {
    /**
     * Chat/analysis model to use
     * Can be OpenRouter format (e.g., 'google/gemini-2.5-flash') or direct provider format
     * @default process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash'
     */
    chatModel?: string;
    /**
     * API key for chat model (if different from embedding)
     * For OpenRouter, use OPENROUTER_API_KEY
     */
    apiKey?: string;
  };

  /**
   * Optional: Feature flags
   */
  features?: {
    enableEncryption?: boolean;
    enableLocalIndexing?: boolean;
    enableKnowledgeGraph?: boolean;
  };

  /**
   * Optional: Index manager options for hybrid restore
   */
  indexManager?: {
    /** Auto-save interval in ms (default: 5 minutes) */
    autoSaveInterval?: number;
    /** Enable auto-save (default: true) */
    enableAutoSave?: boolean;
    /** Progress callback for index operations */
    onProgress?: IndexProgressCallback;
  };
}

/**
 * Default package IDs by network
 */
const DEFAULT_PACKAGE_IDS: Record<string, string> = {
  testnet: process.env.NEXT_PUBLIC_PACKAGE_ID || process.env.PACKAGE_ID || '0xf63a61b8d056ffb2e0efdd057445e15c9c64a1c6f2d13516812d7031b7e7dc9e',
  mainnet: '', // TODO: Add mainnet package ID when deployed
  devnet: ''
};

/**
 * Resolved configuration after applying defaults
 */
interface ResolvedConfig {
  signer: UnifiedSigner;
  userAddress: string;
  walrus: {
    aggregator: string;
    publisher: string;
    network: 'testnet' | 'mainnet';
  };
  sui: {
    network: 'testnet' | 'mainnet' | 'devnet';
    packageId: string;
    rpcUrl: string;
    client: SuiClient;
  };
  ai: {
    geminiApiKey?: string;
    chatModel: string;
    apiKey?: string;
  };
  embedding: {
    provider: 'google' | 'openai' | 'openrouter' | 'cohere';
    apiKey?: string;
    modelName: string;
    dimensions: number;
  };
  features: {
    enableEncryption: boolean;
    enableLocalIndexing: boolean;
    enableKnowledgeGraph: boolean;
  };
  indexManager?: {
    autoSaveInterval?: number;
    enableAutoSave?: boolean;
    onProgress?: IndexProgressCallback;
  };
}

/**
 * Service container for dependency injection
 */
export interface ServiceContainer {
  config: ResolvedConfig;
  storage: StorageService;
  embedding?: EmbeddingService;
  memory: MemoryService;
  query: QueryService;
  classifier?: ClassifierService;
  vector?: VectorService;
  memoryIndex?: MemoryIndexService; // For HNSW indexing with persistence
  batchService?: BatchService; // For batch operations and caching
  analytics?: MemoryAnalyticsService; // For memory insights
  encryption?: EncryptionService; // For SEAL encryption
  permissions?: PermissionService; // For access control
  tx?: TransactionService; // For transaction utilities
  pipeline?: PipelineManager; // For processing pipelines
  clientMemoryManager?: ClientMemoryManager; // For full create pipeline
  viewService?: ViewService; // For read operations
  capability?: CapabilityService; // For capability-based access control
  indexManager?: IndexManager; // For hybrid index persistence
  /** Shared HNSW service instance (singleton) */
  sharedHnswService?: IHnswService;
}

/**
 * Simple PDW Client
 *
 * Main client class providing easy-to-use API for all PDW operations
 */
export class SimplePDWClient {
  private config: ResolvedConfig;
  private services: ServiceContainer;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  /** Shared HNSW service instance - created once and shared across all services */
  private sharedHnswService: IHnswService | null = null;
  private sharedHnswServicePromise: Promise<IHnswService> | null = null;

  constructor(config: SimplePDWConfig) {
    // Resolve configuration with defaults
    this.config = this.resolveConfig(config);

    // Initialize services
    this.services = this.initializeServices(this.config);

    // Start async initialization (WASM loading, etc.)
    this.initPromise = this.initialize();
  }

  /**
   * Resolve configuration with smart defaults
   */
  private resolveConfig(config: SimplePDWConfig): ResolvedConfig {
    const network = config.network || config.sui?.network || 'testnet';

    // Create unified signer
    let signer: UnifiedSigner;
    if ('signAndExecuteTransaction' in config.signer && 'signPersonalMessage' in config.signer && 'getAddress' in config.signer) {
      // Already a UnifiedSigner
      signer = config.signer as UnifiedSigner;
    } else if ('getPublicKey' in config.signer && 'signPersonalMessage' in config.signer) {
      // It's a Keypair
      const suiClient = new SuiClient({
        url: config.sui?.rpcUrl || getFullnodeUrl(network)
      });
      signer = new KeypairSigner(config.signer as Keypair, suiClient);
    } else {
      // It's a WalletAdapter
      signer = new WalletAdapterSigner(config.signer as WalletAdapter);
    }

    // Derive user address if not provided
    const userAddress = config.userAddress || signer.getAddress();

    // Create Sui client
    const suiClient = new SuiClient({
      url: config.sui?.rpcUrl || getFullnodeUrl(network)
    });

    // Resolve embedding configuration with defaults
    const embeddingProvider = config.embedding?.provider || 'google';
    const embeddingApiKey = config.embedding?.apiKey || config.geminiApiKey;
    const embeddingModelName = config.embedding?.modelName || this.getDefaultEmbeddingModel(embeddingProvider);
    const embeddingDimensions = config.embedding?.dimensions || this.getDefaultEmbeddingDimensions(embeddingProvider);

    return {
      signer,
      userAddress,
      walrus: {
        aggregator: config.walrus?.aggregator ||
          `https://aggregator.walrus-${network}.walrus.space`,
        publisher: config.walrus?.publisher ||
          `https://publisher.walrus-${network}.walrus.space`,
        network: (config.walrus?.network || network) as 'testnet' | 'mainnet'
      },
      sui: {
        network,
        packageId: config.sui?.packageId || DEFAULT_PACKAGE_IDS[network],
        rpcUrl: config.sui?.rpcUrl || getFullnodeUrl(network),
        client: suiClient
      },
      ai: {
        geminiApiKey: config.geminiApiKey,
        chatModel: config.ai?.chatModel || process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
        apiKey: config.ai?.apiKey || process.env.OPENROUTER_API_KEY || config.geminiApiKey
      },
      embedding: {
        provider: embeddingProvider,
        apiKey: embeddingApiKey,
        modelName: embeddingModelName,
        dimensions: embeddingDimensions
      },
      features: {
        enableEncryption: config.features?.enableEncryption ?? false,
        enableLocalIndexing: config.features?.enableLocalIndexing ?? true,
        enableKnowledgeGraph: config.features?.enableKnowledgeGraph ?? true
      },
      indexManager: config.indexManager
    };
  }

  /**
   * Get default embedding model for provider
   */
  private getDefaultEmbeddingModel(provider: string): string {
    switch (provider) {
      case 'google':
        return 'text-embedding-004';
      case 'openai':
        return 'text-embedding-3-small';
      case 'openrouter':
        return 'google/gemini-embedding-001';
      case 'cohere':
        return 'embed-english-v3.0';
      default:
        return 'text-embedding-004';
    }
  }

  /**
   * Get default embedding dimensions for provider
   */
  private getDefaultEmbeddingDimensions(provider: string): number {
    switch (provider) {
      case 'google':
        return 3072;
      case 'openai':
        return 1536;
      case 'openrouter':
        return 3072; // google/gemini-embedding-001 returns 3072 dimensions
      case 'cohere':
        return 1024;
      default:
        return 3072;
    }
  }

  /**
   * Create ClientWithCoreApi adapter from SuiClient
   */
  private createClientAdapter(suiClient: SuiClient): ClientWithCoreApi {
    return {
      // Expose the underlying SuiClient for services that need it (e.g., ViewService)
      client: suiClient,
      core: {
        getObject: (objectId: string) => suiClient.getObject({ id: objectId, options: { showContent: true } }),
        getObjects: (objectIds: string[]) => Promise.all(objectIds.map(id => suiClient.getObject({ id, options: { showContent: true } }))),
        executeTransaction: (tx: any) => suiClient.signAndExecuteTransaction(tx)
      },
      $extend: <T>(extension: T) => ({ ...suiClient, ...extension })
    } as ClientWithCoreApi;
  }

  /**
   * Initialize all services with proper dependency injection
   */
  private initializeServices(config: ResolvedConfig): ServiceContainer {
    const { sui, walrus, ai, embedding: embeddingConfig, userAddress } = config;

    // 1. Storage Service (foundation)
    const storage = new StorageService({
      packageId: sui.packageId,
      walrusAggregatorUrl: walrus.aggregator,
      walrusPublisherUrl: walrus.publisher,
      suiClient: sui.client,
      network: walrus.network,
      epochs: 3,
      useUploadRelay: true
    });

    // 2. Embedding Service (if API key provided)
    let embedding: EmbeddingService | undefined;
    if (embeddingConfig.apiKey) {
      embedding = new EmbeddingService({
        provider: embeddingConfig.provider,
        apiKey: embeddingConfig.apiKey,
        modelName: embeddingConfig.modelName,
        dimensions: embeddingConfig.dimensions
      });

      console.log(`✅ Embedding Service initialized: ${embeddingConfig.provider}/${embeddingConfig.modelName} (${embeddingConfig.dimensions}d)`);

      // Connect to storage for search
      storage.initializeSearch(embedding);
    }

    // 3. Create client adapter for services requiring ClientWithCoreApi
    const clientAdapter = this.createClientAdapter(sui.client);

    // 4. Memory Service (blockchain operations)
    const pdwConfig: PDWConfig = {
      packageId: sui.packageId
    };
    const memory = new MemoryService(clientAdapter, pdwConfig);

    // 5. Classifier Service (if AI enabled)
    let classifier: ClassifierService | undefined;
    if (embeddingConfig.apiKey) {
      classifier = new ClassifierService(
        clientAdapter,      // client
        pdwConfig,          // config
        embedding,          // embeddingService
        embeddingConfig.apiKey     // aiApiKey
      );
    }

    // 9. Create shared HNSW service (singleton for all vector operations)
    // Note: This starts async initialization - services will wait for it when needed
    let sharedHnswService: IHnswService | undefined;
    if (config.features.enableLocalIndexing) {
      // Start HNSW initialization early, store promise for later await
      this.sharedHnswServicePromise = createHnswService({
        indexConfig: {
          dimension: embeddingConfig.dimensions,
          maxElements: 10000,
          efConstruction: 200,
          m: 16
        },
        batchConfig: {
          maxBatchSize: 100,
          batchDelayMs: 5000
        }
      });
      console.log('✅ Shared HNSW service initialization started (singleton for all vector services)');
    }

    // 9a. Vector Service (if local indexing enabled)
    // Note: HNSW service will be injected after async initialization
    let vector: VectorService | undefined;
    if (config.features.enableLocalIndexing && embedding && embeddingConfig.apiKey) {
      vector = new VectorService(
        {
          embedding: {
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.modelName,
            dimensions: embeddingConfig.dimensions
          },
          index: {
            maxElements: 10000,
            m: 16,
            efConstruction: 200
          }
          // Note: hnswService will be set after async init completes
        },
        embedding,  // Already instantiated
        storage
      );
    }

    // 9b. MemoryIndexService (for HNSW indexing with Walrus persistence)
    // Note: HNSW service will be injected after async initialization
    let memoryIndex: MemoryIndexService | undefined;
    if (config.features.enableLocalIndexing) {
      memoryIndex = new MemoryIndexService(storage, {
        maxElements: 10000,
        dimension: embeddingConfig.dimensions,
        efConstruction: 200,
        m: 16
        // Note: hnswService will be set after async init completes
      });
      // Initialize with embedding service if available
      if (embedding) {
        memoryIndex.initialize(embedding, storage);
      }
    }

    // 10. ClientMemoryManager (for full create pipeline)
    // Note: HNSW service will be injected after async initialization
    let clientMemoryManager: ClientMemoryManager | undefined;
    if (ai.geminiApiKey) {
      clientMemoryManager = new ClientMemoryManager({
        packageId: sui.packageId,
        accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID ||
          '0x1d0a1936e170e54ff12ef30a042b390a8ef6dff3a642c5e7056222da038bde',
        walrusAggregator: walrus.aggregator,
        geminiApiKey: ai.geminiApiKey,
        walrusNetwork: walrus.network,
        enableLocalIndexing: config.features.enableLocalIndexing
        // Note: hnswService will be set after async init completes
      });
    }

    // 11. ViewService (for read operations)
    const viewService = new ViewService(clientAdapter, pdwConfig);

    // 12. BatchService (for batch operations and caching)
    const batchService = new BatchService({
      embedding: {
        batchSize: 10,
        delayMs: 1000
      },
      indexing: {
        batchSize: 20,
        delayMs: 500
      },
      storage: {
        batchSize: 5,
        delayMs: 2000
      },
      cache: {
        maxSize: 1000,
        ttlMs: 3600000, // 1 hour default
        cleanupIntervalMs: 60000, // 1 minute
        enableMetrics: true
      },
      enableMetrics: true
    });

    // 13. MemoryAnalyticsService (for insights and analytics)
    const analytics = new MemoryAnalyticsService();

    // 14. EncryptionService (for SEAL encryption - optional)
    let encryption: EncryptionService | undefined;
    if (config.features.enableEncryption) {
      encryption = new EncryptionService(clientAdapter, pdwConfig);
    }

    // 15. PermissionService (for access control)
    const permissions = new PermissionService({
      suiClient: sui.client,
      packageId: sui.packageId,
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID ||
        '0x1d0a1936e170e54ff12ef30a042b390a8ef6dff3a642c5e7056222da038bde'
    });

    // 16. TransactionService (for transaction utilities)
    const tx = new TransactionService(sui.client, pdwConfig);

    // 17. PipelineManager (for processing pipelines)
    const pipeline = new PipelineManager({
      maxConcurrentPipelines: 10,
      enableScheduling: true,
      enableHealthChecks: true,
      enableMetricsCollection: true
    });

    // 18. CapabilityService (for capability-based access control)
    const capability = new CapabilityService({
      suiClient: sui.client,
      packageId: sui.packageId,
    });

    // 19. IndexManager (for hybrid index persistence with blockchain integration)
    let indexManager: IndexManager | undefined;
    if (config.features.enableLocalIndexing && vector && embedding) {
      indexManager = new IndexManager(
        vector,
        storage,
        embedding,
        {
          autoSaveInterval: config.indexManager?.autoSaveInterval ?? 5 * 60 * 1000, // 5 minutes
          enableAutoSave: config.indexManager?.enableAutoSave ?? true,
          storageKeyPrefix: 'pdw_index_',
          onProgress: config.indexManager?.onProgress,
          // Blockchain integration
          transactionService: tx,
          getMemoryIndexFromChain: async (userAddress: string) => {
            return viewService.getMemoryIndex(userAddress);
          },
          executeTransaction: async (transaction: any, signer: any) => {
            try {
              const result = await sui.client.signAndExecuteTransaction({
                transaction,
                signer,
                options: {
                  showEffects: true,
                  showObjectChanges: true,
                },
              });

              // CRITICAL: Wait for transaction to be confirmed before returning
              // This ensures the gas coin version is updated on the network
              // before the next transaction is built
              if (result.digest) {
                try {
                  await sui.client.waitForTransaction({
                    digest: result.digest,
                    options: { showEffects: true },
                  });
                } catch (waitError) {
                  console.warn('⚠️ waitForTransaction failed:', waitError);
                  // Continue anyway - the transaction was submitted
                }
              }

              return {
                digest: result.digest,
                effects: result.effects,
                error: result.effects?.status?.status === 'failure'
                  ? result.effects.status.error
                  : undefined,
              };
            } catch (error: any) {
              return {
                digest: '',
                effects: undefined,
                error: error.message || String(error),
              };
            }
          },
        }
      );
    }

    // 20. QueryService (advanced search) - initialized with all dependencies
    const query = new QueryService(
      memoryIndex,    // MemoryIndexService for vector search
      embedding,      // EmbeddingService for query embedding generation
      storage,        // StorageService for content retrieval
      undefined       // GraphService - will be set if knowledge graph is enabled
    );

    return {
      config,
      storage,
      embedding,
      memory,
      query,
      classifier,
      vector,
      memoryIndex,
      batchService,
      analytics,
      encryption,
      permissions,
      tx,
      pipeline,
      clientMemoryManager,
      viewService,
      capability,
      indexManager
    };
  }

  /**
   * Initialize client (async operations like WASM loading)
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Initialize shared HNSW service FIRST (singleton for all vector operations)
      // This ensures all subsequent service initializations get the same instance
      if (this.sharedHnswServicePromise) {
        this.sharedHnswService = await this.sharedHnswServicePromise;
        this.services.sharedHnswService = this.sharedHnswService;
        console.log('✅ Shared HNSW service ready (singleton)');
      }

      // Initialize vector service if enabled (WASM loading)
      // Note: VectorService.initialize() will use singleton from createHnswService
      if (this.services.vector) {
        await this.services.vector.initialize();
      }

      // Initialize knowledge graph if enabled
      if (this.config.features.enableKnowledgeGraph && this.services.embedding) {
        await this.services.storage.initializeKnowledgeGraph({
          embeddingService: this.services.embedding,
          geminiApiKey: this.config.ai.geminiApiKey
        });
      }

      this.initialized = true;
      console.log('✅ SimplePDWClient initialized');
    } catch (error) {
      console.error('Failed to initialize SimplePDWClient:', error);
      throw error;
    }
  }

  /**
   * Ensure client is initialized before operations
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Get service container (internal use)
   */
  getServices(): ServiceContainer {
    return this.services;
  }

  /**
   * Get configuration (internal use)
   */
  getConfig(): ResolvedConfig {
    return this.config;
  }

  /**
   * Wait for initialization to complete
   */
  async ready(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Initialize index with hybrid restore strategy
   *
   * This method implements the hybrid pattern:
   * 1. Try to load from Walrus cache (fast, ~500ms)
   * 2. If failed, rebuild from blockchain + Walrus (slow but complete)
   * 3. Sync any new memories since last save
   * 4. Start auto-save periodically
   *
   * @param options - Optional progress callback and settings
   * @returns Initialization result with stats
   *
   * @example
   * ```typescript
   * const pdw = await createPDWClient(config);
   * await pdw.ready();
   *
   * // Initialize index with hybrid restore
   * const result = await pdw.initializeIndex({
   *   onProgress: (stage, progress, message) => {
   *     console.log(`[${stage}] ${progress}% - ${message}`);
   *   }
   * });
   *
   * console.log(`Index ready: ${result.vectorCount} vectors (${result.method})`);
   * ```
   */
  async initializeIndex(options: {
    onProgress?: IndexProgressCallback;
    forceRebuild?: boolean;
  } = {}): Promise<{
    restored: boolean;
    method: 'cache' | 'rebuild' | 'empty';
    vectorCount: number;
    syncedCount: number;
    timeMs: number;
  }> {
    await this.ensureInitialized();

    if (!this.services.indexManager) {
      console.warn('IndexManager not available. Enable local indexing in config.');
      return {
        restored: false,
        method: 'empty',
        vectorCount: 0,
        syncedCount: 0,
        timeMs: 0,
      };
    }

    // Set progress callback if provided
    if (options.onProgress) {
      this.services.indexManager = new IndexManager(
        this.services.vector!,
        this.services.storage,
        this.services.embedding!,
        {
          autoSaveInterval: 5 * 60 * 1000,
          enableAutoSave: true,
          storageKeyPrefix: 'pdw_index_',
          onProgress: options.onProgress,
        }
      );
    }

    const userAddress = this.config.userAddress;

    // Force rebuild if requested
    if (options.forceRebuild) {
      this.services.indexManager.clearIndexState(userAddress);
    }

    // Define callbacks for fetching data
    const getMemoriesFromChain = async () => {
      const viewService = this.services.viewService;
      if (!viewService) {
        return [];
      }

      try {
        // Fetch memories with pagination (max 50 per page)
        const allMemories: any[] = [];
        let cursor: string | undefined;
        const pageSize = 50; // Max allowed by the API

        do {
          const response = await viewService.getUserMemories(userAddress, {
            limit: pageSize,
            cursor,
          });

          allMemories.push(...response.data);
          cursor = response.nextCursor;
        } while (cursor && allMemories.length < 1000); // Cap at 1000 memories

        return allMemories.map((m: any) => ({
          id: m.id,
          blobId: m.blobId || m.blob_id,
          vectorId: m.vectorId || m.vector_id,
          category: m.category,
          importance: m.importance,
          topic: m.topic,
          createdAt: m.createdAt || m.created_at || Date.now(),
        }));
      } catch (error) {
        console.warn('Failed to fetch memories from chain:', error);
        return [];
      }
    };

    const getMemoryContent = async (blobId: string) => {
      try {
        const result = await this.services.storage.retrieveMemoryPackage(blobId);
        return {
          content: result.memoryPackage?.content || '',
          embedding: result.memoryPackage?.embedding,
          metadata: result.memoryPackage?.metadata,
        };
      } catch (error) {
        console.warn(`Failed to fetch memory content for ${blobId}:`, error);
        return { content: '', embedding: undefined, metadata: undefined };
      }
    };

    // Initialize with hybrid strategy
    return this.services.indexManager.initialize(
      userAddress,
      getMemoriesFromChain,
      getMemoryContent
    );
  }

  /**
   * Save current index to Walrus
   *
   * @returns Blob ID of saved index, or null if nothing to save
   */
  async saveIndex(): Promise<string | null> {
    await this.ensureInitialized();

    if (!this.services.indexManager) {
      console.warn('IndexManager not available');
      return null;
    }

    return this.services.indexManager.saveIndexWithSigner(
      this.config.userAddress,
      this.config.signer.getSigner()
    );
  }

  /**
   * Get index statistics
   */
  getIndexStats(): {
    indexState: any;
    vectorCacheSize: number;
    isAutoSaveEnabled: boolean;
  } | null {
    if (!this.services.indexManager) {
      return null;
    }

    return this.services.indexManager.getStats(this.config.userAddress);
  }

  /**
   * Memory operations namespace
   */
  get memory(): MemoryNamespace {
    return new MemoryNamespace(this.services);
  }

  /**
   * Search operations namespace
   */
  get search(): SearchNamespace {
    return new SearchNamespace(this.services);
  }

  /**
   * Classification operations namespace
   */
  get classify(): ClassifyNamespace {
    return new ClassifyNamespace(this.services);
  }

  /**
   * Knowledge graph operations namespace
   */
  get graph(): GraphNamespace {
    return new GraphNamespace(this.services);
  }

  /**
   * Embeddings operations namespace
   */
  get embeddings(): EmbeddingsNamespace {
    return new EmbeddingsNamespace(this.services);
  }

  /**
   * Batch operations namespace
   */
  get batch(): BatchNamespace {
    return new BatchNamespace(this.services);
  }

  /**
   * Cache operations namespace
   */
  get cache(): CacheNamespace {
    return new CacheNamespace(this.services);
  }

  /**
   * Vector index operations namespace
   */
  get index(): IndexNamespace {
    return new IndexNamespace(this.services);
  }

  /**
   * Analytics and insights namespace
   */
  get analytics(): AnalyticsNamespace {
    return new AnalyticsNamespace(this.services);
  }

  /**
   * SEAL encryption operations namespace
   */
  get encryption(): EncryptionNamespace {
    return new EncryptionNamespace(this.services);
  }

  /**
   * Access control and permissions namespace
   */
  get permissions(): PermissionsNamespace {
    return new PermissionsNamespace(this.services);
  }

  /**
   * Transaction utilities namespace
   */
  get tx(): TxNamespace {
    return new TxNamespace(this.services);
  }

  /**
   * Processing pipelines namespace
   */
  get pipeline(): PipelineNamespace {
    return new PipelineNamespace(this.services);
  }

  /**
   * Capability operations namespace
   *
   * Provides low-level access to MemoryCap capability objects.
   * For most use cases, prefer using the `context` namespace instead.
   *
   * @example
   * ```typescript
   * const cap = await pdw.capability.create('MEMO');
   * const keyId = pdw.capability.computeKeyId(cap);
   * ```
   */
  get capability(): CapabilityNamespace {
    return new CapabilityNamespace(this.services);
  }

  /**
   * Context operations namespace
   *
   * Higher-level API for managing app contexts (built on capabilities).
   * Use this for managing app-scoped data and access control.
   *
   * @example
   * ```typescript
   * // Get or create context for MEMO app
   * const ctx = await pdw.context.getOrCreate('MEMO');
   *
   * // List all contexts
   * const contexts = await pdw.context.list();
   *
   * // Share context with another user
   * await pdw.context.transfer('MEMO', recipientAddress);
   * ```
   */
  get context(): ContextNamespace {
    return new ContextNamespace(this.services);
  }

  /**
   * Wallet operations namespace
   *
   * Simplified wallet operations for address info, balance, and owned objects.
   *
   * @example
   * ```typescript
   * const address = await pdw.wallet.getAddress();
   * const balance = await pdw.wallet.getFormattedBalance();
   * const caps = await pdw.wallet.getMemoryCaps();
   * ```
   */
  get wallet(): WalletNamespace {
    return new WalletNamespace(this.services);
  }

  // ===========================================================================
  // CONSOLIDATED NAMESPACES (New Unified API)
  // ===========================================================================

  /**
   * AI operations namespace (consolidated)
   *
   * Unified API for all AI-powered operations:
   * - Embeddings (generate, batch, similarity)
   * - Classification (classify, shouldSave, importance)
   * - Chat with memory context
   *
   * @example
   * ```typescript
   * // Generate embeddings
   * const vector = await pdw.ai.embed('Hello world');
   *
   * // Classify content
   * const category = await pdw.ai.classify('I love TypeScript');
   *
   * // Chat with memory context
   * const session = await pdw.ai.chat.createSession();
   * const response = await pdw.ai.chat.send(session.id, 'What do you know about me?');
   * ```
   */
  get ai(): AINamespace {
    return new AINamespace(this.services);
  }

  /**
   * Security operations namespace (consolidated)
   *
   * Unified API for encryption, permissions, and contexts:
   * - SEAL encryption/decryption
   * - App contexts (MemoryCap management)
   * - OAuth-style permissions
   *
   * @example
   * ```typescript
   * // Encrypt data
   * const { encryptedData } = await pdw.security.encrypt(data);
   *
   * // Decrypt data
   * const decrypted = await pdw.security.decrypt({ encryptedData });
   *
   * // Manage app contexts
   * const ctx = await pdw.security.context.getOrCreate('MEMO');
   *
   * // Grant permissions
   * await pdw.security.permissions.grant('APP_ID', ['read', 'write']);
   * ```
   */
  get security(): SecurityNamespace {
    return new SecurityNamespace(this.services);
  }

  /**
   * Blockchain operations namespace (consolidated)
   *
   * Unified API for Sui blockchain operations:
   * - Transaction building and execution
   * - Wallet operations (balance, owned objects)
   *
   * @example
   * ```typescript
   * // Build and execute transaction
   * const tx = pdw.blockchain.tx.buildCreate({ ... });
   * const result = await pdw.blockchain.tx.execute(tx);
   *
   * // Check balance
   * const balance = await pdw.blockchain.wallet.getFormattedBalance();
   *
   * // Get owned objects
   * const memories = await pdw.blockchain.wallet.getMemories();
   * ```
   */
  get blockchain(): BlockchainNamespace {
    return new BlockchainNamespace(this.services);
  }

  /**
   * Storage operations namespace (consolidated)
   *
   * Unified API for Walrus storage and caching:
   * - Upload/download data to Walrus
   * - In-memory LRU cache
   *
   * @example
   * ```typescript
   * // Upload to Walrus
   * const result = await pdw.storage.upload(data);
   *
   * // Download from Walrus
   * const data = await pdw.storage.download(blobId);
   *
   * // Use cache
   * pdw.storage.cache.set('key', value, 60000);
   * const cached = pdw.storage.cache.get('key');
   * ```
   */
  get storage(): ConsolidatedStorageNamespace {
    return new ConsolidatedStorageNamespace(this.services);
  }
}
