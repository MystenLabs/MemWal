/**
 * Storage Managers - Modular Storage Operations
 *
 * This module provides focused managers extracted from StorageService:
 * - WalrusStorageManager: Core blob upload/download
 * - MemorySearchManager: HNSW indexing and semantic search
 * - KnowledgeGraphManager: Entity extraction and graph operations
 * - WalrusMetadataManager: Blob metadata attachment
 * - QuiltBatchManager: Batch uploads via Quilts
 * - BlobAttributesManager: Dynamic field operations
 */

export { WalrusStorageManager } from './WalrusStorageManager';
export type {
  WalrusStorageConfig,
  BlobUploadOptions,
  WalrusUploadResult,
  WalrusRetrievalResult
} from './WalrusStorageManager';

export { MemorySearchManager } from './MemorySearchManager';
export type {
  MemoryMetadata,
  MetadataSearchQuery,
  MetadataSearchResult,
  IndexingResult
} from './MemorySearchManager';

export { KnowledgeGraphManager } from './KnowledgeGraphManager';
export type {
  GraphCache,
  GraphQueryOptions,
  GraphInitConfig
} from './KnowledgeGraphManager';

export { WalrusMetadataManager } from './WalrusMetadataManager';
export type {
  WalrusMemoryMetadata,
  MetadataBuildOptions
} from './WalrusMetadataManager';

export { QuiltBatchManager } from './QuiltBatchManager';
export type {
  BatchMemory,
  QuiltMemoryPackage,
  QuiltUploadOptions,
  QuiltUploadResult,
  QuiltFileResult,
  QuiltRetrieveResult,
  QuiltMemoryRetrieveResult,
  QuiltListResult
} from './QuiltBatchManager';

export { BlobAttributesManager } from './BlobAttributesManager';
export type {
  BlobQueryResult
} from './BlobAttributesManager';
