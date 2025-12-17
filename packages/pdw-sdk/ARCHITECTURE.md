# PDW SDK Architecture

Detailed workflow diagrams and architecture documentation for the Personal Data Wallet SDK.

## Table of Contents

- [Memory Creation Flow](#memory-creation-flow)
- [Search Flow](#search-flow)
- [SEAL Encryption Flow](#seal-encryption-flow)
- [Architecture Overview](#architecture-overview)
- [Consolidated Namespaces](#consolidated-namespaces)
- [Index Persistence (Hybrid Pattern)](#index-persistence-hybrid-pattern)

---

## Memory Creation Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PDW Memory Creation Workflow                        │
└─────────────────────────────────────────────────────────────────────────────┘

User Input: "I am working at CommandOSS as a software engineer"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: AI Pre-check (Optional but Recommended)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.shouldSave(content) ──► true/false                                   │
│                                                                             │
│ • Analyzes content relevance                                                │
│ • Filters noise/spam                                                        │
│ • Returns: true (save) or false (skip)                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                          (if shouldSave = true)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: AI Classification                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Gemini API (text-embedding-004)                                             │
│                                                                             │
│ Input:  "I am working at CommandOSS as a software engineer"                 │
│ Output: {                                                                   │
│   category: "fact",                                                         │
│   importance: 8,                                                            │
│   topic: "employment",                                                      │
│   summary: "User works at CommandOSS as software engineer"                  │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Embedding Generation                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ Gemini API (text-embedding-004)                                             │
│                                                                             │
│ Input:  "I am working at CommandOSS as a software engineer"                 │
│ Output: Float32Array[768] = [0.0234, -0.0156, 0.0891, ...]                   │
│                                                                             │
│ • 768 dimensions                                                            │
│ • Normalized vector                                                         │
│ • Used for semantic search                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Knowledge Graph Extraction                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│ Gemini API (gemini-1.5-flash)                                               │
│                                                                             │
│ Entities:                                                                   │
│ ┌──────────────┬──────────────┬────────────┐                                │
│ │ ID           │ Type         │ Confidence │                                │
│ ├──────────────┼──────────────┼────────────┤                                │
│ │ user         │ person       │ 1.0        │                                │
│ │ commandoss   │ organization │ 1.0        │                                │
│ │ software_eng │ concept      │ 0.95       │                                │
│ └──────────────┴──────────────┴────────────┘                                │
│                                                                             │
│ Relationships:                                                              │
│ ┌──────────┬─────────────┬────────────┐                                     │
│ │ Source   │ Target      │ Type       │                                     │
│ ├──────────┼─────────────┼────────────┤                                     │
│ │ user     │ commandoss  │ works_at   │                                     │
│ │ user     │ software_eng│ occupation │                                     │
│ └──────────┴─────────────┴────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Walrus Upload                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Walrus Publisher (https://publisher.walrus-testnet.walrus.space)            │
│                                                                             │
│ Memory Package:                                                             │
│ {                                                                           │
│   content: "I am working at CommandOSS...",                                 │
│   embedding: [0.0234, -0.0156, ...],                                        │
│   metadata: {                                                               │
│     category: "fact",                                                       │
│     importance: 8,                                                          │
│     topic: "employment",                                                    │
│     entities: [...],                                                        │
│     relationships: [...]                                                    │
│   },                                                                        │
│   timestamp: 1701705600000,                                                 │
│   identity: "0xb59f00b2454bef14d538b..."                                    │
│ }                                                                           │
│                                                                             │
│ Output: blobId = "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU"              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: On-chain Registration (Sui Blockchain)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ Transaction: memory::create_memory_record                                   │
│                                                                             │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Move Call Parameters:                                                   │ │
│ │ • index_id: 0xc42287aeec73b7c3350753e3aab52ce59e2234c9566c38eb0e...     │ │
│ │ • blob_id: "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU"               │ │
│ │ • category: "fact"                                                      │ │
│ │ • topic: "employment"                                                   │ │
│ │ • importance: 8                                                         │ │
│ │ • content_hash: keccak256(content)                                      │ │
│ │ • content_size: 52                                                      │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Output: MemoryRecord {                                                      │
│   id: "0x6bce7d4140b7e6572df79aa1c8b12abfb6965268fe3186e5a1b2434163279a6a", │
│   owner: "0xb59f00b2454bef14d538b3609fb99e32fcf17f96ce7a4195d145ca67b1c93e07"│
│ }                                                                           │
│                                                                             │
│ • Auto-retry on version conflict (up to 3 attempts)                         │
│ • Gas estimation before execution                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 7: Local HNSW Indexing                                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ hnswlib-wasm (WebAssembly)                                                  │
│                                                                             │
│ Index Parameters:                                                           │
│ • Max elements: 10,000                                                      │
│ • Dimensions: 768                                                           │
│ • M: 16 (connections per layer)                                             │
│ • efConstruction: 200                                                       │
│                                                                             │
│ Stored Metadata (NO content for privacy):                                   │
│ {                                                                           │
│   memoryId: "0x6bce7d4140b7e6572df79aa1c8b12abfb6965268...",                │
│   blobId: "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU",                    │
│   category: "fact",                                                         │
│   importance: 8,                                                            │
│   timestamp: 1701705600000                                                  │
│ }                                                                           │
│                                                                             │
│ • Persisted to IndexedDB (browser)                                          │
│ • Can be saved to Walrus for cross-device sync                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ RESULT                                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ {                                                                           │
│   id: "0x6bce7d4140b7e6572df79aa1c8b12abfb6965268fe3186e5a1b2434163279a6a", │
│   blobId: "KEG_kj_5nx8wr3eJFZwIkJtjKvEGaUNMvTvhDYddaPU",                    │
│   embedding: [0.0234, -0.0156, ...],  // 768 dimensions                     │
│   category: "fact",                                                         │
│   importance: 8,                                                            │
│   topic: "employment",                                                      │
│   entities: [...],                                                          │
│   relationships: [...]                                                      │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Search Flow

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PDW Search Workflow                               │
└─────────────────────────────────────────────────────────────────────────────┘

Query: "What company do I work for?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Query Embedding                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.ai.embed("What company do I work for?")                                 │
│ Output: Float32Array[768] = [0.0123, -0.0456, ...]                           │
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
│ pdw.storage.download(blobId) ──► MemoryPackage                              │
│                                                                             │
│ • Decrypted if encrypted (SEAL)                                             │
│ • Cached locally for subsequent access                                      │
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
│ pdw.security.context.create('MY_APP')                                       │
│                                                                             │
│ Creates on-chain object:                                                    │
│ MemoryCap {                                                                 │
│   id: "0x05ac7bdc83308ea2cea429afc9fd6bbc91838b013f60e07cd24f3518b6d4b09d", │
│   owner: "0xb59f00b2454bef14d538b...",                                      │
│   app_id: "MY_APP",                                                         │
│   nonce: [random 32 bytes]  ◄── Used for key derivation                     │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Compute Key ID                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ key_id = keccak256(owner_address || nonce)                                  │
│                                                                             │
│ • Deterministic: same owner + nonce = same key_id                           │
│ • Only owner can derive this key_id                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: SEAL Encrypt                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.security.encrypt(data, threshold=2)                                     │
│                                                                             │
│ • Identity-Based Encryption (IBE)                                           │
│ • Threshold: 2 of N key servers must agree                                  │
│ • Key servers: Mysten Labs operated (testnet)                               │
│                                                                             │
│ Output: {                                                                   │
│   encryptedObject: Uint8Array[...],                                         │
│   keyId: Uint8Array[32],                                                    │
│   nonce: Uint8Array[32]                                                     │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                          Upload to Walrus
                                  │
                                  │
                              DECRYPTION
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Request Decryption Key                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ pdw.security.decrypt({ encryptedContent, memoryCapId, keyId })              │
│                                                                             │
│ 1. Build seal_approve transaction with MemoryCap                            │
│ 2. Key servers verify:                                                      │
│    • Caller owns the MemoryCap                                              │
│    • key_id matches MemoryCap's derived key                                 │
│ 3. If verified, key servers release decryption shares                       │
│ 4. Combine shares (threshold) to decrypt                                    │
│                                                                             │
│ Output: Uint8Array (decrypted data)                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PDW SDK Architecture                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            SimplePDWClient                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     Consolidated Namespaces                             ││
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────┐              ││
│  │  │ pdw.ai   │  │pdw.security│ │pdw.blockchain│ │pdw.storage│            ││
│  │  │          │  │          │  │            │  │          │              ││
│  │  │• embed   │  │• encrypt │  │• tx.build  │  │• upload  │              ││
│  │  │• classify│  │• decrypt │  │• tx.execute│  │• download│              ││
│  │  │• chat.*  │  │• context │  │• wallet.*  │  │• cache.* │              ││
│  │  └──────────┘  └──────────┘  └────────────┘  └──────────┘              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                       Legacy Namespaces                                 ││
│  │  memory | search | embeddings | classify | graph | encryption | ...    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│   Gemini AI API     │ │  Sui Blockchain │ │   Walrus Storage    │
│                     │ │                 │ │                     │
│ • text-embedding-004│ │ • Testnet       │ │ • Publisher API     │
│ • gemini-1.5-flash  │ │ • Mainnet       │ │ • Aggregator API    │
│ • 768 dimensions    │ │ • Package ID    │ │ • Blob storage      │
└─────────────────────┘ └─────────────────┘ └─────────────────────┘
                                    │
                                    ▼
                        ┌─────────────────────┐
                        │  SEAL Key Servers   │
                        │                     │
                        │ • Threshold IBE     │
                        │ • 2-of-N decryption │
                        │ • Mysten operated   │
                        └─────────────────────┘
```

---

## Consolidated Namespaces

The SDK consolidates 18 legacy namespaces into 4 primary namespaces for a cleaner API:

### Namespace Mapping

| Consolidated | Merged From | Primary Methods |
|--------------|-------------|-----------------|
| `pdw.ai` | embeddings, classify, chat | embed, embedBatch, classify, shouldSave, chat.send |
| `pdw.security` | encryption, permissions, context, capability | encrypt, decrypt, context.create, permissions.grant |
| `pdw.blockchain` | tx, wallet | tx.build, tx.execute, wallet.getAddress, wallet.getBalance |
| `pdw.storage` | storage, cache | upload, download, cache.get, cache.set |

### Before vs After

```typescript
// Before (legacy namespaces)
await pdw.embeddings.generate(text);
await pdw.classify.category(text);
await pdw.encryption.encrypt(data);
await pdw.context.create(appId);

// After (consolidated namespaces)
await pdw.ai.embed(text);
await pdw.ai.classify(text);
await pdw.security.encrypt(data);
await pdw.security.context.create(appId);
```

---

## Data Flow Summary

```text
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  User    │───►│   AI     │───►│  Storage │───►│  Chain   │
│  Input   │    │ Services │    │ (Walrus) │    │  (Sui)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     │          ┌────┴────┐          │               │
     │          │         │          │               │
     │      Embedding  Classify      │               │
     │      Generation  + KG         │               │
     │          │         │          │               │
     │          └────┬────┘          │               │
     │               │               │               │
     │               ▼               │               │
     │        ┌──────────┐           │               │
     │        │  HNSW    │           │               │
     │        │  Index   │◄──────────┼───────────────┤
     │        └──────────┘           │               │
     │               │               │               │
     └───────────────┴───────────────┴───────────────┘
                     │
                     ▼
              Search Results
```

---

## Index Persistence (Hybrid Pattern)

The SDK uses a hybrid persistence strategy for the HNSW index to balance performance and reliability.

### The Problem

HNSW index exists only in memory (WebAssembly). When the browser tab closes, the index is lost and must be rebuilt - which is slow for large memory sets.

### Hybrid Solution

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Hybrid Index Persistence Strategy                       │
└─────────────────────────────────────────────────────────────────────────────┘

              App Start
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Check localStorage for IndexState                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ IndexState: {                                                               │
│   blobId: "fdSmZpsA1UzBw2TrtFeHDZsdfbFH1NaqQHT61pmt4ko",                    │
│   lastSyncTimestamp: 1733628900000,                                         │
│   vectorCount: 150,                                                         │
│   version: 3                                                                │
│ }                                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
   Cache Found         No Cache
        │                   │
        ▼                   ▼
┌───────────────────┐   ┌───────────────────────────────────────────────────┐
│ OPTION 2: Fast    │   │ OPTION 1: Full Rebuild (Fallback)                 │
│ Cache Restore     │   ├───────────────────────────────────────────────────┤
├───────────────────┤   │ 1. Query blockchain for all user memories         │
│ 1. Download from  │   │ 2. For each memory:                               │
│    Walrus (~500ms)│   │    - Download from Walrus                         │
│ 2. Parse JSON     │   │    - Parse embedding                              │
│ 3. Restore vectors│   │    - Add to HNSW index                            │
│    to HNSW        │   │ 3. Time: O(n) where n = memory count              │
└───────────────────┘   └───────────────────────────────────────────────────┘
        │                   │
        └─────────┬─────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Incremental Sync                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Compare lastSyncTimestamp with blockchain data:                             │
│                                                                             │
│ for each memory where createdAt > lastSyncTimestamp:                        │
│   • Download content from Walrus                                            │
│   • Generate/extract embedding                                              │
│   • Add to HNSW index                                                       │
│                                                                             │
│ Time: O(k) where k = new memories since last sync                           │
└─────────────────────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Auto-save (Every 5 minutes or on significant changes)               │
├─────────────────────────────────────────────────────────────────────────────┤
│ SerializedIndexPackage: {                                                   │
│   formatVersion: "1.0",                                                     │
│   vectors: [{ vectorId: 1, vector: [...768 floats...] }, ...],             │
│   metadata: [[1, { category: "fact", ... }], ...],                          │
│   hnswConfig: { maxElements: 10000, m: 16, efConstruction: 200 }           │
│ }                                                                           │
│                                                                             │
│ ──► Upload to Walrus ──► Update IndexState in localStorage                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Usage

```typescript
// Initialize with hybrid restore
const pdw = await createPDWClient({
  signer: keypair,
  network: 'testnet',
  geminiApiKey: process.env.GEMINI_API_KEY,
  features: { enableLocalIndexing: true }
});

await pdw.ready();

// Initialize index with progress callback
const result = await pdw.initializeIndex({
  onProgress: (stage, progress, message) => {
    console.log(`[${stage}] ${progress}% - ${message}`);
  },
  forceRebuild: false  // Set to true to skip cache
});

console.log(`Index ready: ${result.vectorCount} vectors (${result.method})`);
// Output: Index ready: 150 vectors (cache)

// Manually save index
const blobId = await pdw.saveIndex();

// Get index stats
const stats = pdw.getIndexStats();
// { indexState: {...}, vectorCacheSize: 150, isAutoSaveEnabled: true }
```

### Performance Comparison

| Method | 100 memories | 1000 memories | 10000 memories |
|--------|-------------|---------------|----------------|
| Cache Restore | ~500ms | ~800ms | ~2s |
| Full Rebuild | ~30s | ~5min | ~50min |

---

## Related Documentation

- [README.md](./README.md) - Quick start and API reference
- [BENCHMARKS.md](./BENCHMARKS.md) - Performance metrics and benchmarks
