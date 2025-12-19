# MemWal SDK Documentation

Complete documentation for MemWal (`@cmdoss/memwal-sdk`) - TypeScript SDK for decentralized memory storage on Sui blockchain with Walrus.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Memory Operations](#memory-operations)
- [Search Operations](#search-operations)
- [AI Operations](#ai-operations)
- [Index Management](#index-management)
- [Batch Operations](#batch-operations)
- [Knowledge Graph](#knowledge-graph)
- [Encryption (SEAL)](#encryption-seal)
- [Error Handling](#error-handling)
- [TypeScript Types](#typescript-types)
- [Best Practices](#best-practices)

---

## Installation

### npm

```bash
npm install @cmdoss/memwal-sdk @mysten/sui
```

### pnpm

```bash
pnpm add @cmdoss/memwal-sdk @mysten/sui
```

### yarn

```bash
yarn add @cmdoss/memwal-sdk @mysten/sui
```

### Node.js Native Performance (Recommended)

For best vector search performance in Node.js, install the native HNSW binding:

```bash
npm install hnswlib-node
```

This requires C++ build tools:

| Platform | Installation |
|----------|--------------|
| Windows | [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with C++ workload |
| macOS | `xcode-select --install` |
| Linux | `sudo apt-get install build-essential python3` |

If `hnswlib-node` is not available, the SDK automatically falls back to `hnswlib-wasm`.

---

## Quick Start

### 1. Setup Environment Variables

Create a `.env` file:

```env
# Required
SUI_PRIVATE_KEY=suiprivkey1...
PACKAGE_ID=0x...
OPENROUTER_API_KEY=sk-or-v1-...

# Optional (defaults shown)
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
```

### 2. Initialize Client

```typescript
import { SimplePDWClient } from '@cmdoss/memwal-sdk';
import { Ed25519Keypair, decodeSuiPrivateKey } from '@mysten/sui/keypairs/ed25519';

// Decode private key
const { secretKey } = decodeSuiPrivateKey(process.env.SUI_PRIVATE_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

// Create client
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: process.env.PACKAGE_ID!,
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY!,
  }
});

// Wait for initialization
await pdw.ready();
console.log('MemWal SDK ready!');
```

### 3. Create Your First Memory

```typescript
// Create a memory with automatic classification
const memory = await pdw.memory.create('I started working at CommandOSS as a software engineer in 2024');

console.log('Memory created:');
console.log(`  ID: ${memory.id}`);
console.log(`  Blob ID: ${memory.blobId}`);
console.log(`  Category: ${memory.category}`);  // Auto-classified as "fact"
console.log(`  Importance: ${memory.importance}`);
```

### 4. Search Memories

```typescript
// Semantic search
const results = await pdw.search.vector('What is my job?', { limit: 5 });

console.log('Search results:');
for (const result of results) {
  console.log(`  Score: ${result.score.toFixed(3)}`);
  console.log(`  Content: ${result.content}`);
  console.log(`  Category: ${result.category}`);
  console.log('---');
}
```

---

## Configuration

### Full Configuration Options

```typescript
import { SimplePDWClient, SimplePDWConfig } from '@cmdoss/memwal-sdk';

const config: SimplePDWConfig = {
  // Required: Sui keypair for signing transactions
  signer: keypair,

  // Required: Sui network
  network: 'testnet',  // or 'mainnet'

  // Required: PDW smart contract package ID
  packageId: '0x...',

  // Required: Embedding configuration
  embedding: {
    provider: 'openrouter',  // or 'gemini'
    apiKey: 'sk-or-v1-...',
    model: 'text-embedding-3-large',  // Optional, default shown
  },

  // Optional: Walrus storage endpoints
  walrus: {
    aggregator: 'https://aggregator.walrus-testnet.walrus.space',
    publisher: 'https://publisher.walrus-testnet.walrus.space',
  },

  // Optional: AI configuration (for classification)
  ai: {
    provider: 'openrouter',
    apiKey: 'sk-or-v1-...',
    model: 'anthropic/claude-3-haiku',  // For classification
  },

  // Optional: Feature flags
  features: {
    enableKnowledgeGraph: false,  // Entity extraction (adds ~3-6s)
    enableLocalIndexing: true,    // HNSW vector index
  },

  // Optional: Index manager configuration
  indexManager: {
    dimension: 3072,       // Embedding dimensions
    maxElements: 10000,    // Maximum vectors
    efConstruction: 200,   // Build-time quality
    m: 16,                 // Connections per layer
  },
};

const pdw = new SimplePDWClient(config);
await pdw.ready();
```

### Using Different Embedding Providers

#### OpenRouter (Recommended)

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  embedding: {
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: 'text-embedding-3-large',  // 3072 dimensions
  }
});
```

#### Google Gemini

```typescript
const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  embedding: {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY!,
    model: 'text-embedding-004',  // 768 dimensions
  }
});
```

---

## Memory Operations

### Create Memory

#### Basic Creation

```typescript
const memory = await pdw.memory.create('Your memory content here');
```

#### With Options

```typescript
const memory = await pdw.memory.create('I love hiking in the mountains', {
  category: 'preference',    // Override auto-classification
  importance: 9,             // 1-10 scale
  topic: 'hobbies',          // Optional topic tag
  metadata: {                // Custom metadata
    source: 'user-input',
    tags: ['outdoor', 'sports']
  },
  onProgress: (status) => {  // Progress callback
    console.log(`Progress: ${status}`);
  }
});
```

#### Response Structure

```typescript
interface Memory {
  id: string;           // On-chain memory ID (0x...)
  blobId: string;       // Walrus blob ID
  content: string;      // Memory content
  category: string;     // fact, event, preference, thought, etc.
  importance: number;   // 1-10
  topic?: string;       // Topic tag
  embedding?: number[]; // 3072-dim vector
  createdAt: number;    // Unix timestamp
  updatedAt?: number;
  encrypted: boolean;
  metadata?: Record<string, any>;
}
```

### Get Memory

```typescript
// Get by memory ID
const memory = await pdw.memory.get('0x...');

console.log(memory.content);
console.log(memory.category);
```

### List Memories

```typescript
// List all memories
const memories = await pdw.memory.list();

// With filters
const memories = await pdw.memory.list({
  limit: 20,              // Max results
  offset: 0,              // Pagination offset
  category: 'fact',       // Filter by category
  sortBy: 'createdAt',    // Sort field
  order: 'desc'           // Sort order
});

// Iterate results
for (const memory of memories) {
  console.log(`[${memory.category}] ${memory.content}`);
}
```

### Update Memory

```typescript
await pdw.memory.update(memoryId, {
  content: 'Updated content',
  category: 'event',
  importance: 7
});
```

### Delete Memory

```typescript
await pdw.memory.delete(memoryId);
```

### Delete Multiple Memories

```typescript
await pdw.memory.deleteBatch([memoryId1, memoryId2, memoryId3]);
```

### Get Related Memories

```typescript
// Find memories related to a specific memory
const related = await pdw.memory.getRelated(memoryId, { limit: 5 });
```

### Export Memories

```typescript
// Export all memories as JSON
const exportData = await pdw.memory.export();
```

---

## Search Operations

### Vector Search (Semantic)

Find memories by semantic similarity:

```typescript
const results = await pdw.search.vector('What projects have I worked on?', {
  limit: 10,              // Max results
  threshold: 0.5,         // Minimum similarity (0-1)
  category: 'fact',       // Optional category filter
  fetchContent: true,     // Fetch full content from Walrus
  includeEmbeddings: false // Include embedding vectors
});

// Results sorted by similarity score (highest first)
for (const result of results) {
  console.log(`Score: ${result.score.toFixed(3)}`);
  console.log(`Content: ${result.content}`);
  console.log(`Category: ${result.category}`);
}
```

### Search by Category

```typescript
// Get all facts
const facts = await pdw.search.byCategory('fact', { limit: 20 });

// Get all events
const events = await pdw.search.byCategory('event', { limit: 20 });

// Available categories: fact, event, preference, thought, goal, relationship
```

### Hybrid Search

Combines vector similarity with keyword matching:

```typescript
const results = await pdw.search.hybrid('CommandOSS engineer', {
  category: 'fact',
  limit: 10,
  vectorWeight: 0.7,    // Weight for vector similarity
  keywordWeight: 0.3    // Weight for keyword match
});
```

### Semantic Search with Reranking

```typescript
const results = await pdw.search.semantic('career goals', {
  limit: 10,
  rerank: true  // Re-rank results for better relevance
});
```

### Search by Date Range

```typescript
const results = await pdw.search.byDate({
  start: new Date('2024-01-01'),
  end: new Date('2024-12-31')
}, { limit: 50 });
```

### Search by Importance

```typescript
// Get high-importance memories (8-10)
const important = await pdw.search.byImportance({
  min: 8,
  max: 10
}, { limit: 20 });
```

### Fetch Content for Results

```typescript
// If you searched without fetchContent, you can fetch later
const resultsWithContent = await pdw.search.withContent(results);
```

---

## AI Operations

### Generate Embedding

```typescript
// Single text
const embedding = await pdw.ai.embed('Text to embed');
console.log(`Dimensions: ${embedding.length}`);  // 3072

// The embedding is a Float32Array
console.log(`First 5 values: ${embedding.slice(0, 5)}`);
```

### Classify Content

Automatically categorize and analyze content:

```typescript
const classification = await pdw.ai.classify('I got promoted to Senior Engineer today!');

console.log(classification);
// {
//   category: 'event',
//   importance: 8,
//   topic: 'career',
//   summary: 'User received a promotion to Senior Engineer'
// }
```

### Should Save Check

Determine if content is worth saving:

```typescript
const shouldSave = await pdw.ai.shouldSave('asdfghjkl random text');
console.log(shouldSave);  // false

const shouldSave2 = await pdw.ai.shouldSave('I learned TypeScript today');
console.log(shouldSave2);  // true
```

---

## Index Management

The SDK uses HNSW (Hierarchical Navigable Small World) for fast vector search.

### Get Index Statistics

```typescript
const stats = await pdw.index.getStats();
console.log(`Vectors indexed: ${stats.currentCount}`);
console.log(`Dimensions: ${stats.dimension}`);
console.log(`Max capacity: ${stats.maxElements}`);
```

### Save Index to Walrus

Backup your index for cross-device sync:

```typescript
const blobId = await pdw.index.save();
console.log(`Index saved to Walrus: ${blobId}`);

// Store this blobId for later restoration
```

### Load Index from Walrus

```typescript
await pdw.index.load(blobId);
console.log('Index restored from Walrus');
```

### Add Vector Manually

```typescript
await pdw.index.add({
  vectorId: 1,
  vector: embedding,  // 3072-dim array
  metadata: { memoryId: '0x...', category: 'fact' }
});
```

### Search Index Directly

```typescript
const results = await pdw.index.search(queryEmbedding, {
  k: 10,  // Top-k results
  ef: 50  // Search quality parameter
});
```

### Clear Index

```typescript
await pdw.index.clear();
```

### Flush Pending Writes

```typescript
await pdw.index.flush();
```

---

## Batch Operations

Walrus Quilt enables batch uploads with ~90% gas savings.

### Create Batch

```typescript
// Simple batch
const memories = await pdw.memory.createBatch([
  'First memory content',
  'Second memory content',
  'Third memory content'
]);

console.log(`Created ${memories.length} memories`);
memories.forEach(m => {
  console.log(`  ${m.id}: ${m.category}`);
});
```

### Batch with Options

```typescript
const memories = await pdw.memory.createBatch(
  [
    'I prefer dark mode in all applications',
    'I like working late at night',
    'I enjoy coffee in the morning'
  ],
  {
    category: 'preference',  // Apply to all
    importance: 6
  }
);
```

### Gas Savings Comparison

| Batch Size | Individual Gas | Quilt Gas | Savings |
|------------|----------------|-----------|---------|
| 2 memories | ~0.006 SUI | ~0.004 SUI | ~33% |
| 5 memories | ~0.015 SUI | ~0.005 SUI | ~67% |
| 10 memories | ~0.030 SUI | ~0.006 SUI | ~80% |
| 20 memories | ~0.060 SUI | ~0.008 SUI | ~87% |

### Update Batch

```typescript
await pdw.memory.updateBatch([
  { id: memoryId1, content: 'Updated content 1' },
  { id: memoryId2, importance: 9 },
  { id: memoryId3, category: 'event' }
]);
```

---

## Knowledge Graph

Extract entities and relationships from memories (requires `enableKnowledgeGraph: true`).

### Extract from Content

```typescript
const graph = await pdw.graph.extract('John works at CommandOSS with Sarah');

console.log('Entities:');
graph.entities.forEach(e => {
  console.log(`  ${e.name} (${e.type})`);
});
// John (person)
// CommandOSS (organization)
// Sarah (person)

console.log('Relationships:');
graph.relationships.forEach(r => {
  console.log(`  ${r.source} --[${r.type}]--> ${r.target}`);
});
// John --[works_at]--> CommandOSS
// Sarah --[works_at]--> CommandOSS
// John --[colleague]--> Sarah
```

### Search Entities

```typescript
const results = await pdw.search.entities('CommandOSS', { limit: 10 });
```

### Search Relationships

```typescript
const results = await pdw.search.relationships('works_at', { limit: 10 });
```

---

## Encryption (SEAL)

Optional end-to-end encryption using Mysten SEAL.

### Create Encrypted Memory

```typescript
const memory = await pdw.memory.create('Sensitive information', {
  encrypt: true
});
```

### Encrypt Data

```typescript
const encrypted = await pdw.encryption.encrypt(data);
```

### Decrypt Data

```typescript
const decrypted = await pdw.encryption.decrypt(encryptedData, {
  memoryCapId: '0x...'
});
```

---

## Error Handling

### Common Errors

```typescript
import { PDWError } from '@cmdoss/memwal-sdk';

try {
  const memory = await pdw.memory.create(content);
} catch (error) {
  if (error instanceof PDWError) {
    switch (error.code) {
      case 'INSUFFICIENT_GAS':
        console.log('Need more SUI for gas');
        break;
      case 'WALRUS_UPLOAD_FAILED':
        console.log('Storage error, retrying...');
        break;
      case 'EMBEDDING_FAILED':
        console.log('AI API error');
        break;
      case 'TRANSACTION_FAILED':
        console.log('Blockchain transaction failed');
        break;
      default:
        console.log(`Error: ${error.message}`);
    }
  }
}
```

### Retry Logic

```typescript
async function createWithRetry(content: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await pdw.memory.create(content);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Retry ${i + 1}/${maxRetries}...`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
```

---

## TypeScript Types

### Import Types

```typescript
import type {
  SimplePDWClient,
  SimplePDWConfig,
  Memory,
  SearchResult,
  Classification,
  IndexStats,
  KnowledgeGraph,
  Entity,
  Relationship
} from '@cmdoss/memwal-sdk';
```

### Key Interfaces

```typescript
interface Memory {
  id: string;
  blobId: string;
  content: string;
  category: string;
  importance: number;
  topic?: string;
  embedding?: number[];
  createdAt: number;
  updatedAt?: number;
  encrypted: boolean;
  metadata?: Record<string, any>;
  vectorId?: number;
}

interface SearchResult {
  id: string;
  blobId: string;
  content?: string;
  score: number;
  similarity: number;
  category: string;
  importance: number;
  topic?: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

interface Classification {
  category: string;
  importance: number;
  topic: string;
  summary: string;
}

interface IndexStats {
  currentCount: number;
  dimension: number;
  maxElements: number;
  spaceType: string;
  totalVectors: number;
}
```

---

## Best Practices

### 1. Always Wait for Ready

```typescript
const pdw = new SimplePDWClient(config);
await pdw.ready();  // Don't skip this!
```

### 2. Use Batch Operations

```typescript
// Instead of this:
for (const content of contents) {
  await pdw.memory.create(content);  // Expensive!
}

// Do this:
await pdw.memory.createBatch(contents);  // ~90% cheaper
```

### 3. Cache Embeddings

```typescript
const embeddingCache = new Map<string, number[]>();

async function getEmbedding(text: string) {
  if (!embeddingCache.has(text)) {
    embeddingCache.set(text, await pdw.ai.embed(text));
  }
  return embeddingCache.get(text)!;
}
```

### 4. Use Appropriate Search Thresholds

```typescript
// High precision (fewer but more relevant results)
const results = await pdw.search.vector(query, { threshold: 0.8 });

// High recall (more results, some less relevant)
const results = await pdw.search.vector(query, { threshold: 0.5 });
```

### 5. Handle Rate Limits

```typescript
async function rateLimitedCreate(contents: string[]) {
  for (const content of contents) {
    await pdw.memory.create(content);
    await new Promise(r => setTimeout(r, 500));  // 500ms delay
  }
}
```

### 6. Save Index Periodically

```typescript
// Save index every 10 new memories
let memoryCount = 0;

async function createAndTrack(content: string) {
  await pdw.memory.create(content);
  memoryCount++;

  if (memoryCount % 10 === 0) {
    await pdw.index.save();
  }
}
```

---

## Related Documentation

- [README.md](../README.md) - Quick start guide
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [BENCHMARKS.md](../BENCHMARKS.md) - Performance metrics
- [CHANGELOG.md](../CHANGELOG.md) - Version history

---

## Resources

- [GitHub Repository](https://github.com/cmdoss/personal-data-wallet)
- [npm Package](https://www.npmjs.com/package/@cmdoss/memwal-sdk)
- [Sui Documentation](https://docs.sui.io)
- [Walrus Documentation](https://docs.walrus.site)
- [OpenRouter](https://openrouter.ai/docs)

---

## License

MIT License - see [LICENSE](../LICENSE) file for details.
