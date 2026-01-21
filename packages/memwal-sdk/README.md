# @cmdoss/memwal-sdk

[![npm version](https://img.shields.io/npm/v/@cmdoss/memwal-sdk.svg)](https://www.npmjs.com/package/@cmdoss/memwal-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**MemWal** (Memory + Walrus) - TypeScript SDK for decentralized memory storage on Sui blockchain with Walrus.

## Features

| Feature | Description |
|---------|-------------|
| **Memory CRUD** | Create, read, search, delete memories on Sui + Walrus |
| **Unified Search** | `pdw.memory.search()` - auto-embeds query and searches |
| **SEAL Encryption** | Identity-based encryption (enabled by default) |
| **Vector Search** | Fast HNSW search (768 dimensions default) |
| **AI Classification** | Auto-categorize memories (fact, event, preference, etc.) |
| **Batch Upload** | ~90% gas savings with Quilt batching |
| **Knowledge Graph** | Entity and relationship extraction |

## Installation

```bash
npm install @cmdoss/memwal-sdk @mysten/sui
```

## Quick Start

### Node.js (with Keypair)

```typescript
import { SimplePDWClient } from '@cmdoss/memwal-sdk';
import { Ed25519Keypair, decodeSuiPrivateKey } from '@mysten/sui/keypairs/ed25519';

// Setup keypair
const { secretKey } = decodeSuiPrivateKey(process.env.SUI_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

// Initialize client
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: process.env.PACKAGE_ID!,
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY!,
    dimensions: 768  // Default: 768 (fast), 1536, or 3072 (highest quality)
  }
});

await pdw.ready();

// Create memory (auto: embed, classify, encrypt, upload, register, index)
const memory = await pdw.memory.create('I work at CommandOSS as a developer');
console.log('Memory ID:', memory.id);

// Search memories (NEW: unified search API)
const results = await pdw.memory.search('work experience', { limit: 5 });
console.log('Found:', results.length, 'memories');
```

### Browser (with dapp-kit + Slush/Sui Wallet)

```typescript
import { DappKitSigner, SimplePDWClient } from '@cmdoss/memwal-sdk/browser';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';

function MyComponent() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const handleSave = async () => {
    // Create signer from dapp-kit hooks
    const signer = new DappKitSigner({
      address: account.address,
      client: suiClient,
      signAndExecuteTransaction: async ({ transaction }) => {
        const result = await signAndExecute({ transaction });
        return { digest: result.digest, effects: result.effects };
      },
    });

    // Initialize client
    const pdw = new SimplePDWClient({
      signer,
      network: 'testnet',
      userAddress: account.address,
      sui: { packageId: process.env.NEXT_PUBLIC_PACKAGE_ID! },
      embedding: {
        provider: 'openrouter',
        apiKey: process.env.NEXT_PUBLIC_OPENROUTER_API_KEY!,
        dimensions: 768
      },
      features: { enableLocalIndexing: false }, // Disable for browser
    });

    await pdw.ready();

    // Create memory - wallet popup appears for signing
    const memory = await pdw.memory.create('Hello from browser!');

    // Search memories
    const results = await pdw.memory.search('hello', { limit: 5 });
  };
}
```

## API Reference

### Core Namespaces

The SDK provides 5 core namespaces for common operations:

```typescript
pdw.memory   // Create, get, search, list, delete memories
pdw.ai       // Embed, classify, extract commands
pdw.index    // HNSW index management
pdw.wallet   // Wallet address and balance info
pdw.advanced // Power user features (graph, analytics, etc.)
```

### `pdw.memory` - Memory Operations

```typescript
// CREATE - handles everything internally (embed, encrypt, upload, register, index)
const memory = await pdw.memory.create(content, {
  category?: string,      // Auto-classify if not provided
  importance?: number,    // Auto-score if not provided (1-10)
  embedding?: number[],   // Auto-generate if not provided
});

// CREATE BATCH - upload multiple memories efficiently
const memories = await pdw.memory.createBatch([
  { content: 'Memory 1', category: 'fact' },
  { content: 'Memory 2', category: 'preference' }
]);

// SEARCH - unified semantic search (auto-embeds query)
const results = await pdw.memory.search(query, {
  limit?: number,         // Max results (default: 10)
  threshold?: number,     // Min similarity 0-1 (default: 0.7)
  category?: string,      // Filter by category
  includeContent?: boolean // Include decrypted content (default: true)
});

// GET - retrieve by ID (auto-decrypts)
const memory = await pdw.memory.get(memoryId);

// LIST - list all memories with filters
const memories = await pdw.memory.list({
  category?: string,
  limit?: number,
  offset?: number
});

// DELETE
await pdw.memory.delete(memoryId);
await pdw.memory.deleteBatch([id1, id2, id3]);
```

### `pdw.ai` - AI Operations

```typescript
// Generate embeddings
const embedding = await pdw.ai.embed(text);
const embeddings = await pdw.ai.embedBatch([text1, text2]);

// Classify content
const { category, importance } = await pdw.ai.classify(content);

// Extract memory commands from user input
const memories = pdw.ai.extractMultipleMemories(userMessage);
// Input: "remember I like pizza and my name is John"
// Output: ["I like pizza", "my name is John"]

// Check if content should be saved as memory
const shouldSave = await pdw.ai.shouldSave(content);
```

### `pdw.index` - HNSW Index Management

```typescript
// Add vector to index
await pdw.index.add(spaceId, vectorId, vector, {
  content: string,
  blobId: string,
  category: string,
  importance: number,
  isEncrypted: boolean,
  forceStoreContent: boolean  // Store content even when encrypted (for RAG)
});

// Search vectors
const results = await pdw.index.search(spaceId, queryVector, {
  k: 10,
  threshold: 0.7
});

// Get index stats
const stats = pdw.index.getStats(spaceId);

// Rebuild index from blockchain
await pdw.index.rebuild(userAddress);

// Clear index
await pdw.index.clear(spaceId);

// Flush to disk
await pdw.index.flush(spaceId);
```

### `pdw.wallet` - Wallet Information

```typescript
// Get wallet address
const address = pdw.wallet.address;

// Get SUI balance
const balance = await pdw.wallet.balance();

// Get memory count
const count = await pdw.wallet.memoryCount();
```

### `pdw.advanced` - Power User Features

```typescript
// Knowledge Graph
const graph = await pdw.advanced.graph.extract(content);
// Returns: { entities: [...], relationships: [...] }

// Analytics
const insights = await pdw.advanced.analytics.getInsights();

// Manual encryption/decryption
const encrypted = await pdw.advanced.encryption.encrypt(data);
const decrypted = await pdw.advanced.encryption.decrypt(encrypted);

// Permissions
await pdw.advanced.permissions.grant(memoryId, targetAddress);
await pdw.advanced.permissions.revoke(memoryId, targetAddress);

// Transaction building (low-level)
const tx = pdw.advanced.blockchain.buildCreateMemoryTx(params);
```

### Legacy Search API (Deprecated)

```typescript
// Still works but deprecated - use pdw.memory.search() instead
await pdw.search.vector(query, { limit });      // -> pdw.memory.search()
await pdw.search.byCategory('fact');            // -> pdw.memory.list({ category: 'fact' })
await pdw.search.hybrid(query, { category });   // -> pdw.memory.search(query, { category })
```

## Configuration

### Full Configuration

```typescript
const pdw = new SimplePDWClient({
  // Required
  signer: keypair,                // Sui keypair or wallet adapter
  network: 'testnet',             // 'testnet' | 'mainnet' | 'devnet'

  // Embedding configuration (required for AI features)
  embedding: {
    provider: 'openrouter',       // 'google' | 'openai' | 'openrouter' | 'cohere'
    apiKey: process.env.OPENROUTER_API_KEY,
    modelName: 'google/text-embedding-004',  // Optional: defaults per provider
    dimensions: 768               // Optional: 768 (default), 1536, or 3072
  },

  // Optional: Sui configuration
  sui: {
    packageId: '0x...',           // Default: from env PACKAGE_ID
    rpcUrl: 'https://...',        // Default: from network
  },

  // Optional: Walrus configuration
  walrus: {
    aggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
    publisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  },

  // Optional: AI configuration
  ai: {
    apiKey: process.env.OPENROUTER_API_KEY,
    chatModel: 'google/gemini-2.5-flash',
  },

  // Optional: Feature flags
  features: {
    enableEncryption: true,       // Default: true (SEAL encryption)
    enableLocalIndexing: true,    // Default: true (HNSW vector search)
    enableKnowledgeGraph: true    // Default: true (entity extraction)
  },

  // Optional: Encryption configuration
  encryption: {
    enabled: true,
    keyServers: ['0x...', '0x...'],  // Default: testnet key servers
    threshold: 2,                    // M of N key servers required
    accessRegistryId: '0x...'
  },

  // Optional: Index backup to Walrus (cloud sync)
  indexBackup: {
    enabled: true,
    aggregatorUrl: 'https://...',
    publisherUrl: 'https://...',
    autoSync: false,
    epochs: 3
  }
});
```

### Environment Variables

```bash
# Required
SUI_PRIVATE_KEY=suiprivkey1...
PACKAGE_ID=0x...

# Embedding (at least one API key required)
EMBEDDING_PROVIDER=openrouter    # google, openai, openrouter, cohere
EMBEDDING_API_KEY=               # Falls back to provider-specific keys
EMBEDDING_MODEL=                 # Optional: override default model
EMBEDDING_DIMENSIONS=768         # 768 (default), 1536, 3072

# Provider-specific API keys (fallback)
OPENROUTER_API_KEY=sk-or-v1-...
GEMINI_API_KEY=...
OPENAI_API_KEY=sk-...
COHERE_API_KEY=...

# Walrus (optional - defaults to testnet)
WALRUS_NETWORK=testnet
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space

# SEAL Encryption (optional - defaults configured)
ENABLE_ENCRYPTION=true
SEAL_KEY_SERVERS=0xKEY1,0xKEY2
SEAL_THRESHOLD=2
ACCESS_REGISTRY_ID=0x...
```

### Embedding Providers

| Provider | Model Default | Dimensions | API Key |
|----------|---------------|------------|---------|
| `openrouter` | `google/text-embedding-004` | 768 | `OPENROUTER_API_KEY` |
| `google` | `text-embedding-004` | 768 | `GEMINI_API_KEY` |
| `openai` | `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` |
| `cohere` | `embed-english-v3.0` | 1024 | `COHERE_API_KEY` |

**Dimensions Trade-offs:**
- **768** (default): Fast embedding + small storage + fast search
- **1536**: Balance of quality and speed
- **3072**: Highest quality, slowest

**Recommendation**: Use `openrouter` with 768 dimensions for best performance.

## SEAL Encryption

Encryption is **enabled by default** in v0.8.0+. All memory content is automatically encrypted using SEAL (Secure Encrypted Access Layer).

### How It Works

1. **Identity-based**: Uses Sui address as encryption identity
2. **Threshold security**: Requires M of N key servers (default: 2 of 2)
3. **Zero gas for decryption**: No blockchain transactions required
4. **Privacy-preserving**: Content never exposed on-chain

### Default Encryption (Recommended)

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  embedding: { provider: 'openrouter', apiKey: 'key' }
  // Encryption automatically enabled!
});

// Memories encrypted on upload, decrypted on retrieval
await pdw.memory.create('My private data');
```

### Disabling Encryption (Development Only)

```typescript
const pdw = new SimplePDWClient({
  // ...
  features: {
    enableEncryption: false  // Stores content in plaintext!
  }
});
```

## Server-Side RAG

For server-side applications with RAG (Retrieval-Augmented Generation), content needs to be stored in the local index even when encrypted.

### Configuration

When indexing memories server-side, use `forceStoreContent: true`:

```typescript
await pdw.index.add(walletAddress, vectorId, embedding, {
  content: plaintextContent,
  blobId: blobId,
  isEncrypted: true,
  forceStoreContent: true  // Store content for RAG even when encrypted
});
```

### API Route Example

```typescript
// /api/memory/index/route.ts
export async function POST(req: Request) {
  const { walletAddress, memoryId, content, embedding, blobId } = await req.json();

  const pdw = await getReadOnlyPDWClient(walletAddress);

  await pdw.index.add(walletAddress, vectorId, embedding, {
    content,
    blobId,
    isEncrypted: true,
    forceStoreContent: true  // Enable RAG for encrypted memories
  });
}
```

### Chat API with Memory Search

```typescript
// /api/chat/route.ts
export async function POST(req: Request) {
  const { messages, walletAddress } = await req.json();
  const pdw = await getReadOnlyPDWClient(walletAddress);

  // Search memories for context
  const memories = await pdw.memory.search(userMessage, {
    limit: 10,
    threshold: 0.3,
    includeContent: true
  });

  // Build prompt with memory context
  const systemPrompt = `
    User's memories:
    ${memories.map(m => m.content).join('\n')}
  `;

  // Call LLM with context
  return streamText({ model, messages, system: systemPrompt });
}
```

## Vector Search (HNSW)

The SDK uses HNSW for fast approximate nearest neighbor search:

| Implementation | Environment | Performance |
|----------------|-------------|-------------|
| `hnswlib-node` | Node.js | **Fastest** (native C++) |
| `hnswlib-wasm` | Browser + Node.js | Good (fallback) |

The SDK auto-detects and uses the best available implementation.

### For Best Performance in Node.js

```bash
# Requires C++ build tools
npm install hnswlib-node
```

<details>
<summary>Build tools installation</summary>

| Platform | Command |
|----------|---------|
| Windows | Install [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with C++ workload |
| macOS | `xcode-select --install` |
| Linux | `sudo apt-get install build-essential python3` |

</details>

## Index Rebuild

When users log in on a new device or the local index is lost, rebuild from blockchain:

```typescript
import { rebuildIndexNode, hasExistingIndexNode } from '@cmdoss/memwal-sdk';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

const client = new SuiClient({ url: getFullnodeUrl('testnet') });

// Check if index exists
const hasIndex = await hasExistingIndexNode(userAddress);

if (!hasIndex) {
  // Rebuild from blockchain + Walrus
  const result = await rebuildIndexNode({
    userAddress,
    client,
    packageId: process.env.PACKAGE_ID!,
    network: 'testnet',
    force: false,  // Set true to force rebuild
    fetchConcurrency: 10,  // Parallel blob fetches
    onProgress: (current, total, status) => {
      console.log(`${current}/${total}: ${status}`);
    }
  });

  console.log(`Indexed ${result.indexedMemories}/${result.totalMemories} memories`);
}
```

## Exports

```typescript
// Main exports
import { SimplePDWClient } from '@cmdoss/memwal-sdk';

// Browser-safe exports
import { SimplePDWClient, DappKitSigner } from '@cmdoss/memwal-sdk/browser';

// React hooks
import { usePDWClient, useMemory } from '@cmdoss/memwal-sdk/hooks';

// Services (advanced)
import { EmbeddingService, MemoryIndexService } from '@cmdoss/memwal-sdk/services';

// LangChain integration
import { PDWVectorStore } from '@cmdoss/memwal-sdk/langchain';

// Vercel AI SDK integration
import { createPDWTool } from '@cmdoss/memwal-sdk/ai-sdk';

// Node.js utilities
import { rebuildIndexNode, hasExistingIndexNode, clearIndexNode } from '@cmdoss/memwal-sdk';
```

## Benchmarks

Tested on localhost with encryption enabled:

| Operation | Time | Description |
|-----------|------|-------------|
| Memory Search | ~0.5s | Semantic search (local HNSW) |
| Create Memory | ~2.5s | Classify + embed + encrypt + upload + index |
| AI Classification | ~0.8s | Categorize content |
| Batch Upload (5 items) | ~3s | Quilt batching with encryption |
| Blockchain Query | ~0.3s | List memories from Sui |

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design and data flow
- [BENCHMARKS.md](./BENCHMARKS.md) - Detailed performance metrics
- [CHANGELOG.md](./CHANGELOG.md) - Version history

## License

MIT
