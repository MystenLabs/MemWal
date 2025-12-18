# MemWal SDK Architecture

Detailed workflow diagrams and architecture documentation for MemWal (`@cmdoss/memwal`).

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Memory Creation Flow](#memory-creation-flow)
- [Search Flow](#search-flow)
- [Batch Upload (Quilt)](#batch-upload-quilt)
- [HNSW Vector Indexing](#hnsw-vector-indexing)
- [SEAL Encryption Flow](#seal-encryption-flow)
- [API Namespaces](#api-namespaces)

---

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MemWal SDK Architecture                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            SimplePDWClient                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Primary Namespaces                              ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ││
│  │  │ memory   │  │ search   │  │ index    │  │ ai       │  │ graph    │  ││
│  │  │          │  │          │  │          │  │          │  │          │  ││
│  │  │• create  │  │• vector  │  │• add     │  │• embed   │  │• extract │  ││
│  │  │• createBatch│• hybrid  │  │• search  │  │• classify│  │• query   │  ││
│  │  │• get     │  │• byCategory│ │• save    │  │• shouldSave│          │  ││
│  │  │• delete  │  │• semantic│  │• load    │  │          │  │          │  ││
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        Service Container                                ││
│  │  embedding | memoryIndex | storage | tx | encryption | capability      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│   Embedding API     │ │  Sui Blockchain │ │   Walrus Storage    │
│                     │ │                 │ │                     │
│ • OpenRouter        │ │ • Testnet       │ │ • Publisher API     │
│ • Gemini            │ │ • Mainnet       │ │ • Aggregator API    │
│ • 3072 dimensions   │ │ • Package ID    │ │ • Quilt Batching    │
└─────────────────────┘ └─────────────────┘ └─────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│  HNSW Vector Index  │ │  SEAL Encryption│ │  Knowledge Graph    │
│                     │ │                 │ │                     │
│ • hnswlib-node      │ │ • Threshold IBE │ │ • Entity extraction │
│ • hnswlib-wasm      │ │ • 2-of-N decrypt│ │ • Relationships     │
│ • Auto-detect env   │ │ • Mysten SEAL   │ │ • Gemini-powered    │
└─────────────────────┘ └─────────────────┘ └─────────────────────┘
```

---

## Memory Creation Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      MemWal Memory Creation Workflow                        │
└─────────────────────────────────────────────────────────────────────────────┘

User Input: "I am working at CommandOSS as a software engineer"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: AI Pre-check (Optional)                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.shouldSave(content) → true/false                                     │
│                                                                             │
│ • Analyzes content relevance                                                │
│ • Filters noise/spam                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: AI Classification                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.classify(content) → { category, importance, topic, summary }         │
│                                                                             │
│ Output: { category: "fact", importance: 8, topic: "employment" }            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Embedding Generation                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.embed(content) → Float32Array[3072]                                  │
│                                                                             │
│ • OpenRouter or Gemini API                                                  │
│ • 3072 dimensions (text-embedding-3-large)                                  │
│ • Normalized vector for cosine similarity                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Walrus Upload                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Memory Package uploaded to Walrus:                                          │
│ {                                                                           │
│   content: "I am working at CommandOSS...",                                 │
│   embedding: [0.0234, -0.0156, ...],  // 3072 dims                          │
│   metadata: { category, importance, topic },                                │
│   timestamp: 1701705600000,                                                 │
│   identity: "0xb59f00b2454bef14d538b..."                                    │
│ }                                                                           │
│                                                                             │
│ Output: blobId = "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU"              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: On-chain Registration (Sui Blockchain)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ Transaction: memory::create_memory_record                                   │
│                                                                             │
│ Parameters:                                                                 │
│ • blob_id: "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU"                    │
│ • category: "fact"                                                          │
│ • importance: 8                                                             │
│ • content_hash: keccak256(content)                                          │
│                                                                             │
│ Output: MemoryRecord { id: "0x6bce7d4140b7e6572...", owner: "0xb59f..." }   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Local HNSW Indexing                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Auto-detected implementation:                                               │
│ • Node.js: hnswlib-node (native C++, fastest)                               │
│ • Browser: hnswlib-wasm (WebAssembly fallback)                              │
│                                                                             │
│ Index entry (NO content stored for privacy):                                │
│ { memoryId, blobId, category, importance, timestamp, vectorId }             │
│                                                                             │
│ Persistence:                                                                │
│ • Node.js: Filesystem (.pdw-indexes/)                                       │
│ • Browser: IndexedDB                                                        │
│ • Cloud: Optional Walrus backup                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Usage

```typescript
import { SimplePDWClient } from '@cmdoss/memwal';

const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  embedding: { provider: 'openrouter', apiKey: '...' }
});

await pdw.ready();

// Create single memory
const memory = await pdw.memory.create('I work at CommandOSS', {
  category: 'fact',
  importance: 8
});

// Create batch (uses Quilt for ~90% gas savings)
const memories = await pdw.memory.createBatch([
  'Memory 1 content',
  'Memory 2 content',
  'Memory 3 content'
]);
```

---

## Search Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MemWal Search Workflow                             │
└─────────────────────────────────────────────────────────────────────────────┘

Query: "What company do I work for?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Query Embedding                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.embed("What company do I work for?")                                 │
│ Output: Float32Array[3072]                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: HNSW Search (Local Index)                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ Algorithm: Hierarchical Navigable Small World                               │
│ Complexity: O(log n)                                                        │
│                                                                             │
│ Returns top-k nearest neighbors by cosine similarity:                       │
│ ┌────────┬────────────────────────────────────────────┬───────────┐         │
│ │ Rank   │ Memory ID                                  │ Score     │         │
│ ├────────┼────────────────────────────────────────────┼───────────┤         │
│ │ 1      │ 0x6bce7d4140b7e6572df79aa1c8b12abfb...    │ 0.8542    │         │
│ │ 2      │ 0xac333f3c2de375da1fbbee1bdada24ff...     │ 0.7231    │         │
│ │ 3      │ 0xbb7a63c4a7a62d2a0b083bc02ee96593...     │ 0.6890    │         │
│ └────────┴────────────────────────────────────────────┴───────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Content Retrieval (Walrus)                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ For each result, fetch content from Walrus:                                 │
│                                                                             │
│ • Download MemoryPackage from blobId                                        │
│ • Decrypt if encrypted (SEAL)                                               │
│ • Cache locally for subsequent access                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ RESULT                                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ [                                                                           │
│   {                                                                         │
│     id: "0x6bce7d4140b7e6572df79aa1c8b12abfb...",                           │
│     content: "I am working at CommandOSS as a software engineer",           │
│     score: 0.8542,                                                          │
│     category: "fact",                                                       │
│     importance: 8                                                           │
│   },                                                                        │
│   ...                                                                       │
│ ]                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Search Methods

```typescript
// Vector search (semantic)
const results = await pdw.search.vector('work experience', { limit: 5 });

// Filter by category
const facts = await pdw.search.byCategory('fact', { limit: 10 });

// Hybrid search (vector + category filter)
const filtered = await pdw.search.hybrid('work', { category: 'fact' });

// With content fetched
const withContent = await pdw.search.withContent(results);
```

---

## Batch Upload (Quilt)

Walrus Quilt enables batch uploads with ~90% gas savings.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Quilt Batch Upload Flow                              │
└─────────────────────────────────────────────────────────────────────────────┘

Individual Upload:                    Quilt Batch Upload:
┌─────────────┐                       ┌─────────────┐
│ Memory 1    │──► Transaction 1      │ Memory 1    │
└─────────────┘                       │ Memory 2    │──► Single Transaction
┌─────────────┐                       │ Memory 3    │    (Quilt)
│ Memory 2    │──► Transaction 2      │ Memory 4    │
└─────────────┘                       │ Memory 5    │
┌─────────────┐                       └─────────────┘
│ Memory 3    │──► Transaction 3
└─────────────┘                       Gas: 1x base fee
                                      vs
Gas: 3x base fee                      Individual: 5x base fee
                                      Savings: ~90%

Quilt Structure:
┌─────────────────────────────────────────────────────────────────────────────┐
│ quiltId: "abc123..."                                                        │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ quiltPatchId: 1 │ │ quiltPatchId: 2 │ │ quiltPatchId: 3 │                 │
│ │ identifier: m1  │ │ identifier: m2  │ │ identifier: m3  │                 │
│ │ tags: {...}     │ │ tags: {...}     │ │ tags: {...}     │                 │
│ │ content: ...    │ │ content: ...    │ │ content: ...    │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Usage

```typescript
// Batch create memories (automatically uses Quilt)
const results = await pdw.memory.createBatch([
  'First memory content',
  'Second memory content',
  'Third memory content'
]);

// Results include quilt information
results.forEach(r => {
  console.log(`ID: ${r.id}, BlobId: ${r.blobId}`);
});
```

---

## HNSW Vector Indexing

The SDK auto-detects the environment and uses the optimal HNSW implementation.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Environment-Aware HNSW Factory                           │
└─────────────────────────────────────────────────────────────────────────────┘

                    createHnswService()
                            │
              ┌─────────────┴─────────────┐
              │                           │
        isBrowser()?                 isNode()?
              │                           │
              ▼                           ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│  BrowserHnswIndexService│   │    NodeHnswService      │
│  (hnswlib-wasm)         │   │    (hnswlib-node)       │
│                         │   │                         │
│  • WebAssembly          │   │  • Native C++ bindings  │
│  • IndexedDB persistence│   │  • Filesystem persistence│
│  • ~50% slower than node│   │  • Fastest performance  │
│  • Universal fallback   │   │  • Requires build tools │
└─────────────────────────┘   └─────────────────────────┘

Singleton Pattern:
┌─────────────────────────────────────────────────────────────────────────────┐
│ First call: Creates new instance and initializes                            │
│ Subsequent calls: Returns existing singleton                                │
│                                                                             │
│ Benefits:                                                                   │
│ • Prevents redundant index loading                                          │
│ • Shared index across all SDK clients                                       │
│ • Automatic environment detection                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Index Configuration

```typescript
// Default configuration
const indexConfig = {
  dimension: 3072,        // Embedding dimensions
  maxElements: 10000,     // Maximum vectors
  efConstruction: 200,    // Build-time quality
  m: 16,                  // Connections per layer
  spaceType: 'cosine'     // Distance metric
};

// Access via namespace
const stats = await pdw.index.getStats();
// { currentCount: 150, dimension: 3072, maxElements: 10000 }

// Manual save/load
await pdw.index.save();  // Save to Walrus for backup
await pdw.index.load();  // Load from Walrus backup
```

---

## SEAL Encryption Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SEAL Encryption Workflow                            │
└─────────────────────────────────────────────────────────────────────────────┘

                              ENCRYPTION
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Create MemoryCap (On-chain)                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Creates on-chain capability object for key derivation                       │
│                                                                             │
│ MemoryCap {                                                                 │
│   id: "0x05ac7bdc83308ea2cea429afc9fd6bbc91838b...",                        │
│   owner: "0xb59f00b2454bef14d538b...",                                      │
│   nonce: [random 32 bytes]  ← Used for key derivation                       │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: SEAL Encrypt                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Identity-Based Encryption (IBE)                                           │
│ • Threshold: 2 of N key servers must agree                                  │
│ • Key servers: Mysten Labs operated                                         │
│                                                                             │
│ Output: { encryptedObject, keyId, nonce }                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                          Upload to Walrus
                                  │
                              DECRYPTION
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Request Decryption Key                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Build seal_approve transaction with MemoryCap                            │
│ 2. Key servers verify:                                                      │
│    • Caller owns the MemoryCap                                              │
│    • key_id matches MemoryCap's derived key                                 │
│ 3. If verified, key servers release decryption shares                       │
│ 4. Combine shares (threshold) to decrypt                                    │
│                                                                             │
│ Output: Decrypted content                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## API Namespaces

### Primary Namespaces

| Namespace | Methods | Description |
|-----------|---------|-------------|
| `pdw.memory` | create, createBatch, get, delete, list | Memory CRUD operations |
| `pdw.search` | vector, hybrid, byCategory, semantic | Search operations |
| `pdw.index` | add, search, save, load, getStats | HNSW index management |
| `pdw.ai` | embed, classify, shouldSave | AI/embedding operations |
| `pdw.graph` | extract, query | Knowledge graph |

### Supporting Namespaces

| Namespace | Methods | Description |
|-----------|---------|-------------|
| `pdw.encryption` | encrypt, decrypt | SEAL encryption |
| `pdw.capability` | create, verify | Capability management |
| `pdw.storage` | upload, download | Walrus storage |
| `pdw.wallet` | getAddress, getBalance | Wallet operations |
| `pdw.tx` | build, execute | Transaction building |

---

## Related Documentation

- [README.md](./README.md) - Quick start guide
- [BENCHMARKS.md](./BENCHMARKS.md) - Performance metrics
- [CHANGELOG.md](./CHANGELOG.md) - Version history
