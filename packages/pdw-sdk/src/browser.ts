/**
 * Personal Data Wallet SDK - Browser Entry Point
 *
 * This entry point excludes React hooks and other Node.js-specific exports
 * for use in vanilla browser environments without React.
 *
 * For React applications, use the main 'pdw-sdk' import instead.
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

// ==================== SERVICES ====================
export { StorageService } from './services/StorageService';
export { EmbeddingService } from './services/EmbeddingService';
export { GeminiAIService } from './services/GeminiAIService';
export { QueryService } from './services/QueryService';
export { ClassifierService } from './services/ClassifierService';
export { MemoryIndexService } from './services/MemoryIndexService';
export { ViewService } from './services/ViewService';
export { TransactionService } from './services/TransactionService';
export { BatchService } from './services/BatchService';
export { ChatService } from './services/ChatService';
export { CrossContextPermissionService } from './services/CrossContextPermissionService';
export { MemoryService } from './services/MemoryService';
export { VectorService } from './services/VectorService';
export { CapabilityService } from './services/CapabilityService';

// ==================== INFRASTRUCTURE ====================
export { WalrusStorageService, StorageManager } from './infrastructure/walrus';
export { SuiService, BlockchainManager } from './infrastructure/sui';
export { SealService } from './infrastructure/seal';
export { EncryptionService } from './infrastructure/seal';

// ==================== CORE ====================
export * from './core/interfaces';

// ==================== UTILITIES ====================
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
export { ConfigurationHelper, Config } from './config';
export type { SDKConfig, EnvironmentConfig } from './config';

// Type exports
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

// SDK Version
export const SDK_VERSION = '1.0.0';
export const SDK_NAME = 'Personal Data Wallet SDK (Browser)';

// Client-side memory management (without React)
export { ClientMemoryManager } from './client/ClientMemoryManager';
export { PersonalDataWallet } from './client/PersonalDataWallet';
export type {
  ClientMemoryManagerConfig,
  CreateMemoryOptions as ClientCreateMemoryOptions,
  RetrieveMemoryOptions as ClientRetrieveMemoryOptions,
  BatchRetrieveMemoriesOptions as ClientBatchRetrieveMemoriesOptions,
  BatchRetrieveResult as ClientBatchRetrieveResult,
  ClientMemoryMetadata
} from './client/ClientMemoryManager';

// Wallet architecture components
export { MainWalletService } from './wallet/MainWalletService';
export { ContextWalletService } from './wallet/ContextWalletService';
export { PermissionService } from './access/PermissionService';
export type { ConsentRepository } from './permissions/ConsentRepository';
export {
  InMemoryConsentRepository,
  IndexedDBConsentRepository,
  createConsentRepository
} from './permissions/ConsentRepository';
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

// Re-export common types from core for convenience
export type {
  ChatSession,
  ChatMessage,
  MemorySearchOptions,
  MemorySearchResult
} from './core/types';
