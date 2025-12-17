/**
 * Core Module - Barrel Export
 *
 * Re-exports all core types, interfaces, and base classes for the PDW SDK.
 */

// Re-export core interfaces and base classes
export * from './interfaces';

// Re-export types
export * from './types';

/**
 * Core TypeScript types for Personal Data Wallet SDK
 */

import type { Transaction, TransactionArgument } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';

// Base configuration for the SDK
export interface PDWConfig {
  /** Package ID for the deployed Move contracts */
  packageId?: string;
  /** Default encryption options */
  encryptionConfig?: EncryptionConfig;
  /** Storage configuration */
  storageConfig?: StorageConfig;
  /** Walrus storage configuration */
  walrusPublisherUrl?: string;
  walrusAggregatorUrl?: string;
  walrusMaxFileSize?: number;
  walrusTimeout?: number;
}

// Batch processing types
export interface BatchConfig {
  batchSize: number;
  delayMs: number;
}

export interface BatchStats {
  totalBatches: number;
  totalItems: number;
  averageBatchSize: number;
  totalProcessingTime: number;
  averageProcessingTime: number;
  successCount: number;
  errorCount: number;
  lastProcessed: Date;
  pendingBatches: number;
  processedToday: number;
}

// Memory operations
export interface MemoryCreateOptions {
  content: string;
  category: string;
  userAddress: string;
  topic?: string;
  importance?: number;
  customMetadata?: Record<string, string>;
  signer?: Signer;
  encrypt?: boolean;
  metadata?: Record<string, any>;
}

export interface MemoryContextOptions {
  query_text: string;
  user_address: string;
  user_signature?: string;
  k?: number;
}

export interface MemorySearchOptions {
  query: string;
  userAddress: string;
  category?: string;
  k?: number;
  includeContent?: boolean;
  threshold?: number; // Similarity threshold (0.0-1.0)
  userSignature?: string;
  includeMetadata?: boolean;
  timeRange?: {
    start?: string; // ISO date string
    end?: string;   // ISO date string
  };
}

export interface MemorySearchResult {
  id: string;
  content?: string;
  category: string;
  timestamp: string;
  similarity_score?: number;
  isEncrypted: boolean;
  owner: string;
  blobId?: string;
  vectorId?: number;
  embeddings?: {
    content?: number[];
    metadata?: number[];
    dimension?: number;
  };
  metadata?: Record<string, any>;
  importance?: number;
  topic?: string;
}

// Advanced Memory Features - Embeddings & Vector Search
export interface EmbeddingOptions {
  text: string;
  type?: 'content' | 'metadata' | 'query';
  userAddress: string;
}

export interface BasicEmbeddingResult {
  embeddings: number[];
  dimension: number;
  model: string;
  processingTime: number;
}

export interface VectorSearchOptions {
  queryVector: number[];
  userAddress: string;
  k?: number;
  efSearch?: number;
  category?: string;
  minSimilarity?: number;
}

export interface VectorSearchResult {
  results: Array<{
    memoryId: string;
    vectorId: number;
    similarity: number;
    distance: number;
    metadata?: any;
  }>;
  searchStats: {
    searchTime: number;
    nodesVisited: number;
    exactMatches: number;
    approximateMatches: number;
  };
}

export interface MemoryWithEmbeddingsOptions {
  content: string;
  category: string;
  topic?: string;
  importance?: number;
  userAddress: string;
  signer?: any;
  customMetadata?: Record<string, string>;
  generateEmbeddings?: boolean;
}

export interface MemoryWithEmbeddingsResult {
  memoryId: string;
  embeddings?: {
    content: number[];
    metadata: number[];
  };
  processingStats: {
    totalTime: number;
    embeddingTime: number;
    storageTime: number;
    blockchainTime: number;
  };
}

export interface MemoryWithContextOptions {
  memoryId: string;
  userAddress: string;
  includeRelated?: boolean;
  relatedCount?: number;
  contextRadius?: number;
}

export interface MemoryWithContextResult {
  memory: MemorySearchResult;
  relatedMemories?: MemorySearchResult[];
  contextGraph?: {
    nodes: Array<{ id: string; label: string; category: string }>;
    edges: Array<{ from: string; to: string; similarity: number }>;
  };
}

export interface BatchMemoryOptions {
  memories: Array<{
    content: string;
    category: string;
    topic?: string;
    importance?: number;
  }>;
  userAddress: string;
  batchSize?: number;
  generateEmbeddings?: boolean;
}

export interface BatchMemoryResult {
  results: Array<{
    success: boolean;
    memoryId?: string;
    error?: string;
  }>;
  batchStats: {
    totalProcessed: number;
    successful: number;
    failed: number;
    totalTime: number;
    averageTimePerMemory: number;
  };
}

export interface MemoryContext {
  context: string;
  relevantMemories: MemorySearchResult[];
  queryMetadata: {
    queryTimeMs: number;
    memoriesFound: number;
    contextLength: number;
  };
}

// ==================== VECTOR EMBEDDING INTERFACES ====================

export interface VectorEmbedding {
  vector: number[];
  dimension: number;
  model: string; // e.g., 'text-embedding-ada-002', 'gemini-embedding'
  metadata?: {
    contentType?: string;
    category?: string;
    timestamp?: number;
    source?: string;
  };
}

export interface EmbeddingOptions {
  model?: string;
  dimension?: number; // Default 768 for Gemini
  normalize?: boolean;
  batchSize?: number; // For batch processing
}

export interface EmbeddingResult {
  embedding: VectorEmbedding;
  tokenCount?: number;
  processingTimeMs?: number;
}

export interface VectorSearchOptions {
  vector: number[];
  k?: number;
  threshold?: number; // Similarity threshold
  category?: string;
  timeRange?: {
    start?: number;
    end?: number;
  };
  includeMetadata?: boolean;
}

export interface VectorSearchMatch {
  memoryId: string;
  similarity: number;
  distance: number;
  embedding?: VectorEmbedding;
  memory?: MemorySearchResult;
}

export interface HNSWIndexOptions {
  dimension: number;
  maxElements: number;
  efConstruction?: number; // Default 200
  m?: number; // Default 16
  randomSeed?: number;
  allowReplaceDeleted?: boolean;
}

export interface HNSWIndexStats {
  totalElements: number;
  dimension: number;
  maxElements: number;
  efConstruction: number;
  m: number;
  currentElementCount: number;
  deletedElementCount?: number;
}

export interface BatchEmbeddingJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  userAddress: string;
  memories: Array<{
    memoryId: string;
    content: string;
    category: string;
  }>;
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

// Chat operations
export interface ChatOptions {
  text: string;
  userId: string;
  sessionId?: string;
  model?: string;
  userAddress?: string;
  memoryContext?: string;
  enableMemoryContext?: boolean;
  maxMemoryContext?: number;
  signer?: Signer;
}

export interface ChatStreamEvent {
  type: 'start' | 'chunk' | 'end' | 'error';
  content?: string;
  intent?: string;
  memoryStored?: boolean;
  memoryId?: string;
  memoryExtraction?: any;
  relevantMemories?: MemorySearchResult[];
  message?: string;
}

export interface CreateSessionOptions {
  userAddress: string;
  title?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  memoryContext?: MemoryContext;
}

export interface ChatSession {
  id: string;
  userAddress: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// Storage operations (unified interface)
export interface StorageConfig {
  provider?: 'walrus' | 'local';
  cacheEnabled?: boolean;
  encryptionEnabled?: boolean;
}

export interface StorageUploadResult {
  blobId: string;
  size: number;
  contentHash?: string;
}

// Encryption configuration
export interface EncryptionConfig {
  enabled: boolean;
  keyServers?: string[];
  policyConfig?: Record<string, any>;
}

// View query result types
export interface MemoryRecord {
  id: string;
  owner: string;
  category: string;
  vectorId: number;
  blobId: string;
  contentType: string;
  contentSize: number;
  contentHash: string;
  topic: string;
  importance: number;
  embeddingBlobId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryIndex {
  id: string;
  owner: string;
  version: number;
  indexBlobId: string;
  graphBlobId: string;
  memoryCount: number;
  lastUpdated: number;
}

export interface MemoryStats {
  totalMemories: number;
  categoryCounts: Record<string, number>;
  totalSize: number;
  averageImportance: number;
  lastActivityTime: number;
}

export interface AccessPermission {
  id: string;
  grantor: string;
  grantee: string;
  contentId: string;
  permissionType: string;
  expiresAt?: number;
  createdAt: number;
  isActive: boolean;
}

export interface ContentRegistry {
  id: string;
  owner: string;
  contentHash: string;
  encryptionInfo: string;
  accessCount: number;
  createdAt: number;
}

// Transaction builder types
export type TransactionThunk = (tx: Transaction) => TransactionArgument | Promise<TransactionArgument>;
export type AsyncTransactionThunk = (tx: Transaction) => Promise<TransactionArgument>;

// API response types
export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface MemoryStatsResponse {
  totalMemories: number;
  categoryCounts: Record<string, number>;
  totalSize: number;
  lastUpdated: string;
}

// BatchStats interface moved above to avoid duplication

// Client extension types
export interface ClientWithCoreApi {
  core: {
    getObject: (objectId: string) => Promise<any>;
    getObjects: (objectIds: string[]) => Promise<any[]>;
    executeTransaction: (tx: any) => Promise<any>;
  };
  $extend: <T>(extension: T) => any;
}

// Storage types
export interface WalrusQuiltFile {
  identifier: string;
  content: Uint8Array | string;
  tags?: Record<string, string>;
}

export interface QuiltUploadResult {
  quiltId: string;
  files: Array<{
    identifier: string;
    blobId: string;
  }>;
  metadata?: Record<string, string>;
}

// Encryption types
export interface EncryptionResult {
  encryptedData: Uint8Array;
  backupKey: Uint8Array;
  sessionKey?: any;
}

export interface DecryptionOptions {
  encryptedData: Uint8Array;
  userAddress: string;
  sessionKey?: any;
  signedTxBytes?: Uint8Array;
}

// SEAL-specific encryption types
export interface SealEncryptionResult {
  encryptedData: string;
  backupKey: string;
  contentHash: string;
}

export interface SealDecryptionOptions {
  encryptedData: string;
  userAddress: string;
  sessionKey?: any; // SessionKey from @mysten/seal
  signedTxBytes?: Uint8Array;
}

export interface AccessGrantOptions {
  ownerAddress: string;
  recipientAddress: string;
  contentId: string;
  accessLevel: 'read' | 'write';
  expiresIn?: number;
}

export interface AccessRevokeOptions {
  ownerAddress: string;
  recipientAddress: string;
  contentId: string;
}

// Error handling types
export type ErrorCategory = 
  | 'validation'
  | 'blockchain'
  | 'storage' 
  | 'encryption'
  | 'network'
  | 'configuration'
  | 'authentication'
  | 'permission';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ErrorObject {
  name: string;
  message: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  context?: Record<string, any>;
  timestamp: string;
  stack?: string;
  originalError?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface AccessControlOptions {
  memoryId: string;
  grantee: string;
  accessLevel: 'read' | 'write';
  expiresIn?: number;
}

// Utility types
export type Thunk<T = any> = (tx: any) => T;
export type AsyncThunk<T = any> = (tx: any) => Promise<T>;

// Client extension interface
export interface PDWClientExtension {
  // Top-level imperative methods
  createMemory: (options: MemoryCreateOptions) => Promise<string>;
  searchMemories: (options: MemorySearchOptions) => Promise<MemorySearchResult[]>;
  getMemoryContext: (query: string, userAddress: string) => Promise<MemoryContext>;
  
  // Transaction builders
  tx: {
    createMemoryRecord: (options: Omit<MemoryCreateOptions, 'signer'>) => Promise<Transaction>;
    deleteMemory: (memoryId: string) => Promise<Transaction>;
    updateMemoryIndex: (indexId: string, options: any) => Promise<Transaction>;
  };
  
  // Move call builders (for transaction composition)
  call: {
    createMemoryRecord: (options: any) => TransactionThunk;
    deleteMemory: (memoryId: string) => TransactionThunk;
    updateMemoryIndex: (indexId: string, options: any) => TransactionThunk;
  };
  
  // View/query methods
  view: {
    getUserMemories: (userAddress: string) => Promise<MemorySearchResult[]>;
    getMemoryIndex: (userAddress: string) => Promise<any>;
    getMemory: (memoryId: string) => Promise<MemorySearchResult | null>;
  };
  
  // BCS types (will be populated by generated code)
  bcs: Record<string, any>;
}

// Chat System Types
export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'memory';
  content: string;
  timestamp?: string;
  memoryId?: string;
  walrusHash?: string;
  metadata?: Record<string, any>;
}

export interface ChatSession {
  id: string;
  title: string;
  owner: string;
  summary?: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
  message_count: number;
  sui_object_id?: string;
  metadata?: Record<string, any>;
}

export interface ChatMessageRequest {
  text: string;
  userId: string;
  sessionId?: string;
  model?: string;
  originalUserMessage?: string;
  memoryContext?: string;
  userAddress?: string;
}

export interface ChatMessageResponse {
  content: string;
  type: string;
  memoryExtraction?: any;
  memoryStored?: boolean;
  memoryId?: string;
}

export interface CreateChatSessionRequest {
  userAddress: string;
  title?: string;
  modelName: string;
  suiObjectId?: string;
}

export interface ChatSessionResponse {
  session: ChatSession;
  success: boolean;
  message?: string;
}

export interface ChatSessionsResponse {
  success: boolean;
  sessions: ChatSession[];
  message?: string;
}

export interface StreamChatEvent {
  type: 'message' | 'memory' | 'error' | 'done' | 'thinking';
  data: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface UpdateSessionTitleRequest {
  userAddress: string;
  title: string;
}

export interface AddMessageRequest {
  content: string;
  type: 'user' | 'assistant' | 'system';
  userAddress: string;
  memoryId?: string;
  metadata?: Record<string, any>;
}

export interface SaveSummaryRequest {
  sessionId: string;
  summary: string;
  userAddress: string;
}

export interface ChatStreamOptions {
  onMessage?: (event: StreamChatEvent) => void;
  onThinking?: (event: StreamChatEvent) => void;
  onMemory?: (event: StreamChatEvent) => void;
  onError?: (event: StreamChatEvent) => void;
  onDone?: () => void;
  abortController?: AbortController;
}

// Storage System Types
export interface StorageMetadata {
  contentType: string;
  size: number;
  tags: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  encrypted: boolean;
  compressionType?: 'gzip' | 'brotli' | 'none';
  checksumSha256: string;
}

export interface StorageOptions {
  provider?: 'walrus' | 'local';
  encrypt?: boolean;
  compress?: 'gzip' | 'none'; // Remove brotli as it's not widely supported
  tags?: Record<string, string>;
  cacheLocally?: boolean;
  cacheExpiry?: number; // milliseconds
  retryAttempts?: number;
}

export interface StorageResult {
  blobId: string;
  walrusUrl: string;
  metadata: StorageMetadata;
  cached: boolean;
  processingTimeMs: number;
}

export interface RetrieveOptions {
  useCache?: boolean;
  decrypt?: boolean;
  decompress?: boolean;
  maxCacheAge?: number; // milliseconds
}

export interface RetrieveResult {
  content: Uint8Array | string;
  metadata: StorageMetadata;
  fromCache: boolean;
  retrievalTimeMs: number;
}

export interface StorageStats {
  totalItems: number;
  totalSize: number;
  cacheSize: number;
  cacheHitRate: number;
  averageStorageTime: number;
  averageRetrievalTime: number;
}

export interface WalrusConfig {
  publisherUrl: string;
  aggregatorUrl: string;
  maxFileSize?: number; // bytes, default 1GB
  timeout?: number; // milliseconds, default 30s
}

export interface CacheEntry {
  content: Uint8Array | string;
  metadata: StorageMetadata;
  cachedAt: number;
  accessCount: number;
  lastAccessed: number;
}

export interface StorageFilter {
  tags?: Record<string, string>;
  contentType?: string;
  minSize?: number;
  maxSize?: number;
  createdAfter?: string;
  createdBefore?: string;
  encrypted?: boolean;
}

// Transaction Types
export interface TransactionOptions {
  /** Gas budget for the transaction */
  gasBudget?: number;
  /** Gas price override */
  gasPrice?: number;
  /** Sender address override (defaults to signer address) */
  sender?: string;
}

export interface TransactionResult {
  /** Transaction digest */
  digest: string;
  /** Transaction effects */
  effects?: any;
  /** Created objects */
  createdObjects?: Array<{ objectId: string; objectType: string }>;
  /** Mutated objects */
  mutatedObjects?: Array<{ objectId: string; objectType: string }>;
  /** Deleted objects */
  deletedObjects?: string[];
  /** Gas used */
  gasUsed?: number;
  /** Transaction status */
  status: 'success' | 'failure';
  /** Error message if failed */
  error?: string;
}

// Memory Transaction Types
export interface CreateMemoryRecordTxOptions extends TransactionOptions {
  category: string;
  vectorId: number | bigint;
  blobId: string;
  contentType: string;
  contentSize: number | bigint;
  contentHash: string;
  topic: string;
  importance: number;
  embeddingBlobId: string;
}

export interface UpdateMemoryMetadataTxOptions extends TransactionOptions {
  memoryId: string;
  metadataBlobId: string;
  embeddingDimension: number;
}

export interface DeleteMemoryRecordTxOptions extends TransactionOptions {
  memoryId: string;
}

export interface CreateMemoryIndexTxOptions extends TransactionOptions {
  indexBlobId: string;
  graphBlobId: string;
}

export interface UpdateMemoryIndexTxOptions extends TransactionOptions {
  /** MemoryIndex object ID on-chain */
  indexId: string;
  /** Expected version for optimistic locking (must match current on-chain version) */
  expectedVersion: number;
  /** New index blob ID on Walrus */
  newIndexBlobId: string;
  /** New graph blob ID on Walrus */
  newGraphBlobId: string;
}

// Access Control Transaction Types
export interface GrantAccessTxOptions extends TransactionOptions {
  contentId: string;
  recipient: string;
  permissions: number[];
  expirationTime?: number;
}

export interface RevokeAccessTxOptions extends TransactionOptions {
  contentId: string;
  recipient: string;
}

export interface RegisterContentTxOptions extends TransactionOptions {
  contentHash: string;
  encryptionKey: string;
  accessPolicy: number[];
}