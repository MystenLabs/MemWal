# React Hooks API Reference

Complete guide to all React hooks in the Personal Data Wallet SDK.

## Table of Contents

- [Overview](#overview)
- [High-Level Hooks](#high-level-hooks)
  - [useCreateMemory](#usecreatememory)
  - [useSearchMemories](#usesearchmemories)
  - [useWalletMemories](#usewalletmemories)
  - [useMemoryChat](#usememorychat)
  - [useMemoryManager](#usememorymanager)
- [Browser-Compatible Hooks](#browser-compatible-hooks)
  - [useMemoryIndex](#usememoryindex)
  - [useMemorySearch](#usememorysearch)
  - [useKnowledgeGraph](#useknowledgegraph)
  - [useMemoryServices](#usememoryservices)
- [Vector Embedding Hooks](#vector-embedding-hooks)
  - [useStoreEmbedding](#usestoreembedding)
  - [useRetrieveEmbedding](#useretrieveembedding)
- [Complete Examples](#complete-examples)
- [Best Practices](#best-practices)

---

## Overview

The SDK provides three categories of React hooks:

### 1. High-Level Hooks
Ready-to-use hooks for common memory operations with full blockchain integration:
- `useCreateMemory` - Create and store memories
- `useSearchMemories` - Semantic search with vector similarity
- `useWalletMemories` - Fetch all user memories
- `useMemoryChat` - Memory-aware AI chat (RAG)
- `useMemoryManager` - Initialize memory manager

### 2. Browser-Compatible Hooks
Client-side operations using WebAssembly and IndexedDB:
- `useMemoryIndex` - HNSW vector index management
- `useMemorySearch` - Browser-based vector search
- `useKnowledgeGraph` - Entity and relationship management
- `useMemoryServices` - Low-level service access

### 3. Vector Embedding Hooks
Specialized hooks for RAG workflows:
- `useStoreEmbedding` - Generate and store embeddings
- `useRetrieveEmbedding` - Retrieve stored embeddings

---

## High-Level Hooks

### useCreateMemory

Create memories with full pipeline processing: classification → embedding → storage → indexing.

#### Usage

```tsx
import { useCreateMemory } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

function CreateMemoryComponent() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const {
    mutate: createMemory,
    mutateAsync,
    isPending,
    isSuccess,
    data,
    error,
    progress,
    reset
  } = useCreateMemory({
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!,
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    },
    onSuccess: (result) => {
      console.log('Memory created!', result);
    },
    onError: (error) => {
      console.error('Failed:', error);
    },
    onProgress: (progress) => {
      console.log('Step:', progress.step, progress.message);
    }
  });

  const handleCreate = () => {
    if (!account) return;

    createMemory({
      content: 'Important meeting notes from today',
      category: 'work',
      account,
      signAndExecute
    });
  };

  return (
    <div>
      <button onClick={handleCreate} disabled={isPending || !account}>
        {isPending ? `Creating... (${progress?.message || 'Processing'})` : 'Create Memory'}
      </button>

      {progress && (
        <div className="mt-2 text-sm">
          <div>Step {progress.step}/7: {progress.message}</div>
          <div className="w-full bg-gray-200 rounded">
            <div
              className="bg-blue-500 h-2 rounded"
              style={{ width: `${(progress.step / 7) * 100}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-red-500">Error: {error.message}</p>}

      {isSuccess && data && (
        <div className="mt-4 p-4 bg-green-50 border rounded">
          <h3 className="font-bold">✅ Memory Created!</h3>
          <p className="text-sm mt-2">
            <strong>Blob ID:</strong> <code className="text-xs">{data.blobId}</code>
          </p>
          <p className="text-sm">
            <strong>Vector ID:</strong> {data.vectorId}
          </p>
          <p className="text-sm">
            <strong>Category:</strong> {data.metadata.category}
          </p>
        </div>
      )}
    </div>
  );
}
```

#### API Reference

**Options:**

```typescript
interface UseCreateMemoryOptions {
  config: {
    packageId: string;              // PDW package ID
    accessRegistryId: string;       // Access registry ID
    walrusAggregator: string;       // Walrus aggregator URL
    geminiApiKey: string;           // Gemini API key
    walletRegistryId?: string;      // Optional wallet registry
  };
  onSuccess?: (result: CreateMemoryResult) => void;
  onError?: (error: Error) => void;
  onProgress?: (progress: CreateMemoryProgress) => void;
}
```

**Input:**

```typescript
interface CreateMemoryInput {
  content: string;                    // Memory content
  category?: string;                  // Optional category (auto-classified if omitted)
  account: {
    address: string;
  };
  signAndExecute: SignAndExecuteFunction;
}
```

**Return:**

```typescript
interface UseCreateMemoryReturn {
  mutate: (input: CreateMemoryInput) => void;
  mutateAsync: (input: CreateMemoryInput) => Promise<CreateMemoryResult>;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data?: CreateMemoryResult;
  error: Error | null;
  progress?: CreateMemoryProgress;
  reset: () => void;
}

interface CreateMemoryResult {
  blobId: string;                     // Walrus blob ID
  vectorId: number;                   // HNSW vector ID
  metadata: MemoryMetadata;           // Full metadata
  transactionDigest?: string;         // Sui transaction hash
}
```

**Progress Steps:**

1. Classifying content (AI-powered category detection)
2. Generating embedding (768-dimensional vector)
3. Uploading to Walrus (decentralized storage)
4. Creating on-chain record (Sui blockchain)
5. Indexing vector (HNSW index)
6. Extracting knowledge graph (entities & relationships)
7. Finalizing (cleanup and verification)

---

### useSearchMemories

Semantic search across user memories using vector similarity.

#### Usage

```tsx
import { useSearchMemories } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useState } from 'react';

function MemorySearch() {
  const account = useCurrentAccount();
  const [query, setQuery] = useState('');

  const {
    data: results,
    isLoading,
    isFetching,
    error,
    refetch
  } = useSearchMemories(
    account?.address,
    query,
    {
      k: 10,                        // Return top 10 results
      minSimilarity: 0.5,           // Minimum similarity threshold (0-1)
      enabled: query.length > 2,    // Only search when query is long enough
      debounceMs: 500,              // Debounce search by 500ms
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY,
      config: {
        packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
        walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
      }
    }
  );

  return (
    <div className="p-4">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memories..."
        className="w-full p-2 border rounded"
      />

      {isLoading && <p className="mt-2">Searching...</p>}

      {error && (
        <p className="mt-2 text-red-500">Error: {error.message}</p>
      )}

      {results && results.length > 0 && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-gray-600">
            Found {results.length} {results.length === 1 ? 'memory' : 'memories'}
          </p>

          {results.map((result) => (
            <div
              key={result.memoryId}
              className="p-4 border rounded hover:shadow-md transition"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <p className="font-medium">{result.content.substring(0, 200)}</p>
                  <div className="mt-2 flex gap-2 text-xs text-gray-500">
                    <span className="px-2 py-1 bg-blue-100 rounded">
                      {result.category}
                    </span>
                    <span>Similarity: {(result.similarity * 100).toFixed(1)}%</span>
                    <span>{new Date(result.timestamp).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="ml-4">
                  <div className="w-16 h-16 flex items-center justify-center bg-gray-100 rounded">
                    <span className="text-2xl font-bold text-gray-400">
                      {Math.round(result.similarity * 100)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {results && results.length === 0 && query.length > 2 && (
        <p className="mt-4 text-gray-500">No memories found matching "{query}"</p>
      )}
    </div>
  );
}
```

#### API Reference

**Options:**

```typescript
interface UseSearchMemoriesOptions {
  k?: number;                         // Number of results (default: 5)
  minSimilarity?: number;             // Minimum similarity 0-1 (default: 0.3)
  enabled?: boolean;                  // Enable/disable query (default: true)
  debounceMs?: number;                // Debounce delay (default: 300)
  staleTime?: number;                 // Cache stale time (default: 5min)
  geminiApiKey?: string;              // Gemini API key
  config?: {
    packageId: string;
    walrusAggregator: string;
  };
}
```

**Return:**

```typescript
interface UseSearchMemoriesReturn {
  data?: SearchMemoryResult[];
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<any>;
}

interface SearchMemoryResult {
  memoryId: string;
  blobId: string;
  content: string;
  category: string;
  similarity: number;                 // 0-1 similarity score
  timestamp: number;
  metadata: MemoryMetadata;
}
```

---

### useWalletMemories

Fetch and manage all memories for a user's wallet.

#### Usage

```tsx
import { useWalletMemories } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';

function MemoriesList() {
  const account = useCurrentAccount();

  const {
    data: memories,
    isLoading,
    error,
    refetch,
    stats
  } = useWalletMemories(account?.address, {
    filters: {
      category: 'work',               // Filter by category
      startDate: new Date('2024-01-01'),
      importance: { min: 5 }          // Only important memories
    },
    sort: {
      field: 'createdAt',
      order: 'desc'
    },
    page: 1,
    pageSize: 20,
    includeContent: true,             // Fetch full content (slower)
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
    }
  });

  if (isLoading) return <div>Loading memories...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="p-4">
      {/* Stats Summary */}
      {stats && (
        <div className="mb-6 p-4 bg-blue-50 rounded">
          <h3 className="font-bold mb-2">Memory Stats</h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-gray-600">Total</div>
              <div className="text-2xl font-bold">{stats.total}</div>
            </div>
            <div>
              <div className="text-gray-600">Categories</div>
              <div className="text-2xl font-bold">{stats.categories.length}</div>
            </div>
            <div>
              <div className="text-gray-600">Storage</div>
              <div className="text-2xl font-bold">
                {(stats.totalSize / 1024 / 1024).toFixed(2)} MB
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Memories List */}
      <div className="space-y-3">
        {memories?.map((memory) => (
          <div key={memory.id} className="p-4 border rounded">
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <h4 className="font-medium">{memory.content?.substring(0, 100)}</h4>
                <div className="mt-2 flex gap-2 text-xs text-gray-500">
                  <span className="px-2 py-1 bg-gray-100 rounded">
                    {memory.category}
                  </span>
                  <span>⭐ {memory.importance}/10</span>
                  <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {memories && memories.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p>No memories found</p>
          <p className="text-sm mt-2">Create your first memory to get started!</p>
        </div>
      )}
    </div>
  );
}
```

#### API Reference

**Options:**

```typescript
interface UseWalletMemoriesOptions {
  filters?: MemoryFilters;
  sort?: SortOption;
  page?: number;
  pageSize?: number;
  includeContent?: boolean;           // Fetch full content (default: false)
  enabled?: boolean;
  staleTime?: number;
  config?: {
    packageId: string;
    walrusAggregator: string;
  };
}

interface MemoryFilters {
  category?: string | string[];
  startDate?: Date;
  endDate?: Date;
  importance?: { min?: number; max?: number };
  tags?: string[];
}

interface SortOption {
  field: 'createdAt' | 'updatedAt' | 'importance';
  order: 'asc' | 'desc';
}
```

**Return:**

```typescript
interface UseWalletMemoriesReturn {
  data?: WalletMemory[];
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<any>;
  stats?: MemoryStats;
}

interface WalletMemory {
  id: string;
  blobId: string;
  content?: string;                   // Only if includeContent: true
  category: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  metadata: MemoryMetadata;
}

interface MemoryStats {
  total: number;
  categories: string[];
  totalSize: number;                  // Bytes
  oldestMemory: number;               // Timestamp
  newestMemory: number;               // Timestamp
}
```

---

### useMemoryChat

Memory-aware AI chat with automatic context retrieval (RAG).

#### Usage

```tsx
import { useMemoryChat } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';

function MemoryAIChat() {
  const account = useCurrentAccount();

  const {
    messages,
    sendMessage,
    createMemoryFromMessage,
    isProcessing,
    retrievedMemories,
    clearHistory,
    error
  } = useMemoryChat(account?.address, {
    systemPrompt: `You are a helpful AI assistant with access to the user's memories.
                   Use the provided context to give personalized responses.`,
    maxContextMemories: 5,            // Include top 5 relevant memories
    aiProvider: 'gemini',
    autoSaveMessages: false,          // Don't auto-save to memories
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
    }
  });

  const handleSend = async (text: string) => {
    await sendMessage(text);
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto p-4">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[70%] p-3 rounded-lg ${
                msg.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-800'
              }`}
            >
              <p>{msg.content}</p>
              {msg.timestamp && (
                <p className="text-xs mt-1 opacity-70">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </p>
              )}
            </div>
          </div>
        ))}

        {isProcessing && (
          <div className="flex justify-start">
            <div className="bg-gray-200 text-gray-800 p-3 rounded-lg">
              <p className="animate-pulse">Thinking...</p>
            </div>
          </div>
        )}
      </div>

      {/* Retrieved Memories Context */}
      {retrievedMemories && retrievedMemories.length > 0 && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
          <p className="font-semibold mb-1">
            📚 Using {retrievedMemories.length} memories for context
          </p>
          <div className="space-y-1">
            {retrievedMemories.map((mem, i) => (
              <p key={i} className="text-xs text-gray-600 truncate">
                • {mem.content.substring(0, 80)}...
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          Error: {error.message}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem('message') as HTMLInputElement;
          if (input.value.trim()) {
            handleSend(input.value.trim());
            input.value = '';
          }
        }}
        className="flex gap-2"
      >
        <input
          name="message"
          type="text"
          placeholder="Ask me anything about your memories..."
          className="flex-1 p-2 border rounded"
          disabled={isProcessing || !account}
        />
        <button
          type="submit"
          disabled={isProcessing || !account}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Send
        </button>
      </form>

      {/* Actions */}
      <div className="mt-2 flex gap-2 justify-end">
        <button
          onClick={clearHistory}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Clear History
        </button>
      </div>
    </div>
  );
}
```

#### API Reference

**Options:**

```typescript
interface UseMemoryChatOptions {
  systemPrompt?: string;              // System prompt for AI
  maxContextMemories?: number;        // Max memories for context (default: 5)
  aiProvider?: 'gemini' | 'openai';   // AI provider (default: 'gemini')
  autoSaveMessages?: boolean;         // Save messages as memories (default: false)
  geminiApiKey?: string;              // API key
  config?: {
    packageId: string;
    walrusAggregator: string;
  };
}
```

**Return:**

```typescript
interface UseMemoryChatReturn {
  messages: ChatMessage[];
  sendMessage: (content: string) => Promise<void>;
  createMemoryFromMessage: (messageIndex: number) => Promise<void>;
  isProcessing: boolean;
  retrievedMemories?: SearchMemoryResult[];
  clearHistory: () => void;
  error: Error | null;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}
```

**How It Works:**

1. User sends a message
2. Hook searches memories for relevant context
3. Top N memories are retrieved based on similarity
4. Context is included in AI prompt
5. AI generates response using context
6. Response is returned and displayed
7. Optionally save conversation to memories

---

### useMemoryManager

Initialize the ClientMemoryManager for advanced operations.

#### Usage

```tsx
import { useMemoryManager } from 'personal-data-wallet-sdk/hooks';
import { useSuiClient } from '@mysten/dapp-kit';

function AdvancedMemoryOps() {
  const suiClient = useSuiClient();

  const manager = useMemoryManager({
    packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
    accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!,
    walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    client: suiClient
  });

  // Use manager for advanced operations
  const handleAdvancedOperation = async () => {
    // Direct access to all services
    const embedding = await manager.embeddingService.embedText({
      text: 'custom text',
      type: 'query'
    });

    // Custom memory pipeline
    const result = await manager.createMemory({
      content: 'custom content',
      category: 'custom',
      account: { address: '0x...' },
      signAndExecute: async () => {},
      client: suiClient
    });
  };

  return <div>Advanced operations...</div>;
}
```

#### API Reference

**Configuration:**

```typescript
interface MemoryManagerConfig {
  packageId: string;
  accessRegistryId: string;
  walrusAggregator: string;
  geminiApiKey: string;
  walletRegistryId?: string;
  client: SuiClient;
}
```

**Return:** `ClientMemoryManager` instance with all services and methods.

---

## Browser-Compatible Hooks

### useMemoryIndex

Manage HNSW vector index in the browser using WebAssembly.

#### Usage

```tsx
import { useMemoryIndex } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';

function VectorIndexManager() {
  const account = useCurrentAccount();

  const {
    addMemory,
    removeMemory,
    search,
    getStats,
    clear,
    isInitialized,
    stats
  } = useMemoryIndex(account?.address, {
    maxElements: 10000,               // Max vectors
    M: 16,                            // HNSW parameter
    efConstruction: 200,              // Build quality
    efSearch: 50,                     // Search quality
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    }
  });

  const handleAddMemory = async () => {
    await addMemory({
      content: 'New memory content',
      metadata: {
        category: 'personal',
        timestamp: Date.now()
      }
    });
  };

  const handleSearch = async (query: string) => {
    const results = await search(query, 5); // Top 5 results
    console.log('Search results:', results);
  };

  return (
    <div className="p-4">
      <h3 className="text-lg font-bold mb-4">Vector Index</h3>

      {stats && (
        <div className="mb-4 p-3 bg-gray-50 rounded">
          <p><strong>Indexed:</strong> {stats.totalVectors} vectors</p>
          <p><strong>Dimension:</strong> {stats.dimension}</p>
          <p><strong>Index Size:</strong> {(stats.indexSizeBytes / 1024).toFixed(2)} KB</p>
        </div>
      )}

      <div className="space-y-2">
        <button
          onClick={handleAddMemory}
          disabled={!isInitialized}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Add Memory to Index
        </button>

        <button
          onClick={clear}
          className="px-4 py-2 bg-red-500 text-white rounded ml-2"
        >
          Clear Index
        </button>
      </div>
    </div>
  );
}
```

#### API Reference

**Options:**

```typescript
interface UseMemoryIndexOptions {
  maxElements?: number;               // Max vectors (default: 10000)
  M?: number;                         // HNSW M parameter (default: 16)
  efConstruction?: number;            // Build quality (default: 200)
  efSearch?: number;                  // Search quality (default: 50)
  persistToWalrus?: boolean;          // Backup to Walrus (default: true)
  config?: {
    packageId: string;
    geminiApiKey: string;
  };
}
```

**Return:**

```typescript
interface UseMemoryIndexReturn {
  addMemory: (options: AddMemoryOptions) => Promise<number>;
  removeMemory: (vectorId: number) => Promise<void>;
  search: (query: string, k: number) => Promise<IndexedMemory[]>;
  getStats: () => IndexStats;
  clear: () => Promise<void>;
  isInitialized: boolean;
  stats?: IndexStats;
}

interface IndexStats {
  totalVectors: number;
  dimension: number;
  indexSizeBytes: number;
  lastUpdated: number;
}
```

---

### useMemorySearch

Browser-based semantic search without server calls.

#### Usage

```tsx
import { useMemorySearch } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';

function LocalSearch() {
  const account = useCurrentAccount();

  const {
    search,
    isSearching,
    results,
    error
  } = useMemorySearch(account?.address, {
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
  });

  const handleSearch = async (query: string) => {
    await search(query, {
      k: 10,
      threshold: 0.5,
      useGraphExpansion: true         // Include knowledge graph results
    });
  };

  return (
    <div>
      <input
        type="text"
        onChange={(e) => handleSearch(e.target.value)}
        placeholder="Search locally..."
      />

      {isSearching && <p>Searching...</p>}

      {results?.map((result) => (
        <div key={result.id}>
          <p>{result.content}</p>
          <p>Score: {result.score.toFixed(3)}</p>
        </div>
      ))}
    </div>
  );
}
```

---

### useKnowledgeGraph

Manage entities and relationships extracted from memories.

#### Usage

```tsx
import { useKnowledgeGraph } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';

function KnowledgeGraphView() {
  const account = useCurrentAccount();

  const {
    entities,
    relationships,
    addEntity,
    addRelationship,
    search,
    getRelated,
    visualize
  } = useKnowledgeGraph(account?.address, {
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
    }
  });

  const handleVisualize = () => {
    const graphData = visualize();
    // Use with D3.js or other graph viz library
    console.log('Graph data:', graphData);
  };

  return (
    <div className="p-4">
      <h3 className="text-lg font-bold mb-4">Knowledge Graph</h3>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="p-3 bg-blue-50 rounded">
          <p className="font-semibold">Entities</p>
          <p className="text-2xl">{entities?.length || 0}</p>
        </div>
        <div className="p-3 bg-green-50 rounded">
          <p className="font-semibold">Relationships</p>
          <p className="text-2xl">{relationships?.length || 0}</p>
        </div>
      </div>

      {/* Entity List */}
      <div className="space-y-2">
        {entities?.slice(0, 10).map((entity) => (
          <div key={entity.id} className="p-2 border rounded">
            <p className="font-medium">{entity.name}</p>
            <p className="text-sm text-gray-600">{entity.type}</p>
          </div>
        ))}
      </div>

      <button
        onClick={handleVisualize}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
      >
        Visualize Graph
      </button>
    </div>
  );
}
```

---

### useMemoryServices

Access low-level services for advanced operations.

#### Usage

```tsx
import { useMemoryServices } from 'personal-data-wallet-sdk/hooks';
import { useSuiClient } from '@mysten/dapp-kit';

function AdvancedServices() {
  const suiClient = useSuiClient();

  const services = useMemoryServices({
    packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
    suiClient
  });

  // Direct access to all services
  const {
    memoryService,
    storageService,
    embeddingService,
    vectorService,
    chatService,
    encryptionService
  } = services;

  const handleCustomOperation = async () => {
    // Example: Direct embedding generation
    const embedding = await embeddingService.embedText({
      text: 'custom text',
      type: 'query',
      taskType: 'RETRIEVAL_QUERY'
    });

    // Example: Direct storage operation
    const result = await storageService.uploadBlob(
      new Uint8Array([1, 2, 3]),
      {
        signer: {...},
        epochs: 5
      }
    );
  };

  return <div>Custom operations...</div>;
}
```

---

## Vector Embedding Hooks

### useStoreEmbedding

See [Embedding Hooks Guide](./EMBEDDING_HOOKS_GUIDE.md#usestoreembedding) for complete documentation.

### useRetrieveEmbedding

See [Embedding Hooks Guide](./EMBEDDING_HOOKS_GUIDE.md#useretrieveembedding) for complete documentation.

---

## Complete Examples

### Example 1: Full Memory Management App

```tsx
import {
  useCreateMemory,
  useSearchMemories,
  useWalletMemories,
  useMemoryChat
} from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useState } from 'react';

function MemoryApp() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [activeTab, setActiveTab] = useState<'create' | 'search' | 'list' | 'chat'>('create');

  // Create memory
  const { mutate: createMemory, isPending: isCreating } = useCreateMemory({
    config: {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!,
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR!,
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    }
  });

  // Search memories
  const [searchQuery, setSearchQuery] = useState('');
  const { data: searchResults } = useSearchMemories(
    account?.address,
    searchQuery,
    { debounceMs: 500 }
  );

  // List all memories
  const { data: allMemories } = useWalletMemories(account?.address);

  // Memory chat
  const { messages, sendMessage, isProcessing } = useMemoryChat(account?.address, {
    maxContextMemories: 5,
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
  });

  return (
    <div className="container mx-auto p-4">
      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b">
        {['create', 'search', 'list', 'chat'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as any)}
            className={`px-4 py-2 ${
              activeTab === tab ? 'border-b-2 border-blue-500 font-bold' : ''
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'create' && (
        <div>
          <h2 className="text-2xl font-bold mb-4">Create Memory</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              createMemory({
                content: formData.get('content') as string,
                category: formData.get('category') as string,
                account: account!,
                signAndExecute
              });
            }}
          >
            <textarea
              name="content"
              placeholder="Enter memory content..."
              className="w-full p-2 border rounded mb-2"
              rows={5}
            />
            <input
              name="category"
              placeholder="Category (optional)"
              className="w-full p-2 border rounded mb-2"
            />
            <button
              type="submit"
              disabled={isCreating || !account}
              className="px-4 py-2 bg-blue-500 text-white rounded"
            >
              {isCreating ? 'Creating...' : 'Create Memory'}
            </button>
          </form>
        </div>
      )}

      {activeTab === 'search' && (
        <div>
          <h2 className="text-2xl font-bold mb-4">Search Memories</h2>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="w-full p-2 border rounded mb-4"
          />
          <div className="space-y-3">
            {searchResults?.map((result) => (
              <div key={result.memoryId} className="p-4 border rounded">
                <p>{result.content}</p>
                <p className="text-sm text-gray-500 mt-2">
                  Similarity: {(result.similarity * 100).toFixed(1)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'list' && (
        <div>
          <h2 className="text-2xl font-bold mb-4">All Memories</h2>
          <div className="space-y-3">
            {allMemories?.map((memory) => (
              <div key={memory.id} className="p-4 border rounded">
                <p className="font-medium">{memory.category}</p>
                <p className="text-sm text-gray-500">
                  {new Date(memory.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="h-[600px] flex flex-col">
          <h2 className="text-2xl font-bold mb-4">Memory Chat</h2>
          <div className="flex-1 overflow-y-auto space-y-3 mb-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`p-3 rounded ${
                  msg.role === 'user' ? 'bg-blue-100 ml-12' : 'bg-gray-100 mr-12'
                }`}
              >
                <p>{msg.content}</p>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem('message') as HTMLInputElement;
              sendMessage(input.value);
              input.value = '';
            }}
          >
            <input
              name="message"
              placeholder="Ask about your memories..."
              className="w-full p-2 border rounded"
              disabled={isProcessing}
            />
          </form>
        </div>
      )}
    </div>
  );
}
```

---

## Best Practices

### 1. Always Check for Wallet Connection

```tsx
const account = useCurrentAccount();

if (!account) {
  return <div>Please connect your wallet</div>;
}
```

### 2. Use Debouncing for Search

```tsx
useSearchMemories(address, query, {
  debounceMs: 500,  // Wait 500ms after user stops typing
  enabled: query.length > 2  // Only search when query is long enough
});
```

### 3. Handle Loading States

```tsx
const { isPending, progress } = useCreateMemory();

return (
  <button disabled={isPending}>
    {isPending ? `${progress?.message}...` : 'Create'}
  </button>
);
```

### 4. Implement Error Boundaries

```tsx
import { ErrorBoundary } from 'react-error-boundary';

<ErrorBoundary fallback={<div>Something went wrong</div>}>
  <MemoryComponent />
</ErrorBoundary>
```

### 5. Cache Configuration

```tsx
useSearchMemories(address, query, {
  staleTime: 5 * 60 * 1000,  // 5 minutes
  cacheTime: 10 * 60 * 1000  // 10 minutes
});
```

### 6. Pagination for Large Lists

```tsx
const { data } = useWalletMemories(address, {
  page: currentPage,
  pageSize: 20
});
```

### 7. Use Progress Callbacks

```tsx
useCreateMemory({
  onProgress: (progress) => {
    console.log(`Step ${progress.step}/7: ${progress.message}`);
    // Update UI with progress
  }
});
```

### 8. Clean Up on Unmount

```tsx
useEffect(() => {
  return () => {
    // Clean up any subscriptions or timers
  };
}, []);
```

---

## Support

For more information:
- 📚 [Complete Documentation](../README.md)
- 🎯 [Embedding Hooks Guide](./EMBEDDING_HOOKS_GUIDE.md)
- 🚀 [Quick Start](./EMBEDDING_HOOKS_QUICKSTART.md)
- 🐛 [GitHub Issues](https://github.com/CommandOSSLabs/personal-data-wallet/issues)

---

**License:** MIT
