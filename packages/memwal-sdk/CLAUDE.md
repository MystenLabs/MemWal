# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Context

**Location**: `packages/pdw-sdk/`
**Package**: `personal-data-wallet-sdk` v0.2.4
**Description**: TypeScript SDK for building memory-aware applications with decentralized storage, SEAL encryption, and Sui blockchain integration

This is a standalone SDK package within the Personal Data Wallet monorepo. See the repository-level CLAUDE.md for overall project context.

## Development Commands

```bash
# Building
npm run build              # Full build: codegen + TypeScript compilation
npm run build:ts           # TypeScript compilation only
npm run dev                # Watch mode for development

# Code Generation (from Move contracts)
npm run codegen            # Generate TypeScript types from Move
npm run codegen:summaries  # Generate Move summaries (requires smart-contract dir)

# Testing
npm test                   # Run all tests
npm run test:watch         # Watch mode for tests
npm run test:seal          # Test SEAL integration specifically
npm run test:seal:watch    # Watch mode for SEAL tests
npm run test:embedding-hooks  # Test embedding hooks live

# Verification
npm run verify:deployment  # Verify deployment configuration
npm run verify:quick       # Quick config test + deployment verification

# Code Quality
npm run lint               # Run ESLint
npm run lint:fix           # Fix ESLint issues automatically

# Example App
cd example && npm run dev  # Run example Next.js app
```

## SDK Architecture

### Directory Structure

```
src/
├── client/              # Client-side API for React dApps
│   ├── ClientMemoryManager.ts    # High-level memory manager
│   ├── PersonalDataWallet.ts     # Sui client extension
│   └── factory.ts                # Factory functions for client creation
│
├── services/            # Business logic layer (14 services)
│   ├── MemoryService.ts          # Memory CRUD operations
│   ├── ChatService.ts            # Memory-aware AI chat
│   ├── QueryService.ts           # Advanced search
│   ├── StorageService.ts         # Walrus storage coordinator (refactored)
│   ├── EmbeddingService.ts       # Gemini embeddings
│   ├── EncryptionService.ts      # SEAL encryption
│   ├── TransactionService.ts     # Sui transactions
│   ├── ViewService.ts            # Read-only queries
│   ├── ClassifierService.ts      # Content classification
│   ├── MemoryIndexService.ts     # Memory indexing
│   ├── VectorService.ts          # Vector operations
│   ├── BatchService.ts           # Batch processing
│   ├── GeminiAIService.ts        # Gemini AI client
│   ├── CrossContextPermissionService.ts
│   └── storage/                  # Storage manager modules
│       ├── WalrusStorageManager.ts    # Core Walrus operations
│       ├── MemorySearchManager.ts     # Memory indexing and search
│       ├── KnowledgeGraphManager.ts   # Knowledge graph operations
│       ├── WalrusMetadataManager.ts   # Metadata operations
│       ├── QuiltBatchManager.ts       # Batch uploads
│       └── BlobAttributesManager.ts   # Dynamic field operations
│
├── infrastructure/      # External service integrations
│   ├── ai/
│   │   ├── GeminiAIService.ts    # Google Gemini client
│   │   └── EmbeddingService.ts   # Text-to-vector conversion
│   ├── seal/
│   │   ├── SealService.ts        # SEAL client wrapper
│   │   └── EncryptionService.ts  # Encryption operations
│   ├── sui/
│   │   ├── SuiService.ts         # Sui blockchain client
│   │   └── BlockchainManager.ts  # On-chain operations
│   └── walrus/
│       ├── WalrusStorageService.ts  # Walrus client wrapper
│       └── StorageManager.ts        # Storage operations
│
├── vector/              # Vector indexing (WASM-based)
│   ├── HnswWasmService.ts        # Browser-compatible HNSW (PRIMARY)
│   ├── BrowserHnswIndexService.ts # Browser index service
│   └── VectorManager.ts          # High-level vector management
│
├── graph/               # Knowledge graph extraction
│   ├── GraphService.ts           # Entity/relationship extraction
│   ├── KnowledgeGraphManager.ts  # Graph operations
│   └── BrowserKnowledgeGraphManager.ts
│
├── batch/               # Batch processing and caching
│   ├── BatchManager.ts           # Batch coordination
│   ├── BatchingService.ts        # Batching logic
│   └── MemoryProcessingCache.ts  # In-memory caching
│
├── hooks/               # React hooks (16 hooks)
│   ├── useCreateMemory.ts        # Create memories with progress
│   ├── useCreateMemoryBatch.ts   # Create multiple memories in batch
│   ├── useSearchMemories.ts      # Vector search with caching
│   ├── useMemoryChat.ts          # Memory-aware chat
│   ├── useWalletMemories.ts      # Fetch user memories
│   ├── useMemoryManager.ts       # Manager initialization
│   ├── useMemoryServices.ts      # Low-level services
│   ├── useMemorySearch.ts        # Vector search
│   ├── useMemoryIndex.ts         # Indexing operations
│   ├── useKnowledgeGraph.ts      # Graph operations
│   ├── useStoreEmbedding.ts      # Store vectors to Walrus
│   ├── useRetrieveEmbedding.ts   # Retrieve vectors from Walrus
│   ├── usePDWRAG.ts              # LangChain RAG integration
│   ├── usePDWVectorStore.ts      # LangChain VectorStore hook
│   └── utils/
│       ├── types.ts              # Shared hook types
│       └── cache.ts              # Hook-level caching
│
├── langchain/           # LangChain integration
│   ├── PDWEmbeddings.ts          # LangChain Embeddings adapter
│   ├── PDWVectorStore.ts         # LangChain VectorStore implementation
│   └── createPDWRAG.ts           # RAG pipeline helpers
│
├── api/                 # API client utilities
│   └── client.ts                 # API client configuration
│
├── chat/                # Chat utilities
│   └── index.ts                  # Chat exports
│
├── pipeline/            # Memory processing pipeline
│   ├── MemoryPipeline.ts         # 7-stage pipeline
│   └── PipelineManager.ts        # Pipeline orchestration
│
├── retrieval/           # Memory retrieval and decryption
│   ├── MemoryRetrievalService.ts
│   ├── MemoryDecryptionPipeline.ts
│   ├── AdvancedSearchService.ts
│   └── MemoryAnalyticsService.ts
│
├── wallet/              # Wallet architecture
│   ├── MainWalletService.ts      # Main wallet operations
│   └── ContextWalletService.ts   # Context-specific wallets
│
├── access/              # Access control
│   └── PermissionService.ts
│
├── aggregation/         # Multi-context queries
│   └── AggregationService.ts
│
├── transactions/        # Transaction builders
├── view/                # View function wrappers
├── permissions/         # Consent management
├── memory/              # Memory types and utilities
├── embedding/           # Embedding types
├── encryption/          # Encryption utilities
├── config/              # Configuration management
├── core/                # Core types and interfaces
├── types/               # Type definitions
├── utils/               # Utility functions
├── errors/              # Error types and recovery
├── generated/           # Auto-generated from Move contracts
└── index.ts             # Main SDK exports
```

### Service Layer Organization

**Three-Tier Architecture**:

1. **Business Logic** (`src/services/`): High-level operations for app developers
2. **Infrastructure** (`src/infrastructure/`): External service clients (Walrus, Sui, SEAL, Gemini)
3. **Utilities** (`src/vector/`, `src/graph/`, `src/batch/`): Specialized processing

**Service Initialization Pattern**:

```typescript
// Services accept config objects in constructors
const embeddingService = new EmbeddingService({
  apiKey: config.geminiApiKey,
  model: 'text-embedding-004',
  dimensions: 768
});

// Infrastructure services wrap external clients
const storageService = new StorageService(
  config.walrusAggregator,
  config.walrusPublisher
);
```

### Refactored StorageService Architecture

**Recent Change**: The `StorageService` has been refactored to use a **manager delegation pattern** for better separation of concerns and maintainability.

**Location**: `src/services/StorageService.ts`

**New Architecture**:

The `StorageService` is now a coordinator that delegates to specialized managers:

1. **WalrusStorageManager** (`src/services/storage/WalrusStorageManager.ts`)
   - Core Walrus blob operations (upload, retrieve)
   - Handles encryption integration
   - Manages Walrus client connections

2. **MemorySearchManager** (`src/services/storage/MemorySearchManager.ts`)
   - Memory indexing with HNSW
   - Metadata-based search
   - Vector similarity search
   - Category and time-range filtering

3. **KnowledgeGraphManager** (`src/services/storage/KnowledgeGraphManager.ts`)
   - Entity/relationship extraction
   - Knowledge graph building
   - Graph search and traversal
   - Graph analytics

4. **WalrusMetadataManager** (`src/services/storage/WalrusMetadataManager.ts`)
   - Blob metadata creation
   - Metadata attachment/retrieval
   - Metadata format conversion

5. **QuiltBatchManager** (`src/services/storage/QuiltBatchManager.ts`)
   - Batch memory uploads as Quilts
   - Tag-based file organization
   - Multi-file retrieval

6. **BlobAttributesManager** (`src/services/storage/BlobAttributesManager.ts`)
   - Dynamic field operations on blobs
   - Attribute-based queries
   - On-chain metadata storage

**Backward Compatibility**: The refactored `StorageService` maintains **full backward compatibility** with the original API. All existing code continues to work without changes.

**Benefits**:
- Clearer separation of concerns
- Easier testing and maintenance
- Individual managers can be used standalone
- Better code organization
- Reduced complexity in main service

### Client API Architecture

**Two Primary Entry Points**:

1. **ClientMemoryManager** (`src/client/ClientMemoryManager.ts`):
   - High-level API for React dApps
   - Handles complete memory lifecycle
   - Progress callbacks and error handling
   - Used by React hooks internally

2. **PersonalDataWallet** (`src/client/PersonalDataWallet.ts`):
   - Sui client extension (follows @mysten patterns)
   - Exposes namespaced API via `client.pdw.*`
   - Transaction builders, view methods, service access
   - Not yet fully implemented (future work)

**Current Recommendation**: Use `ClientMemoryManager` directly or via React hooks.

## React Hooks Architecture

### Hook Categories

**1. High-Level Hooks** (User-facing):
```typescript
useCreateMemory()         // Create memories with progress tracking
useCreateMemoryBatch()    // Create multiple memories in batch
useSearchMemories()       // Semantic search with caching
useMemoryChat()           // Memory-aware AI chat (RAG)
useWalletMemories()       // Fetch and manage user memories
useMemoryManager()        // Initialize ClientMemoryManager
```

**2. Vector Embedding Hooks** (RAG workflows):
```typescript
useStoreEmbedding()       // Generate and store vectors on Walrus
useRetrieveEmbedding()    // Retrieve stored vectors
```

**3. LangChain Integration Hooks** (Advanced RAG):
```typescript
usePDWRAG()               // LangChain RAG with PDW backend
usePDWVectorStore()       // LangChain VectorStore hook
```

**4. Browser-Compatible Hooks** (Advanced):
```typescript
useMemoryServices()       // Low-level service management
useMemorySearch()         // Direct vector search
useMemoryIndex()          // Index management
useKnowledgeGraph()       // Graph operations
```

### Hook Patterns

**All hooks follow React Query conventions**:

```typescript
// Mutation hooks (create, update, delete)
const { mutate, mutateAsync, isPending, data, error } = useCreateMemory(options);

// Query hooks (read operations)
const { data, isLoading, error, refetch } = useSearchMemories(address, query, options);
```

**Progress Tracking Pattern**:

```typescript
const { mutate, isPending, progress } = useCreateMemory({
  config: { ... },
  onProgress: (progress) => {
    console.log(progress.stage);    // 'embedding' | 'encrypting' | 'uploading' | 'indexing'
    console.log(progress.message);  // User-friendly message
    console.log(progress.percent);  // 0-100
  }
});
```

## LangChain Integration

### Overview

The SDK now provides native LangChain integration, making it easy to use PDW as a backend for LangChain applications. This includes standard LangChain interfaces for embeddings and vector stores, plus helper functions for common RAG patterns.

**Location**: `src/langchain/`

**Export Path**: Import from `personal-data-wallet-sdk/langchain`

### Components

**1. PDWEmbeddings** - LangChain Embeddings Interface

Standard LangChain `Embeddings` implementation using Gemini:

```typescript
import { PDWEmbeddings } from 'personal-data-wallet-sdk/langchain';

const embeddings = new PDWEmbeddings({
  geminiApiKey: process.env.GEMINI_API_KEY!,
  model: 'text-embedding-004',
  dimensions: 768
});

// Use with any LangChain component
const vectors = await embeddings.embedDocuments(['text1', 'text2']);
```

**2. PDWVectorStore** - LangChain VectorStore Implementation

Complete LangChain `VectorStore` with PDW backend:

```typescript
import { PDWVectorStore } from 'personal-data-wallet-sdk/langchain';

const vectorStore = new PDWVectorStore(embeddings, {
  userAddress: '0x...',
  packageId: '0x...',
  walrusAggregator: 'https://...',
  suiClient,
  signer,
  sealService // optional encryption
});

// Add documents
await vectorStore.addDocuments([
  { pageContent: 'content', metadata: { category: 'note' } }
]);

// Similarity search
const results = await vectorStore.similaritySearch('query', 5);
```

**3. RAG Helpers** - Ready-to-use RAG Patterns

Pre-built RAG chains with PDW integration:

```typescript
import {
  createPDWRAG,
  createPDWRAGWithSources,
  createConversationalPDWRAG
} from 'personal-data-wallet-sdk/langchain';

// Basic RAG
const rag = await createPDWRAG({
  vectorStore,
  model: new ChatGoogleGenerativeAI(),
  prompt: customPrompt // optional
});

const answer = await rag.invoke({ question: 'What is...?' });

// RAG with source citations
const ragWithSources = await createPDWRAGWithSources({
  vectorStore,
  model: new ChatGoogleGenerativeAI()
});

// Conversational RAG with memory
const conversationalRag = await createConversationalPDWRAG({
  vectorStore,
  model: new ChatGoogleGenerativeAI(),
  memoryKey: 'chat_history'
});
```

### Integration Patterns

**Use with LangChain Agents**:

```typescript
import { createRetrievalChain } from 'langchain/chains/retrieval';

const retriever = vectorStore.asRetriever({ k: 5 });
const chain = await createRetrievalChain({
  retriever,
  combineDocsChain: // ... your chain
});
```

**Use with React Hooks**:

```typescript
import { usePDWRAG, usePDWVectorStore } from 'personal-data-wallet-sdk/hooks';

function MyComponent() {
  const { vectorStore, isReady } = usePDWVectorStore(config);
  const { ask, answer, isLoading } = usePDWRAG({ vectorStore });

  return (
    <div>
      <input onChange={(e) => ask(e.target.value)} />
      {isLoading ? 'Thinking...' : answer}
    </div>
  );
}
```

### Benefits

- **Standard Interface**: Drop-in replacement for any LangChain VectorStore
- **Decentralized**: All data stored on Walrus, indexed on Sui
- **Encrypted**: Optional SEAL encryption for sensitive data
- **Browser-compatible**: Works in React apps with WASM HNSW
- **Full LangChain ecosystem**: Works with all LangChain tools and chains

## Vercel AI SDK Integration

### Overview

PDW now uses **Vercel AI SDK** as its core embedding layer, making it provider-agnostic and compatible with any AI SDK embedding model. This means you can use PDW with OpenAI, Google Gemini, Cohere, Anthropic, or any other AI SDK-supported provider.

**Location**: `src/ai-sdk/` and refactored `src/services/EmbeddingService.ts`

**Export Path**: Import from `personal-data-wallet-sdk/ai-sdk`

### Architecture Changes (v0.3.0)

**Before (v0.2.x):**
- EmbeddingService used `@google/genai` directly
- Locked to Gemini embeddings only
- LangChain integration separate

**After (v0.3.0):**
- EmbeddingService wraps `ai-sdk`'s `embed()` and `embedMany()`
- Works with **any** AI SDK provider
- Unified architecture: LangChain and AI SDK both use same backend

### Key Features

**1. Provider-Agnostic Embeddings**

PDW now accepts embeddings from **any source**:

```typescript
// Option 1: OpenAI
import { openai } from '@ai-sdk/openai';
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';

const store = new PDWVectorStore({
  walrus: { aggregator: '...' },
  sui: { network: 'testnet', packageId: '...' },
  signer,
  userAddress,
  dimensions: 1536  // OpenAI dimensions
});

const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-large'),
  value: 'text'
});

await store.add({ id: 'doc-1', vector: embedding, text: 'text' });

// Option 2: Google Gemini
import { google } from '@ai-sdk/google';

const { embedding } = await embed({
  model: google.textEmbedding('text-embedding-004'),
  value: 'text'
});

// Option 3: Cohere
import { cohere } from '@ai-sdk/cohere';

const { embedding } = await embed({
  model: cohere.textEmbedding('embed-english-v3.0'),
  value: 'text'
});
```

**2. Refactored EmbeddingService**

The `EmbeddingService` now has three configuration modes:

```typescript
import { EmbeddingService } from 'personal-data-wallet-sdk';

// Mode 1: Direct ai-sdk model (most flexible)
import { openai } from '@ai-sdk/openai';
const service = new EmbeddingService({
  model: openai.embedding('text-embedding-3-large')
});

// Mode 2: Provider config (PDW creates model)
const service = new EmbeddingService({
  provider: 'openai',
  apiKey: 'sk-...',
  modelName: 'text-embedding-3-large',
  dimensions: 3072
});

// Mode 3: Backward compatible (defaults to google)
const service = new EmbeddingService({
  apiKey: process.env.GEMINI_API_KEY,  // Works as before
  model: 'text-embedding-004',
  dimensions: 768
});
```

**3. PDWVectorStore for AI SDK Users**

New vector store specifically designed for AI SDK workflows:

```typescript
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';
import { embed, generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Initialize store
const store = new PDWVectorStore({
  walrus: {
    aggregator: 'https://aggregator.walrus-testnet.walrus.space',
    publisher: 'https://publisher.walrus-testnet.walrus.space'
  },
  sui: {
    network: 'testnet',
    packageId: '0x...'
  },
  signer: keypair,
  userAddress: address,
  dimensions: 1536,
  features: {
    encryption: false,           // Optional SEAL encryption
    extractKnowledgeGraph: false // Optional graph extraction
  }
});

// Store documents
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'React hooks let you use state in functions'
});

await store.add({
  id: 'doc-1',
  vector: embedding,
  text: 'React hooks let you use state in functions',
  metadata: { category: 'documentation' }
});

// Search
const { embedding: queryEmb } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'How do I use state in React?'
});

const results = await store.search({
  vector: queryEmb,
  limit: 5,
  filters: { category: 'documentation' }
});

// Generate with context
const context = results.map(r => r.text).join('\n');
const { text } = await generateText({
  model: openai('gpt-4-turbo'),
  prompt: `Context:\n${context}\n\nQuestion: How do I use state in React?`
});
```

### Benefits

**For AI SDK Users:**
- ✅ Use any embedding provider (OpenAI, Gemini, Cohere, etc.)
- ✅ Familiar `embed()` / `embedMany()` API
- ✅ Full PDW capabilities (Walrus + Sui + Graphs + Encryption)
- ✅ Drop-in replacement for Pinecone/Chroma
- ✅ Decentralized storage (you own your data)

**For PDW Core:**
- ✅ Provider-agnostic architecture
- ✅ Better ecosystem integration
- ✅ Reduced vendor lock-in
- ✅ Unified embedding layer for LangChain + AI SDK

### Migration Guide (v0.2.x → v0.3.0)

**Existing code continues to work without changes!** The refactored `EmbeddingService` is backward compatible.

**Before:**
```typescript
const service = new EmbeddingService({
  apiKey: process.env.GEMINI_API_KEY,
  model: 'text-embedding-004',
  dimensions: 768
});
```

**After (same code, uses ai-sdk internally):**
```typescript
const service = new EmbeddingService({
  apiKey: process.env.GEMINI_API_KEY,
  model: 'text-embedding-004',  // Treated as modelName
  dimensions: 768
});
// Now uses ai-sdk's google.textEmbedding() internally
```

**Or switch to explicit provider:**
```typescript
const service = new EmbeddingService({
  provider: 'google',  // or 'openai', 'cohere'
  apiKey: process.env.GEMINI_API_KEY,
  modelName: 'text-embedding-004',
  dimensions: 768
});
```

**Or bring your own model:**
```typescript
import { openai } from '@ai-sdk/openai';

const service = new EmbeddingService({
  model: openai.embedding('text-embedding-3-large')
});
```

### Examples

See `examples/ai-sdk/` for complete examples:
- `basic-rag.ts` - Full RAG workflow with OpenAI
- `multi-provider.ts` - Using OpenAI, Gemini, and Cohere together

### Dependencies

**Added in v0.3.0:**
- `ai` (^4.0.0) - Vercel AI SDK core
- `@ai-sdk/google` (^1.0.0) - Google Gemini provider (default)

**Optional peer dependencies:**
- `@ai-sdk/openai` - OpenAI provider
- `@ai-sdk/cohere` - Cohere provider
- `@ai-sdk/anthropic` - Anthropic provider

## Browser Compatibility Implementation

### WebAssembly Vector Indexing

**Primary Implementation**: `HnswWasmService` (`src/vector/HnswWasmService.ts`)

- Uses `hnswlib-wasm` for browser-compatible HNSW indexing
- Replaces Node.js-only `hnswlib-node`
- Export alias: `export { HnswWasmService as HnswIndexService }` for backward compatibility

**Key Features**:
```typescript
// Async initialization (WASM loading)
const service = new HnswWasmService(storageService, indexConfig, batchConfig);
await service.initialize(); // Called automatically in constructor

// IndexedDB persistence via Emscripten FS
await index.writeIndex(indexName);
await lib.EmscriptenFileSystemManager.syncFS(false); // Persist to IndexedDB

// Loading from IndexedDB
await lib.EmscriptenFileSystemManager.syncFS(true);  // Load from IndexedDB
await index.readIndex(indexName, false);
```

**Performance Characteristics**:
- WASM loading: ~2-5MB, one-time download
- Query latency: 10-50ms (after index loaded)
- Index loading: 100-500ms (depends on size)
- Batch operations: 5-second window, max 50 vectors

**Storage Strategy**:
1. **In-Memory**: Active HNSW indices (fast access)
2. **IndexedDB**: Browser-persistent storage (via Emscripten)
3. **Walrus**: Distributed backup and cross-device sync

### No Filesystem Dependencies

**Problem**: Node.js `fs` module doesn't work in browsers

**Solution**:
- All file operations use IndexedDB via WASM Emscripten filesystem
- StorageService uses Walrus for blob storage
- No `process.cwd()` or Node.js-specific APIs

## Testing Strategy

### Test Organization

```
test/
├── services/            # Service unit tests
├── integration/         # Integration tests
├── storage/             # Walrus storage tests
├── encryption/          # SEAL encryption tests
├── hooks/               # React hooks tests
├── access/              # Access control tests
├── permissions/         # Consent management tests
├── transactions/        # Transaction builder tests
├── view/                # View function tests
└── wallet/              # Wallet architecture tests
```

### Running Tests

```bash
# All tests (60-second timeout for SEAL operations)
npm test

# Specific test file
npx jest test/services/EmbeddingService.test.ts

# Watch mode (re-run on changes)
npm run test:watch

# SEAL integration tests (requires testnet)
npm run test:seal

# Test with coverage
npm test -- --coverage

# Verbose output
npm test -- --verbose

# Specific test pattern
npx jest --testPathPattern=seal-deployment
```

### Test Configuration

**File**: `jest.config.js`

- **Environment**: Node.js (`testEnvironment: 'node'`)
- **Timeout**: 60 seconds (SEAL operations are slow)
- **Transform**: ts-jest for TypeScript
- **Setup**: `test/setup.ts` runs before all tests
- **Coverage**: Excludes `src/generated/` and `.d.ts` files

### Writing Tests

**Pattern for Service Tests**:

```typescript
import { EmbeddingService } from '../src/services/EmbeddingService';

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = new EmbeddingService({
      apiKey: process.env.GEMINI_API_KEY,
      model: 'text-embedding-004',
      dimensions: 768
    });
  });

  it('should generate embeddings', async () => {
    const result = await service.embedText({
      text: 'test content',
      type: 'RETRIEVAL_DOCUMENT'
    });

    expect(result.embedding).toHaveLength(768);
    expect(result.embedding[0]).toBeGreaterThan(-1);
    expect(result.embedding[0]).toBeLessThan(1);
  });
});
```

**SEAL Tests Require Testnet**:

```typescript
// SEAL tests need actual key servers and Sui testnet
it('should encrypt and decrypt data', async () => {
  const sealClient = await SealClient.new(
    SEAL_OBJECT_IDS,
    suiClient,
    'testnet'
  );

  // Test encryption/decryption flow
}, 60000); // 60-second timeout
```

## Code Generation

### Move Contract Types

**When to Regenerate**:
- After smart contract changes in `../../smart-contract/`
- After changing Move function signatures
- After adding new Move modules

**Process**:
```bash
# 1. Build Move contracts
cd ../../smart-contract
sui move build

# 2. Generate TypeScript types
cd ../packages/pdw-sdk
npm run codegen

# 3. Types generated in src/generated/
# 4. Commit generated files (required for type safety)
```

**Generated Files**:
- `src/generated/pdw/memory.ts` - Memory module types
- `src/generated/pdw/wallet.ts` - Wallet module types
- `src/generated/pdw/seal_access_control.ts` - Access control types
- `src/generated/utils/` - Utility functions

**Never Edit Generated Files Manually** - They will be overwritten.

## Key Implementation Patterns

### Async Initialization Pattern

Many services require async initialization (WASM loading, client setup):

```typescript
class MyService {
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    // Load WASM, connect to services, etc.
  }

  async someMethod() {
    await this.initPromise; // Wait for initialization
    // ... do work
  }
}
```

### Batch Processing Pattern

**Location**: `src/batch/BatchManager.ts`, `src/vector/HnswWasmService.ts`

Vector indexing uses intelligent batching for performance:

```typescript
// Batching configuration
{
  maxBatchSize: 50,        // Max vectors per batch
  batchDelayMs: 5000,      // Wait 5s to collect vectors
  maxCacheSize: 100,       // Max batches in memory
  cacheTtlMs: 30 * 60 * 1000  // 30-minute cache TTL
}

// Vectors are queued and processed in batches
await vectorService.addVector(embedding, id); // Queued
// ... more vectors added within 5 seconds
// Batch automatically processed after delay or when size reached
```

**Why Batching Matters**:
- HNSW index operations are expensive
- IndexedDB writes are async
- Walrus uploads benefit from batching
- Reduces user-perceived latency

### Progress Callback Pattern

**Location**: `src/client/ClientMemoryManager.ts`

Long-running operations provide progress updates:

```typescript
await manager.createMemory({
  content: 'My memory',
  account,
  signAndExecute,
  client,
  onProgress: (status: string) => {
    // status examples:
    // "Generating embedding..."
    // "Encrypting with SEAL..."
    // "Uploading to Walrus..."
    // "Registering on-chain..."
    // "Indexing vector..."
    console.log(status);
  }
});
```

### Error Recovery Pattern

**Location**: `src/errors/recovery.ts`

Services implement graceful degradation:

```typescript
try {
  // Try primary method
  await uploadToWalrus(data);
} catch (error) {
  // Fall back to local storage
  console.warn('Walrus upload failed, using local storage');
  await saveLocally(data);
}
```

## Configuration Management

### Environment Variables

**Required**:
```bash
NEXT_PUBLIC_PACKAGE_ID=0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde
NEXT_PUBLIC_ACCESS_REGISTRY_ID=0x1d0a1936e170e54ff12ef30a042b390a8ef6dff3a642c5e7056222da038bde
NEXT_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
NEXT_PUBLIC_GEMINI_API_KEY=<your-gemini-api-key>
```

**Optional**:
```bash
NEXT_PUBLIC_WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
NEXT_PUBLIC_SUI_NETWORK=testnet
NEXT_PUBLIC_SEAL_KEY_SERVERS=https://keyserver1.com,https://keyserver2.com
```

### Configuration Helper

**Location**: `src/config/ConfigurationHelper.ts`

Provides environment-aware configuration:

```typescript
import { Config } from './config';

const geminiKey = Config.getGeminiKey();
const packageId = Config.getPackageId();
const network = Config.getNetwork(); // 'testnet' | 'mainnet' | 'devnet'
```

## Common Development Tasks

### Adding a New Service

1. Create service file in `src/services/` or `src/infrastructure/`
2. Implement service interface from `src/core/interfaces/`
3. Add to exports in `src/services/index.ts` or relevant module index
4. Update `src/index.ts` if exposing at top level
5. Write tests in `test/services/`
6. Update this documentation

### Adding a New React Hook

1. Create hook file in `src/hooks/`
2. Follow React Query patterns (useMutation for writes, useQuery for reads)
3. Add types to `src/hooks/utils/types.ts` if shared
4. Export from `src/hooks/index.ts`
5. Update `src/index.ts` exports
6. Write tests in `test/hooks/`
7. Update README.md with usage example
8. For LangChain hooks, also export from `src/langchain/index.ts` if applicable

### Adding LangChain Integration Features

1. Create new component in `src/langchain/`
2. Implement standard LangChain interfaces (Embeddings, VectorStore, etc.)
3. Add corresponding React hook in `src/hooks/` if needed
4. Export from `src/langchain/index.ts`
5. Ensure browser compatibility (no Node.js-specific code)
6. Write integration tests with LangChain chains
7. Update documentation with usage examples

### Modifying Move Contracts

1. Edit contracts in `../../smart-contract/sources/`
2. Run `sui move build` in smart-contract directory
3. Run `npm run codegen` in pdw-sdk directory
4. Update service code to use new types
5. Update tests
6. Commit both Move code and generated TypeScript

### Adding Browser-Compatible Features

**Checklist**:
- ✅ No `fs`, `path`, or Node.js-only modules
- ✅ Use IndexedDB for persistence (via WASM Emscripten if needed)
- ✅ Use Web APIs (fetch, crypto, IndexedDB)
- ✅ Test in actual browser (not just Node.js)
- ✅ Handle WASM async loading
- ✅ Consider memory limits (~2-4GB per tab)

## Debugging Tips

### WASM Loading Issues

```typescript
// Check if WASM loaded
console.log('WASM loaded:', !!hnswlib);

// Monitor WASM loading time
const start = Date.now();
await loadHnswlib();
console.log('WASM load time:', Date.now() - start, 'ms');
```

### IndexedDB Issues

```typescript
// Check IndexedDB quota
if (navigator.storage && navigator.storage.estimate) {
  const estimate = await navigator.storage.estimate();
  console.log('Storage used:', estimate.usage);
  console.log('Storage quota:', estimate.quota);
}

// Check if IndexedDB is available
const isAvailable = 'indexedDB' in window;
console.log('IndexedDB available:', isAvailable);
```

### SEAL Decryption Failures

```typescript
// Common issues:
// 1. Session key expired (TTL exceeded)
// 2. Wrong identity format (must be [PackageId][UserAddress])
// 3. Key servers unreachable
// 4. Invalid ciphertext format

// Debug identity
const identity = `${packageId}${userAddress.replace('0x', '')}`;
console.log('SEAL identity:', identity);
console.log('Identity length:', identity.length); // Should be 32 + 64 = 96 chars
```

### Vector Search Returns No Results

```typescript
// Common issues:
// 1. Index not loaded
// 2. Query vector dimensions mismatch
// 3. Empty index
// 4. efSearch too low

// Debug
console.log('Index loaded:', await service.hasIndex(userAddress));
console.log('Vector count:', await service.getVectorCount(userAddress));
console.log('Query dimensions:', queryVector.length); // Should be 768
```

## Performance Optimization

### Memory Creation Flow

**Current Performance** (~1-2 seconds):
1. Embedding generation: ~200-500ms (Gemini API)
2. Knowledge graph extraction: ~300-500ms (Gemini API)
3. SEAL encryption: ~50-200ms
4. Walrus upload: ~200-500ms
5. Sui transaction: ~100-300ms
6. Vector indexing: ~10-50ms (batched)

**Optimization Opportunities**:
- Parallelize embedding + graph extraction (independent operations)
- Batch multiple memory creations
- Skip encryption for non-sensitive content
- Use local-first indexing (update Walrus in background)

### Vector Search Flow

**Current Performance** (~50-200ms):
1. Load/check index: ~10-50ms (cached)
2. Generate query embedding: ~200-500ms (Gemini API)
3. HNSW search: ~10-50ms
4. Load memory metadata: ~20-100ms (Sui RPC)
5. Retrieve content: ~100-300ms (Walrus + SEAL)

**Optimization Opportunities**:
- Pre-generate embeddings for common queries
- Cache query embeddings (same query → same embedding)
- Load metadata in parallel with content retrieval
- Skip decryption if only showing summaries

## SDK Exports Structure

**Top-Level Exports** (`src/index.ts`):

```typescript
// Pipeline (main entry)
export { MemoryPipeline, PipelineManager }

// Client APIs
export { ClientMemoryManager, PersonalDataWallet }

// React Hooks
export { useCreateMemory, useSearchMemories, useMemoryChat, ... }

// Services (business logic)
export { MemoryService, ChatService, StorageService, ... }

// Infrastructure
export { WalrusStorageService, SuiService, SealService, ... }

// Utilities
export { VectorManager, GraphService, BatchManager, ... }

// Types (all major interfaces and types)
```

**Subpath Exports** (`package.json` exports):

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./hooks": "./dist/hooks/index.js",         // React hooks only
    "./services": "./dist/services/index.js",   // Server-safe exports
    "./langchain": "./dist/langchain/index.js"  // LangChain integration
  }
}
```

## Critical Notes for AI Assistants

### When Modifying Services

- **Always check dependencies**: Services often depend on other services (dependency injection pattern)
- **Maintain backward compatibility**: Many projects depend on this SDK
- **Update TypeScript types**: Ensure exported types match implementation
- **Consider browser compatibility**: No Node.js-only APIs
- **Test with actual Sui testnet**: Mock tests aren't enough for blockchain interactions
- **StorageService refactoring**: The StorageService now uses manager delegation - when adding storage features, consider which manager should own the functionality (WalrusStorageManager, MemorySearchManager, etc.)

### When Working with WASM

- **Async initialization is mandatory**: WASM modules load asynchronously
- **Handle loading errors gracefully**: WASM might fail to load in some environments
- **Test in actual browsers**: Node.js behavior differs from browsers
- **Consider bundle size**: WASM files add to bundle size

### When Working with React Hooks

- **Follow React Query patterns**: Don't reinvent caching/loading states
- **Use stable identities for cache keys**: Avoid object/array keys
- **Provide TypeScript types for all options**: Hooks are user-facing
- **Document progress callbacks**: Users rely on these for UX

### When Working with Transactions

- **Always use transaction builders**: Don't construct PTB arguments manually
- **Test on testnet first**: Mainnet transactions cost real money
- **Handle signature errors**: Wallet connection issues are common
- **Provide clear error messages**: Users need to know what went wrong

### When Working with LangChain Integration

- **Follow LangChain interfaces**: PDWVectorStore and PDWEmbeddings implement standard LangChain interfaces
- **Maintain compatibility**: Changes should not break existing LangChain chains
- **Test with real LangChain chains**: Use actual RAG pipelines, not just unit tests
- **Document examples**: LangChain users expect clear integration examples
- **Browser-first design**: All LangChain components must work in browsers (WASM HNSW, no Node.js deps)

## Related Files

- **Repository-level**: `../../CLAUDE.md` - Overall project documentation
- **Example app**: `example/README.md` - Integration examples
- **Package info**: `package.json` - Dependencies and scripts
- **TypeScript config**: `tsconfig.json` - Compiler settings
- **Jest config**: `jest.config.js` - Test configuration

## Version Information

- **SDK Version**: 0.2.4
- **Node.js**: 20.x+ (for development)
- **Browser Support**: Chrome 57+, Firefox 52+, Safari 11+, Edge 16+
- **Package Manager**: npm (package-lock.json committed)
