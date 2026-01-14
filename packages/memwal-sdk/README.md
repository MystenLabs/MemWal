# @cmdoss/memwal-sdk

[![npm version](https://img.shields.io/npm/v/@cmdoss/memwal-sdk.svg)](https://www.npmjs.com/package/@cmdoss/memwal-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**MemWal** (Memory + Walrus) - TypeScript SDK for decentralized memory storage on Sui blockchain with Walrus.

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
  }
});

await pdw.ready();

// Create memory
const memory = await pdw.memory.create('I work at CommandOSS as a developer');
console.log('Memory ID:', memory.id);

// Search memories
const results = await pdw.search.vector('work experience', { limit: 5 });
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
      features: { enableLocalIndexing: false }, // Disable for browser
    });

    // Create memory - wallet popup appears for signing
    const memory = await pdw.memory.create('Hello from browser!');
  };
}
```

## Features

| Feature | Description |
|---------|-------------|
| Memory CRUD | Create, read, update, delete memories on Sui + Walrus |
| Vector Search | Semantic search with HNSW (3072 dimensions) |
| AI Classification | Auto-categorize memories (fact, event, preference, etc.) |
| SEAL Encryption | Optional identity-based encryption |
| Batch Upload | ~90% gas savings with Quilt batching |
| Knowledge Graph | Entity and relationship extraction |

## Environment Variables

```env
SUI_PRIVATE_KEY=suiprivkey1...
PACKAGE_ID=0x...
OPENROUTER_API_KEY=sk-or-v1-...

# Optional
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
```

## API Overview

```typescript
// Memory operations
await pdw.memory.create(content, { category, importance });
await pdw.memory.createBatch([...contents]);
await pdw.memory.get(id);
await pdw.memory.delete(id);

// Search
await pdw.search.vector(query, { limit });
await pdw.search.byCategory('fact');
await pdw.search.hybrid(query, { category });

// AI
await pdw.ai.embed(text);
await pdw.ai.classify(content);
await pdw.ai.shouldSave(content);

// Knowledge Graph
await pdw.graph.extract(content);
```

## Vector Search (HNSW)

The SDK uses HNSW for fast vector search:

| Implementation | Environment | Performance |
|----------------|-------------|-------------|
| `hnswlib-node` | Node.js | **Fastest** (native C++) |
| `hnswlib-wasm` | Browser + Node.js | Good (fallback) |

The SDK auto-detects and uses the best available implementation.

**For best performance in Node.js:**

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

## Configuration

### Basic Configuration

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,               // Required: Sui keypair or wallet adapter
  network: 'testnet',            // Required: 'testnet' | 'mainnet' | 'devnet'

  // Embedding configuration (required for AI features)
  embedding: {
    provider: 'openrouter',      // 'google' | 'openai' | 'openrouter' | 'cohere'
    apiKey: process.env.OPENROUTER_API_KEY,
    modelName: 'google/gemini-embedding-001',  // Optional: defaults per provider
    dimensions: 3072             // Optional: defaults per provider
  },

  // Optional: Sui configuration
  sui: {
    packageId: '0x...',          // Default: from env PACKAGE_ID
    rpcUrl: 'https://...',       // Default: from network
  },

  // Optional: Walrus configuration
  walrus: {
    aggregator: 'https://...',   // Default: from network
    publisher: 'https://...',    // Default: from network
  },

  // Optional: Feature flags
  features: {
    enableEncryption: true,      // Default: true (SEAL encryption)
    enableLocalIndexing: true,   // Default: true (HNSW vector search)
    enableKnowledgeGraph: true   // Default: true (entity extraction)
  }
});
```

### SEAL Encryption (Enabled by Default)

**🔒 Encryption is enabled by default in v0.7.0+**

All memory content is automatically encrypted using SEAL (Secure Encrypted Access Layer) with identity-based encryption.

#### Default Encryption (Recommended)

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  embedding: { provider: 'openrouter', apiKey: 'key' }
  // Encryption automatically enabled with defaults!
});

// Memories are encrypted on upload, decrypted on retrieval
await pdw.memory.create('My private data');
```

#### Custom Encryption Configuration

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  embedding: { provider: 'openrouter', apiKey: 'key' },

  // Encryption configuration (optional)
  encryption: {
    enabled: true,              // Default: true
    keyServers: [               // Default: testnet key servers
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
    ],
    threshold: 2,               // Default: 2 (M of N key servers required)
    accessRegistryId: '0x...'   // Default: testnet registry
  }
});
```

#### Environment Variables

```bash
# Disable encryption (not recommended for production)
ENABLE_ENCRYPTION=false

# Custom key servers (comma-separated)
SEAL_KEY_SERVERS=0xKEY1,0xKEY2,0xKEY3

# Custom threshold
SEAL_THRESHOLD=2

# Custom access registry
ACCESS_REGISTRY_ID=0x...
```

#### How SEAL Encryption Works

- **Zero gas for decryption** - No blockchain transactions required
- **Identity-based** - Uses Sui address as identity (userAddress)
- **Threshold security** - Requires M of N key servers (default: 2 of 2)
- **Cross-app sharing** - Share memories between apps with same user
- **Privacy-preserving** - Content never exposed on-chain or in plaintext

#### Disabling Encryption (Development Only)

⚠️ **Not recommended for production**. Only use for non-sensitive test data:

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  embedding: { provider: 'openrouter', apiKey: 'key' },
  features: {
    enableEncryption: false  // ⚠️ Stores content in plaintext!
  }
});
```

### Embedding Providers

| Provider | Model Default | Dimensions | API Key |
|----------|---------------|------------|---------|
| `openrouter` | `google/gemini-embedding-001` | 3072 | `OPENROUTER_API_KEY` |
| `google` | `text-embedding-004` | 3072 | `GEMINI_API_KEY` |
| `openai` | `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` |
| `cohere` | `embed-english-v3.0` | 1024 | `COHERE_API_KEY` |

**Recommendation**: Use `openrouter` for unified access to multiple models.

## Benchmarks

Tested on localhost with Option A+ (local content retrieval enabled):

| Operation | Time | Description |
|-----------|------|-------------|
| Vector Search + RAG | ~2.3s | Chat with semantic search |
| Create Memory | ~2.3s | Classify + embed + upload + index |
| AI Classification | ~2.3s | Categorize content |
| Batch Upload (2 items) | ~2.3s | Quilt batching |
| Blockchain Query | ~2.3s | List memories from Sui |

**Average query time: ~2.3s** (with OpenRouter API latency included)

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design and data flow
- [BENCHMARKS.md](./BENCHMARKS.md) - Detailed performance metrics
- [CHANGELOG.md](./CHANGELOG.md) - Version history

## License

MIT
