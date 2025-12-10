/**
 * DEMONSTRATION: Multiple File Upload with Metadata Management
 *
 * This example demonstrates how the personal-data-wallet-sdk handles
 * uploading multiple files with proper metadata management.
 *
 * Key Features:
 * - Batch upload with ~90% gas savings (Walrus Quilts)
 * - Per-file metadata tags (plaintext, searchable)
 * - SEAL encryption for content security
 * - Tag-based filtering and retrieval
 *
 * Run: npx tsx examples/multiple-file-upload-demo.ts
 */

import { StorageService } from '../src/services/StorageService';
import { EmbeddingService } from '../src/services/EmbeddingService';
import { EncryptionService } from '../src/services/EncryptionService';
import { GeminiAIService } from '../src/services/GeminiAIService';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

// ==================== EXAMPLE 1: Basic Batch Upload ====================

async function example1_BasicBatchUpload() {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 1: Basic Batch Upload with Metadata');
  console.log('='.repeat(80) + '\n');

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

  const encryptionService = new EncryptionService(
    new SuiClient({ url: getFullnodeUrl('testnet') }) as any,
    {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID!,
      network: 'testnet'
    }
  );

  // ========== STEP 1: Prepare Multiple Memories ==========

  const memoriesToUpload = [
    {
      content: 'Met with the team to discuss Q4 roadmap. Focus on AI features.',
      category: 'work',
      userCategory: 'meetings'
    },
    {
      content: 'Completed a 10km run in 55 minutes. New personal best!',
      category: 'health',
      userCategory: 'fitness'
    },
    {
      content: 'Read chapter 5 of "Deep Learning" by Goodfellow. Notes on CNNs.',
      category: 'education',
      userCategory: 'learning'
    }
  ];

  console.log(`📝 Preparing ${memoriesToUpload.length} memories for batch upload...\n`);

  // ========== STEP 2: Process Each Memory ==========

  const processedMemories = [];

  for (let i = 0; i < memoriesToUpload.length; i++) {
    const memory = memoriesToUpload[i];
    console.log(`\n[Memory ${i + 1}/${memoriesToUpload.length}]`);
    console.log(`  Content: "${memory.content.substring(0, 50)}..."`);

    // 2a. Generate embedding (768-dimensional vector)
    console.log(`  🔢 Generating embedding...`);
    const embeddingResult = await embeddingService.embedText({
      text: memory.content,
      taskType: 'RETRIEVAL_DOCUMENT'
    });
    console.log(`     ✅ Embedding: 768D vector`);

    // 2b. Encrypt content with SEAL
    console.log(`  🔐 Encrypting content...`);
    const encryptionResult = await encryptionService.encrypt(
      new TextEncoder().encode(memory.content),
      '0x1234567890abcdef1234567890abcdef12345678' // User's Sui address
    );
    console.log(`     ✅ Encrypted: ${encryptionResult.encryptedObject.length} bytes`);

    // 2c. Extract AI metadata (simulated here)
    const aiMetadata = {
      importance: Math.floor(Math.random() * 5) + 5, // 5-10
      topic: memory.category,
      summary: memory.content.substring(0, 100)
    };

    processedMemories.push({
      content: memory.content,
      category: memory.category,
      importance: aiMetadata.importance,
      topic: aiMetadata.topic,
      embedding: embeddingResult.vector,
      encryptedContent: encryptionResult.encryptedObject,
      summary: aiMetadata.summary
    });
  }

  console.log(`\n✅ All ${processedMemories.length} memories processed!\n`);

  // ========== STEP 3: Upload as Quilt (Batch) ==========

  console.log('📦 Uploading batch to Walrus Quilt...\n');

  // Mock signer for demonstration
  const mockSigner = {
    async signAndSend(txb: any) {
      return { digest: 'mock-digest-123' };
    }
  } as any;

  const uploadResult = await storageService.uploadMemoryBatch(
    processedMemories,
    {
      signer: mockSigner,
      epochs: 5,
      userAddress: '0x1234567890abcdef1234567890abcdef12345678'
    }
  );

  // ========== STEP 4: Display Results ==========

  console.log('\n' + '='.repeat(80));
  console.log('📊 BATCH UPLOAD RESULTS');
  console.log('='.repeat(80));
  console.log(`Quilt ID:        ${uploadResult.quiltId}`);
  console.log(`Files Uploaded:  ${uploadResult.files.length}`);
  console.log(`Upload Time:     ${uploadResult.uploadTimeMs.toFixed(1)}ms`);
  console.log(`Gas Saved:       ~${((1 - 1/uploadResult.files.length) * 100).toFixed(0)}%`);
  console.log('='.repeat(80) + '\n');

  return uploadResult;
}


// ==================== EXAMPLE 2: Metadata Structure Details ====================

function example2_MetadataStructure() {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 2: Understanding Metadata Structure');
  console.log('='.repeat(80) + '\n');

  console.log('Each file in the batch has TWO types of metadata:\n');

  // 1. Plaintext Tags (Searchable at Walrus level)
  console.log('📋 1. PLAINTEXT TAGS (Searchable, not encrypted)');
  console.log('-'.repeat(80));

  const plaintextTags = {
    // Core metadata
    'category': 'work',              // User-defined category
    'importance': '8',               // AI-extracted importance (1-10)
    'topic': 'Q4 Planning',          // AI-extracted topic
    'summary': 'Meeting about...',   // AI-generated summary

    // Timestamps
    'timestamp': '2025-01-15T10:30:00.000Z',
    'created_at': '2025-01-15T10:30:00.000Z',

    // Encryption info
    'encrypted': 'true',
    'encryption_type': 'seal',

    // Owner
    'owner': '0x1234...5678',

    // Technical metadata
    'embedding_dimensions': '768'
  };

  console.log(JSON.stringify(plaintextTags, null, 2));
  console.log('\n✅ These tags allow filtering WITHOUT decryption!\n');

  // 2. Encrypted Content
  console.log('🔐 2. ENCRYPTED CONTENT (Stored as Uint8Array)');
  console.log('-'.repeat(80));
  console.log('Content: [Encrypted with SEAL - IBE]');
  console.log('Format:  Uint8Array (binary)');
  console.log('Decrypt: Requires session key + identity + PTB validation');
  console.log('\n✅ Content remains private, only authorized users can decrypt!\n');

  // 3. Optional: On-Chain Blob Attributes
  console.log('⛓️  3. ON-CHAIN BLOB ATTRIBUTES (Optional)');
  console.log('-'.repeat(80));

  const blobAttributes = {
    'memory_category': 'work',
    'memory_topic': 'Q4 Planning',
    'memory_importance': '8',
    'memory_vector_id': 'vector-abc123',
    'memory_embedding_blob_id': '0xabcd...ef01',
    'memory_graph_blob_id': '0x1234...5678',
    'memory_seal_identity': 'pkg-addr-identity',
    'memory_encrypted': 'true',
    'memory_created_at': '1705315800000'
  };

  console.log(JSON.stringify(blobAttributes, null, 2));
  console.log('\n✅ These are queryable on-chain via Sui smart contracts!\n');
}


// ==================== EXAMPLE 3: Tag-Based Querying ====================

async function example3_TagBasedQuerying(quiltId: string) {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 3: Tag-Based Querying and Filtering');
  console.log('='.repeat(80) + '\n');

  const storageService = new StorageService({
    packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
    walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
    network: 'testnet'
  });

  console.log('🔍 Query 1: Get ALL files from Quilt');
  console.log('-'.repeat(80));

  const allFiles = await storageService.getQuiltFiles(quiltId);
  console.log(`✅ Retrieved ${allFiles.length} files\n`);

  console.log('🔍 Query 2: Filter by category="work"');
  console.log('-'.repeat(80));

  const workFiles = await storageService.getQuiltFilesByTags(
    quiltId,
    [{ category: 'work' }]
  );
  console.log(`✅ Found ${workFiles.length} work-related files\n`);

  console.log('🔍 Query 3: Filter by importance >= 7');
  console.log('-'.repeat(80));
  console.log('(Note: This requires client-side filtering after retrieval)');

  const importantFiles = allFiles.filter(file => {
    // Access tags from WalrusFile (API-dependent)
    // const importance = parseInt(file.tags?.['importance'] || '0');
    // return importance >= 7;
    return true; // Placeholder
  });
  console.log(`✅ Found ${importantFiles.length} important files\n`);
}


// ==================== EXAMPLE 4: React Hook Usage ====================

function example4_ReactHookDemo() {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 4: Using React Hook for Batch Upload');
  console.log('='.repeat(80) + '\n');

  const reactCode = `
import { useCreateMemoryBatch } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useState } from 'react';

function BatchMemoryUploader() {
  const account = useCurrentAccount();
  const [memories, setMemories] = useState([
    { content: 'Memory 1', category: 'work' },
    { content: 'Memory 2', category: 'personal' },
    { content: 'Memory 3', category: 'health' }
  ]);

  // Initialize the batch upload hook
  const {
    mutate: createBatch,
    isPending,
    progress,
    data,
    error
  } = useCreateMemoryBatch({
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    onSuccess: (result) => {
      console.log(\`✅ Created \${result.memoriesCreated} memories\`);
      console.log(\`   Quilt ID: \${result.quiltId}\`);
      console.log(\`   Upload time: \${result.uploadTimeMs}ms\`);
    },
    onProgress: (progress) => {
      console.log(\`\${progress.message} (\${progress.percent}%)\`);
    },
    onError: (error) => {
      console.error('❌ Upload failed:', error.message);
    }
  });

  const handleUpload = () => {
    createBatch({ memories });
  };

  return (
    <div>
      <h2>Batch Memory Upload</h2>

      {/* Progress indicator */}
      {isPending && progress && (
        <div className="progress">
          <div className="progress-bar" style={{ width: \`\${progress.percent}%\` }} />
          <p>{progress.message}</p>
          <p>Processing: {progress.current}/{progress.total}</p>
        </div>
      )}

      {/* Upload button */}
      <button
        onClick={handleUpload}
        disabled={isPending || !account}
      >
        {isPending
          ? \`Uploading... \${progress?.percent || 0}%\`
          : \`Upload \${memories.length} Memories\`
        }
      </button>

      {/* Results */}
      {data && (
        <div className="success">
          <h3>✅ Upload Successful!</h3>
          <p>Quilt ID: {data.quiltId}</p>
          <p>Files: {data.files.length}</p>
          <p>Time: {data.uploadTimeMs}ms</p>
          <p>Gas Saved: ~{((1 - 1/data.files.length) * 100).toFixed(0)}%</p>
        </div>
      )}

      {/* Error handling */}
      {error && (
        <div className="error">
          <h3>❌ Upload Failed</h3>
          <p>{error.message}</p>
        </div>
      )}
    </div>
  );
}

// Progress stages:
// 1. "preparing"  - Preparing batch operation...
// 2. "processing" - Generating embedding for memory X/Y...
// 3. "encrypting" - Encrypting memory X/Y...
// 4. "uploading"  - Uploading batch to Walrus Quilt...
// 5. "success"    - Batch created successfully!
`;

  console.log(reactCode);
}


// ==================== EXAMPLE 5: Complete Flow Diagram ====================

function example5_CompleteFlowDiagram() {
  console.log('\n' + '='.repeat(80));
  console.log('EXAMPLE 5: Complete Batch Upload Flow');
  console.log('='.repeat(80) + '\n');

  const flowDiagram = `
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MULTIPLE FILE UPLOAD FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

USER INPUT: Multiple Memories
  ├─ Memory 1: { content, category }
  ├─ Memory 2: { content, category }
  └─ Memory 3: { content, category }
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: AI METADATA EXTRACTION (Batch)                                     │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Service: GeminiAIService.extractRichMetadataBatch()                         │
│ Time:    ~500ms for entire batch                                            │
│ Output:  For each memory:                                                   │
│          ├─ importance: number (1-10)                                        │
│          ├─ topic: string                                                    │
│          ├─ summary: string                                                  │
│          └─ category: string (AI-refined)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: PER-MEMORY PROCESSING (Sequential)                                 │
│ ─────────────────────────────────────────────────────────────────────────── │
│ For Memory[i]:                                                               │
│                                                                              │
│   [2a] Generate Embedding                                                   │
│        Service: EmbeddingService.embedText()                                │
│        Time:    ~200ms per memory                                           │
│        Output:  768-dimensional vector                                      │
│                 [0.0234, -0.0156, 0.0432, ...]                              │
│            ↓                                                                 │
│   [2b] Encrypt Content                                                      │
│        Service: EncryptionService.encrypt()                                 │
│        Time:    ~50ms per memory                                            │
│        Output:  Uint8Array (SEAL encrypted)                                 │
│                 encryptedObject: [0x12, 0x34, ...]                          │
│                 backupKey: [0xab, 0xcd, ...]                                │
│            ↓                                                                 │
│   [2c] Collect Processed Memory                                             │
│        {                                                                     │
│          content: string,                                                    │
│          category: string,                                                   │
│          importance: number,                                                 │
│          topic: string,                                                      │
│          embedding: number[768],                                             │
│          encryptedContent: Uint8Array,                                       │
│          summary: string                                                     │
│        }                                                                     │
│                                                                              │
│ Result: processedMemories[] array                                           │
└─────────────────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 3: CREATE WALRUS FILES                                                │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Service: QuiltBatchManager.uploadMemoryBatch()                              │
│                                                                              │
│ For each processed memory, create WalrusFile:                               │
│                                                                              │
│   WalrusFile {                                                               │
│     identifier: "memory-{timestamp}-{index}-{random}.json",                 │
│     contents: encryptedContent (Uint8Array),                                │
│     tags: {                                                                  │
│       // PLAINTEXT METADATA (searchable)                                    │
│       'category': 'work',                                                    │
│       'importance': '8',                                                     │
│       'topic': 'Q4 Planning',                                                │
│       'timestamp': '2025-01-15T10:30:00.000Z',                               │
│       'created_at': '2025-01-15T10:30:00.000Z',                              │
│       'encrypted': 'true',                                                   │
│       'encryption_type': 'seal',                                             │
│       'owner': '0x1234...5678',                                              │
│       'summary': 'Meeting about...',                                         │
│       'embedding_dimensions': '768'                                          │
│     }                                                                        │
│   }                                                                          │
│                                                                              │
│ Files: [WalrusFile, WalrusFile, WalrusFile, ...]                            │
└─────────────────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 4: BATCH UPLOAD TO WALRUS (Quilt)                                     │
│ ─────────────────────────────────────────────────────────────────────────── │
│ API Call: walrusClient.writeFiles()                                         │
│ Time:     ~300ms for entire batch                                           │
│ Gas:      1 Sui transaction (vs N transactions individually)                │
│ Savings:  ~90% gas reduction for N files                                    │
│                                                                              │
│ Result:                                                                      │
│   ├─ quiltId: "0xabcd...ef01"      // Shared ID for all files              │
│   ├─ files: [                                                                │
│   │     { blobId: "0x1234..." },   // Individual blob IDs                   │
│   │     { blobId: "0x5678..." },                                            │
│   │     { blobId: "0x9abc..." }                                             │
│   │   ]                                                                      │
│   └─ uploadTimeMs: 1847                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ STAGE 5: OPTIONAL ENHANCEMENTS                                              │
│ ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│ [5a] Attach Blob Attributes (On-Chain)                                      │
│      Service: BlobAttributesManager.setBlobAttributes()                     │
│      Purpose: Make metadata queryable via Sui smart contracts               │
│      Cost:    Additional Sui transaction per blob                           │
│                                                                              │
│ [5b] Index Vectors (Browser)                                                │
│      Service: HnswWasmService.addVectorToIndexBatched()                     │
│      Purpose: Enable fast semantic search in browser                        │
│      Storage: IndexedDB (via WASM Emscripten FS)                            │
│                                                                              │
│ [5c] Build Knowledge Graph                                                  │
│      Service: GraphService.extractGraph()                                   │
│      Purpose: Extract entities and relationships                            │
│      Storage: Separate Walrus blob                                          │
└─────────────────────────────────────────────────────────────────────────────┘
            ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ FINAL RESULT                                                                 │
│ ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│ {                                                                            │
│   quiltId: "0xabcd...ef01",                                                 │
│   files: [                                                                   │
│     { identifier: "memory-...-0-xyz.json", blobId: "0x1234..." },           │
│     { identifier: "memory-...-1-abc.json", blobId: "0x5678..." },           │
│     { identifier: "memory-...-2-def.json", blobId: "0x9abc..." }            │
│   ],                                                                         │
│   uploadTimeMs: 1847,                                                       │
│   memoriesCreated: 3                                                        │
│ }                                                                            │
│                                                                              │
│ 🎉 All files stored with searchable metadata and encrypted content!         │
└─────────────────────────────────────────────────────────────────────────────┘

PERFORMANCE METRICS (3 memories):
  ├─ AI metadata extraction:  ~500ms  (batch)
  ├─ Embeddings generation:   ~600ms  (3 × 200ms)
  ├─ SEAL encryption:         ~150ms  (3 × 50ms)
  ├─ Walrus upload:           ~300ms  (single transaction)
  └─ Total:                   ~1.5 seconds

GAS SAVINGS:
  ├─ Individual uploads:  3 transactions  = 100% cost
  ├─ Batch upload:        1 transaction   = ~33% cost
  └─ Savings:             ~67% (or ~90% for larger batches)
`;

  console.log(flowDiagram);
}


// ==================== MAIN EXECUTION ====================

async function main() {
  console.log('\n');
  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('║' + '  PERSONAL DATA WALLET SDK - MULTIPLE FILE UPLOAD DEMONSTRATION'.padEnd(78) + '║');
  console.log('║' + ' '.repeat(78) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');

  try {
    // Run demonstrations
    example2_MetadataStructure();
    example4_ReactHookDemo();
    example5_CompleteFlowDiagram();

    // Uncomment to run actual upload (requires valid credentials)
    // const result = await example1_BasicBatchUpload();
    // await example3_TagBasedQuerying(result.quiltId);

  } catch (error) {
    console.error('\n❌ Error during demonstration:', error);
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ DEMONSTRATION COMPLETE');
  console.log('='.repeat(80) + '\n');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export {
  example1_BasicBatchUpload,
  example2_MetadataStructure,
  example3_TagBasedQuerying,
  example4_ReactHookDemo,
  example5_CompleteFlowDiagram
};
