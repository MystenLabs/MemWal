/**
 * Personal Data Wallet SDK
 * 
 * Comprehensive SDK for decentralized memory processing with AI-powered insights.
 * 
 * Features:
 * - 🧠 Local AI embedding generation (Gemini API)
 * - 🔍 HNSW vector indexing with intelligent batching
 * - 📊 Knowledge graph extraction and management
 * - 🗄️ Walrus decentralized storage with encryption
 * - ⛓️ Sui blockchain ownership tracking
 * - 🔄 Unified processing pipeline with monitoring
 * 
 * @version 1.0.0
 * @author Personal Data Wallet Team
 */

// Core pipeline - the main entry point
export { MemoryPipeline, PipelineManager } from './pipeline';
export type { 
  PipelineConfig, 
  PipelineExecution, 
  PipelineMetrics,
  PipelineManagerConfig,
  SystemMetrics 
} from './pipeline';

// Import for internal use
import { MemoryPipeline } from './pipeline/MemoryPipeline';
import { PipelineManager } from './pipeline/PipelineManager';
import type { PipelineConfig, PipelineManagerConfig } from './pipeline';

// ==================== SERVICES ====================
// Business logic services
export { StorageService } from './services/StorageService';
export {
  EmbeddingService,
  getSharedEmbeddingService,
  clearSharedEmbeddingServices,
  getSharedEmbeddingStats,
} from './services/EmbeddingService';
export { GeminiAIService } from './services/GeminiAIService';
export { QueryService } from './services/QueryService';
export { ClassifierService } from './services/ClassifierService';
export { MemoryIndexService } from './services/MemoryIndexService';
export { ViewService } from './services/ViewService';
export { TransactionService } from './services/TransactionService';
export { BatchService } from './services/BatchService';
export { CrossContextPermissionService } from './services/CrossContextPermissionService';
export { MemoryService } from './services/MemoryService';
export { VectorService } from './services/VectorService';
export { CapabilityService } from './services/CapabilityService';
export { IndexManager } from './services/IndexManager';
export type {
  IndexState,
  SerializedIndexPackage,
  IndexProgressCallback,
  IndexManagerOptions
} from './services/IndexManager';

// ==================== INFRASTRUCTURE ====================
// External integrations (use these instead of old paths)
export { WalrusStorageService, StorageManager } from './infrastructure/walrus';
export { SuiService, BlockchainManager } from './infrastructure/sui';
export { SealService } from './infrastructure/seal';
export { EncryptionService } from './infrastructure/seal';

// ==================== CORE ====================
// Core interfaces and base classes
export * from './core/interfaces';

// ==================== UTILITIES ====================
// Vector indexing and batch processing
export { VectorManager, createHnswService, isBrowser, isNode } from './vector';
export type { IHnswService, IHnswSearchResultItem, IHnswSearchOptions, IHnswBatchStats } from './vector';
export { BrowserHnswIndexService } from './vector/BrowserHnswIndexService';
export { BatchManager, BatchingService, MemoryProcessingCache } from './batch';
export { GraphService, KnowledgeGraphManager } from './graph';

// Memory retrieval, analytics, and decryption
export { MemoryRetrievalService, MemoryDecryptionPipeline } from './retrieval';
export type { 
  UnifiedMemoryQuery, 
  UnifiedMemoryResult, 
  RetrievalStats, 
  RetrievalContext,
  KeyServerConfig,
  DecryptionConfig,
  DecryptionRequest,
  DecryptionResult,
  BatchDecryptionResult
} from './retrieval';

// Configuration management
import { Config as ConfigClass } from './config';
export { ConfigurationHelper, Config } from './config';
export type { SDKConfig, EnvironmentConfig } from './config';

// Internal Config reference for use in this file
const Config = ConfigClass;

// Type exports for all modules
export type {
  Memory,
  ProcessedMemory,
  EmbeddingResult,
  EmbeddingConfig
} from './embedding/types';

export type {
  VectorSearchResult,
  HNSWIndexConfig
} from './vector';

export type {
  CacheConfig,
  CacheMetrics
} from './batch';

export type {
  Entity,
  Relationship,
  KnowledgeGraph
} from './graph';

// Infrastructure types - Walrus
export type {
  WalrusUploadResult,
  WalrusRetrievalResult,
  MemoryMetadata
} from './infrastructure/walrus/WalrusStorageService';

export type {
  StorageResult
} from './infrastructure/walrus/StorageManager';

// Infrastructure types - Sui
export type {
  MemoryRecord,
  TransactionResult
} from './infrastructure/sui/SuiService';

export type {
  OwnershipVerification,
  BlockchainStats
} from './infrastructure/sui/BlockchainManager';

// Utility exports - using imported classes above

/**
 * SDK Version Information
 */
export const SDK_VERSION = '1.0.0';
export const SDK_NAME = 'Personal Data Wallet SDK';

/**
 * Quick start configuration presets
 */
export const QuickStartConfigs = {
  /**
   * Basic configuration for simple memory processing
   */
  BASIC: {
    embedding: { 
      enableBatching: true, 
      batchSize: 10 
    },
    storage: { 
      enableEncryption: false,
      enableBatching: false
    },
    blockchain: { 
      enableOwnershipTracking: false 
    }
  } as PipelineConfig,

  /**
   * Full decentralized configuration with all features
   */
  DECENTRALIZED: {
    embedding: { 
      enableBatching: true, 
      batchSize: 20 
    },
    vector: { 
      enablePersistence: true,
      maxElements: 10000
    },
    graph: { 
      enableExtraction: true, 
      confidenceThreshold: 0.7 
    },
    storage: { 
      enableEncryption: true,
      enableBatching: true,
      network: 'testnet'
    },
    blockchain: { 
      enableOwnershipTracking: true,
      enableBatching: true,
      network: 'testnet'
    },
    enableRollback: true,
    enableMonitoring: true
  } as PipelineConfig,

  /**
   * High-performance configuration optimized for throughput
   */
  HIGH_PERFORMANCE: {
    embedding: { 
      enableBatching: true, 
      batchSize: 50 
    },
    batch: { 
      enableBatching: true, 
      batchSize: 100, 
      batchDelayMs: 2000 
    },
    vector: { 
      maxElements: 50000,
      enablePersistence: true
    },
    graph: { 
      enableExtraction: false // Disable for performance
    },
    storage: { 
      enableBatching: true,
      enableEncryption: false // Disable for performance
    },
    blockchain: { 
      enableBatching: true,
      enableOwnershipTracking: true
    },
    skipFailedSteps: true,
    maxRetryAttempts: 1,
    enableMonitoring: true
  } as PipelineConfig,

  /**
   * Development configuration with enhanced debugging
   */
  DEVELOPMENT: {
    embedding: { 
      enableBatching: false // Process individually for debugging
    },
    vector: { 
      maxElements: 1000 
    },
    graph: { 
      enableExtraction: true,
      confidenceThreshold: 0.5 // Lower threshold for testing
    },
    storage: { 
      enableEncryption: false,
      enableBatching: false
    },
    blockchain: { 
      enableOwnershipTracking: false, // Skip for dev
      enableBatching: false
    },
    enableRollback: true,
    enableMonitoring: true,
    skipFailedSteps: false,
    maxRetryAttempts: 0 // Fail fast for debugging
  } as PipelineConfig
};

/**
 * Create a pre-configured pipeline with quick start settings
 */
export function createQuickStartPipeline(
  preset: keyof typeof QuickStartConfigs,
  overrides: Partial<PipelineConfig> = {}
): MemoryPipeline {
  const baseConfig = QuickStartConfigs[preset];
  const mergedConfig = { ...baseConfig, ...overrides };
  
  // Auto-configure API key if not provided
  if (!mergedConfig.embedding?.apiKey) {
    try {
      // Config is already imported at top of file
      const apiKey = Config.getGeminiKey();
      mergedConfig.embedding = {
        ...mergedConfig.embedding,
        apiKey
      };
      console.log('✅ Auto-configured Gemini API key from environment');
    } catch (error) {
      console.warn('⚠️ No Gemini API key found. Please provide one for AI features to work.');
    }
  }
  
  return new MemoryPipeline(mergedConfig);
}

/**
 * Create a pipeline manager with recommended settings
 */
export function createPipelineManager(
  config: Partial<PipelineManagerConfig> = {}
): PipelineManager {
  const defaultConfig: PipelineManagerConfig = {
    maxConcurrentPipelines: 5,
    enableScheduling: true,
    enableHealthChecks: true,
    enableMetricsCollection: true,
    defaultPipelineConfig: QuickStartConfigs.BASIC
  };
  
  const mergedConfig = { ...defaultConfig, ...config };
  return new PipelineManager(mergedConfig);
}

/**
 * SDK Information and utilities
 */
export const SDK = {
  version: SDK_VERSION,
  name: SDK_NAME,
  
  /**
   * Get SDK build information
   */
  getBuildInfo(): {
    version: string;
    name: string;
    buildDate: string;
    features: string[];
  } {
    return {
      version: SDK_VERSION,
      name: SDK_NAME,
      buildDate: new Date().toISOString(),
      features: [
        'AI Embedding Generation',
        'HNSW Vector Indexing', 
        'Knowledge Graph Extraction',
        'Walrus Decentralized Storage',
        'Sui Blockchain Integration',
        'Unified Processing Pipeline',
        'Batch Processing & Caching',
        'Comprehensive Monitoring'
      ]
    };
  },

  /**
   * Validate configuration
   */
  validateConfig(config: PipelineConfig): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate embedding config
    if (config.embedding?.batchSize && config.embedding.batchSize > 100) {
      warnings.push('Large embedding batch size may cause memory issues');
    }

    // Validate vector config  
    if (config.vector?.maxElements && config.vector.maxElements > 100000) {
      warnings.push('Large vector index may impact performance');
    }

    // Validate network consistency
    if (config.storage?.network !== config.blockchain?.network) {
      warnings.push('Storage and blockchain networks should match');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
};

// Default export for convenience
export default {
  MemoryPipeline,
  PipelineManager,
  createQuickStartPipeline,
  createPipelineManager,
  QuickStartConfigs,
  SDK
};

// Client-side memory management for React dApps
export { ClientMemoryManager } from './client/ClientMemoryManager';
export { PersonalDataWallet } from './client/PersonalDataWallet';
export { SimplePDWClient } from './client/SimplePDWClient';
export type { SimplePDWConfig, ServiceContainer } from './client/SimplePDWClient';

// Signer abstractions for different environments
export {
  KeypairSigner,
  WalletAdapterSigner,
  DappKitSigner
} from './client/signers';
export type {
  UnifiedSigner,
  SignAndExecuteResult,
  SignPersonalMessageResult,
  WalletAdapter,
  DappKitSignerConfig,
  DappKitSignAndExecuteFn,
  DappKitSignPersonalMessageFn
} from './client/signers';
export type {
  ClientMemoryManagerConfig,
  CreateMemoryOptions as ClientCreateMemoryOptions,
  RetrieveMemoryOptions as ClientRetrieveMemoryOptions,
  BatchRetrieveMemoriesOptions as ClientBatchRetrieveMemoriesOptions,
  BatchRetrieveResult as ClientBatchRetrieveResult,
  ClientMemoryMetadata
} from './client/ClientMemoryManager';

// Wallet architecture components
/** @deprecated Use CapabilityService instead */
export { MainWalletService } from './wallet/MainWalletService';
/** @deprecated Use ContextNamespace instead */
export { ContextWalletService } from './wallet/ContextWalletService';
export { PermissionService } from './access/PermissionService';
export type { ConsentRepository } from './permissions/ConsentRepository';
export { FileSystemConsentRepository, InMemoryConsentRepository } from './permissions/ConsentRepository';
export { AggregationService } from './aggregation/AggregationService';
export type {
  MainWallet,
  ContextWallet,
  ConsentRequest,
  ConsentRequestRecord,
  ConsentStatus,
  AccessGrant,
  CreateMainWalletOptions,
  CreateContextWalletOptions,
  DeriveContextIdOptions,
  RotateKeysOptions,
  RotateKeysResult,
  PermissionScope,
  RequestConsentOptions,
  GrantPermissionsOptions,
  RevokePermissionsOptions,
  AggregatedQueryOptions,
  PermissionScopes
} from './core/types/wallet';

// Legacy version for compatibility
export const VERSION = '1.0.0';

// Rebuild utility (Browser)
export { rebuildIndex, hasExistingIndex, clearIndex } from './utils/rebuildIndex';
export type { RebuildIndexOptions, RebuildIndexResult } from './utils/rebuildIndex';

// Rebuild utility (Node.js)
export { rebuildIndexNode, hasExistingIndexNode, clearIndexNode } from './utils/rebuildIndexNode';
export type { RebuildIndexNodeOptions, RebuildIndexNodeResult } from './utils/rebuildIndexNode';

// MemoryIndex on-chain utilities
export {
  getMemoryIndex,
  updateMemoryIndexOnChain,
  createMemoryIndexOnChain,
  syncIndexAndUpdateOnChain,
  uploadPlaceholderToWalrus
} from './utils/memoryIndexOnChain';
export type {
  OnChainMemoryIndex,
  GetMemoryIndexOptions,
  UpdateMemoryIndexOnChainOptions,
  CreateMemoryIndexOnChainOptions,
  UpdateMemoryIndexResult,
  CreateMemoryIndexResult,
  SyncAndUpdateOptions,
  SyncAndUpdateResult
} from './utils/memoryIndexOnChain';

// ==================== AI SDK INTEGRATION ====================
// AI SDK tools and vector store for Vercel AI SDK integration
export { pdwTools } from './ai-sdk/tools';
export type { PDWToolsConfig, PDWToolResult } from './ai-sdk/tools';
export { PDWVectorStore as AIPDWVectorStore } from './ai-sdk/PDWVectorStore';
export type {
  PDWVectorStoreConfig as AIPDWVectorStoreConfig,
  AddVectorParams,
  SearchParams as AISearchParams,
  SearchResult as AISearchResult
} from './ai-sdk/types';

// ==================== LANGCHAIN INTEGRATION ====================
// LangChain adapters for RAG workflows with decentralized storage
export { PDWEmbeddings } from './langchain/PDWEmbeddings';
export type { PDWEmbeddingsParams } from './langchain/PDWEmbeddings';
export { PDWVectorStore } from './langchain/PDWVectorStore';
export type { PDWVectorStoreConfig, PDWAddDocumentOptions } from './langchain/PDWVectorStore';
