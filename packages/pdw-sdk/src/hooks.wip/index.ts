/**
 * React Hooks for Personal Data Wallet SDK
 *
 * High-level hooks for React dApps:
 * - useMemoryManager: Initialize ClientMemoryManager
 * - useCreateMemory: Create memories with progress tracking
 * - useCreateMemoryBatch: Create multiple memories in a single Quilt (~90% gas savings)
 * - useSearchMemories: Search memories with caching
 * - useWalletMemories: Fetch and manage all user memories
 * - useMemoryChat: Memory-aware chat with AI integration
 *
 * LangChain integration hooks:
 * - usePDWVectorStore: Initialize PDWVectorStore for LangChain
 * - usePDWRAG: Build RAG applications with LangChain + PDW
 *
 * Browser-compatible hooks for client-side operations:
 * - useMemorySearch: Vector search with HNSW
 * - useMemoryIndex: Memory indexing
 * - useKnowledgeGraph: Knowledge graph operations
 * - useMemoryServices: Low-level service management
 *
 * Vector embedding hooks (for RAG workflows):
 * - useStoreEmbedding: Generate and store vector embeddings
 * - useRetrieveEmbedding: Retrieve stored embeddings
 *
 * @example
 * ```tsx
 * import { useCreateMemory, useSearchMemories } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount } from '@mysten/dapp-kit';
 *
 * function MyComponent() {
 *   const account = useCurrentAccount();
 *   const { mutate: createMemory, isPending } = useCreateMemory();
 *   const { data: results } = useSearchMemories(account?.address, query);
 *
 *   // Use the hooks...
 * }
 * ```
 */

// ==================== High-Level Hooks ====================

export {
  useMemoryManager,
  type MemoryManagerConfig
} from './useMemoryManager';

export {
  useCreateMemory,
  type UseCreateMemoryOptions,
  type UseCreateMemoryReturn
} from './useCreateMemory';

export {
  useCreateMemoryBatch,
  type UseCreateMemoryBatchOptions,
  type UseCreateMemoryBatchReturn
} from './useCreateMemoryBatch';

export {
  useSearchMemories,
  type UseSearchMemoriesOptions,
  type UseSearchMemoriesReturn
} from './useSearchMemories';

export {
  useWalletMemories,
  type UseWalletMemoriesOptions,
  type UseWalletMemoriesReturn
} from './useWalletMemories';

export {
  useMemoryChat,
  type UseMemoryChatOptions,
  type UseMemoryChatReturn
} from './useMemoryChat';

// ==================== Browser-Compatible Hooks ====================

export {
  useMemoryServices,
  clearMemoryServices,
  getMemoryServicesStats,
  type MemoryServices,
  type MemoryServicesConfig
} from './useMemoryServices';

export {
  useMemorySearch,
  type SearchOptions,
  type SearchResult
} from './useMemorySearch';

export {
  useMemoryIndex,
  type AddMemoryOptions,
  type IndexedMemory,
  type IndexStats
} from './useMemoryIndex';

export {
  useKnowledgeGraph
} from './useKnowledgeGraph';

// ==================== Vector Embedding Hooks ====================

export {
  useStoreEmbedding,
  type StoreEmbeddingInput,
  type StoreEmbeddingResult,
  type UseStoreEmbeddingOptions,
  type UseStoreEmbeddingReturn
} from './useStoreEmbedding';

export {
  useRetrieveEmbedding,
  type RetrievedEmbedding,
  type UseRetrieveEmbeddingOptions,
  type UseRetrieveEmbeddingReturn
} from './useRetrieveEmbedding';

// ==================== LangChain Integration Hooks ====================

export {
  usePDWVectorStore,
  type UsePDWVectorStoreOptions,
  type UsePDWVectorStoreReturn
} from './usePDWVectorStore';

export {
  usePDWRAG,
  type UsePDWRAGOptions,
  type UsePDWRAGReturn
} from './usePDWRAG';

// ==================== Shared Types ====================

export type {
  Account,
  SignAndExecuteFunction,
  SignPersonalMessageFunction,
  CreateMemoryInput,
  CreateMemoryProgress,
  CreateMemoryResult,
  CreateMemoryBatchInput,
  CreateMemoryBatchProgress,
  CreateMemoryBatchResult,
  SearchMemoryOptions,
  SearchMemoryResult,
  MemoryFilters,
  SortOption,
  MemoryStats,
  WalletMemory,
  ChatMessage,
  MemoryChatConfig,
  MutationState,
  QueryState
} from './utils/types';
