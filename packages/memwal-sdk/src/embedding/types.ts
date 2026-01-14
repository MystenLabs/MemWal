/**
 * Advanced Embedding Types for PDW SDK
 * 
 * Comprehensive type definitions for vector embedding operations,
 * HNSW indexing, and AI-powered similarity search.
 */

// Core embedding interfaces
export interface VectorEmbedding {
  vector: number[];
  dimension: number;
  model: string;
  metadata?: {
    contentType?: string;
    category?: string;
    timestamp?: number;
    source?: string;
  };
}

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  requestsPerMinute?: number;
}

export interface EmbeddingOptions {
  text: string;
  type?: 'content' | 'metadata' | 'query';
  taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'SEMANTIC_SIMILARITY';
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  model: string;
  processingTime: number;
  tokenCount?: number;
}

export interface BatchEmbeddingResult {
  vectors: number[][];
  dimension: number;
  model: string;
  totalProcessingTime: number;
  averageProcessingTime: number;
  successCount: number;
  failedCount: number;
}

// HNSW Index interfaces
export interface HNSWIndexConfig {
  dimension: number;
  maxElements?: number;
  efConstruction?: number;
  m?: number;
  randomSeed?: number;
  spaceType?: 'cosine' | 'l2' | 'ip';
}

export interface HNSWIndexEntry {
  id: number;
  vector: number[];
  metadata?: Record<string, any>;
}

export interface HNSWSearchResult {
  ids: number[];
  distances: number[];
  similarities?: number[];
}

export interface HNSWSearchOptions {
  k?: number;
  efSearch?: number;
  filter?: (metadata: any) => boolean;
}

// Batch processing interfaces
export interface BatchConfig {
  maxBatchSize?: number;
  batchDelayMs?: number;
  maxCacheSize?: number;
  cacheTtlMs?: number;
}

export interface BatchJob {
  userAddress: string;
  vectors: Map<number, number[]>;
  scheduledAt: Date;
  metadata?: Map<number, any>;
}

export interface BatchStats {
  totalUsers: number;
  totalPendingVectors: number;
  activeBatchJobs: number;
  cacheHitRate: number;
  averageBatchSize: number;
  averageProcessingTime: number;
}

// Knowledge graph interfaces
export interface Entity {
  id: string;
  label: string;
  type: string;
  confidence?: number;
  properties?: Record<string, any>;
}

export interface Relationship {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  confidence?: number;
  properties?: Record<string, any>;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relationships: Relationship[];
  metadata?: {
    version: number;
    lastUpdated: Date;
    totalEntities: number;
    totalRelationships: number;
  };
}

export interface GraphExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
  processingTime: number;
  confidence: number;
}

// Memory data structures
export interface Memory {
  id: string;
  content: string;
  category?: string;
  createdAt?: Date;
  userId?: string;
  metadata?: Record<string, any>;
  tags?: string[];
  embeddings?: number[];
}

export interface ProcessedMemory extends Memory {
  embedding?: number[];
  embeddingModel?: string;
  processedAt?: Date;
  vectorId?: number;
  blobId?: string;
  encryptionKeyId?: string;
}

// Memory pipeline interfaces
export interface MemoryPipelineConfig {
  enableClassification?: boolean;
  enableEmbeddings?: boolean;
  enableGraphExtraction?: boolean;
  enableEncryption?: boolean;
  batchConfig?: BatchConfig;
  embeddingConfig?: EmbeddingConfig;
}

export interface MemoryPipelineResult {
  success: boolean;
  memoryId?: string;
  vectorId?: number;
  blobId?: string;
  embeddingBlobId?: string;
  graphBlobId?: string;
  processingStats: {
    totalTime: number;
    classificationTime: number;
    embeddingTime: number;
    indexingTime: number;
    graphTime: number;
    encryptionTime: number;
    storageTime: number;
  };
  errors?: string[];
}

// Advanced storage interfaces
export interface EnhancedStorageMetadata {
  contentType: string;
  contentSize: number;
  contentHash: string;
  category: string;
  topic?: string;
  importance?: number;
  embeddingBlobId?: string;
  embeddingDimension?: number;
  hasKnowledgeGraph?: boolean;
  graphBlobId?: string;
  createdTimestamp: number;
  updatedTimestamp?: number;
  customMetadata?: Record<string, string>;
}

export interface MetadataSearchOptions {
  query: string;
  threshold?: number;
  limit?: number;
  category?: string;
  minImportance?: number;
  timeRange?: {
    start?: Date;
    end?: Date;
  };
}

export interface MetadataSearchResult {
  blobId: string;
  content?: string;
  metadata: EnhancedStorageMetadata;
  similarity: number;
  rank: number;
}

// Vector search interfaces
export interface VectorSearchOptions {
  queryVector: number[];
  userAddress: string;
  k?: number;
  efSearch?: number;
  category?: string;
  minSimilarity?: number;
  includeMetadata?: boolean;
  timeFilter?: {
    start?: Date;
    end?: Date;
  };
}

export interface VectorSearchMatch {
  memoryId: string;
  vectorId: number;
  similarity: number;
  distance: number;
  embedding?: VectorEmbedding;
  metadata?: any;
}

export interface VectorSearchResult {
  results: VectorSearchMatch[];
  searchStats: {
    searchTime: number;
    nodesVisited: number;
    exactMatches: number;
    approximateMatches: number;
    cacheHits: number;
    indexSize: number;
  };
}

// Error interfaces
export interface EmbeddingError extends Error {
  code: 'API_ERROR' | 'RATE_LIMIT' | 'INVALID_INPUT' | 'DIMENSION_MISMATCH' | 'NETWORK_ERROR';
  details?: any;
}

export interface VectorError extends Error {
  code: 'INDEX_ERROR' | 'SEARCH_ERROR' | 'STORAGE_ERROR' | 'VALIDATION_ERROR';
  details?: any;
}

// Utility types
export type VectorDistance = 'cosine' | 'euclidean' | 'manhattan' | 'dot_product';
export type EmbeddingModel = 'text-embedding-004' | 'text-embedding-3-large' | 'text-embedding-3-small';
export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

// Configuration validation
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Batch processing results
export interface MemoryBatchResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  totalTime: number;
  averageTime: number;
  errors?: string[];
  results: MemoryPipelineResult[];
}

// Enhanced memory metadata
export interface MemoryMetadata {
  id: string;
  category: string;
  importance?: number;
  tags?: string[];
  topic?: string;
  createdAt: Date;
  updatedAt?: Date;
  size: number;
  embeddingModel?: string;
  vectorId?: number;
  customFields?: Record<string, any>;
}

// Search similarity result
export interface SimilarityResult {
  id: string;
  similarity: number;
  distance: number;
  metadata?: any;
}

// Vector operation result
export interface VectorOperationResult {
  success: boolean;
  vectorId?: number;
  operation: 'add' | 'update' | 'delete' | 'search';
  processingTime: number;
  error?: string;
}

// Vector statistics
export interface VectorStats {
  totalVectors: number;
  dimension: number;
  avgSimilarity: number;
  indexSize: number;
  lastUpdated: Date;
}

// Index statistics  
export interface IndexStats {
  totalEntries: number;
  dimension: number;
  memoryUsage: number;
  searchPerformance: {
    avgSearchTime: number;
    avgNodesVisited: number;
  };
}

// Vector search stats
export interface VectorSearchStats {
  searchTime: number;
  nodesVisited: number;
  cacheHits: number;
  totalResults: number;
}

// Note: Using individual named exports instead of default export