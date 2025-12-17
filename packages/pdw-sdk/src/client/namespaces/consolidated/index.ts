/**
 * Consolidated Namespaces - Unified API Surface
 *
 * Exports all consolidated namespaces that merge related functionality
 * into a cleaner, more intuitive API.
 *
 * @module client/namespaces/consolidated
 */

export { AINamespace } from './AINamespace';
export type {
  PatternAnalysis,
  ClassificationResult,
  ChatSession,
  ChatMessage,
  EmbedOptions
} from './AINamespace';

export { SecurityNamespace } from './SecurityNamespace';
export type {
  EncryptionResult,
  DecryptionOptions,
  ContextInfo
} from './SecurityNamespace';

export { BlockchainNamespace } from './BlockchainNamespace';
export type {
  MemoryTxOptions,
  BatchOperationType,
  BatchOperation,
  WalletInfo,
  OwnedObject
} from './BlockchainNamespace';

export { StorageNamespace } from './StorageNamespace';
export type {
  CacheStats,
  UploadResult,
  MemoryPackage,
  UploadOptions
} from './StorageNamespace';
