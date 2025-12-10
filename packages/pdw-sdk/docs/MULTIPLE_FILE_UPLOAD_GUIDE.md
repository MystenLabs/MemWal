# Multiple File Upload & Metadata Management Guide

## 📚 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Metadata Management](#metadata-management)
4. [How It Works](#how-it-works)
5. [Code Examples](#code-examples)
6. [API Reference](#api-reference)
7. [Performance & Gas Savings](#performance--gas-savings)
8. [Best Practices](#best-practices)

---

## Overview

The Personal Data Wallet SDK provides **efficient batch upload** functionality for multiple files using **Walrus Quilts**. This approach offers:

- ✅ **~90% gas savings** (1 transaction vs N transactions)
- ✅ **Per-file metadata** (plaintext tags for filtering)
- ✅ **SEAL encryption** (content remains private)
- ✅ **Tag-based querying** (search without decryption)
- ✅ **Atomic operations** (all files succeed or fail together)

---

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                   BATCH UPLOAD ARCHITECTURE                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  StorageService (Main API)                                  │
│         ↓                                                    │
│  QuiltBatchManager (Batch Operations)                       │
│         ↓                                                    │
│  WalrusClient.writeFiles() (Single Transaction)             │
│         ↓                                                    │
│  Walrus Quilt (Distributed Storage)                         │
│                                                              │
│  Result: quiltId + [blobId1, blobId2, ...]                  │
└─────────────────────────────────────────────────────────────┘
```

### Key Classes

| Class | Location | Purpose |
|-------|----------|---------|
| `QuiltBatchManager` | `src/services/storage/QuiltBatchManager.ts` | Handles batch operations |
| `StorageService` | `src/services/StorageService.ts` | Main storage API (delegates to managers) |
| `useCreateMemoryBatch` | `src/hooks/useCreateMemoryBatch.ts` | React hook for batch uploads |
| `BatchManager` | `src/batch/BatchManager.ts` | Orchestrates embedding/indexing/storage |

---

## Metadata Management

### Two-Tier Metadata System

Each file in a batch has **two types of metadata**:

#### 1. **Plaintext Tags** (Searchable)

Stored at Walrus level, allows filtering **WITHOUT decryption**.

```typescript
{
  // Core metadata
  'category': 'work',                    // User-defined category
  'importance': '8',                     // AI-extracted (1-10)
  'topic': 'Q4 Planning',                // AI-extracted topic
  'summary': 'Meeting about roadmap',    // AI-generated summary

  // Timestamps
  'timestamp': '2025-01-15T10:30:00Z',   // Creation timestamp
  'created_at': '2025-01-15T10:30:00Z',  // Same as timestamp

  // Security metadata
  'encrypted': 'true',                   // Content is encrypted
  'encryption_type': 'seal',             // SEAL IBE encryption

  // Ownership
  'owner': '0x1234...5678',              // Sui address of owner

  // Technical metadata
  'embedding_dimensions': '768'          // Vector dimensions
}
```

**Benefits:**
- ✅ Filter by category, importance, topic without decryption
- ✅ Query by date ranges
- ✅ Find files by owner
- ✅ Check encryption status

#### 2. **Encrypted Content** (Private)

Stored as `Uint8Array`, requires SEAL decryption to access.

```typescript
{
  encryptedContent: Uint8Array,  // SEAL encrypted data
  backupKey: Uint8Array          // Symmetric key for disaster recovery
}
```

**Security:**
- 🔐 Content encrypted with Identity-Based Encryption (IBE)
- 🔐 Only authorized users can decrypt (via session keys)
- 🔐 Access control enforced on-chain (via `seal_approve` functions)

#### 3. **Optional: On-Chain Blob Attributes**

Additional metadata stored as Sui object dynamic fields.

```typescript
await storageService.setBlobAttributes(
  blobObjectId,
  {
    'memory_category': 'work',
    'memory_vector_id': 'vector-abc123',
    'memory_embedding_blob_id': '0xabcd...ef01',
    'memory_graph_blob_id': '0x1234...5678'
  },
  signer
);
```

**Query Example:**
```typescript
const memories = await storageService.queryMemoriesByAttributes(
  { 'memory_category': 'work' },
  ownerAddress,
  limit
);
```

---

## How It Works

### Complete Upload Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ INPUT: Multiple Memories                                         │
│   ├─ Memory 1: { content: "...", category: "work" }             │
│   ├─ Memory 2: { content: "...", category: "personal" }         │
│   └─ Memory 3: { content: "...", category: "health" }           │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 1: AI Metadata Extraction (Batch)                         │
│ ──────────────────────────────────────────────────────────────── │
│ Service: GeminiAIService.extractRichMetadataBatch()             │
│ Time:    ~500ms (entire batch)                                  │
│                                                                  │
│ For each memory → { importance, topic, summary, category }      │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 2: Per-Memory Processing (Sequential)                     │
│ ──────────────────────────────────────────────────────────────── │
│ For Memory[i]:                                                   │
│                                                                  │
│   [A] Generate Embedding                                        │
│       • EmbeddingService.embedText()                            │
│       • Time: ~200ms per memory                                 │
│       • Output: 768D vector                                     │
│                                                                  │
│   [B] Encrypt Content                                           │
│       • EncryptionService.encrypt()                             │
│       • Time: ~50ms per memory                                  │
│       • Output: Uint8Array (SEAL encrypted)                     │
│                                                                  │
│   [C] Collect → processedMemories[]                             │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 3: Create WalrusFiles                                     │
│ ──────────────────────────────────────────────────────────────── │
│ For each processed memory:                                      │
│                                                                  │
│   WalrusFile.from({                                             │
│     identifier: "memory-{timestamp}-{index}-{random}.json",     │
│     contents: encryptedContent,      // Uint8Array              │
│     tags: { ...plaintextMetadata }   // Searchable tags         │
│   })                                                            │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 4: Batch Upload to Walrus (Quilt)                        │
│ ──────────────────────────────────────────────────────────────── │
│ API: walrusClient.writeFiles()                                  │
│ Time: ~300ms for entire batch                                   │
│ Gas: 1 Sui transaction (vs N individual)                        │
│                                                                  │
│ Result:                                                          │
│   ├─ quiltId: "0xabcd...ef01"       // Shared ID               │
│   ├─ files: [{ blobId }, { blobId }] // Individual IDs         │
│   └─ uploadTimeMs: 1847                                         │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ OUTPUT: Batch Upload Result                                     │
│ ──────────────────────────────────────────────────────────────── │
│ {                                                                │
│   quiltId: "0xabcd...ef01",                                     │
│   files: [                                                       │
│     { identifier: "...", blobId: "0x1234..." },                 │
│     { identifier: "...", blobId: "0x5678..." }                  │
│   ],                                                             │
│   uploadTimeMs: 1847,                                           │
│   memoriesCreated: 3                                            │
│ }                                                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Examples

### Example 1: Basic Batch Upload (TypeScript)

```typescript
import { StorageService } from 'personal-data-wallet-sdk';
import { EmbeddingService } from 'personal-data-wallet-sdk';
import { EncryptionService } from 'personal-data-wallet-sdk';

// Initialize services
const storageService = new StorageService({
  packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  network: 'testnet'
});

const embeddingService = new EmbeddingService({
  apiKey: process.env.GEMINI_API_KEY!,
  model: 'text-embedding-004',
  dimensions: 768
});

const encryptionService = new EncryptionService(suiClient, {
  packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
  network: 'testnet'
});

// Prepare memories
const memories = [
  { content: 'Meeting notes...', category: 'work' },
  { content: 'Workout log...', category: 'health' },
  { content: 'Book notes...', category: 'education' }
];

// Process each memory
const processedMemories = await Promise.all(
  memories.map(async (memory) => {
    // Generate embedding
    const embeddingResult = await embeddingService.embedText({
      text: memory.content,
      taskType: 'RETRIEVAL_DOCUMENT'
    });

    // Encrypt content
    const encryptionResult = await encryptionService.encrypt(
      new TextEncoder().encode(memory.content),
      userAddress
    );

    return {
      content: memory.content,
      category: memory.category,
      importance: 7,
      topic: memory.category,
      embedding: embeddingResult.vector,
      encryptedContent: encryptionResult.encryptedObject,
      summary: memory.content.substring(0, 100)
    };
  })
);

// Upload as batch
const result = await storageService.uploadMemoryBatch(
  processedMemories,
  {
    signer: signer,
    epochs: 5,
    userAddress: account.address
  }
);

console.log('Batch uploaded!');
console.log('Quilt ID:', result.quiltId);
console.log('Files:', result.files.length);
console.log('Time:', result.uploadTimeMs, 'ms');
```

### Example 2: React Hook Usage

```tsx
import { useCreateMemoryBatch } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useState } from 'react';

function BatchUploader() {
  const account = useCurrentAccount();
  const [memories, setMemories] = useState([
    { content: 'Memory 1', category: 'work' },
    { content: 'Memory 2', category: 'personal' },
    { content: 'Memory 3', category: 'health' }
  ]);

  const {
    mutate: createBatch,
    isPending,
    progress,
    data,
    error
  } = useCreateMemoryBatch({
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    onSuccess: (result) => {
      console.log(`✅ Created ${result.memoriesCreated} memories`);
      console.log(`   Quilt ID: ${result.quiltId}`);
      console.log(`   Upload time: ${result.uploadTimeMs}ms`);
    },
    onProgress: (progress) => {
      console.log(`${progress.message} (${progress.percent}%)`);
    }
  });

  return (
    <div>
      <h2>Batch Memory Upload</h2>

      {/* Progress */}
      {isPending && progress && (
        <div className="progress-container">
          <div
            className="progress-bar"
            style={{ width: `${progress.percent}%` }}
          />
          <p>{progress.message}</p>
          <p>
            Processing: {progress.current}/{progress.total}
          </p>
        </div>
      )}

      {/* Upload button */}
      <button
        onClick={() => createBatch({ memories })}
        disabled={isPending || !account}
      >
        {isPending
          ? `Uploading... ${progress?.percent || 0}%`
          : `Upload ${memories.length} Memories`}
      </button>

      {/* Results */}
      {data && (
        <div className="success">
          <h3>✅ Upload Successful!</h3>
          <p>Quilt ID: {data.quiltId}</p>
          <p>Files: {data.files.length}</p>
          <p>Time: {data.uploadTimeMs}ms</p>
          <p>Gas Saved: ~{((1 - 1 / data.files.length) * 100).toFixed(0)}%</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="error">
          <h3>❌ Upload Failed</h3>
          <p>{error.message}</p>
        </div>
      )}
    </div>
  );
}
```

### Example 3: Tag-Based Querying

```typescript
// Get all files from a Quilt
const allFiles = await storageService.getQuiltFiles(quiltId);
console.log(`Retrieved ${allFiles.length} files`);

// Filter by tags (client-side)
const workFiles = await storageService.getQuiltFilesByTags(
  quiltId,
  [{ category: 'work' }]
);
console.log(`Found ${workFiles.length} work files`);

// Filter by importance (custom logic)
const importantFiles = allFiles.filter(file => {
  const importance = parseInt(file.tags?.['importance'] || '0');
  return importance >= 7;
});

// Filter by date range
const recentFiles = allFiles.filter(file => {
  const timestamp = new Date(file.tags?.['timestamp'] || 0);
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return timestamp > oneWeekAgo;
});
```

### Example 4: Retrieve and Decrypt Files

```typescript
import { SealClient } from '@mysten/seal';

// Initialize SEAL client
const sealClient = await SealClient.new(
  SEAL_OBJECT_IDS,
  suiClient,
  'testnet'
);

// Create session key
const sessionKey = await SessionKey.create({
  address: userAddress,
  packageId: fromHEX(packageId),
  ttlMin: 10,
  suiClient
});

// Get personal message and sign
const message = sessionKey.getPersonalMessage();
const { signature } = await keypair.signPersonalMessage(message);
sessionKey.setPersonalMessageSignature(signature);

// Retrieve and decrypt file
const file = await storageService.getQuiltFiles(quiltId);
const encryptedData = file[0].contents;

// Prepare PTB for seal_approve
const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::module::seal_approve`,
  arguments: [tx.pure.vector('u8', identity)]
});
const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

// Decrypt
const decryptedBytes = await sealClient.decrypt({
  data: encryptedData,
  sessionKey,
  txBytes
});

const decryptedContent = new TextDecoder().decode(decryptedBytes);
console.log('Decrypted:', decryptedContent);
```

---

## API Reference

### `uploadMemoryBatch()`

Upload multiple memories in a single Quilt.

```typescript
async uploadMemoryBatch(
  memories: Array<{
    content: string;
    category: string;
    importance: number;
    topic: string;
    embedding: number[];
    encryptedContent: Uint8Array;
    summary?: string;
  }>,
  options: {
    signer: Signer;
    epochs?: number;
    userAddress: string;
  }
): Promise<{
  quiltId: string;
  files: Array<{ identifier: string; blobId: string }>;
  uploadTimeMs: number;
}>
```

**Parameters:**
- `memories`: Array of processed memories (already embedded and encrypted)
- `options.signer`: Sui transaction signer
- `options.epochs`: Storage duration in Walrus epochs (default: 3)
- `options.userAddress`: Owner's Sui address

**Returns:**
- `quiltId`: Shared ID for all files in the batch
- `files`: Array of file identifiers and blob IDs
- `uploadTimeMs`: Upload duration in milliseconds

### `getQuiltFiles()`

Retrieve all files from a Quilt.

```typescript
async getQuiltFiles(quiltId: string): Promise<Array<WalrusFile>>
```

**Parameters:**
- `quiltId`: The Quilt ID returned from `uploadMemoryBatch()`

**Returns:**
- Array of `WalrusFile` objects with content and tags

### `getQuiltFilesByTags()`

Query files by tags (client-side filtering).

```typescript
async getQuiltFilesByTags(
  quiltId: string,
  tagFilters: Array<Record<string, string>>
): Promise<Array<WalrusFile>>
```

**Parameters:**
- `quiltId`: The Quilt ID
- `tagFilters`: Array of tag filters (e.g., `[{ category: 'work' }]`)

**Returns:**
- Array of matching `WalrusFile` objects

### `useCreateMemoryBatch()`

React hook for batch memory creation.

```typescript
function useCreateMemoryBatch(
  options: UseCreateMemoryBatchOptions
): UseCreateMemoryBatchReturn
```

**Options:**
```typescript
interface UseCreateMemoryBatchOptions {
  geminiApiKey: string;
  onSuccess?: (result: CreateMemoryBatchResult) => void;
  onError?: (error: Error) => void;
  onProgress?: (progress: CreateMemoryBatchProgress) => void;
  config?: MemoryManagerConfig;
  invalidateQueries?: boolean;
}
```

**Returns:**
```typescript
interface UseCreateMemoryBatchReturn {
  mutate: (input: CreateMemoryBatchInput) => void;
  mutateAsync: (input: CreateMemoryBatchInput) => Promise<CreateMemoryBatchResult>;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data?: CreateMemoryBatchResult;
  error: Error | null;
  progress?: CreateMemoryBatchProgress;
  reset: () => void;
}
```

**Progress Stages:**
- `preparing`: Preparing batch operation
- `processing`: Generating embeddings
- `encrypting`: Encrypting content
- `uploading`: Uploading to Walrus
- `success`: Batch created successfully
- `error`: Upload failed

---

## Performance & Gas Savings

### Time Breakdown (3 memories)

| Stage | Individual | Batch | Improvement |
|-------|-----------|-------|-------------|
| AI Metadata | 3 × 300ms = 900ms | 500ms | 44% faster |
| Embeddings | 3 × 200ms = 600ms | 600ms | Same |
| Encryption | 3 × 50ms = 150ms | 150ms | Same |
| Walrus Upload | 3 × 300ms = 900ms | 300ms | **67% faster** |
| **Total** | **~2.5 seconds** | **~1.5 seconds** | **40% faster** |

### Gas Savings

| Files | Individual Txs | Batch Txs | Gas Saved |
|-------|---------------|-----------|-----------|
| 3 | 3 | 1 | ~67% |
| 5 | 5 | 1 | ~80% |
| 10 | 10 | 1 | ~90% |
| 20 | 20 | 1 | ~95% |

**Formula**: Gas Saved = `((N - 1) / N) × 100%`

### Practical Limits

- **Recommended**: 5-15 files per batch
- **Maximum**: ~20 files (depends on content size)
- **Memory Usage**: ~5-10MB per batch (in browser)

---

## Best Practices

### 1. **Optimal Batch Sizes**

```typescript
// ✅ GOOD: 5-15 files per batch
const batch = memories.slice(0, 10);
await uploadMemoryBatch(batch, options);

// ❌ AVOID: Too many files (memory issues)
const hugeBatch = memories.slice(0, 100); // May cause OOM
```

### 2. **Error Handling**

```typescript
try {
  const result = await storageService.uploadMemoryBatch(memories, options);
  console.log('Success:', result.quiltId);
} catch (error) {
  console.error('Batch upload failed:', error);

  // Retry with smaller batch
  const halfSize = Math.floor(memories.length / 2);
  await uploadMemoryBatch(memories.slice(0, halfSize), options);
  await uploadMemoryBatch(memories.slice(halfSize), options);
}
```

### 3. **Progress Tracking**

```typescript
const { mutate, progress } = useCreateMemoryBatch({
  geminiApiKey: apiKey,
  onProgress: (progress) => {
    // Update UI with progress
    setUploadProgress({
      stage: progress.stage,
      percent: progress.percent,
      message: progress.message,
      current: progress.current,
      total: progress.total
    });
  }
});
```

### 4. **Metadata Optimization**

```typescript
// ✅ GOOD: Essential metadata only
tags: {
  'category': memory.category,
  'importance': memory.importance.toString(),
  'topic': memory.topic,
  'timestamp': new Date().toISOString()
}

// ❌ AVOID: Excessive metadata
tags: {
  'category': memory.category,
  'subcategory': memory.subcategory,
  'tags': memory.tags.join(','),
  'full_content': memory.content, // Don't store content in tags!
  // ... too many fields
}
```

### 5. **Tag-Based Querying**

```typescript
// ✅ GOOD: Efficient filtering
const workFiles = await storageService.getQuiltFilesByTags(
  quiltId,
  [{ category: 'work' }]
);

// ✅ GOOD: Combined filters (client-side)
const importantWorkFiles = workFiles.filter(file => {
  const importance = parseInt(file.tags?.['importance'] || '0');
  return importance >= 7;
});

// ❌ AVOID: Fetching all files unnecessarily
const allFiles = await storageService.getQuiltFiles(quiltId);
// Then filtering client-side (inefficient for large sets)
```

### 6. **Session Key Management**

```typescript
// ✅ GOOD: Reuse session key for multiple decryptions
const sessionKey = await SessionKey.create({ ... });

for (const file of files) {
  const decrypted = await sealClient.decrypt({
    data: file.contents,
    sessionKey, // Reuse
    txBytes
  });
}

// ❌ AVOID: Creating new session key each time
for (const file of files) {
  const sessionKey = await SessionKey.create({ ... }); // Slow!
  const decrypted = await sealClient.decrypt({ ... });
}
```

---

## Troubleshooting

### Issue: "Transaction too large"

**Cause**: Too many files in a single batch.

**Solution**: Split into smaller batches.

```typescript
const BATCH_SIZE = 10;
for (let i = 0; i < memories.length; i += BATCH_SIZE) {
  const batch = memories.slice(i, i + BATCH_SIZE);
  await uploadMemoryBatch(batch, options);
}
```

### Issue: "Out of memory"

**Cause**: Processing too many memories at once.

**Solution**: Process in chunks.

```typescript
async function processInChunks(memories, chunkSize = 5) {
  const results = [];
  for (let i = 0; i < memories.length; i += chunkSize) {
    const chunk = memories.slice(i, i + chunkSize);
    const processed = await processMemories(chunk);
    results.push(...processed);
  }
  return results;
}
```

### Issue: "Session key expired"

**Cause**: Session key TTL exceeded.

**Solution**: Create new session key.

```typescript
// Session keys expire after TTL (default 10 minutes)
const sessionKey = await SessionKey.create({
  ttlMin: 30 // Increase TTL to 30 minutes
});
```

---

## Related Documentation

- [SEAL Encryption Guide](./SEAL_ENCRYPTION.md)
- [Storage Service API](./STORAGE_SERVICE.md)
- [React Hooks Reference](./HOOKS_REFERENCE.md)
- [Walrus Integration](./WALRUS_INTEGRATION.md)

---

## Support

For issues or questions:
- **GitHub**: [Issues](https://github.com/CommandOSSLabs/personal-data-wallet/issues)
- **Documentation**: [SDK Docs](https://docs.pdw.example.com)
- **Example**: See `examples/multiple-file-upload-demo.ts`
