# Personal Data Wallet SDK

[![npm version](https://img.shields.io/npm/v/personal-data-wallet-sdk.svg)](https://www.npmjs.com/package/personal-data-wallet-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

SDK for building applications with decentralized memory storage, SEAL encryption, and Sui blockchain integration.

## Features

- **Memory Management** - Create, search, store memories with AI-powered classification
- **SEAL Encryption** - Identity-based encryption with MemoryCap capability pattern
- **Walrus Storage** - Decentralized blob storage on Walrus network
- **Sui Blockchain** - On-chain ownership registration with transaction retry
- **Vector Search** - Semantic search with HNSW (3072 dimensions, hnswlib-node/wasm)
- **Knowledge Graph** - Entity and relationship extraction with AI
- **LangChain & AI-SDK Integration** - RAG workflows with PDWVectorStore

## Installation

```bash
npm install personal-data-wallet-sdk @mysten/sui
```

## Quick Start

### 1. Initialize

```typescript
import { SimplePDWClient } from 'personal-data-wallet-sdk';
import { Ed25519Keypair, decodeSuiPrivateKey } from '@mysten/sui/keypairs/ed25519';

const { secretKey } = decodeSuiPrivateKey(process.env.SUI_PRIVATE_KEY);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: process.env.PACKAGE_ID,
  // OpenRouter (recommended) - unified access to multiple models
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY,
    // Uses google/gemini-embedding-001 by default (3072 dimensions)
  },
  // Or use Google directly:
  // geminiApiKey: process.env.GEMINI_API_KEY,
  features: {
    enableEncryption: false,
    enableLocalIndexing: true,
    enableKnowledgeGraph: true
  }
});

await pdw.ready();
```

### 2. AI Operations

```typescript
// Check if content should be saved
const shouldSave = await pdw.ai.shouldSave('I am working at CommandOSS');
// true

// Get full classification
const classification = await pdw.ai.classifyFull('I am working at CommandOSS');
// { category: 'fact', importance: 8, topic: 'employment', summary: '...' }

// Generate embedding
const vector = await pdw.ai.embed('Hello world');
// Float32Array[3072]
```

### 3. Create Memory

```typescript
const memory = await pdw.memory.create(
  'I am working at CommandOSS as a software engineer',
  { category: 'fact', importance: 8 }
);

console.log('Memory ID:', memory.id);     // On-chain object ID
console.log('Blob ID:', memory.blobId);   // Walrus blob ID
```

### Memory Keywords (Natural Language)

When using the chat API, you can save memories using natural language keywords. The SDK automatically detects these patterns and extracts the content to store:

| Keyword Pattern | Example | Extracted Content |
|----------------|---------|-------------------|
| `remember that...` | "Remember that my birthday is Dec 25" | "my birthday is Dec 25" |
| `remember...` | "Remember I like pizza" | "I like pizza" |
| `don't forget that...` | "Don't forget that meeting is at 3pm" | "meeting is at 3pm" |
| `don't forget...` | "Don't forget to call mom" | "to call mom" |
| `please remember...` | "Please remember my email is test@example" | "my email is test@example" |
| `store in memory...` | "Store in memory: API key is abc123" | "API key is abc123" |
| `save to memory...` | "Save to memory my address is..." | "my address is..." |
| `add to memory...` | "Add to my memory: project deadline Friday" | "project deadline Friday" |
| `keep in mind...` | "Keep in mind: use TypeScript" | "use TypeScript" |
| `note that...` | "Note that the server runs on port 3000" | "the server runs on port 3000" |

```typescript
// Single memory extraction
const content = pdw.ai.extractMemoryContent('Remember that my name is John');
// Returns: 'my name is John'

const noContent = pdw.ai.extractMemoryContent('Hello there');
// Returns: null (no memory keyword detected)
```

### Multiple Memories in One Message

The SDK can split a single message into multiple separate memories:

```typescript
// Comma + "and" separated
const memories = pdw.ai.extractMultipleMemories(
  'Remember that my name is John, I work at Google, and my birthday is Dec 25'
);
// Returns: ['my name is John', 'I work at Google', 'my birthday is Dec 25']

// Semicolon-separated
const memories2 = pdw.ai.extractMultipleMemories(
  'Note that: API key is abc123; server port is 3000; database is PostgreSQL'
);
// Returns: ['API key is abc123', 'server port is 3000', 'database is PostgreSQL']

// Numbered list
const memories3 = pdw.ai.extractMultipleMemories(
  'Remember: 1. My email is test@example 2. My phone is 123-456 3. I prefer dark mode'
);
// Returns: ['My email is test@example', 'My phone is 123-456', 'I prefer dark mode']

// Batch save all extracted memories
const extractedMemories = pdw.ai.extractMultipleMemories(userMessage);
if (extractedMemories.length > 0) {
  // Save each as separate memory
  const results = await pdw.memory.createBatch(extractedMemories, { category: 'custom' });
  console.log(`Saved ${results.length} memories`);
}
```

**Supported formats:**
- Comma-separated: `"x, y, z"` or `"x, y, and z"`
- Semicolon-separated: `"x; y; z"`
- Numbered list: `"1. x 2. y 3. z"`
- Bullet list: `"- x - y - z"` or `"• x • y • z"`

### 4. Search Memories

```typescript
// Vector search (semantic)
const results = await pdw.search.vector('CommandOSS work', { limit: 5 });

// Search by category
const facts = await pdw.search.byCategory('fact');

// Hybrid search
const hybrid = await pdw.search.hybrid('software engineer', { category: 'fact' });
```

### 5. Knowledge Graph

```typescript
const extraction = await pdw.graph.extract(
  'John works at Google as a Software Engineer'
);

console.log(extraction.entities);
// [{ id: 'john', name: 'John', type: 'person' }, ...]

console.log(extraction.relationships);
// [{ source: 'john', target: 'google', type: 'works_at' }]
```

---

## API Reference

### Consolidated Namespaces (Recommended)

| Namespace | Description |
|-----------|-------------|
| `pdw.ai` | Embeddings, classification, chat |
| `pdw.security` | Encryption, permissions, contexts |
| `pdw.blockchain` | Transactions, wallet operations |
| `pdw.storage` | Walrus storage, caching |

### pdw.ai

```typescript
await pdw.ai.embed(text)              // Generate embedding
await pdw.ai.embedBatch(texts[])      // Batch embeddings
pdw.ai.similarity(v1, v2)             // Cosine similarity
await pdw.ai.classify(content)        // Get category
await pdw.ai.shouldSave(content)      // Should save? true/false
await pdw.ai.classifyFull(content)    // Full classification

// Chat
const session = pdw.ai.chat.createSession()
await pdw.ai.chat.send(sessionId, message)
```

### pdw.security

```typescript
await pdw.security.encrypt(data)
await pdw.security.decrypt({ encryptedContent, memoryCapId })

// Context management
await pdw.security.context.create(appId)
await pdw.security.context.getOrCreate(appId)

// Permissions
await pdw.security.permissions.grant(appId, ['read', 'write'])
await pdw.security.permissions.revoke(appId)
```

### pdw.blockchain

```typescript
pdw.blockchain.tx.build(type, params)
await pdw.blockchain.tx.execute(tx)
await pdw.blockchain.tx.estimateGas(tx)

pdw.blockchain.wallet.getAddress()
await pdw.blockchain.wallet.getBalance()
await pdw.blockchain.wallet.getFormattedBalance()
```

### pdw.storage

```typescript
await pdw.storage.upload(data)
await pdw.storage.download(blobId)
await pdw.storage.exists(blobId)

pdw.storage.cache.set(key, value, ttl)
pdw.storage.cache.get(key)
pdw.storage.cache.stats()
```

### Legacy Namespaces

Still available for backward compatibility:

```typescript
pdw.memory      // CRUD operations
pdw.search      // Vector search
pdw.embeddings  // Embedding generation
pdw.classify    // Classification
pdw.graph       // Knowledge graph
pdw.encryption  // SEAL encryption
pdw.context     // App contexts
pdw.permissions // OAuth-style permissions
pdw.tx          // Transactions
pdw.wallet      // Wallet operations
pdw.batch       // Batch operations
pdw.analytics   // Insights
```

---

## SEAL Encryption

```typescript
// Enable encryption
const pdw = new SimplePDWClient({
  features: { enableEncryption: true }
});

// Create app context
const context = await pdw.security.context.getOrCreate('MY_APP');

// Create session key
await pdw.security.createSessionKey();

// Encrypt
const data = new TextEncoder().encode('Secret message');
const { encryptedObject, keyId } = await pdw.security.encrypt(data);

// Decrypt
const decrypted = await pdw.security.decrypt({
  encryptedContent: encryptedObject,
  memoryCapId: context.id,
  keyId
});
```

---

## LangChain Integration

```typescript
import { PDWEmbeddings, PDWVectorStore } from 'personal-data-wallet-sdk/langchain';

const embeddings = new PDWEmbeddings({ geminiApiKey });
const vectorStore = new PDWVectorStore(embeddings, { network: 'testnet', signer: keypair });

await vectorStore.addDocuments([
  { pageContent: 'Sui is a Layer 1 blockchain', metadata: { category: 'blockchain' } }
]);

const results = await vectorStore.similaritySearch('blockchain', 3);
```

---

## AI-SDK Integration

```typescript
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';

const vectorStore = new PDWVectorStore({ embeddingService, network: 'testnet', signer: keypair });

await vectorStore.add({ id: 'doc1', text: 'Content', metadata: {} });
const results = await vectorStore.search('query', { limit: 5 });
```

---

## Configuration

### Environment Variables

```env
SUI_NETWORK=testnet
PACKAGE_ID=0x...
SUI_PRIVATE_KEY=suiprivkey1qz...

# Embedding Provider (choose one)
# Option 1: OpenRouter (recommended - unified API for multiple models)
EMBEDDING_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...

# Option 2: Google Gemini directly
# EMBEDDING_PROVIDER=google
# GEMINI_API_KEY=AIzaSy...

# Option 3: OpenAI
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# Walrus Storage
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
```

### Full Config

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  // Embedding configuration (new in v0.5.0)
  embedding: {
    provider: 'openrouter',  // 'openrouter' | 'google' | 'openai' | 'cohere'
    apiKey: 'sk-or-v1-...',
    modelName: 'google/gemini-embedding-001',  // optional, uses defaults
    dimensions: 3072,  // optional, model default
  },
  // Legacy: still works if embedding.provider not set
  // geminiApiKey: 'AIza...',
  walrus: {
    aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
    publisherUrl: 'https://publisher.walrus-testnet.walrus.space'
  },
  features: {
    enableEncryption: true,
    enableLocalIndexing: true,
    enableKnowledgeGraph: true
  }
});
```

---

## Browser Usage

```html
<script type="module">
import { SimplePDWClient } from 'https://esm.sh/personal-data-wallet-sdk';
import { Ed25519Keypair, decodeSuiPrivateKey } from 'https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519';

const { secretKey } = decodeSuiPrivateKey('suiprivkey1qz...');
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  embedding: {
    provider: 'openrouter',
    apiKey: 'your-openrouter-key'
  }
});

await pdw.ready();
const memory = await pdw.memory.create('Hello from browser!');
</script>
```

---

## Testing

```bash
npm test              # Unit tests
npm run test:e2e      # E2E tests (Playwright)
npm run test:e2e:ui   # E2E with UI
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Detailed workflow diagrams, data flow, namespace mapping |
| [BENCHMARKS.md](./BENCHMARKS.md) | Performance metrics, speed, size, cost estimates |

---

## Troubleshooting

### "Encryption service not configured"

```typescript
const pdw = new SimplePDWClient({
  features: { enableEncryption: true }
});
```

### "Knowledge Graph not initialized"

```typescript
const pdw = new SimplePDWClient({
  geminiApiKey: 'your-key',
  features: { enableKnowledgeGraph: true }
});
```

### Transaction Version Conflict (Gas Coin Version)

The SDK now includes `waitForTransaction` after each blockchain transaction to prevent Gas Coin Version Conflict errors. This ensures the gas coin version is properly updated on the network before the next transaction is built.

```typescript
// Handled automatically - no action needed
const memory = await pdw.memory.create('content');
// Transaction waits for confirmation before returning
```

---

## Changelog

### v0.5.0 (Latest)

#### OpenRouter Integration

**Unified AI Gateway Support**
- New `embedding.provider` configuration option supporting `'openrouter'`, `'google'`, `'openai'`, `'cohere'`
- OpenRouter as recommended provider for unified access to multiple AI models
- Default embedding model: `google/gemini-embedding-001` (3072 dimensions)
- Flexible configuration with `embedding.apiKey`, `embedding.modelName`, `embedding.dimensions`

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY,
  }
});
```

#### Vector Dimension Upgrade

**768 → 3072 Dimensions**
- Updated all default vector dimensions from 768 to 3072
- Better semantic representation with higher-dimensional embeddings
- Supports `google/gemini-embedding-001` output natively

#### Bug Fixes

- **ESM Module Compatibility**: Fixed ESM import issues for Next.js and modern bundlers
- **API Route Fixes**: Fixed `pdw.pipeline.createMemory` → `pdw.memory.create` in chat routes
- **AI SDK v5 Compatibility**: Added support for `@openrouter/ai-sdk-provider` for Vercel AI SDK v5

#### Breaking Changes

- **Index Rebuild Required**: Due to dimension change from 768 → 3072, existing HNSW indexes must be rebuilt
- Run `rebuildIndexNode()` or `clearIndexNode()` to rebuild from blockchain data

```typescript
import { clearIndexNode, rebuildIndexNode } from 'personal-data-wallet-sdk';

// Clear old 768-dimension index
await clearIndexNode(userAddress);

// Rebuild with 3072 dimensions
await rebuildIndexNode({ userAddress, client, packageId, walrusAggregator });
```

---

### v0.4.1

#### Multi-Device Index Sync

**Index Staleness Detection**
- Automatic detection when index file is modified by another process
- Auto-reload index from disk before search if file is newer than cache
- Supports multi-tab and multi-process scenarios on same device

**Rebuild Index from Blockchain**
- New `rebuildIndexNode()` utility for Node.js environments
- Rebuilds HNSW index by fetching memories from Sui blockchain + Walrus
- Use when logging in on a new device or after index corruption

```typescript
import { rebuildIndexNode, hasExistingIndexNode } from 'personal-data-wallet-sdk';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

// Check if index exists
const hasIndex = await hasExistingIndexNode(userAddress);

if (!hasIndex) {
  // Rebuild from blockchain
  const client = new SuiClient({ url: getFullnodeUrl('testnet') });
  const result = await rebuildIndexNode({
    userAddress,
    client,
    packageId: process.env.PACKAGE_ID,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    onProgress: (current, total, status) => console.log(`${current}/${total}: ${status}`)
  });
  console.log(`Indexed ${result.indexedMemories}/${result.totalMemories} memories`);
}
```

#### New Exports
- `rebuildIndexNode()` - Rebuild index from blockchain (Node.js)
- `hasExistingIndexNode()` - Check if local index exists (Node.js)
- `clearIndexNode()` - Delete local index (Node.js)

---

### v0.4.0

#### Major Features

**Hybrid HNSW Implementation (Node.js + Browser Support)**
- `hnswlib-node` support for Node.js/Next.js Server Components
- `createHnswService()` factory with automatic environment detection
- Singleton pattern to prevent redundant initializations
- Full Next.js RSC support

```typescript
import { createHnswService } from 'personal-data-wallet-sdk';

// Auto-detects: hnswlib-node (Node.js) or hnswlib-wasm (browser)
const hnswService = await createHnswService({ indexConfig: { dimension: 3072 } });
```

**Optimized Sui Transaction Handling**
- Exponential backoff retry for gas coin conflicts (500ms -> 1000ms -> 2000ms)
- Automatic transaction rebuilding on version conflicts

#### Configuration Changes
- Default AI model: `gemini-2.5-flash-lite` (higher rate limits, better reliability)
- Updated all services: `ClientMemoryManager`, `GeminiAIService`, `ChatService`, `GraphService`, etc.

#### Bug Fixes
- Fixed Webpack bundling with native Node.js modules
- Added `serverComponentsExternalPackages` for Next.js

#### New Exports
- `createHnswService`, `isHnswAvailable()`, `getHnswServiceType()`, `resetHnswServiceSingleton()`
- `isBrowser()` / `isNode()` environment utilities

---

### v0.3.3

- **CRITICAL FIX**: Added `waitForTransaction` after each Sui transaction to prevent Gas Coin Version Conflict
- Improved transaction reliability for sequential operations (memory create, index save, etc.)
- Updated Walrus integration with proper CDN externalization for browser builds
- Added `build:browser` npm script for browser bundle generation

### v0.3.2

- Added ARCHITECTURE.md with detailed workflow diagrams
- Added BENCHMARKS.md with performance metrics
- Updated documentation structure

### v0.3.1

- Consolidated Namespaces (`pdw.ai`, `pdw.security`, `pdw.blockchain`, `pdw.storage`)
- AI Classification in `memory.create()`
- Knowledge Graph extraction
- Batch Operations
- Transaction Retry
- E2E Tests (24 tests)
- Benchmark Tests (8 tests)

---

## License

MIT
