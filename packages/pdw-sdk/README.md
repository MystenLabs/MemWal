# Personal Data Wallet SDK

[![npm version](https://img.shields.io/npm/v/personal-data-wallet-sdk.svg)](https://www.npmjs.com/package/personal-data-wallet-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

SDK for building applications with decentralized memory storage, SEAL encryption, and Sui blockchain integration.

## Features

- **Memory Management** - Create, search, store memories with AI-powered classification
- **SEAL Encryption** - Identity-based encryption with MemoryCap capability pattern
- **Walrus Storage** - Decentralized blob storage on Walrus network
- **Sui Blockchain** - On-chain ownership registration with transaction retry
- **Vector Search** - Semantic search with HNSW (768 dimensions, hnswlib-wasm)
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
  geminiApiKey: process.env.GEMINI_API_KEY,
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
// Float32Array[768]
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
GEMINI_API_KEY=AIzaSy...
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
```

### Full Config

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  geminiApiKey: 'AIza...',
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
  geminiApiKey: 'your-key'
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
