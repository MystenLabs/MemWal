# @cmdoss/memwal-sdk

[![npm version](https://img.shields.io/npm/v/@cmdoss/memwal-sdk.svg)](https://www.npmjs.com/package/@cmdoss/memwal-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**MemWal** (Memory + Walrus) - TypeScript SDK for decentralized memory storage on Sui blockchain with Walrus.

## Installation

```bash
npm install @cmdoss/memwal-sdk @mysten/sui
```

## Quick Start

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
