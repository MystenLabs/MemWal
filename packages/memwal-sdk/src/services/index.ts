/**
 * Server-safe exports for Next.js API routes
 * These exports don't include React hooks or browser-only dependencies
 */

export { EmbeddingService } from './EmbeddingService';
export type { EmbeddingOptions, EmbeddingResult } from './EmbeddingService';

export { StorageService } from './StorageService';
export type {
  StorageServiceConfig,
  MemoryMetadata,
  WalrusUploadResult,
  BlobUploadOptions,
  MetadataSearchQuery,
  MetadataSearchResult,
  WalrusMemoryMetadata
} from './StorageService';

// Export storage managers for advanced use cases
export * from './storage';

// Capability service for SEAL PrivateData pattern
export { CapabilityService } from './CapabilityService';
export type { CapabilityServiceConfig } from './CapabilityService';
