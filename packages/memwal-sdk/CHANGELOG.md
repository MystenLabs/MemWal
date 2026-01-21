# Changelog

## 0.9.0

### Major Changes

**🎯 Simplified API (5 Core Namespaces)**

This release introduces a simplified, unified API that reduces complexity from 20+ namespaces to 5 core namespaces. The goal is making 90% of tasks achievable with just `pdw.memory.*`.

**Core Namespaces:**
```typescript
pdw.memory   // Create, get, search, list, delete memories
pdw.ai       // Embed, classify, extract commands
pdw.index    // HNSW index management
pdw.wallet   // Wallet address and balance info
pdw.advanced // Power user features (graph, analytics, etc.)
```

**New Unified Search API:**
```typescript
// OLD (multiple steps required)
const embedding = await pdw.embeddings.generate(query);
const results = await pdw.search.vector(embedding, { limit: 10 });

// NEW (single method, auto-embeds query)
const results = await pdw.memory.search(query, {
  limit: 10,
  threshold: 0.3,
  category: 'fact',
  includeContent: true
});
```

**🔧 Server-Side RAG Support**

Added `forceStoreContent` option for server-side RAG applications. When encryption is enabled, content is normally NOT stored in the local index for security. This option allows storing plaintext content in the local index for RAG use cases.

```typescript
await pdw.index.add(walletAddress, vectorId, embedding, {
  content: plaintextContent,
  blobId: blobId,
  isEncrypted: true,
  forceStoreContent: true  // Store content for RAG even when encrypted
});
```

**Use Case:** Server-side chat APIs that need to search and retrieve memory content without decrypting from Walrus on every request.

**⚡ Performance: Default 768 Dimensions**

Changed default embedding dimensions from 3072 to 768 for better performance:

| Dimensions | Embedding Speed | Storage Size | Search Speed | Quality |
|------------|-----------------|--------------|--------------|---------|
| **768** (new default) | Fast | Small | Fast | Good |
| 1536 | Medium | Medium | Medium | Better |
| 3072 | Slow | Large | Slow | Best |

**Configuration:**
```typescript
const pdw = new SimplePDWClient({
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY,
    dimensions: 768  // Default, can be 1536 or 3072
  }
});
```

**Environment Variable:**
```bash
EMBEDDING_DIMENSIONS=768  # 768 (default), 1536, 3072
```

### New Features

**`pdw.memory.search()` - Unified Semantic Search**
- Auto-embeds query text
- Auto-decrypts content (if encrypted)
- Returns content with similarity scores
- Supports category filtering
- Configurable similarity threshold

```typescript
const results = await pdw.memory.search('work experience', {
  limit: 10,
  threshold: 0.3,     // Minimum similarity (0-1)
  category: 'fact',   // Optional filter
  includeContent: true
});

// Returns: [{ id, content, similarity, category, importance, ... }]
```

**`pdw.ai.extractMultipleMemories()` - Memory Command Extraction**
- Parse user input for multiple memories
- Supports "remember X and Y" patterns
- Used by chat APIs for automatic memory detection

```typescript
const memories = pdw.ai.extractMultipleMemories(
  "remember I like pizza and my name is John"
);
// Returns: ["I like pizza", "my name is John"]
```

**Index Management Improvements**
- `forceStoreContent` option for RAG
- Better cross-process index loading
- Improved flush/save reliability

### Deprecations

The following namespaces are deprecated (still work with console warnings):

| Deprecated | Use Instead |
|------------|-------------|
| `pdw.search.vector()` | `pdw.memory.search()` |
| `pdw.search.byCategory()` | `pdw.memory.list({ category })` |
| `pdw.search.hybrid()` | `pdw.memory.search(query, { category })` |
| `pdw.embeddings.generate()` | `pdw.ai.embed()` |
| `pdw.classify.category()` | `pdw.ai.classify()` |

**Deprecation Timeline:**
- v0.9.0: Deprecation warnings added
- v1.0.0: Warnings become errors
- v2.0.0: Deprecated methods removed

### Bug Fixes

- **RAG with Encryption**: Fixed issue where encrypted memories had no content in local index, preventing RAG from working
- **Cross-Process Index**: Added explicit index loading for Next.js API routes running in separate processes
- **Dimension Mismatch**: Fixed dimension configuration inconsistencies across services

### Documentation

- **README.md**: Complete rewrite with full API reference
  - 5 core namespaces documented
  - Server-side RAG section
  - Configuration examples
  - Embedding providers comparison
  - Index rebuild guide
- **CLAUDE.md**: Updated with simplified API patterns
- **Examples**: Updated to use new `pdw.memory.search()` API

### Migration Guide

**From v0.8.0:**

1. **Search API** (recommended but not required):
   ```typescript
   // Old
   const results = await pdw.search.vector(query, { limit: 10 });

   // New
   const results = await pdw.memory.search(query, { limit: 10 });
   ```

2. **Embedding Dimensions** (if using 3072):
   - Existing indexes continue to work
   - New memories default to 768
   - Set `EMBEDDING_DIMENSIONS=3072` to keep 3072

3. **Server-Side RAG**:
   - Add `forceStoreContent: true` to index operations
   - Rebuild index to include content for existing memories

---

## 0.8.0

### Major Changes

**🔐 Default SEAL Encryption (v2.2 Format)**

This release enables end-to-end encryption by default using Mysten's SEAL protocol. All memory content AND vector embeddings are now encrypted before being stored on Walrus.

**New Encryption Features:**
- **v2.2 Package Format**: Both content and embedding are encrypted (full privacy - no plaintext on Walrus)
- **Capability-based Encryption**: Each memory gets a unique MemoryCap → keyId for decryption
- **Session Key Caching**: Single wallet signature creates session key for multiple decrypt operations
- **Automatic Decryption**: `pdw.storage.retrieveAndDecrypt()` handles all version detection and decryption internally

**New SDK Methods:**
- `pdw.storage.retrieveAndDecrypt(blobId, options)` - High-level decrypt API with automatic version detection
- `pdw.storage.storeMemoryPackage()` - Now encrypts both content + embedding by default
- Supports v2.2 (full encryption), v2.1, v2.0 (legacy), and plaintext formats

**Privacy Improvements:**
- Vector embeddings are now encrypted (prevents embedding inversion attacks)
- Only the wallet owner can decrypt (identity-based encryption)
- Embedding stored encrypted on Walrus, decrypted locally for HNSW index rebuild

**Example Usage:**
```typescript
// Encrypt & Upload (automatic)
const memory = await pdw.memory.create('Secret information');
// Content + Embedding encrypted → uploaded to Walrus

// Decrypt & Retrieve (automatic)
const result = await pdw.storage.retrieveAndDecrypt(blobId, {
  signFn: async (msg) => ({ signature: await wallet.sign(msg) })
});
console.log(result.content);     // Decrypted content
console.log(result.embedding);   // Decrypted 3072D vector
console.log(result.version);     // "2.2"
```

**Breaking Changes:**
- Encryption is now enabled by default (`features.enableEncryption: true`)
- New memories use v2.2 format (backward compatible - can still read v2.0/v2.1/legacy)

**🚀 Walrus Storage Optimization**

Improved Walrus integration with proper endpoint support for faster uploads:

- **Upload Relay Support**: New `walrusUploadRelayUrl` config for browser/mobile uploads (fewer network connections)
- **Publisher Support**: `walrusPublisherUrl` for server-side direct uploads
- **Aggregator**: `walrusAggregatorUrl` for blob retrieval
- **Auto-detection**: Automatically uses Upload Relay in browser, Publisher on server
- **Fixed REST API endpoints**: Correct `/v1/blobs` endpoint paths per Walrus docs

**Testnet Defaults:**
```typescript
{
  walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  walrusUploadRelayUrl: 'https://upload-relay.testnet.walrus.space',
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
}
```

---

## 0.7.0

### Minor Changes

**Performance Optimizations:**
- Global singleton cache and wallet integration optimization
- Add LRU cache to NodeHnswService with configurable capacity (default: 1000 entries)
- Add LRU cache to HnswWasmService for memory management
- Add singleton pattern for EmbeddingService to prevent multiple instances
- Reduce default embedding dimension from 3072 to 768 for better performance
- Memory cache eviction to prevent memory leaks

**New Features:**
- `findMemoryInQuilt()` method for improved quilt file matching
- Enhanced Quilt memory indexing with batch upload support
- MemoryIndex on-chain management utilities
- HNSW index Walrus sync for cross-device restoration
- Incremental index sync by blobId

**Bug Fixes:**
- Fix Quilt batch sync by extracting base quiltId correctly
- Fix batch memory content storage and transaction status detection
- Fix Quilt blobId and use `getBlob().files()` for correct retrieval

**Architecture Improvements:**
- Memory management with LRU eviction policies
- Optimized cache strategies for embedding and HNSW services
- Improved Quilt file handling and retrieval patterns

## 0.6.2

### Patch Changes

**Quilt blobId Fix:**
- QuiltBatchManager: use shared `quiltId` instead of `quiltPatchId` as blobId for correct file retrieval
- QuiltBatchManager: update all retrieval methods (`getQuiltFiles`, `getFileByIdentifier`, `listQuiltPatches`, `getQuiltFilesByTags`) to use `getBlob().files()` pattern
- rebuildIndexNode: use `getBlob().files()` for proper Quilt parsing during index recovery
- sync-missing API: use `getBlob().files()` for Quilt file retrieval

**Improvements:**
- Immediate local index creation when saving memories (no need to wait for sync)
- Enhanced GeminiAIService with improved embedding generation
- StorageNamespace: added batch upload methods

## 0.6.1

### Patch Changes

- [`d55c998`](https://github.com/CommandOSSLabs/MemWal/commit/d55c9982f29b619d15a88a2d759260a0ce7c82df) Thanks [@Aaron1924](https://github.com/Aaron1924)! - Add DappKitSigner for @mysten/dapp-kit wallet integration

  **New Features:**

  - `DappKitSigner` adapter for browser wallet signing with dapp-kit hooks
  - `getClient()` method on `UnifiedSigner` interface for SuiClient access
  - `./browser` export path for browser-safe imports (excludes Node.js dependencies)

  **Bug Fixes:**

  - Fix VectorService metadata priority for correct blob retrieval
  - Dynamic import for createHnswService to prevent bundling hnswlib-node in browser builds

  **Usage with Slush/Sui wallets:**

  ```typescript
  import { DappKitSigner, SimplePDWClient } from '@cmdoss/memwal-sdk/browser';
  import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';

  const signer = new DappKitSigner({
    address: account.address,
    client: suiClient,
    signAndExecuteTransaction: signAndExecute,
  });

  const pdw = new SimplePDWClient({ signer, network: 'testnet', ... });
  await pdw.memory.create('Hello world'); // Wallet popup for signing
  ```

All notable changes to the MemWal SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2025-12-18

### 🎉 Major Features

#### Official SDK Integration (No More External API Calls)

- **Refactored** All external `fetch()` API calls replaced with official SDKs
- **Added** `@mysten/walrus` SDK for Walrus storage operations
- **Added** `@openrouter/sdk` for AI chat and embeddings
- **Upgraded** Walrus operations to use native SDK methods (`writeBlob`, `readBlob`, `writeFiles`)

**Benefits**:

- ✅ Better type safety with official TypeScript SDKs
- ✅ Automatic error handling and retries built into SDKs
- ✅ No manual HTTP request handling
- ✅ SDK updates automatically bring new features
- ✅ REST API fallback for read-only operations without signer

#### Walrus SDK Integration

- **Changed** `WalrusStorageService` to use `@mysten/walrus` SDK
- **Added** `writeBlob()` for single blob uploads (requires signer)
- **Added** `readBlob()` for blob retrieval
- **Maintained** REST API fallback when signer unavailable

```typescript
// SDK automatically handles upload/download
const { blobId } = await walrusClient.walrus.writeBlob({
  blob: data,
  epochs: 12,
  signer: keypair,
});

const content = await walrusClient.walrus.readBlob({ blobId });
```

#### OpenRouter SDK Integration

- **Changed** `GeminiAIService` to use `@openrouter/sdk` for chat completions
- **Changed** `EmbeddingService` to use `@openrouter/sdk` for embeddings
- **Added** Proper type handling for SDK response unions

```typescript
// Chat completions via SDK
const result = await openRouterClient.chat.send({
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user", content: prompt }],
});

// Embeddings via SDK
const embeddings = await openRouterClient.embeddings.generate({
  model: "google/gemini-embedding-001",
  input: text,
});
```

#### Batch Memory Upload (Quilt)

- **Added** `pdw.memory.createBatch()` for efficient multi-memory uploads
- **Uses** Walrus SDK `writeFiles()` with automatic Quilt batching
- **Achieves** ~90% gas savings vs individual uploads
- **Pipeline**: Parallel classify → embed → encrypt → batch upload → batch register

```typescript
// Upload 3 memories in a single Quilt transaction
const memories = await pdw.memory.createBatch(
  ["I love TypeScript", "Meeting at 3pm tomorrow", "Remember to buy milk"],
  {
    category: "note",
    importance: 5,
  }
);
// Gas saved: ~67% (3 items → 1 transaction)
```

#### Optional Encryption (Option A+)

- **Changed** Encryption is now optional per-memory
- **Added** `enableEncryption` feature flag for flexible security
- **Implemented** "Option A+" pattern:
  - Encryption OFF: Content stored in local index for fast retrieval
  - Encryption ON: Content NOT stored in index (security - prevents data leakage)
- **Benefits**: Fast local search without Walrus fetch when security not required

```typescript
// Configure encryption at client level
const pdw = new SimplePDWClient({
  features: {
    enableEncryption: false, // Fast local retrieval
    // OR
    enableEncryption: true, // Secure, fetch from Walrus on search
  },
});
```

#### Optimized Index Service

- **Added** Singleton pattern for HNSW service (prevents redundant initializations)
- **Added** Index staleness detection for multi-process scenarios
- **Added** Auto-reload from disk when file is newer than cache
- **Improved** `SerialTransactionExecutor` for gas coin management
- **Optimized** Vector metadata storage with `isEncrypted` flag

### 🔧 Bug Fixes

#### SDK Type Handling

- **Fixed** OpenRouter chat content type (can be string or array)
- **Fixed** OpenRouter embeddings response union type handling
- **Fixed** Walrus SDK `$extend` method usage (not `extend`)

### ✨ Enhancements

#### QuiltBatchManager

- **Confirmed** Already uses `writeFiles()` from Walrus SDK for batch uploads
- **Maintained** Efficient multi-file uploads with ~90% gas savings

### 📦 Dependencies

- **Added** `@openrouter/sdk` `^0.3.7` - Official OpenRouter SDK
- **Updated** `@mysten/walrus` `^0.8.3` - Walrus SDK with writeBlob/readBlob

### 🔧 Installation Notes

#### hnswlib-node Native Binding Issues

If you encounter errors related to native bindings, node-gyp, or addon compilation when installing `hnswlib-node`:

**Common Error Messages:**

- `Error: Cannot find module 'hnswlib-node'`
- `node-gyp rebuild failed`
- `error MSB8020: The build tools for v143 cannot be found`
- `gyp ERR! build error`
- `Module did not self-register`

**Solutions:**

1. **Skip hnswlib-node** (uses WASM fallback - slower but works everywhere):

   ```bash
   npm install --ignore-optional
   # or
   npm install --omit=optional
   ```

2. **Install build tools** (for native performance):

   **Windows:**

   ```powershell
   # Run as Administrator
   npm install -g windows-build-tools
   # Or install Visual Studio Build Tools with C++ workload
   ```

   **macOS:**

   ```bash
   xcode-select --install
   ```

   **Linux (Ubuntu/Debian):**

   ```bash
   sudo apt-get install build-essential python3
   ```

   **Linux (RHEL/CentOS):**

   ```bash
   sudo yum groupinstall "Development Tools"
   ```

3. **Rebuild after installing build tools:**

   ```bash
   npm rebuild hnswlib-node
   ```

4. **Check Node.js version compatibility:**
   - `hnswlib-node` requires Node.js 14.x - 22.x
   - Run `node -v` to verify your version

**Performance Comparison:**
| Implementation | Environment | Speed | Memory |
|----------------|-------------|-------|--------|
| `hnswlib-node` | Node.js | **Fastest** (native C++) | Lower |
| `hnswlib-wasm` | Browser + Node.js | Good (WebAssembly) | Higher |

The SDK automatically falls back to `hnswlib-wasm` if `hnswlib-node` is not available.

---

## [0.5.0] - 2025-12-16

### 🎉 Major Features

#### OpenRouter Integration (Unified AI Gateway)

- **Added** Full OpenRouter support as the default AI provider for embeddings and chat
- **Added** `google/gemini-embedding-001` model via OpenRouter (3072 dimensions)
- **Added** `google/gemini-2.5-flash` model via OpenRouter for chat/classification
- **Refactored** `GeminiAIService` to use OpenRouter Chat Completions API instead of direct `@google/genai`
- **Refactored** `EmbeddingService` to support OpenRouter embeddings endpoint

**Benefits**:

- ✅ Single API key (`OPENROUTER_API_KEY`) for all AI operations
- ✅ Access to 200+ AI models through unified API
- ✅ Better rate limits and reliability
- ✅ Fallback support across multiple providers
- ✅ Cost optimization with model selection flexibility

**Configuration**:

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: "testnet",
  embedding: {
    provider: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY,
    modelName: "google/gemini-embedding-001", // 3072 dimensions
  },
  features: {
    enableLocalIndexing: true,
  },
});
```

**Environment Variables**:

```env
OPENROUTER_API_KEY=sk-or-v1-...
AI_CHAT_MODEL=google/gemini-2.5-flash        # Chat/classification model
AI_EMBEDDING_MODEL=google/gemini-embedding-001  # Embedding model (3072 dims)
```

#### Vector Dimension Upgrade (768 → 3072)

- **Changed** Default embedding dimension from 768 to 3072
- **Updated** All HNSW services (`NodeHnswService`, `HnswWasmService`, `BrowserHnswIndexService`)
- **Updated** All namespace defaults (`IndexNamespace`, `SearchNamespace`, `TxNamespace`)
- **Updated** All service defaults (`EmbeddingService`, `VectorService`, `MemoryIndexService`)
- **Updated** LangChain integration (`PDWEmbeddings`, `PDWVectorStore`)
- **Updated** Utility scripts (`rebuildIndex`, `rebuildIndexNode`)

**Migration Note**:
⚠️ Existing HNSW indexes created with 768 dimensions must be rebuilt:

```typescript
import { rebuildIndexNode, clearIndexNode } from "personal-data-wallet-sdk";

// Clear old index
await clearIndexNode(userAddress);

// Rebuild with new 3072 dimensions
const result = await rebuildIndexNode({
  userAddress,
  client,
  packageId,
  walrusAggregator,
  force: true,
});
```

### 🔧 Bug Fixes

#### ESM Module Compatibility

- **Fixed** ESM import issues with `@openrouter/ai-sdk-provider`
- **Fixed** AI SDK v5 compatibility (removed unsupported `compatibility` option)
- **Fixed** OpenRouter API endpoint (uses `/chat/completions` not `/responses`)

#### API Route Fixes

- **Fixed** `pdw.pipeline.createMemory is not a function` error
  - Changed to correct method: `pdw.memory.create()`
- **Fixed** Memory save result property access (`saveResult.id` instead of `saveResult.memoryObjectId`)

### ✨ Enhancements

#### Model Configuration via Environment

- **Added** Environment variable support for AI models:
  - `AI_CHAT_MODEL` - Default: `google/gemini-2.5-flash`
  - `AI_EMBEDDING_MODEL` - Default: `google/gemini-embedding-001`
- **Updated** All services to read from environment with fallback defaults

### 📦 Dependencies

- **Recommended** `@openrouter/ai-sdk-provider` for Vercel AI SDK integration
- **Maintained** `@google/genai` for backward compatibility
- **Maintained** `ai` v5.x for AI SDK core

### 🔄 Breaking Changes

1. **Embedding Dimensions**: Default changed from 768 to 3072

   - Existing indexes need rebuilding
   - Walrus blobs with old embeddings remain readable

2. **OpenRouter as Default**:
   - Direct Google Gemini API still supported via `provider: 'google'`
   - OpenRouter recommended for production use

### 📊 Performance

- **Improved** Embedding quality with 3072 dimensions (4x more semantic information)
- **Improved** Rate limiting with OpenRouter's unified gateway
- **Maintained** HNSW search performance (dimension increase has minimal impact)

---

## [0.4.1] - 2025-12-15

### 🔧 Bug Fixes

#### Multi-Device Index Sync

- **Added** Index staleness detection for multi-process scenarios
- **Added** Auto-reload index from disk when file is newer than cache
- **Added** `rebuildIndexNode()` utility for Node.js environments

---

## [0.4.0] - 2025-12-11

### 🎉 Major Features

#### Hybrid HNSW Implementation (Node.js + Browser Support)

- **Added** `hnswlib-node` support for Node.js/Next.js Server Components
- **Added** `IHnswService` interface for unified HNSW operations across environments
- **Added** `createHnswService()` factory function with automatic environment detection
- **Added** Singleton pattern to prevent redundant HNSW initializations
- **Refactored** Vector indexing to support both:
  - **Browser**: `hnswlib-wasm` (WebAssembly)
  - **Node.js**: `hnswlib-node` (native bindings)

**Benefits**:

- ✅ Full Next.js RSC (React Server Components) support
- ✅ Works in API routes, server actions, and edge functions
- ✅ Singleton pattern reduces initialization overhead by 4x
- ✅ Automatic environment detection - no configuration needed

**Example Usage**:

```typescript
import { createHnswService } from "personal-data-wallet-sdk";

// Automatically uses hnswlib-node in Node.js, hnswlib-wasm in browser
const hnswService = await createHnswService({
  indexConfig: { dimension: 768 },
});

await hnswService.addVector(userAddress, vectorId, embedding);
const results = await hnswService.search(userAddress, queryVector);
```

#### Optimized Sui Transaction Handling

- **Improved** Gas coin conflict handling with exponential backoff retry
- **Added** Automatic transaction rebuilding on version conflicts
- **Enhanced** Retry logic: 500ms → 1000ms → 2000ms delays
- **Documented** Root cause analysis (gas coin versioning, not Memory object conflicts)

### 🔧 Configuration Changes

#### Gemini Model Updates

- **Changed** Default AI model from `gemini-2.0-flash-exp` to `gemini-2.5-flash-lite`
- **Updated** All services to use `gemini-2.5-flash-lite`:
  - `ClientMemoryManager`, `GeminiAIService`, `ChatService`
  - `ChatNamespace`, `AINamespace`, `GraphService`, `MemoryPipeline`

**Benefits**:

- ✅ Higher rate limits (stable model vs experimental)
- ✅ Better reliability for production use

### 🐛 Bug Fixes

#### Next.js Compatibility

- **Fixed** Webpack bundling issues with native Node.js modules
- **Added** `serverComponentsExternalPackages` configuration
- **Fixed** Dynamic import warnings in Next.js builds

### ✨ Enhancements

#### New Exports

- **Added** `createHnswService` - Factory for environment-aware HNSW service
- **Added** `isHnswAvailable()`, `getHnswServiceType()`, `resetHnswServiceSingleton()`
- **Added** `isBrowser()` / `isNode()` - Environment detection utilities

### 📦 Dependencies

- **Added** `hnswlib-node` `^3.0.0` - Native Node.js HNSW implementation
- **Maintained** `hnswlib-wasm` `^0.8.2` for browser support

---

## [0.3.0] - 2025-01-18

### 🎉 Major Features

#### Vercel AI SDK Integration (Provider-Agnostic Embeddings)

- **Added** Full integration with [Vercel AI SDK](https://sdk.vercel.ai/docs) - PDW now depends on `ai` package as the default embedding layer
- **Added** `PDWVectorStore` class - Familiar vector store API for AI SDK users (similar to Pinecone/Chroma)
- **Added** Multi-provider support: OpenAI, Google Gemini, Cohere, Anthropic, and any AI SDK-compatible provider
- **Refactored** `EmbeddingService` to wrap `ai` SDK's `embed()` and `embedMany()` functions
- **Added** Export path `personal-data-wallet-sdk/ai-sdk` for AI SDK integration

**Three Configuration Modes**:

1. **Direct Model**: Pass any `ai` SDK model directly
2. **Provider Config**: Specify provider name (google/openai/cohere) and API key
3. **Backward Compatible**: Existing code works unchanged (defaults to Google Gemini)

**Benefits**:

- ✅ **For AI SDK Users**: Use PDW as a decentralized vector database without vendor lock-in
- ✅ **For PDW Core**: Provider-agnostic architecture, standardized AI operations, better type safety
- ✅ **Fully Backward Compatible**: Zero breaking changes for existing users

**Example Usage**:

```typescript
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { PDWVectorStore } from "personal-data-wallet-sdk/ai-sdk";

const store = new PDWVectorStore({
  walrus: { aggregator: "..." },
  sui: { network: "testnet", packageId: "..." },
  signer,
  userAddress,
  dimensions: 1536,
});

const { embedding } = await embed({
  model: openai.embedding("text-embedding-3-small"),
  value: "Hello world",
});

await store.add({ id: "doc-1", vector: embedding, text: "Hello world" });
```

#### React Hooks (9 Production-Ready Hooks)

- **Added** `useMemoryManager()` - Foundation hook for ClientMemoryManager initialization
- **Added** `useCreateMemory()` - Memory creation with automatic loading states and progress tracking (7 stages)
- **Added** `useSearchMemories()` - Vector search with automatic debouncing (500ms) and React Query caching
- **Added** `useWalletMemories()` - Dashboard hook for fetching all user memories with filtering and sorting
- **Added** `useMemoryChat()` - Complete memory-aware AI chat with context retrieval (killer feature!)
- **Added** `useMemoryServices()` - Low-level service management for advanced use cases
- **Added** `useMemorySearch()` - Direct HNSW vector search operations
- **Added** `useMemoryIndex()` - Direct memory indexing operations
- **Added** `useKnowledgeGraph()` - Knowledge graph extraction and queries

All hooks include:

- ✅ Full TypeScript support with comprehensive types
- ✅ Automatic loading/error states
- ✅ React Query integration for caching
- ✅ Works seamlessly with @mysten/dapp-kit
- ✅ Optimistic updates support

### 🔧 Non-Breaking Changes

#### AI Layer Modernization

- **Changed** Default AI layer from direct `@google/genai` to Vercel AI SDK
  - **Impact**: Better multi-provider support, standardized API
  - **Migration**: No code changes required - existing code works unchanged
  - **Benefits**:
    - Support for OpenAI, Gemini, Cohere, Anthropic, and more
    - Standardized embedding API across providers
    - Better TypeScript types and error handling
    - Smaller bundle size with dynamic imports

#### Browser Compatibility

- **Changed** Vector indexing from `hnswlib-node` to `hnswlib-wasm` for browser compatibility
  - **Impact**: Full browser support via WebAssembly
  - **Migration**: No code changes required - API remains identical
  - **Benefits**:
    - Works in React/Next.js without Node.js polyfills
    - IndexedDB persistence via Emscripten File System
    - Near-native performance via WASM
    - Intelligent batching and caching

### 🐛 Bug Fixes

#### Build & Import Fixes

- **Fixed** Windows path separator issues in generated code from @mysten/codegen

  - Updated `scripts/fix-codegen-paths.js` to properly handle:
    - Backslash → forward slash conversion
    - Correct relative import paths for `deps/sui/*.ts` files (now `../../../utils/index.js`)
  - Generated files now build correctly on Windows

- **Fixed** TypeScript compilation errors in `HnswWasmService.ts`

  - Corrected `HierarchicalNSW` constructor calls (now uses `new` keyword)
  - Fixed `syncFS` calls to include required callback parameter
  - Fixed `searchKnn` to properly handle optional filter parameter
  - Fixed `readIndex` to use correct 2-parameter signature
  - **Preserved** IndexedDB persistence functionality

- **Fixed** Missing variable declaration in `HnswWasmService.ts:161`
  - Changed placeholder variable from `c` to `serialized`

### ✨ Enhancements

#### Query Process Refinements

- **Improved** Search debouncing with configurable delay (default 500ms)
- **Improved** Cache strategy with stale-while-revalidate pattern
- **Added** Configurable similarity thresholds for search results
- **Added** Pagination support foundation for `useWalletMemories()`
- **Enhanced** Error handling with specific error codes and messages

#### Metadata Component Debugging

- **Added** Comprehensive type definitions for all metadata operations
- **Added** Better error messages for metadata validation failures
- **Fixed** Metadata serialization for blockchain transactions
- **Improved** Metadata filtering in search results

#### Developer Experience

- **Simplified** README.md with clear Quick Start guide (237 lines vs 522)
- **Added** Comprehensive hook examples in README
- **Added** Environment variable configuration guide
- **Added** Troubleshooting section with common issues
- **Added** Hook comparison table showing features and priorities
- **Created** `IMPLEMENTATION_ROADMAP.md` with detailed future plans
- **Updated** Package exports to properly expose React hooks

### 📦 Dependencies

#### Added

- **ai** `^4.0.0` - Vercel AI SDK core (standardized AI operations)
- **@ai-sdk/google** `^1.0.0` - Google Gemini provider (default)
- **@tanstack/react-query** to `^5.90.2` (peer dependency for hooks)
- **hnswlib-wasm** `^0.8.2` (replaces hnswlib-node)

#### Optional Peer Dependencies

- **@ai-sdk/openai** - OpenAI embeddings (optional)
- **@ai-sdk/cohere** - Cohere embeddings (optional)
- **@ai-sdk/anthropic** - Anthropic embeddings (optional)

#### Removed

- **hnswlib-node** (no longer needed - replaced by WASM version)

### 📚 Documentation

#### AI SDK Integration

- **Added** Comprehensive AI SDK integration section in `CLAUDE.md`
- **Added** `examples/ai-sdk/README.md` - Complete guide for AI SDK users
- **Added** `examples/ai-sdk/basic-rag.ts` - Full RAG workflow example
- **Added** `examples/ai-sdk/multi-provider.ts` - Multi-provider demonstration
- **Added** Architecture diagrams showing PDW + AI SDK integration
- **Added** Migration guide with three configuration modes
- **Added** Troubleshooting section for common AI SDK issues

#### React Hooks

- **Added** Quick Start guide for React/Next.js apps
- **Added** Complete hook API reference in README
- **Added** Memory-aware chat example
- **Added** Configuration options documentation
- **Added** Core concepts explanation (Categories, Vector Search, SEAL, Walrus)
- **Created** `REACT_HOOKS.md` with detailed hook proposal and specifications
- **Created** `IMPLEMENTATION_ROADMAP.md` with 6-phase development plan

### 🏗️ Project Structure

```
packages/pdw-sdk/
├── src/
│   ├── ai-sdk/                       # NEW: AI SDK Integration
│   │   ├── index.ts                  # Export: personal-data-wallet-sdk/ai-sdk
│   │   ├── PDWVectorStore.ts         # Vector store for AI SDK users
│   │   └── types.ts                  # AI SDK integration types
│   ├── hooks/                        # NEW: React hooks
│   │   ├── index.ts                  # Main exports
│   │   ├── useMemoryManager.ts       # Foundation hook
│   │   ├── useCreateMemory.ts        # Memory creation
│   │   ├── useSearchMemories.ts      # Search with caching
│   │   ├── useWalletMemories.ts      # Dashboard support
│   │   ├── useMemoryChat.ts          # AI chat integration
│   │   ├── useMemoryServices.ts      # Service management
│   │   ├── useMemorySearch.ts        # Direct search
│   │   ├── useMemoryIndex.ts         # Direct indexing
│   │   ├── useKnowledgeGraph.ts      # Graph operations
│   │   └── utils/                    # Hook utilities
│   │       ├── types.ts              # Type definitions
│   │       └── cache.ts              # Cache keys
│   ├── services/
│   │   └── EmbeddingService.ts       # REFACTORED: Now wraps ai-sdk
│   └── vector/
│       └── HnswWasmService.ts        # UPDATED: Browser-compatible HNSW
├── examples/
│   └── ai-sdk/                       # NEW: AI SDK examples
│       ├── README.md                 # Complete guide
│       ├── basic-rag.ts              # RAG workflow
│       └── multi-provider.ts         # Multi-provider demo
└── scripts/
    └── fix-codegen-paths.js          # UPDATED: Better path fixing
```

### 🎯 Performance Improvements

- **Improved** Vector search performance with WASM (~10x faster than JS)
- **Added** Intelligent batching for memory operations (configurable batch size)
- **Added** Automatic cache cleanup to prevent memory leaks
- **Optimized** IndexedDB persistence with periodic sync
- **Reduced** bundle size for core hooks (targeting <50KB gzipped)

### 🔐 Security

- **Maintained** Full SEAL encryption support
- **Maintained** Identity-based encryption (IBE)
- **Maintained** Session key management
- **Enhanced** Error messages to avoid leaking sensitive information

### 🌐 Browser Support

Now fully compatible with:

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Opera 76+
- ✅ All modern browsers with WebAssembly support

### 📊 Metrics

- **9 hooks** implemented (64% of planned 14 hooks)
- **5 core hooks** (100% of Phase 1)
- **4 browser-compatible hooks** (100%)
- **5 advanced hooks** remaining (Phase 2-3)

---

## [0.2.0] - 2025-01-XX

### Added

- Initial SDK release
- ClientMemoryManager for browser-side memory operations
- SEAL encryption integration
- Walrus storage integration
- Sui blockchain integration
- Vector search with HNSW
- Knowledge graph extraction
- AI embeddings via Gemini

### Changed

- Restructured package architecture
- Separated infrastructure services

### Fixed

- Various stability improvements

---

## [0.1.0] - 2024-XX-XX

### Added

- Initial prototype release
- Basic memory creation
- Basic search functionality

---

## Future Releases

### [0.4.0] - Planned Q1 2025

- Advanced hooks: `useMemoryRetrieval()`, `useMemoryEncryption()`
- Comprehensive examples and demo app
- Storybook components
- Additional AI SDK examples (streaming, function calling)

### [0.5.0] - Planned Q2 2025

- Batch operations: `useBatchMemories()`
- Context management: `useMemoryContext()`
- Permission management: `useMemoryAccess()`
- Complete test coverage (>85%)
- AI SDK integration tests

### [1.0.0] - Planned Q3 2025

- Production-ready stable release
- Complete documentation
- Video tutorials
- Performance optimizations
- ~~Multi-AI provider support~~ ✅ Completed in v0.3.0

---

For more details, see [IMPLEMENTATION_ROADMAP.md](./IMPLEMENTATION_ROADMAP.md)
