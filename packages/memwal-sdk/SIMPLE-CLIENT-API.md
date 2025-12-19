# Simple PDW Client - Complete API Reference

**Version:** 0.3.0
**Last Updated:** November 2024

---

## 📖 Table of Contents

1. [Introduction](#introduction)
2. [Quick Start](#quick-start)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [API Reference](#api-reference)
   - [memory.*](#memory-namespace) (9 methods)
   - [search.*](#search-namespace) (8 methods)
   - [classify.*](#classify-namespace) (4 methods)
   - [graph.*](#graph-namespace) (6 methods)
   - [storage.*](#storage-namespace) (10 methods)
6. [Complete Examples](#complete-examples)
7. [Best Practices](#best-practices)
8. [Troubleshooting](#troubleshooting)

---

## Introduction

**Simple PDW Client** provides an easy-to-use, function-based API for Personal Data Wallet operations **without requiring React hooks**.

### Key Features

- ✅ **No React dependencies** - Works in Node.js, browsers, serverless, CLI
- ✅ **Simple async/await API** - No callbacks, no hooks
- ✅ **Full TypeScript support** - Complete type safety
- ✅ **Unified signer** - Works with Keypair (Node.js) and WalletAdapter (browser)
- ✅ **Auto-configuration** - Smart defaults based on network
- ✅ **37 methods** - Covering 26% of PDW SDK (core data operations)

### When to Use

| Use Simple Client For | Use React Hooks For |
|----------------------|-------------------|
| Node.js backends | React UI apps |
| Serverless functions | dApp frontends |
| CLI tools | Progress bars & loading states |
| API endpoints | Real-time UI updates |
| Batch processing | User interaction flows |

---

## Quick Start

### 3 Lines to Get Started

```typescript
import { createSimplePDWClient } from 'personal-data-wallet-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);

const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// Use it!
await pdw.memory.create('I love TypeScript', { category: 'preference' });
const results = await pdw.search.vector('programming languages');
console.log(results);
```

---

## Installation

### NPM Packages

```bash
npm install personal-data-wallet-sdk @mysten/sui @ai-sdk/google
```

### Environment Variables

Create `.env` file:

```bash
# Required
SUI_PRIVATE_KEY=your_sui_private_key
GEMINI_API_KEY=your_gemini_api_key

# Optional (auto-configured for testnet)
PACKAGE_ID=0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
```

---

## Configuration

### SimplePDWConfig Interface

```typescript
interface SimplePDWConfig {
  // Required
  signer: Keypair | WalletAdapter | UnifiedSigner;

  // Optional (auto-configured)
  userAddress?: string;              // Derived from signer if not provided
  network?: 'testnet' | 'mainnet' | 'devnet';  // Default: 'testnet'
  geminiApiKey?: string;             // For AI features

  // Advanced options
  walrus?: {
    aggregator?: string;             // Auto-configured per network
    publisher?: string;
    network?: 'testnet' | 'mainnet';
  };

  sui?: {
    network?: 'testnet' | 'mainnet' | 'devnet';
    packageId?: string;              // Auto-configured per network
    rpcUrl?: string;
  };

  features?: {
    enableEncryption?: boolean;      // Default: false
    enableLocalIndexing?: boolean;   // Default: true
    enableKnowledgeGraph?: boolean;  // Default: true
  };
}
```

### Initialization Options

**Option 1: Minimal (Recommended)**
```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});
```

**Option 2: From Keypair (Node.js helper)**
```typescript
const pdw = await createSimplePDWClientFromKeypair(keypair, {
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});
```

**Option 3: Browser with Wallet**
```typescript
const pdw = await createSimplePDWClient({
  signer: walletAdapter,  // From @mysten/dapp-kit
  userAddress: wallet.address,
  network: 'testnet',
  geminiApiKey: config.geminiApiKey
});
```

**Option 4: Full Custom**
```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY,
  walrus: {
    aggregator: 'https://custom-aggregator.com',
    publisher: 'https://custom-publisher.com'
  },
  sui: {
    packageId: '0xcustom...',
    rpcUrl: 'https://custom-rpc.com'
  },
  features: {
    enableEncryption: true,
    enableLocalIndexing: true,
    enableKnowledgeGraph: true
  }
});
```

---

## API Reference

### memory Namespace

Complete memory CRUD operations with automatic embedding, encryption, and blockchain registration.

#### `memory.create(content, options?)`

Create a new memory with automatic processing pipeline.

**Parameters:**
- `content` (string) - Text content to save
- `options` (optional):
  - `category` - 'fact' | 'preference' | 'todo' | 'note' | 'general'
  - `importance` - Number 1-10
  - `topic` - String topic/tag
  - `metadata` - Custom metadata object
  - `onProgress` - Callback `(stage: string, percent: number) => void`

**Returns:** `Promise<Memory>`

**Example:**
```typescript
const memory = await pdw.memory.create('I love TypeScript', {
  category: 'preference',
  importance: 8,
  topic: 'programming',
  metadata: { source: 'conversation' },
  onProgress: (stage, percent) => {
    console.log(`${stage}: ${percent}%`);
  }
});

console.log(memory.blobId);  // Walrus blob ID
console.log(memory.id);      // Memory ID
```

---

#### `memory.get(memoryId)`

Retrieve a memory by ID with full metadata.

**Parameters:**
- `memoryId` (string) - Memory ID or blob ID

**Returns:** `Promise<Memory>`

**Example:**
```typescript
const memory = await pdw.memory.get('blob-id-123');

console.log(memory.content);    // Original text
console.log(memory.category);   // 'preference'
console.log(memory.importance); // 8
console.log(memory.embedding);  // Vector embedding
```

---

#### `memory.update(memoryId, updates)`

Update memory metadata.

**Parameters:**
- `memoryId` (string) - Memory ID to update
- `updates` (object):
  - `category` - New category
  - `importance` - New importance
  - `topic` - New topic
  - `metadata` - Additional metadata

**Returns:** `Promise<Memory>`

**Note:** Content is immutable on Walrus; only metadata can be updated.

**Example:**
```typescript
const updated = await pdw.memory.update('mem-123', {
  importance: 10,
  category: 'emergency',
  metadata: { urgent: true }
});
```

---

#### `memory.delete(memoryId)`

Delete a memory.

**Parameters:**
- `memoryId` (string) - Memory ID to delete

**Returns:** `Promise<void>`

**Note:** Walrus blobs are immutable; this marks as deleted on-chain and removes from indices.

**Example:**
```typescript
await pdw.memory.delete('mem-123');
console.log('Memory deleted');
```

---

#### `memory.list(options?)`

List user memories with filtering and pagination.

**Parameters:**
- `options` (optional):
  - `category` - Filter by category
  - `limit` - Max results (default: 50)
  - `offset` - Skip N results (default: 0)
  - `sortBy` - 'date' | 'importance' | 'relevance'
  - `order` - 'asc' | 'desc'

**Returns:** `Promise<Memory[]>`

**Example:**
```typescript
// Get all preferences
const preferences = await pdw.memory.list({
  category: 'preference',
  limit: 20,
  sortBy: 'importance',
  order: 'desc'
});

// Get recent memories
const recent = await pdw.memory.list({
  sortBy: 'date',
  order: 'desc',
  limit: 10
});
```

---

#### `memory.createBatch(contents[], options?)`

Create multiple memories in batch.

**Parameters:**
- `contents` (string[]) - Array of content strings
- `options` - Shared options for all memories

**Returns:** `Promise<Memory[]>`

**Example:**
```typescript
const memories = await pdw.memory.createBatch(
  [
    'I prefer dark mode',
    'My favorite food is pizza',
    'I work at Acme Corp'
  ],
  {
    category: 'preference',
    importance: 6,
    onProgress: (stage, percent) => {
      console.log(`Batch: ${stage} ${percent}%`);
    }
  }
);

console.log(`Created ${memories.length} memories`);
```

---

#### `memory.deleteBatch(memoryIds[])`

Delete multiple memories.

**Parameters:**
- `memoryIds` (string[]) - Array of memory IDs

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.memory.deleteBatch(['mem-1', 'mem-2', 'mem-3']);
```

---

#### `memory.getContext(memoryId, options?)`

Get memory with related memories and knowledge graph.

**Parameters:**
- `memoryId` (string) - Memory ID
- `options` (optional):
  - `includeRelated` - Include similar memories (default: false)
  - `includeGraph` - Include knowledge graph (default: false)

**Returns:** `Promise<MemoryContext>`

**Example:**
```typescript
const context = await pdw.memory.getContext('mem-123', {
  includeRelated: true,
  includeGraph: true
});

console.log(context.memory);           // Main memory
console.log(context.related);          // Related memories
console.log(context.entities);         // Extracted entities
console.log(context.relationships);    // Relationships
```

---

#### `memory.getRelated(memoryId, k?)`

Find k most similar memories.

**Parameters:**
- `memoryId` (string) - Memory ID
- `k` (number) - Number of related memories (default: 5)

**Returns:** `Promise<Memory[]>`

**Example:**
```typescript
const related = await pdw.memory.getRelated('mem-123', 10);

console.log(`Found ${related.length} related memories`);
related.forEach(m => {
  console.log(`- ${m.content.substring(0, 50)}...`);
});
```

---

#### `memory.export(options?)`

Export memories to JSON or CSV format.

**Parameters:**
- `options` (optional):
  - `format` - 'json' | 'csv' (default: 'json')
  - `includeContent` - Include full content (default: true)
  - `includeEmbeddings` - Include embedding vectors (default: false)
  - `category` - Filter by category
  - `limit` - Max memories to export

**Returns:** `Promise<string>` (JSON or CSV string)

**Example:**
```typescript
// Export as JSON
const jsonData = await pdw.memory.export({
  format: 'json',
  includeContent: true,
  category: 'fact',
  limit: 100
});

// Save to file
require('fs').writeFileSync('memories.json', jsonData);

// Export as CSV
const csvData = await pdw.memory.export({
  format: 'csv',
  includeContent: true
});

require('fs').writeFileSync('memories.csv', csvData);
```

---

### search Namespace

Advanced search capabilities with multiple strategies.

#### `search.vector(query, options?)`

Vector similarity search using embeddings.

**Parameters:**
- `query` (string) - Search query
- `options` (optional):
  - `limit` - Max results (default: 10)
  - `threshold` - Min similarity 0-1 (default: 0.7)
  - `category` - Filter by category
  - `includeEmbeddings` - Include vectors in results

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.vector('TypeScript programming', {
  limit: 5,
  threshold: 0.8,
  category: 'preference'
});

results.forEach(r => {
  console.log(`Score: ${r.score} - ${r.content}`);
});
```

---

#### `search.semantic(query, options?)`

AI-enhanced semantic search with query expansion.

**Parameters:**
- `query` (string) - Natural language query
- `options` (optional):
  - `limit` - Max results
  - `threshold` - Min similarity
  - `rerank` - Use AI reranking (default: true)

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.semantic(
  'What did I say about my career goals?',
  { limit: 10, rerank: true }
);
```

---

#### `search.keyword(query, options?)`

Metadata keyword search.

**Parameters:**
- `query` (string) - Keyword to search
- `options` (optional):
  - `limit` - Max results
  - `category` - Filter by category
  - `fields` - Fields to search (default: ['content', 'topic'])
  - `caseSensitive` - Case sensitive (default: false)

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.keyword('TypeScript', {
  fields: ['content', 'topic'],
  caseSensitive: false
});
```

---

#### `search.hybrid(query, options?)`

Combined vector + keyword search.

**Parameters:**
- `query` (string) - Search query
- `options` (optional):
  - `limit` - Max results
  - `vectorWeight` - Vector weight 0-1 (default: 0.7)
  - `keywordWeight` - Keyword weight 0-1 (default: 0.3)
  - `category` - Filter by category

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.hybrid('React hooks', {
  vectorWeight: 0.6,
  keywordWeight: 0.4,
  limit: 10
});
```

---

#### `search.byCategory(category, options?)`

Filter memories by category.

**Parameters:**
- `category` (string) - Category to filter
- `options` - Additional search options

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const todos = await pdw.search.byCategory('todo', { limit: 20 });
const facts = await pdw.search.byCategory('fact');
```

---

#### `search.byDate(dateRange, options?)`

Temporal search within date range.

**Parameters:**
- `dateRange` (object):
  - `start` - Date | ISO string
  - `end` - Date | ISO string (optional, default: now)
- `options` - Additional options

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.byDate({
  start: '2024-01-01',
  end: '2024-12-31'
}, {
  category: 'work',
  limit: 50
});

// Last 7 days
const recent = await pdw.search.byDate({
  start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  end: new Date()
});
```

---

#### `search.byImportance(min, max, options?)`

Filter by importance score.

**Parameters:**
- `min` (number) - Min importance (1-10)
- `max` (number) - Max importance (default: 10)
- `options` - Additional options

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
// High importance only
const important = await pdw.search.byImportance(8, 10);

// Medium importance
const medium = await pdw.search.byImportance(4, 7);
```

---

#### `search.advanced(query)`

Advanced multi-filter search.

**Parameters:**
- `query` (object):
  - `text` - Search text (optional)
  - `category` - Category filter
  - `importance` - { min, max } range
  - `dateRange` - { start, end }
  - `limit` - Max results

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.advanced({
  text: 'programming',
  category: 'preference',
  importance: { min: 7, max: 10 },
  dateRange: {
    start: '2024-01-01',
    end: '2024-12-31'
  },
  limit: 20
});
```

---

#### `search.graph(query, options?)`

Graph-based search using knowledge graph relationships.

**Parameters:**
- `query` (string) - Entity or concept to search
- `options` (optional):
  - `limit` - Max results

**Returns:** `Promise<SearchResult[]>`

**Example:**
```typescript
const results = await pdw.search.graph('TypeScript', {
  limit: 10
});

console.log(`Found ${results.length} memories via graph connections`);
```

---

#### `search.withEmbeddings(query, options?)`

Vector search with embedding vectors included in results.

**Parameters:**
- `query` (string) - Search query
- `options` (optional) - Same as vector search

**Returns:** `Promise<SearchResult[]>` (with embeddings)

**Example:**
```typescript
const results = await pdw.search.withEmbeddings('React hooks', {
  limit: 5,
  threshold: 0.8
});

results.forEach(r => {
  console.log(`${r.content.substring(0, 50)}`);
  console.log(`  Embedding dimensions: ${r.embedding?.length}`);
});
```

---

#### `search.multiVector(queries[], options?)`

Search using multiple queries, returning combined results.

**Parameters:**
- `queries` (string[]) - Array of search queries
- `options` (optional) - Search options

**Returns:** `Promise<SearchResult[]>` (deduplicated and sorted)

**Example:**
```typescript
const results = await pdw.search.multiVector(
  ['React', 'Vue', 'Svelte', 'Angular'],
  { limit: 20, threshold: 0.7 }
);

console.log(`Found ${results.length} unique memories across all queries`);
```

---

#### `search.rerank(results, query, options?)`

Rerank existing search results using AI for better relevance.

**Parameters:**
- `results` (SearchResult[]) - Initial search results
- `query` (string) - Original query for context
- `options` (optional):
  - `limit` - Max results to return

**Returns:** `Promise<SearchResult[]>` (reranked)

**Example:**
```typescript
// Initial search
const initialResults = await pdw.search.vector('programming');

// Rerank for better relevance
const reranked = await pdw.search.rerank(
  initialResults,
  'TypeScript programming best practices',
  { limit: 5 }
);

console.log('Top 5 most relevant after AI reranking:');
reranked.forEach((r, i) => {
  console.log(`${i+1}. ${r.content.substring(0, 60)}... (score: ${r.score})`);
});
```

---

### classify Namespace

AI-powered content classification and analysis.

#### `classify.shouldSave(content)`

Determine if content should be saved as memory.

**Parameters:**
- `content` (string) - Text to analyze

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const shouldSave = await pdw.classify.shouldSave('Random spam message');
// Returns: false

const shouldSave2 = await pdw.classify.shouldSave('I love TypeScript');
// Returns: true

if (shouldSave2) {
  await pdw.memory.create('I love TypeScript');
}
```

---

#### `classify.category(content)`

Auto-categorize content.

**Parameters:**
- `content` (string) - Text to categorize

**Returns:** `Promise<string>`

**Possible categories:**
- `fact`, `preference`, `todo`, `note`, `contact`, `personal_info`, `career`, `general`

**Example:**
```typescript
const cat1 = await pdw.classify.category('I prefer dark mode');
// Returns: 'preference'

const cat2 = await pdw.classify.category('Buy milk tomorrow');
// Returns: 'todo'

const cat3 = await pdw.classify.category('Paris is the capital of France');
// Returns: 'fact'
```

---

#### `classify.patterns(content)`

Analyze patterns in content.

**Parameters:**
- `content` (string) - Text to analyze

**Returns:** `Promise<PatternAnalysis>`

**Example:**
```typescript
const analysis = await pdw.classify.patterns('My email is user@example.com');

console.log(analysis.patterns);         // Detected patterns
console.log(analysis.categories);       // Possible categories
console.log(analysis.suggestedCategory); // Best category
```

---

#### `classify.importance(content)`

Calculate importance score (1-10).

**Parameters:**
- `content` (string) - Text to score

**Returns:** `Promise<number>`

**Scoring:**
- 10: Emergency information
- 9: Contact information
- 8: Personal info
- 7: Career information
- 6: Preferences
- 5: Facts
- 4: Notes
- 3: General

**Example:**
```typescript
const score1 = await pdw.classify.importance('Emergency: Call 911');
// Returns: 10

const score2 = await pdw.classify.importance('I like coffee');
// Returns: 6
```

---

### graph Namespace

Knowledge graph extraction and querying.

#### `graph.extract(content)`

Extract entities and relationships from text.

**Parameters:**
- `content` (string) - Text to analyze

**Returns:** `Promise<KnowledgeGraph>`

**Example:**
```typescript
const graph = await pdw.graph.extract(
  'Alice works at Google in California with Bob'
);

console.log(graph.entities);
// [
//   { id: '1', name: 'Alice', type: 'PERSON', confidence: 0.95 },
//   { id: '2', name: 'Google', type: 'ORG', confidence: 0.98 },
//   { id: '3', name: 'California', type: 'LOCATION', confidence: 0.92 },
//   { id: '4', name: 'Bob', type: 'PERSON', confidence: 0.93 }
// ]

console.log(graph.relationships);
// [
//   { source: '1', target: '2', type: 'WORKS_AT', confidence: 0.90 },
//   { source: '2', target: '3', type: 'LOCATED_IN', confidence: 0.85 }
// ]
```

---

#### `graph.query(entityId)`

Query entity and its relationships.

**Parameters:**
- `entityId` (string) - Entity ID

**Returns:** `Promise<GraphQueryResult>`

**Example:**
```typescript
const result = await pdw.graph.query('entity-123');

console.log(result.entity);              // The entity
console.log(result.relationships);       // All relationships
console.log(result.connectedEntities);   // Connected entities
```

---

#### `graph.traverse(startEntity, options?)`

Traverse graph from starting entity.

**Parameters:**
- `startEntity` (string) - Entity ID to start from
- `options` (optional):
  - `maxDepth` - Max hops (default: 3)
  - `relationshipTypes` - Filter relationship types
  - `minConfidence` - Min confidence (default: 0.5)

**Returns:** `Promise<GraphPath[]>`

**Example:**
```typescript
const paths = await pdw.graph.traverse('alice-123', {
  maxDepth: 2,
  relationshipTypes: ['WORKS_WITH', 'FRIENDS_WITH'],
  minConfidence: 0.7
});

paths.forEach(path => {
  console.log('Path:', path.nodes.map(n => n.name).join(' → '));
});
```

---

#### `graph.getEntities(filter?)`

Get all entities matching filter.

**Parameters:**
- `filter` (optional):
  - `type` - Entity type ('PERSON', 'ORG', 'LOCATION', etc.)
  - `minConfidence` - Min confidence
  - `limit` - Max results

**Returns:** `Promise<Entity[]>`

**Example:**
```typescript
// Get all people
const people = await pdw.graph.getEntities({
  type: 'PERSON',
  minConfidence: 0.8
});

// Get all organizations
const orgs = await pdw.graph.getEntities({ type: 'ORG' });
```

---

#### `graph.getRelationships(filter?)`

Get all relationships matching filter.

**Parameters:**
- `filter` (optional):
  - `type` - Relationship type
  - `sourceId` - Source entity ID
  - `targetId` - Target entity ID
  - `minConfidence` - Min confidence
  - `limit` - Max results

**Returns:** `Promise<Relationship[]>`

**Example:**
```typescript
// All WORKS_AT relationships
const workRelations = await pdw.graph.getRelationships({
  type: 'WORKS_AT'
});

// All relationships from Alice
const aliceRelations = await pdw.graph.getRelationships({
  sourceId: 'alice-123'
});
```

---

#### `graph.stats()`

Get knowledge graph statistics.

**Parameters:** None

**Returns:** `Promise<GraphStats>`

**Example:**
```typescript
const stats = await pdw.graph.stats();

console.log(stats.totalEntities);        // 42
console.log(stats.totalRelationships);   // 67
console.log(stats.entityTypes);          // { PERSON: 15, ORG: 10, ... }
console.log(stats.relationshipTypes);    // { WORKS_AT: 20, FRIENDS_WITH: 15, ... }
```

---

### embeddings Namespace

Direct embedding generation and operations.

#### `embeddings.generate(text, options?)`

Generate embedding vector for text.

**Parameters:**
- `text` (string) - Text to embed
- `options` (optional):
  - `type` - 'query' | 'document'

**Returns:** `Promise<number[]>` (768 dimensions for Gemini)

**Example:**
```typescript
const embedding = await pdw.embeddings.generate('TypeScript is awesome');
console.log(embedding.length);  // 768
console.log(embedding[0]);      // 0.234...
```

---

#### `embeddings.batch(texts[])`

Generate embeddings for multiple texts.

**Parameters:**
- `texts` (string[]) - Array of texts

**Returns:** `Promise<number[][]>`

**Example:**
```typescript
const embeddings = await pdw.embeddings.batch([
  'React hooks',
  'Vue composition API',
  'Svelte stores'
]);

console.log(`Generated ${embeddings.length} embeddings`);
```

---

#### `embeddings.similarity(vector1, vector2)`

Calculate cosine similarity between two vectors.

**Parameters:**
- `vector1` (number[]) - First vector
- `vector2` (number[]) - Second vector

**Returns:** `number` (0-1, higher is more similar)

**Example:**
```typescript
const emb1 = await pdw.embeddings.generate('TypeScript');
const emb2 = await pdw.embeddings.generate('JavaScript');

const similarity = pdw.embeddings.similarity(emb1, emb2);
console.log(`Similarity: ${similarity.toFixed(3)}`);  // 0.847
```

---

#### `embeddings.findSimilar(queryVector, candidateVectors, k?)`

Find top-k most similar vectors.

**Parameters:**
- `queryVector` (number[]) - Query vector
- `candidateVectors` (number[][]) - Candidate vectors
- `k` (number) - Number of results (default: 5)

**Returns:** `Array<{ index: number; score: number }>`

**Example:**
```typescript
const query = await pdw.embeddings.generate('React');
const candidates = await pdw.embeddings.batch([
  'React hooks',
  'Vue components',
  'Angular directives',
  'React context'
]);

const similar = pdw.embeddings.findSimilar(query, candidates, 2);
// Returns: [{ index: 0, score: 0.95 }, { index: 3, score: 0.89 }]
```

---

### chat Namespace

AI chat with automatic memory context retrieval.

#### `chat.createSession(options?)`

Create new chat session.

**Parameters:**
- `options` (optional):
  - `title` - Session title
  - `model` - AI model (default: 'gemini-1.5-flash')

**Returns:** `Promise<ChatSession>`

**Example:**
```typescript
const session = await pdw.chat.createSession({
  title: 'My AI Assistant',
  model: 'gemini-1.5-flash'
});

console.log(session.id);     // 'session-123'
console.log(session.title);  // 'My AI Assistant'
```

---

#### `chat.send(sessionId, message)`

Send message and get AI response (non-streaming).

**Parameters:**
- `sessionId` (string) - Session ID
- `message` (string) - User message

**Returns:** `Promise<ChatMessage>`

**Example:**
```typescript
const response = await pdw.chat.send(session.id, 'What do I know about TypeScript?');

console.log(response.role);      // 'assistant'
console.log(response.content);   // AI response with memory context
```

---

#### `chat.stream(sessionId, message, callbacks)`

Stream chat response in real-time.

**Parameters:**
- `sessionId` (string) - Session ID
- `message` (string) - User message
- `callbacks` (object):
  - `onMessage` - Callback for each chunk
  - `onDone` - Callback when complete
  - `onError` - Error callback

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.chat.stream(session.id, 'Tell me about React', {
  onMessage: (chunk) => {
    process.stdout.write(chunk.data);
  },
  onDone: () => {
    console.log('\n✅ Complete!');
  },
  onError: (error) => {
    console.error('Stream error:', error);
  }
});
```

---

#### `chat.getSessions()`

Get all user chat sessions.

**Parameters:** None

**Returns:** `Promise<ChatSession[]>`

**Example:**
```typescript
const sessions = await pdw.chat.getSessions();

sessions.forEach(s => {
  console.log(`${s.title} (${s.messageCount} messages)`);
});
```

---

#### `chat.getSession(sessionId)`

Get session with messages.

**Parameters:**
- `sessionId` (string) - Session ID

**Returns:** `Promise<ChatSession>`

**Example:**
```typescript
const session = await pdw.chat.getSession('session-123');
console.log(session.title);
console.log(session.messageCount);
```

---

#### `chat.updateTitle(sessionId, title)`

Update session title.

**Parameters:**
- `sessionId` (string) - Session ID
- `title` (string) - New title

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.chat.updateTitle(session.id, 'TypeScript Discussion');
```

---

#### `chat.delete(sessionId)`

Delete chat session.

**Parameters:**
- `sessionId` (string) - Session ID

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.chat.delete('session-123');
```

---

### batch Namespace

Batch processing operations with intelligent queuing and progress tracking.

#### `batch.createMany(contents[], options?)`

Create multiple memories in batch.

**Parameters:**
- `contents` (string[]) - Array of content strings
- `options` (optional):
  - `category` - Memory category
  - `importance` - Importance score (1-10)

**Returns:** `Promise<Array<{ id: string; blobId: string }>>`

**Example:**
```typescript
const memories = await pdw.batch.createMany(
  [
    'I love TypeScript',
    'React is awesome',
    'Node.js is powerful'
  ],
  {
    category: 'fact',
    importance: 7
  }
);

console.log(`Created ${memories.length} memories`);
memories.forEach(m => console.log(`ID: ${m.id}, Blob: ${m.blobId}`));
```

---

#### `batch.updateMany(updates[])`

Update multiple memories in batch.

**Parameters:**
- `updates` (Array) - Array of update objects:
  - `id` - Memory ID
  - `content?` - New content
  - `category?` - New category
  - `importance?` - New importance

**Returns:** `Promise<string[]>` (updated IDs)

**Example:**
```typescript
const updated = await pdw.batch.updateMany([
  { id: 'mem-1', content: 'Updated content 1', importance: 9 },
  { id: 'mem-2', category: 'preference' },
  { id: 'mem-3', content: 'Updated content 3' }
]);

console.log(`Updated ${updated.length} memories`);
```

---

#### `batch.deleteMany(ids[])`

Delete multiple memories in batch.

**Parameters:**
- `ids` (string[]) - Array of memory IDs

**Returns:** `Promise<number>` (number of successfully deleted)

**Example:**
```typescript
const deleted = await pdw.batch.deleteMany([
  'mem-1',
  'mem-2',
  'mem-3'
]);

console.log(`Deleted ${deleted} memories`);
```

---

#### `batch.uploadMany(files[])`

Upload multiple files in batch as a Quilt.

**Parameters:**
- `files` (Array) - Array of file objects:
  - `name` - File name
  - `data` - File data (Uint8Array)

**Returns:** `Promise<{ quiltId: string; files: Array<{ name: string; blobId: string }> }>`

**Example:**
```typescript
const result = await pdw.batch.uploadMany([
  { name: 'doc1.txt', data: new TextEncoder().encode('Content 1') },
  { name: 'doc2.txt', data: new TextEncoder().encode('Content 2') },
  { name: 'doc3.txt', data: new TextEncoder().encode('Content 3') }
]);

console.log(`Quilt ID: ${result.quiltId}`);
result.files.forEach(f => console.log(`${f.name}: ${f.blobId}`));
```

---

#### `batch.getProgress()`

Get current batch processing progress.

**Parameters:** None

**Returns:** `BatchProgress`

**Example:**
```typescript
const progress = pdw.batch.getProgress();

console.log(`Total: ${progress.total}`);
console.log(`Completed: ${progress.completed}`);
console.log(`Failed: ${progress.failed}`);
console.log(`In Progress: ${progress.inProgress}`);
console.log(`Percentage: ${progress.percentage.toFixed(2)}%`);
```

---

### cache Namespace

LRU cache with TTL support for fast in-memory caching.

#### `cache.get(key)`

Get cached value by key.

**Parameters:**
- `key` (string) - Cache key

**Returns:** `T | null` (cached value or null if not found/expired)

**Example:**
```typescript
const cached = pdw.cache.get<string>('user:123');

if (cached) {
  console.log('Cache hit:', cached);
} else {
  console.log('Cache miss');
}
```

---

#### `cache.set(key, value, ttl?)`

Set cache value with optional TTL.

**Parameters:**
- `key` (string) - Cache key
- `value` (T) - Value to cache
- `ttl` (number, optional) - Time-to-live in milliseconds

**Returns:** `void`

**Example:**
```typescript
// Cache for 1 hour
pdw.cache.set('user:123', { name: 'Alice' }, 3600000);

// Cache indefinitely
pdw.cache.set('config', { theme: 'dark' });
```

---

#### `cache.has(key)`

Check if key exists in cache (and not expired).

**Parameters:**
- `key` (string) - Cache key

**Returns:** `boolean`

**Example:**
```typescript
if (pdw.cache.has('user:123')) {
  console.log('User data is cached');
} else {
  console.log('Need to fetch user data');
}
```

---

#### `cache.delete(key)`

Delete cache entry.

**Parameters:**
- `key` (string) - Cache key

**Returns:** `boolean` (true if deleted, false if not found)

**Example:**
```typescript
const deleted = pdw.cache.delete('user:123');

if (deleted) {
  console.log('Cache entry removed');
}
```

---

#### `cache.clear()`

Clear all cache entries.

**Parameters:** None

**Returns:** `void`

**Example:**
```typescript
pdw.cache.clear();
console.log('All cache cleared');
```

---

#### `cache.stats()`

Get cache statistics.

**Parameters:** None

**Returns:** `CacheStats`

**Example:**
```typescript
const stats = pdw.cache.stats();

console.log(`Cache size: ${stats.size} entries`);
console.log(`Total access: ${stats.totalAccess}`);
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(2)}%`);
console.log(`Oldest item: ${stats.oldestItem}`);
console.log(`Newest item: ${stats.newestItem}`);
```

---

### analytics Namespace

Memory analytics, insights, and visualization data.

#### `analytics.generate(options?)`

Generate comprehensive analytics report.

**Parameters:**
- `options` (optional):
  - `periodStart` - Start date for analysis
  - `periodEnd` - End date for analysis
  - `includeForecasting` - Include trend forecasts
  - `includeClustering` - Include similarity clusters
  - `includeInsights` - Include AI insights

**Returns:** `Promise<MemoryAnalytics>`

**Example:**
```typescript
const analytics = await pdw.analytics.generate({
  periodStart: new Date('2024-01-01'),
  periodEnd: new Date('2024-12-31'),
  includeForecasting: true,
  includeClustering: true,
  includeInsights: true
});

console.log(`Total memories: ${analytics.totalMemories}`);
console.log(`Average importance: ${analytics.averageImportance}`);
console.log(`Top category: ${analytics.topCategories[0].category}`);
```

---

#### `analytics.categories()`

Get category distribution.

**Parameters:** None

**Returns:** `Promise<CategoryDistribution[]>`

**Example:**
```typescript
const categories = await pdw.analytics.categories();

categories.forEach(c => {
  console.log(`${c.category}: ${c.count} (${c.percentage.toFixed(1)}%)`);
});
```

---

#### `analytics.trends()`

Get temporal trends analysis.

**Parameters:** None

**Returns:** `Promise<{ creation: TrendData; access: TrendData; size: TrendData }>`

**Example:**
```typescript
const trends = await pdw.analytics.trends();

console.log(`Creation trend: ${trends.creation.direction} (strength: ${trends.creation.strength})`);
console.log(`Access trend: ${trends.access.direction}`);

if (trends.creation.forecast) {
  console.log('Future predictions:');
  trends.creation.forecast.forEach(f => {
    console.log(`  ${f.date}: ${f.predicted} ± ${f.confidence}`);
  });
}
```

---

#### `analytics.importance()`

Get importance distribution analysis.

**Parameters:** None

**Returns:** `Promise<{ average: number; distribution: Record<number, number>; highImportance: number; lowImportance: number }>`

**Example:**
```typescript
const importance = await pdw.analytics.importance();

console.log(`Average importance: ${importance.average.toFixed(2)}`);
console.log(`High importance memories: ${importance.highImportance}`);
console.log(`Low importance memories: ${importance.lowImportance}`);

console.log('Distribution:');
Object.entries(importance.distribution).forEach(([level, count]) => {
  console.log(`  Level ${level}: ${count} memories`);
});
```

---

#### `analytics.temporal()`

Get temporal usage patterns.

**Parameters:** None

**Returns:** `Promise<UsagePattern[]>`

**Example:**
```typescript
const patterns = await pdw.analytics.temporal();

patterns.forEach(p => {
  console.log(`${p.type} pattern: ${p.pattern}`);
  console.log(`  Frequency: ${p.frequency}`);
  console.log(`  Trend: ${p.trend}`);
  console.log(`  Peak times:`, p.peakTimes);
});
```

---

#### `analytics.insights()`

Get AI-generated knowledge insights.

**Parameters:** None

**Returns:** `Promise<MemoryInsights>`

**Example:**
```typescript
const insights = await pdw.analytics.insights();

console.log('Knowledge domains:');
insights.knowledgeDomains.forEach(d => {
  console.log(`  ${d.domain}: expertise ${d.expertise}, ${d.memories.length} memories`);
});

console.log('\nRecommendations:');
insights.recommendations.forEach(r => {
  console.log(`  [${r.type}] ${r.title}: ${r.description}`);
});
```

---

#### `analytics.anomalies()`

Detect anomalies in memory patterns.

**Parameters:** None

**Returns:** `Promise<Array<{ date: Date; type: 'spike' | 'drop' | 'outlier'; severity: number; description: string }>>`

**Example:**
```typescript
const anomalies = await pdw.analytics.anomalies();

if (anomalies.length > 0) {
  console.log('Detected anomalies:');
  anomalies.forEach(a => {
    console.log(`  ${a.date}: ${a.type} (severity: ${a.severity})`);
    console.log(`    ${a.description}`);
  });
}
```

---

#### `analytics.correlations()`

Analyze correlations between concepts.

**Parameters:** None

**Returns:** `Promise<Array<{ concept1: string; concept2: string; strength: number; memoryCount: number }>>`

**Example:**
```typescript
const correlations = await pdw.analytics.correlations();

correlations.forEach(c => {
  console.log(`${c.concept1} ↔ ${c.concept2}`);
  console.log(`  Strength: ${c.strength.toFixed(3)}, Memories: ${c.memoryCount}`);
});
```

---

#### `analytics.analyze(memoryId)`

Analyze a single memory in detail.

**Parameters:**
- `memoryId` (string) - Memory ID to analyze

**Returns:** `Promise<{ memoryId: string; importance: number; category: string; relatedCount: number }>`

**Example:**
```typescript
const analysis = await pdw.analytics.analyze('mem-123');

console.log(`Memory: ${analysis.memoryId}`);
console.log(`Importance: ${analysis.importance}`);
console.log(`Category: ${analysis.category}`);
console.log(`Related memories: ${analysis.relatedCount}`);
```

---

#### `analytics.visualizationData()`

Get chart-ready visualization data.

**Parameters:** None

**Returns:** `Promise<{ categoryChart: Array; importanceChart: Array; timelineChart: Array; clusterChart: Array }>`

**Example:**
```typescript
const chartData = await pdw.analytics.visualizationData();

// Category pie chart
console.log('Categories:', chartData.categoryChart);

// Importance bar chart
console.log('Importance:', chartData.importanceChart);

// Timeline line chart
console.log('Timeline:', chartData.timelineChart);

// Cluster scatter plot
console.log('Clusters:', chartData.clusterChart);
```

---

### permissions Namespace

OAuth-style access control and consent management.

#### `permissions.request(appId, scopes, purpose)`

Request user consent for data access.

**Parameters:**
- `appId` (string) - Application identifier
- `scopes` (PermissionScope[]) - Requested scopes (e.g., ['read:memories', 'write:memories'])
- `purpose` (string) - Purpose description for user

**Returns:** `Promise<ConsentRequestRecord>`

**Example:**
```typescript
const request = await pdw.permissions.request(
  'my-app-id',
  ['read:memories', 'read:profile'],
  'Access your memories to provide personalized recommendations'
);

console.log(`Consent request created: ${request.requestId}`);
console.log(`Status: ${request.status}`);
```

---

#### `permissions.grant(appId, scopes, expiresAt?)`

Grant permissions to an application.

**Parameters:**
- `appId` (string) - Application to grant access
- `scopes` (PermissionScope[]) - Scopes to grant
- `expiresAt` (number, optional) - Expiration timestamp

**Returns:** `Promise<AccessGrant>`

**Example:**
```typescript
const grant = await pdw.permissions.grant(
  'my-app-id',
  ['read:memories'],
  Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
);

console.log(`Access granted: ${grant.id}`);
console.log(`Expires at: ${new Date(grant.expiresAt)}`);
```

---

#### `permissions.revoke(appId, scope)`

Revoke a specific permission scope from an app.

**Parameters:**
- `appId` (string) - Application to revoke from
- `scope` (PermissionScope) - Scope to revoke

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const revoked = await pdw.permissions.revoke('my-app-id', 'write:memories');

if (revoked) {
  console.log('Permission revoked successfully');
}
```

---

#### `permissions.check(appId, scope)`

Check if app has a specific permission.

**Parameters:**
- `appId` (string) - Application to check
- `scope` (PermissionScope) - Scope to check

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const hasAccess = await pdw.permissions.check('my-app-id', 'read:memories');

if (hasAccess) {
  console.log('App has read access to memories');
} else {
  console.log('App does not have access - request permission first');
}
```

---

#### `permissions.list()`

List all active permission grants.

**Parameters:** None

**Returns:** `Promise<AccessGrant[]>`

**Example:**
```typescript
const grants = await pdw.permissions.list();

console.log(`Active grants: ${grants.length}`);
grants.forEach(g => {
  console.log(`  App: ${g.requestingWallet}`);
  console.log(`  Scopes: ${g.scopes.join(', ')}`);
  console.log(`  Expires: ${new Date(g.expiresAt || 0)}`);
});
```

---

#### `permissions.getPendingConsents()`

Get all pending consent requests.

**Parameters:** None

**Returns:** `Promise<ConsentRequestRecord[]>`

**Example:**
```typescript
const pending = await pdw.permissions.getPendingConsents();

console.log(`Pending requests: ${pending.length}`);
pending.forEach(r => {
  console.log(`  From: ${r.requesterWallet}`);
  console.log(`  Purpose: ${r.purpose}`);
  console.log(`  Scopes: ${r.targetScopes.join(', ')}`);
});
```

---

#### `permissions.approve(consentId)`

Approve a pending consent request.

**Parameters:**
- `consentId` (string) - Consent request ID

**Returns:** `Promise<AccessGrant>`

**Example:**
```typescript
const grant = await pdw.permissions.approve('req-123');

console.log(`Access granted to ${grant.requestingWallet}`);
console.log(`Scopes: ${grant.scopes.join(', ')}`);
```

---

#### `permissions.deny(consentId)`

Deny a pending consent request.

**Parameters:**
- `consentId` (string) - Consent request ID

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const denied = await pdw.permissions.deny('req-456');

if (denied) {
  console.log('Consent request denied');
}
```

---

### encryption Namespace

SEAL-based encryption with identity-based access control.

#### `encryption.encrypt(data, threshold?)`

Encrypt data using SEAL (Mysten's encryption SDK).

**Parameters:**
- `data` (Uint8Array) - Data to encrypt
- `threshold` (number, optional) - Min key servers required for decryption (default: 2)

**Returns:** `Promise<{ encryptedData: Uint8Array; backupKey: Uint8Array }>`

**Example:**
```typescript
const data = new TextEncoder().encode('Secret data');

const encrypted = await pdw.encryption.encrypt(data, 2);

console.log(`Encrypted: ${encrypted.encryptedData.length} bytes`);
console.log(`Backup key: ${encrypted.backupKey.length} bytes`);
// Store encrypted.encryptedData to Walrus
// Keep encrypted.backupKey secure
```

---

#### `encryption.decrypt(options)`

Decrypt SEAL-encrypted data.

**Parameters:**
- `options` (object):
  - `encryptedData` (Uint8Array) - Encrypted data
  - `sessionKey` (SessionKey, optional) - SEAL session key
  - `requestingWallet` (string, optional) - Wallet requesting access

**Returns:** `Promise<Uint8Array>` (decrypted data)

**Example:**
```typescript
const decrypted = await pdw.encryption.decrypt({
  encryptedData: encryptedBytes,
  sessionKey: await pdw.encryption.getSessionKey()
});

const text = new TextDecoder().decode(decrypted);
console.log('Decrypted:', text);
```

---

#### `encryption.createSessionKey(signer?)`

Create SEAL session key for encryption operations.

**Parameters:**
- `signer` (optional):
  - `signPersonalMessageFn` - dapp-kit signPersonalMessage function
  - `keypair` - Ed25519Keypair for backend

**Returns:** `Promise<SessionKey>`

**Example:**
```typescript
// Frontend with dapp-kit
import { useSignPersonalMessage } from '@mysten/dapp-kit';

const { mutate: signPersonalMessage } = useSignPersonalMessage();
const sessionKey = await pdw.encryption.createSessionKey({
  signPersonalMessageFn: async (msg) => {
    return new Promise((resolve) => {
      signPersonalMessage({ message: msg }, {
        onSuccess: (result) => resolve(result)
      });
    });
  }
});

// Backend with keypair
const sessionKey = await pdw.encryption.createSessionKey({
  keypair: Ed25519Keypair.fromSecretKey(privateKey)
});
```

---

#### `encryption.getSessionKey()`

Get cached session key or create new one.

**Parameters:** None

**Returns:** `Promise<SessionKey>`

**Example:**
```typescript
const sessionKey = await pdw.encryption.getSessionKey();
console.log('Session key ready');
```

---

#### `encryption.exportSessionKey(sessionKey)`

Export session key for persistence.

**Parameters:**
- `sessionKey` (SessionKey) - Session key to export

**Returns:** `Promise<string>` (serialized key)

**Example:**
```typescript
const sessionKey = await pdw.encryption.getSessionKey();
const exported = await pdw.encryption.exportSessionKey(sessionKey);

// Store in localStorage or secure storage
localStorage.setItem('sealSessionKey', exported);
```

---

#### `encryption.importSessionKey(exportedKey)`

Import previously exported session key.

**Parameters:**
- `exportedKey` (string) - Serialized session key

**Returns:** `Promise<SessionKey>`

**Example:**
```typescript
const exported = localStorage.getItem('sealSessionKey');

if (exported) {
  const sessionKey = await pdw.encryption.importSessionKey(exported);
  console.log('Session key restored');
}
```

---

### index Namespace

HNSW-based vector indexing for fast similarity search.

#### `index.create(spaceId, dimension?, config?)`

Create a new HNSW vector index.

**Parameters:**
- `spaceId` (string) - Index space identifier (e.g., userAddress)
- `dimension` (number, optional) - Vector dimension (default: 768)
- `config` (optional):
  - `maxElements` - Max vectors in index
  - `efConstruction` - Index build quality (higher = better, slower)
  - `m` - Number of connections per layer

**Returns:** `Promise<void>`

**Example:**
```typescript
// Create index for user's vectors (768D for Gemini embeddings)
await pdw.index.create(userAddress, 768, {
  maxElements: 10000,
  efConstruction: 200,
  m: 16
});

console.log('Index created and ready for vectors');
```

---

#### `index.add(spaceId, vectorId, vector, metadata?)`

Add vector to index.

**Parameters:**
- `spaceId` (string) - Index space identifier
- `vectorId` (number) - Unique vector ID
- `vector` (number[]) - Vector array
- `metadata` (optional) - Associated metadata

**Returns:** `Promise<void>`

**Example:**
```typescript
const embedding = await pdw.embeddings.generate('I love TypeScript');

await pdw.index.add(userAddress, 1, embedding, {
  memoryId: 'mem-123',
  category: 'fact',
  topic: 'programming'
});
```

---

#### `index.search(spaceId, queryVector, options?)`

Search vectors using HNSW for fast similarity search.

**Parameters:**
- `spaceId` (string) - Index space identifier
- `queryVector` (number[]) - Query vector
- `options` (optional):
  - `k` - Number of results (default: 10)
  - `threshold` - Minimum similarity threshold
  - `efSearch` - Search quality (higher = better, slower)

**Returns:** `Promise<Array<{ vectorId: number; memoryId: string; similarity: number; distance: number }>>`

**Example:**
```typescript
const queryVec = await pdw.embeddings.generate('TypeScript');

const results = await pdw.index.search(userAddress, queryVec, {
  k: 5,
  threshold: 0.7
});

results.forEach(r => {
  console.log(`Memory: ${r.memoryId}, Similarity: ${r.similarity.toFixed(3)}`);
});
```

---

#### `index.getStats(spaceId)`

Get index statistics.

**Parameters:**
- `spaceId` (string) - Index space identifier

**Returns:** `IndexStats`

**Example:**
```typescript
const stats = pdw.index.getStats(userAddress);

console.log(`Total vectors: ${stats.totalVectors}`);
console.log(`Dimension: ${stats.dimension}`);
console.log(`Current count: ${stats.currentCount}`);
console.log(`Space type: ${stats.spaceType}`);
```

---

#### `index.save(spaceId)`

Save index to Walrus storage.

**Parameters:**
- `spaceId` (string) - Index space identifier

**Returns:** `Promise<string | null>` (blob ID)

**Example:**
```typescript
const blobId = await pdw.index.save(userAddress);

if (blobId) {
  console.log(`Index saved: ${blobId}`);
}
```

---

#### `index.load(spaceId, blobId)`

Load index from Walrus storage.

**Parameters:**
- `spaceId` (string) - Index space identifier
- `blobId` (string) - Blob ID of saved index

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.index.load(userAddress, 'blob-123');
console.log('Index loaded successfully');
```

---

#### `index.clear(spaceId)`

Clear all vectors from index.

**Parameters:**
- `spaceId` (string) - Index space identifier

**Returns:** `void`

**Example:**
```typescript
pdw.index.clear(userAddress);
console.log('Index cleared');
```

---

#### `index.optimize(spaceId)`

Optimize index for better search performance.

**Parameters:**
- `spaceId` (string) - Index space identifier

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.index.optimize(userAddress);
console.log('Index optimized');
```

---

### storage Namespace

Direct Walrus storage operations.

#### `storage.upload(data, metadata?)`

Upload raw data to Walrus.

**Parameters:**
- `data` (Uint8Array) - Data bytes
- `metadata` (optional) - Blob metadata

**Returns:** `Promise<UploadResult>`

**Example:**
```typescript
const data = new TextEncoder().encode('Hello world');
const result = await pdw.storage.upload(data, {
  contentType: 'text/plain',
  category: 'document'
});

console.log(result.blobId);  // Walrus blob ID
```

---

#### `storage.download(blobId)`

Download data from Walrus.

**Parameters:**
- `blobId` (string) - Blob ID

**Returns:** `Promise<Uint8Array>`

**Example:**
```typescript
const data = await pdw.storage.download('blob-123');
const text = new TextDecoder().decode(data);
console.log(text);
```

---

#### `storage.uploadBatch(files[])`

Upload multiple files as batch.

**Parameters:**
- `files` (FileUpload[]) - Array of files:
  - `name` - File name
  - `data` - File bytes
  - `contentType` - MIME type

**Returns:** `Promise<QuiltResult>`

**Example:**
```typescript
const result = await pdw.storage.uploadBatch([
  {
    name: 'doc1.txt',
    data: new TextEncoder().encode('Content 1'),
    contentType: 'text/plain'
  },
  {
    name: 'doc2.txt',
    data: new TextEncoder().encode('Content 2'),
    contentType: 'text/plain'
  }
]);

console.log(result.quiltId);  // Quilt ID
console.log(result.files);    // File mappings
```

---

#### `storage.setMetadata(blobId, metadata)`

Attach metadata to blob.

**Parameters:**
- `blobId` (string) - Blob ID
- `metadata` (object) - Key-value metadata

**Returns:** `Promise<void>`

**Example:**
```typescript
await pdw.storage.setMetadata('blob-123', {
  category: 'document',
  author: 'Alice',
  version: '1.0'
});
```

---

#### `storage.getMetadata(blobId)`

Retrieve blob metadata.

**Parameters:**
- `blobId` (string) - Blob ID

**Returns:** `Promise<BlobMetadata>`

**Example:**
```typescript
const metadata = await pdw.storage.getMetadata('blob-123');
console.log(metadata.category);  // 'document'
console.log(metadata.author);    // 'Alice'
```

---

#### `storage.listBlobs(filter?)`

List user's blobs.

**Parameters:**
- `filter` (optional):
  - `category` - Filter by category
  - `limit` - Max results

**Returns:** `Promise<Array<{ blobId, metadata }>>`

**Example:**
```typescript
const blobs = await pdw.storage.listBlobs({
  category: 'document',
  limit: 50
});

blobs.forEach(b => {
  console.log(`${b.blobId}: ${b.metadata.category}`);
});
```

---

#### `storage.getStats()`

Get storage statistics.

**Parameters:** None

**Returns:** `Promise<StorageStats>`

**Example:**
```typescript
const stats = await pdw.storage.getStats();

console.log(stats.totalBlobs);        // 128
console.log(stats.totalSize);         // Bytes
console.log(stats.blobsByCategory);   // { document: 50, image: 30, ... }
```

---

## Complete Examples

### Example 1: Personal Knowledge Base

```typescript
import { createSimplePDWClient } from 'personal-data-wallet-sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);

const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// Save knowledge
await pdw.memory.create('React hooks enable state in function components', {
  category: 'fact',
  importance: 7,
  topic: 'React'
});

await pdw.memory.create('I prefer TypeScript over JavaScript', {
  category: 'preference',
  importance: 8
});

// Search knowledge
const reactInfo = await pdw.search.vector('How do React hooks work?', {
  limit: 3,
  threshold: 0.7
});

console.log('Relevant knowledge:');
reactInfo.forEach(r => {
  console.log(`- [${r.score.toFixed(2)}] ${r.content}`);
});
```

---

### Example 2: Smart Auto-Categorization

```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

async function smartSave(content: string) {
  // Check if worth saving
  const shouldSave = await pdw.classify.shouldSave(content);
  if (!shouldSave) {
    console.log('Not worth saving');
    return;
  }

  // Auto-categorize
  const category = await pdw.classify.category(content);
  const importance = await pdw.classify.importance(content);

  // Save with auto-detected metadata
  await pdw.memory.create(content, {
    category,
    importance
  });

  console.log(`Saved as ${category} with importance ${importance}`);
}

await smartSave('I prefer dark mode in all apps');
// Saved as preference with importance 6

await smartSave('Emergency contact: 911');
// Saved as contact with importance 10
```

---

### Example 3: Knowledge Graph Discovery

```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// Extract graph from conversation
const text = `
Alice works at Google as a Software Engineer.
She collaborates with Bob and Charlie on React projects.
Google is headquartered in Mountain View, California.
`;

const graph = await pdw.graph.extract(text);

console.log('Entities:', graph.entities.length);
graph.entities.forEach(e => {
  console.log(`- ${e.name} (${e.type})`);
});

console.log('\nRelationships:', graph.relationships.length);
graph.relationships.forEach(r => {
  const source = graph.entities.find(e => e.id === r.source);
  const target = graph.entities.find(e => e.id === r.target);
  console.log(`- ${source?.name} ${r.type} ${target?.name}`);
});

// Query specific entity
const people = await pdw.graph.getEntities({ type: 'PERSON' });
console.log('\nPeople mentioned:', people.map(p => p.name));
```

---

### Example 4: Batch Operations

```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// Batch create memories
const notes = [
  'Meeting notes from Q4 planning',
  'Product roadmap for 2025',
  'Team feedback summary'
];

const memories = await pdw.memory.createBatch(notes, {
  category: 'work',
  importance: 7,
  topic: 'Q4-2024',
  onProgress: (stage, percent) => {
    console.log(`Progress: ${stage} - ${percent}%`);
  }
});

console.log(`Created ${memories.length} work memories`);

// Search across all
const results = await pdw.search.hybrid('Q4 planning', {
  limit: 10
});
```

---

### Example 5: Node.js API Endpoint

```typescript
import { createSimplePDWClient } from 'personal-data-wallet-sdk';
import express from 'express';

const app = express();

// Initialize PDW once
const pdw = await createSimplePDWClient({
  signer: serverKeypair,
  network: 'mainnet',
  geminiApiKey: process.env.GEMINI_API_KEY
});

// API endpoint
app.post('/api/memory/search', async (req, res) => {
  try {
    const { query, limit } = req.body;

    const results = await pdw.search.semantic(query, {
      limit: limit || 10
    });

    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/memory/create', async (req, res) => {
  try {
    const { content } = req.body;

    // Auto-categorize and save
    const category = await pdw.classify.category(content);
    const importance = await pdw.classify.importance(content);

    const memory = await pdw.memory.create(content, {
      category,
      importance
    });

    res.json({ memory });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000);
```

---

## Best Practices

### 1. Initialize Once, Use Everywhere

```typescript
// ✅ GOOD: Initialize at app startup
const pdw = await createSimplePDWClient(config);

export async function saveNote(content: string) {
  return pdw.memory.create(content);
}

// ❌ BAD: Reinitialize every time
export async function saveNote(content: string) {
  const pdw = await createSimplePDWClient(config);  // Slow!
  return pdw.memory.create(content);
}
```

### 2. Use Auto-Classification

```typescript
// ✅ GOOD: Let AI categorize
const category = await pdw.classify.category(content);
await pdw.memory.create(content, { category });

// ❌ MANUAL: Hardcode categories
await pdw.memory.create(content, { category: 'general' });
```

### 3. Handle Progress for Long Operations

```typescript
await pdw.memory.create(longText, {
  onProgress: (stage, percent) => {
    // Update UI, log, or track progress
    console.log(`[${percent}%] ${stage}`);
  }
});
```

### 4. Use Appropriate Search Strategy

```typescript
// Vector: Semantic similarity
const results1 = await pdw.search.vector('TypeScript benefits');

// Semantic: Natural language understanding
const results2 = await pdw.search.semantic('What did I say about my career?');

// Keyword: Exact metadata match
const results3 = await pdw.search.keyword('TypeScript', { fields: ['topic'] });

// Hybrid: Best of both
const results4 = await pdw.search.hybrid('React hooks patterns');
```

### 5. Extract Knowledge Graphs

```typescript
// Extract graph when creating important memories
const memory = await pdw.memory.create(longConversation, {
  category: 'work',
  importance: 8
});

// Get the extracted graph
const context = await pdw.memory.getContext(memory.id, {
  includeGraph: true
});

console.log('Entities:', context.entities);
console.log('Relationships:', context.relationships);
```

---

## Troubleshooting

### "Classifier service not configured"

**Cause:** `geminiApiKey` not provided in config

**Solution:**
```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY  // ← Required for classify.*
});
```

### "Embedding service not configured"

**Cause:** `geminiApiKey` not provided

**Solution:** Same as above - AI features require Gemini API key

### "No wallet connected"

**Cause:** Using WalletAdapter but wallet not connected

**Solution:** Connect wallet first before initializing Simple Client

### Build fails with type errors

**Cause:** TypeScript version mismatch

**Solution:**
```bash
npm install typescript@^5.0.0
npm run build
```

### WASM loading timeout

**Cause:** Slow network or browser restrictions

**Solution:**
```typescript
const pdw = await createSimplePDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY,
  features: {
    enableLocalIndexing: false  // Disable WASM if having issues
  }
});
```

---

## API Summary

### Quick Reference

**Total:** 92 methods across 13 namespaces (64% of PDW SDK)

```typescript
const pdw = await createSimplePDWClient(config);

// Memory (10 methods)
await pdw.memory.create(content, options?)
await pdw.memory.get(id)
await pdw.memory.update(id, updates)
await pdw.memory.delete(id)
await pdw.memory.list(options?)
await pdw.memory.createBatch(contents[], options?)
await pdw.memory.deleteBatch(ids[])
await pdw.memory.getContext(id, options?)
await pdw.memory.getRelated(id, k?)
await pdw.memory.export(options?)

// Search (12 methods)
await pdw.search.vector(query, options?)
await pdw.search.semantic(query, options?)
await pdw.search.keyword(query, options?)
await pdw.search.hybrid(query, options?)
await pdw.search.byCategory(category, options?)
await pdw.search.byDate(dateRange, options?)
await pdw.search.byImportance(min, max, options?)
await pdw.search.advanced(query)
await pdw.search.graph(query, options?)
await pdw.search.withEmbeddings(query, options?)
await pdw.search.multiVector(queries[], options?)
await pdw.search.rerank(results, query, options?)

// Classify (4 methods)
await pdw.classify.shouldSave(content)
await pdw.classify.category(content)
await pdw.classify.patterns(content)
await pdw.classify.importance(content)

// Graph (6 methods)
await pdw.graph.extract(content)
await pdw.graph.query(entityId)
await pdw.graph.traverse(startEntity, options?)
await pdw.graph.getEntities(filter?)
await pdw.graph.getRelationships(filter?)
await pdw.graph.stats()

// Embeddings (4 methods)
await pdw.embeddings.generate(text, options?)
await pdw.embeddings.batch(texts[])
pdw.embeddings.similarity(vector1, vector2)
pdw.embeddings.findSimilar(query, candidates, k?)

// Chat (6 methods)
await pdw.chat.createSession(options?)
await pdw.chat.send(sessionId, message)
await pdw.chat.stream(sessionId, message, callbacks)
await pdw.chat.getSessions()
await pdw.chat.getSession(sessionId)
await pdw.chat.updateTitle(sessionId, title)
await pdw.chat.delete(sessionId)

// Batch (5 methods) ⭐ NEW
await pdw.batch.createMany(contents[], options?)
await pdw.batch.updateMany(updates[])
await pdw.batch.deleteMany(ids[])
await pdw.batch.uploadMany(files[])
pdw.batch.getProgress()

// Cache (6 methods) ⭐ NEW
pdw.cache.get<T>(key)
pdw.cache.set<T>(key, value, ttl?)
pdw.cache.has(key)
pdw.cache.delete(key)
pdw.cache.clear()
pdw.cache.stats()

// Analytics (10 methods) ⭐ NEW
await pdw.analytics.generate(options?)
await pdw.analytics.categories()
await pdw.analytics.trends()
await pdw.analytics.importance()
await pdw.analytics.temporal()
await pdw.analytics.insights()
await pdw.analytics.anomalies()
await pdw.analytics.correlations()
await pdw.analytics.analyze(memoryId)
await pdw.analytics.visualizationData()

// Permissions (8 methods) ⭐ NEW
await pdw.permissions.request(appId, scopes, purpose)
await pdw.permissions.grant(appId, scopes, expiresAt?)
await pdw.permissions.revoke(appId, scope)
await pdw.permissions.check(appId, scope)
await pdw.permissions.list()
await pdw.permissions.getPendingConsents()
await pdw.permissions.approve(consentId)
await pdw.permissions.deny(consentId)

// Encryption (6 methods) ⭐ NEW
await pdw.encryption.encrypt(data, threshold?)
await pdw.encryption.decrypt(options)
await pdw.encryption.createSessionKey(signer?)
await pdw.encryption.getSessionKey()
await pdw.encryption.exportSessionKey(key)
await pdw.encryption.importSessionKey(exported)

// Index (7 methods) ⭐ NEW
await pdw.index.create(spaceId, dimension?, config?)
await pdw.index.add(spaceId, vectorId, vector, metadata?)
await pdw.index.search(spaceId, queryVector, options?)
pdw.index.getStats(spaceId)
await pdw.index.save(spaceId)
await pdw.index.load(spaceId, blobId)
pdw.index.clear(spaceId)
await pdw.index.optimize(spaceId)

// Storage (10 methods)
await pdw.storage.upload(data, metadata?)
await pdw.storage.download(blobId)
await pdw.storage.delete(blobId)
await pdw.storage.uploadBatch(files[])
await pdw.storage.downloadBatch(quiltId)
await pdw.storage.setMetadata(blobId, metadata)
await pdw.storage.getMetadata(blobId)
await pdw.storage.listBlobs(filter?)
await pdw.storage.getStats()
await pdw.storage.cleanup()
```

---

## Learn More

- **GitHub:** https://github.com/CommandOSSLabs/personal-data-wallet
- **Full SDK Docs:** [CLAUDE.md](./CLAUDE.md)
- **AI SDK Integration:** [QUICKSTART-AI-SDK.md](./QUICKSTART-AI-SDK.md)
- **Examples:** `examples/simple-client/`

---

## License

MIT
