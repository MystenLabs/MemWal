/**
 * Vector Module - HNSW Vector Indexing and Management
 *
 * Exports all vector-related services and utilities for the PDW SDK.
 * Supports both browser (hnswlib-wasm) and Node.js (hnswlib-node) environments.
 *
 * @example
 * ```typescript
 * // Auto-detect environment and create appropriate service
 * import { createHnswService } from 'personal-data-wallet-sdk/vector';
 * const service = await createHnswService({ indexConfig: { dimension: 768 } });
 * ```
 */

// Interface and utilities (safe for all environments)
export type {
  IHnswService,
  HnswServiceConfig,
  IHnswIndexConfig,
  IHnswSearchOptions,
  IHnswSearchResultItem,
  IHnswBatchStats,
  WalrusBackupConfig
} from './IHnswService';
export { isBrowser, isNode } from './IHnswService';

// Factory function (auto-detects environment, singleton pattern)
export {
  createHnswService,
  isHnswAvailable,
  getHnswServiceType,
  resetHnswServiceSingleton,
  getHnswServiceStats
} from './createHnswService';

// VectorManager (uses factory internally)
export { VectorManager } from './VectorManager';

// Re-export types from embedding module for convenience
export type {
  HNSWIndexConfig,
  HNSWSearchResult,
  HNSWSearchOptions,
  BatchConfig,
  BatchJob,
  BatchStats,
  VectorSearchOptions,
  VectorSearchResult,
  VectorSearchMatch,
  VectorError
} from '../embedding/types';

// Lazy exports for specific implementations (use dynamic import)
// These avoid static import of WASM/native modules at module load time

/**
 * @deprecated Use createHnswService() instead for automatic environment detection
 */
export const getBrowserHnswService = async () => {
  const { BrowserHnswIndexService } = await import('./BrowserHnswIndexService');
  return BrowserHnswIndexService;
};

/**
 * @deprecated Use createHnswService() instead for automatic environment detection
 */
export const getNodeHnswService = async () => {
  const { NodeHnswService } = await import('./NodeHnswService');
  return NodeHnswService;
};

// Default export with lazy loaders
export default {
  createHnswService: async () => (await import('./createHnswService')).createHnswService,
  VectorManager: async () => (await import('./VectorManager')).VectorManager
};