/**
 * AI SDK Integration Types
 *
 * Type definitions for the PDW Vector Store adapter designed for
 * seamless integration with Vercel AI SDK and other AI frameworks.
 *
 * Provides a familiar API similar to Pinecone/Chroma while leveraging
 * PDW's full capabilities: Walrus storage, Sui blockchain, knowledge graphs,
 * and optional SEAL encryption.
 *
 * @module ai-sdk/types
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import type { SealService } from '../infrastructure/seal/SealService';

/**
 * Configuration for initializing PDWVectorStore
 */
export interface PDWVectorStoreConfig {
  /**
   * Walrus storage configuration
   */
  walrus: {
    /** Walrus aggregator URL for reading blobs */
    aggregator: string;
    /** Walrus publisher URL for writing blobs (optional, defaults to aggregator) */
    publisher?: string;
  };

  /**
   * Sui blockchain configuration
   */
  sui: {
    /** Network to use: 'testnet', 'mainnet', or 'devnet' */
    network: 'testnet' | 'mainnet' | 'devnet';
    /** PDW package ID deployed on Sui */
    packageId: string;
    /** Optional: Pre-configured SuiClient (created automatically if not provided) */
    client?: SuiClient;
  };

  /**
   * User identity and signing
   */
  signer: Signer;
  userAddress: string;

  /**
   * Vector configuration
   */
  dimensions: number;
  distanceMetric?: 'cosine' | 'euclidean' | 'ip';

  /**
   * Optional features
   */
  features?: {
    /** Enable SEAL encryption for stored content (default: false) */
    encryption?: boolean;
    /** Automatically extract knowledge graphs from text (default: true) */
    extractKnowledgeGraph?: boolean;
    /** Enable batch processing for better performance (default: true) */
    enableBatching?: boolean;
  };

  /**
   * Optional: SEAL encryption service (required if features.encryption = true)
   */
  sealService?: SealService;

  /**
   * Optional: Gemini API key for knowledge graph extraction
   * (required if features.extractKnowledgeGraph = true)
   */
  geminiApiKey?: string;

  /**
   * Storage configuration
   */
  storage?: {
    /** Number of epochs to store data on Walrus (default: 3) */
    epochs?: number;
    /** Enable deletable blobs (default: true) */
    deletable?: boolean;
  };

  /**
   * Index configuration
   */
  index?: {
    /** HNSW ef construction parameter (default: 200) */
    efConstruction?: number;
    /** HNSW M parameter (default: 16) */
    M?: number;
    /** Max elements in index (default: 10000) */
    maxElements?: number;
  };
}

/**
 * Parameters for adding a vector to the store
 */
export interface AddVectorParams {
  /** Unique identifier for this vector/document */
  id: string;

  /** The embedding vector (from AI SDK or any embedding provider) */
  vector: number[];

  /** Original text content that was embedded */
  text: string;

  /** Optional metadata for filtering and retrieval */
  metadata?: Record<string, any>;

  /** Optional: Category for organization (default: 'general') */
  category?: string;

  /** Optional: Importance score 1-10 (default: 5) */
  importance?: number;

  /** Optional: Topic/tag for grouping */
  topic?: string;
}

/**
 * Batch add parameters for multiple vectors
 */
export interface AddVectorBatchParams {
  vectors: AddVectorParams[];

  /** Optional: Progress callback for batch operations */
  onProgress?: (progress: {
    current: number;
    total: number;
    stage: 'uploading' | 'indexing' | 'blockchain';
    message: string;
  }) => void;
}

/**
 * Parameters for searching vectors
 */
export interface SearchParams {
  /** Query embedding vector */
  vector: number[];

  /** Number of results to return (default: 5) */
  limit?: number;

  /** Metadata filters (AND logic) */
  filters?: {
    category?: string | string[];
    topic?: string | string[];
    importance?: { min?: number; max?: number };
    tags?: string[];
    [key: string]: any;
  };

  /** Minimum similarity score (0-1, default: 0) */
  minScore?: number;

  /** Include related entities from knowledge graph (default: false) */
  includeGraph?: boolean;

  /** Include full text content in results (default: true) */
  includeContent?: boolean;
}

/**
 * Search result item
 */
export interface SearchResult {
  /** Document ID */
  id: string;

  /** Original text content (if includeContent = true) */
  text: string;

  /** Metadata associated with this vector */
  metadata: Record<string, any>;

  /** Similarity score (0-1, higher is more similar) */
  score: number;

  /** Distance from query vector (lower is more similar) */
  distance: number;

  /** Walrus blob ID for the stored content */
  blobId: string;

  /** Sui transaction digest for blockchain record */
  txDigest?: string;

  /** Related entities from knowledge graph (if includeGraph = true) */
  relatedEntities?: Array<{
    id: string;
    name: string;
    type: string;
    confidence: number;
  }>;

  /** Related relationships (if includeGraph = true) */
  relatedRelationships?: Array<{
    source: string;
    target: string;
    type: string;
    confidence: number;
  }>;
}

/**
 * Result from adding a vector
 */
export interface AddVectorResult {
  /** Document ID */
  id: string;

  /** Walrus blob ID */
  blobId: string;

  /** Sui transaction digest */
  txDigest: string;

  /** Vector ID in HNSW index */
  vectorId: number;

  /** Whether knowledge graph was extracted */
  graphExtracted: boolean;

  /** Whether content was encrypted */
  encrypted: boolean;

  /** Upload time in milliseconds */
  uploadTimeMs: number;
}

/**
 * Result from batch add operation
 */
export interface AddVectorBatchResult {
  /** Successfully added vectors */
  successful: AddVectorResult[];

  /** Failed vectors with error messages */
  failed: Array<{
    id: string;
    error: string;
  }>;

  /** Total processing time in milliseconds */
  totalTimeMs: number;

  /** Quilt ID if batch was uploaded as a Walrus Quilt */
  quiltId?: string;
}

/**
 * Parameters for retrieving a vector by ID
 */
export interface GetVectorParams {
  /** Document ID to retrieve */
  id: string;

  /** Include full text content (default: true) */
  includeContent?: boolean;

  /** Include knowledge graph data (default: false) */
  includeGraph?: boolean;
}

/**
 * Result from getting a vector by ID
 */
export interface GetVectorResult {
  /** Document ID */
  id: string;

  /** The embedding vector */
  vector: number[];

  /** Original text content */
  text: string;

  /** Metadata */
  metadata: Record<string, any>;

  /** Walrus blob ID */
  blobId: string;

  /** Knowledge graph data (if includeGraph = true) */
  graph?: {
    entities: Array<{
      id: string;
      name: string;
      type: string;
      confidence: number;
    }>;
    relationships: Array<{
      source: string;
      target: string;
      type: string;
      confidence: number;
    }>;
  };

  /** Whether content is encrypted */
  encrypted: boolean;

  /** Timestamp when created */
  createdAt: number;
}

/**
 * Parameters for deleting vectors
 */
export interface DeleteVectorParams {
  /** Document IDs to delete */
  ids: string[];
}

/**
 * Result from delete operation
 */
export interface DeleteVectorResult {
  /** Successfully deleted IDs */
  deleted: string[];

  /** Failed deletions with error messages */
  failed: Array<{
    id: string;
    error: string;
  }>;
}

/**
 * Statistics about the vector store
 */
export interface VectorStoreStats {
  /** Total number of vectors stored */
  totalVectors: number;

  /** Total storage used in bytes */
  storageBytes: number;

  /** Number of blockchain transactions */
  blockchainTxCount: number;

  /** Knowledge graph statistics */
  graph?: {
    totalEntities: number;
    totalRelationships: number;
    entityTypes: Record<string, number>;
    relationshipTypes: Record<string, number>;
  };

  /** Index statistics */
  index: {
    dimensions: number;
    distanceMetric: string;
    indexSize: number;
  };
}

/**
 * Progress callback for long-running operations
 */
export interface ProgressCallback {
  (progress: {
    stage: 'embedding' | 'encrypting' | 'uploading' | 'blockchain' | 'indexing' | 'graph';
    message: string;
    percent: number;
    current?: number;
    total?: number;
  }): void;
}

/**
 * Error types for PDW operations
 */
export enum PDWErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',
  ENCRYPTION_ERROR = 'ENCRYPTION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INDEX_ERROR = 'INDEX_ERROR',
}

/**
 * Custom error class for PDW operations
 */
export class PDWVectorStoreError extends Error {
  constructor(
    public type: PDWErrorType,
    message: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'PDWVectorStoreError';
  }
}
