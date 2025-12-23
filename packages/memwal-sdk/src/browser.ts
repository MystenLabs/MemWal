/**
 * Personal Data Wallet SDK - Browser Entry Point
 *
 * This entry point provides browser-safe exports that don't require Node.js modules.
 * Exports that depend on Node.js (fs, hnswlib-node) are excluded.
 *
 * For Node.js applications, use the main '@cmdoss/memwal-sdk' import instead.
 */

// ==================== SERVICES (Browser-safe) ====================
export { StorageService } from './services/StorageService';
export { EmbeddingService } from './services/EmbeddingService';
export { GeminiAIService } from './services/GeminiAIService';
export { QueryService } from './services/QueryService';
export { ClassifierService } from './services/ClassifierService';
// Note: MemoryIndexService excluded - depends on createHnswService which imports hnswlib-node
export { ViewService } from './services/ViewService';
export { TransactionService } from './services/TransactionService';
export { BatchService } from './services/BatchService';
export { CrossContextPermissionService } from './services/CrossContextPermissionService';
export { MemoryService } from './services/MemoryService';
// Note: VectorService excluded - depends on HNSW which imports hnswlib-node
export { CapabilityService } from './services/CapabilityService';

// ==================== INFRASTRUCTURE ====================
export { WalrusStorageService, StorageManager } from './infrastructure/walrus';
export { SuiService, BlockchainManager } from './infrastructure/sui';
export { SealService } from './infrastructure/seal';
export { EncryptionService } from './infrastructure/seal';

// ==================== CORE ====================
export * from './core/interfaces';

// ==================== UTILITIES (Browser-safe) ====================
// Note: VectorManager excluded - depends on createHnswService which imports hnswlib-node
// Import directly from specific files to avoid loading Node.js dependencies
export { isBrowser, isNode } from './vector/IHnswService';
export type { IHnswService, IHnswSearchResultItem, IHnswSearchOptions, IHnswBatchStats } from './vector/IHnswService';
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
export { ConfigurationHelper, Config } from './config';
export type { SDKConfig, EnvironmentConfig } from './config';

// Type exports
export type {
  Memory,
  ProcessedMemory,
  EmbeddingResult,
  EmbeddingConfig
} from './embedding/types';

// Import from embedding/types directly to avoid loading vector/index.ts
export type {
  VectorSearchResult,
  HNSWIndexConfig
} from './embedding/types';

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

// SDK Version
export const SDK_VERSION = '1.0.0';
export const SDK_NAME = 'Personal Data Wallet SDK (Browser)';

// Client-side memory management (without React)
// NOTE: ClientMemoryManager excluded from browser entry - it uses createHnswService
// which imports Node.js modules. Use SimplePDWClient for browser apps instead.
// export { ClientMemoryManager } from './client/ClientMemoryManager';
export { PersonalDataWallet } from './client/PersonalDataWallet';
// Types can still be exported (no runtime code)
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
// Import from browser-safe file to avoid loading FileSystemConsentRepository with fs/promises
export type { ConsentRepository } from './permissions/ConsentRepository.browser';
export {
  InMemoryConsentRepository,
  IndexedDBConsentRepository,
  createBrowserConsentRepository
} from './permissions/ConsentRepository.browser';
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

// Rebuild utility
export { rebuildIndex, hasExistingIndex, clearIndex } from './utils/rebuildIndex';
export type { RebuildIndexOptions, RebuildIndexResult } from './utils/rebuildIndex';

// ==================== AI SDK INTEGRATION ====================
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
export { PDWEmbeddings } from './langchain/PDWEmbeddings';
export type { PDWEmbeddingsParams } from './langchain/PDWEmbeddings';
export { PDWVectorStore } from './langchain/PDWVectorStore';
export type { PDWVectorStoreConfig, PDWAddDocumentOptions } from './langchain/PDWVectorStore';

// ==================== SIMPLE CLIENT ====================
// SimplePDWClient - main browser client with high-level API
export { SimplePDWClient } from './client/SimplePDWClient';
export type { SimplePDWConfig } from './client/SimplePDWClient';

// ==================== SIGNERS ====================
// DappKitSigner - adapter for @mysten/dapp-kit wallet signing
export { DappKitSigner } from './client/signers/DappKitSigner';
export type { DappKitSignerConfig, DappKitSignAndExecuteFn, DappKitSignPersonalMessageFn } from './client/signers/DappKitSigner';
export { WalletAdapterSigner } from './client/signers/WalletAdapterSigner';
export type { UnifiedSigner, SignAndExecuteResult, SignPersonalMessageResult } from './client/signers/UnifiedSigner';

// Re-export common types from core for convenience
export type {
  ChatSession,
  ChatMessage,
  MemorySearchOptions,
  MemorySearchResult
} from './core/types';
