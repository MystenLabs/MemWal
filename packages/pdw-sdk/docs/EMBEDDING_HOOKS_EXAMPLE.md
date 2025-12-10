# Vector Embedding Hooks - Usage Examples

The SDK now includes two specialized hooks for working with vector embeddings:
- `useStoreEmbedding` - Generate and store embeddings
- `useRetrieveEmbedding` - Retrieve stored embeddings

These hooks are perfect for **RAG (Retrieval-Augmented Generation)** workflows where you need to:
1. Store document embeddings
2. Retrieve embeddings for search
3. Build semantic search without full memory management overhead

## Installation

```bash
npm install personal-data-wallet-sdk @tanstack/react-query
```

## Basic Usage

### 1. Store an Embedding

```tsx
'use client';

import { useStoreEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useState } from 'react';

export default function EmbeddingUploader() {
  const [text, setText] = useState('');

  const {
    mutate: storeEmbedding,
    isPending,
    data,
    error,
    progress
  } = useStoreEmbedding({
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    epochs: 5, // Store for 5 epochs on Walrus
    onSuccess: (result) => {
      console.log('✅ Embedding stored!');
      console.log('Blob ID:', result.blobId);
      console.log('Vector dimensions:', result.dimension);
      console.log('Time taken:', result.embeddingTime + result.uploadTime, 'ms');
    },
    onError: (error) => {
      console.error('❌ Failed:', error.message);
    }
  });

  const handleStore = () => {
    storeEmbedding({
      content: text,
      type: 'document', // 'document', 'query', or 'metadata'
      metadata: {
        source: 'user-input',
        tags: ['example', 'test']
      }
    });
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Store Embedding</h1>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Enter text to embed..."
        rows={5}
        className="w-full p-3 border rounded mb-4"
      />

      <button
        onClick={handleStore}
        disabled={!text || isPending}
        className="px-6 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
      >
        {isPending ? 'Storing...' : 'Store Embedding'}
      </button>

      {progress && (
        <div className="mt-4 p-3 bg-blue-50 rounded">
          <p className="text-blue-700">⏳ {progress}</p>
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 bg-red-50 rounded">
          <p className="text-red-700">❌ {error.message}</p>
        </div>
      )}

      {data && (
        <div className="mt-4 p-4 bg-green-50 rounded">
          <h2 className="font-semibold text-green-700 mb-2">✅ Success!</h2>
          <div className="space-y-1 text-sm">
            <p><strong>Blob ID:</strong> {data.blobId}</p>
            <p><strong>Dimensions:</strong> {data.dimension}</p>
            <p><strong>Model:</strong> {data.model}</p>
            <p><strong>Embedding Time:</strong> {data.embeddingTime}ms</p>
            <p><strong>Upload Time:</strong> {data.uploadTime}ms</p>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 2. Retrieve an Embedding

```tsx
'use client';

import { useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useState } from 'react';

export default function EmbeddingViewer() {
  const [blobId, setBlobId] = useState('');
  const [queryBlobId, setQueryBlobId] = useState<string>();

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch
  } = useRetrieveEmbedding(queryBlobId, {
    enabled: !!queryBlobId, // Only fetch when blobId is set
    onSuccess: (data) => {
      console.log('✅ Embedding retrieved!');
      console.log('Vector length:', data.vector.length);
      console.log('Content preview:', data.contentPreview);
    },
    onError: (error) => {
      console.error('❌ Failed:', error.message);
    }
  });

  const handleRetrieve = () => {
    setQueryBlobId(blobId);
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Retrieve Embedding</h1>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={blobId}
          onChange={(e) => setBlobId(e.target.value)}
          placeholder="Enter Blob ID..."
          className="flex-1 p-3 border rounded"
        />
        <button
          onClick={handleRetrieve}
          disabled={!blobId || isLoading}
          className="px-6 py-2 bg-green-600 text-white rounded disabled:bg-gray-400"
        >
          {isLoading ? 'Loading...' : 'Retrieve'}
        </button>
      </div>

      {isFetching && (
        <div className="p-3 bg-blue-50 rounded mb-4">
          <p className="text-blue-700">⏳ Fetching from Walrus...</p>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 rounded mb-4">
          <p className="text-red-700">❌ {error.message}</p>
        </div>
      )}

      {data && (
        <div className="p-4 bg-gray-50 rounded space-y-3">
          <h2 className="font-semibold text-lg">📊 Embedding Data</h2>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-gray-600">Dimension:</p>
              <p className="font-mono">{data.dimension}</p>
            </div>
            <div>
              <p className="text-gray-600">Model:</p>
              <p className="font-mono">{data.model}</p>
            </div>
            <div>
              <p className="text-gray-600">Type:</p>
              <p className="font-mono">{data.embeddingType}</p>
            </div>
            <div>
              <p className="text-gray-600">Content Length:</p>
              <p className="font-mono">{data.contentLength} chars</p>
            </div>
          </div>

          <div>
            <p className="text-gray-600 mb-1">Content Preview:</p>
            <p className="p-2 bg-white rounded text-sm italic">
              "{data.contentPreview}"
            </p>
          </div>

          <div>
            <p className="text-gray-600 mb-1">Vector (first 10 values):</p>
            <p className="p-2 bg-white rounded text-xs font-mono overflow-x-auto">
              [{data.vector.slice(0, 10).map(v => v.toFixed(4)).join(', ')}...]
            </p>
          </div>

          {Object.keys(data.metadata).length > 0 && (
            <div>
              <p className="text-gray-600 mb-1">Metadata:</p>
              <pre className="p-2 bg-white rounded text-xs overflow-x-auto">
                {JSON.stringify(data.metadata, null, 2)}
              </pre>
            </div>
          )}

          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-gray-600 text-white rounded text-sm"
          >
            🔄 Refresh
          </button>
        </div>
      )}
    </div>
  );
}
```

## Complete RAG Workflow Example

```tsx
'use client';

import { useStoreEmbedding, useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useState } from 'react';

export default function RAGWorkflow() {
  const [documents, setDocuments] = useState<string[]>([
    'The Personal Data Wallet SDK provides decentralized storage.',
    'SEAL encryption ensures privacy for sensitive data.',
    'Walrus storage offers distributed blob storage on Sui.'
  ]);

  const [storedBlobIds, setStoredBlobIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const storeEmbedding = useStoreEmbedding({
    onSuccess: (result) => {
      setStoredBlobIds(prev => [...prev, result.blobId]);
    }
  });

  // Step 1: Ingest Documents
  const handleIngest = async () => {
    for (const doc of documents) {
      await storeEmbedding.mutateAsync({
        content: doc,
        type: 'document',
        metadata: { source: 'knowledge-base' }
      });
    }
    alert(`✅ Ingested ${documents.length} documents!`);
  };

  // Step 2: Query (simplified - just retrieves all for demo)
  const handleQuery = async () => {
    // In a real RAG system, you'd:
    // 1. Generate query embedding
    // 2. Search HNSW index for similar vectors
    // 3. Retrieve top-k documents
    // 4. Pass to LLM for generation

    // For this example, we just retrieve all stored embeddings
    const retrieved = [];
    for (const blobId of storedBlobIds) {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR}/v1/${blobId}`
      );
      const data = await response.json();
      retrieved.push(data);
    }
    setResults(retrieved);
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">RAG Workflow Demo</h1>

      {/* Step 1: Ingest */}
      <div className="mb-8 p-6 border rounded">
        <h2 className="text-xl font-semibold mb-4">Step 1: Ingest Documents</h2>
        <div className="space-y-2 mb-4">
          {documents.map((doc, i) => (
            <div key={i} className="p-3 bg-gray-50 rounded text-sm">
              {i + 1}. {doc}
            </div>
          ))}
        </div>
        <button
          onClick={handleIngest}
          disabled={storeEmbedding.isPending}
          className="px-6 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400"
        >
          {storeEmbedding.isPending ? 'Ingesting...' : 'Ingest Documents'}
        </button>
        <p className="mt-2 text-sm text-gray-600">
          Stored: {storedBlobIds.length} / {documents.length}
        </p>
      </div>

      {/* Step 2: Query */}
      <div className="mb-8 p-6 border rounded">
        <h2 className="text-xl font-semibold mb-4">Step 2: Query Knowledge Base</h2>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter your question..."
            className="flex-1 p-3 border rounded"
          />
          <button
            onClick={handleQuery}
            disabled={storedBlobIds.length === 0}
            className="px-6 py-2 bg-green-600 text-white rounded disabled:bg-gray-400"
          >
            Query
          </button>
        </div>
      </div>

      {/* Step 3: Results */}
      {results.length > 0 && (
        <div className="p-6 border rounded">
          <h2 className="text-xl font-semibold mb-4">Step 3: Retrieved Context</h2>
          <div className="space-y-3">
            {results.map((result, i) => (
              <div key={i} className="p-4 bg-blue-50 rounded">
                <p className="text-sm mb-2">
                  <strong>Document {i + 1}:</strong>
                </p>
                <p className="text-sm italic">"{result.contentPreview}"</p>
                <p className="text-xs text-gray-600 mt-2">
                  Dimension: {result.dimension} | Model: {result.model}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

## Advanced: With HNSW Search

For a complete RAG system, combine these hooks with HNSW vector search:

```tsx
import {
  useStoreEmbedding,
  useRetrieveEmbedding
} from 'personal-data-wallet-sdk/hooks';
import { BrowserHnswIndexService, EmbeddingService } from 'personal-data-wallet-sdk';

function AdvancedRAG() {
  // 1. Store documents with embeddings
  const { mutateAsync: storeDoc } = useStoreEmbedding();

  // 2. Build HNSW index
  const hnswService = new BrowserHnswIndexService();

  async function ingestDocument(text: string, userId: string) {
    // Store embedding
    const result = await storeDoc({
      content: text,
      type: 'document'
    });

    // Add to HNSW index
    hnswService.addVectorToIndexBatched(
      userId,
      Date.now(), // Vector ID
      result.vector,
      { blobId: result.blobId }
    );
  }

  // 3. Search similar documents
  async function search(query: string, userId: string) {
    // Generate query embedding
    const embeddingService = new EmbeddingService({
      apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!
    });

    const queryEmb = await embeddingService.embedText({
      text: query,
      type: 'query'
    });

    // Search HNSW index
    const results = await hnswService.searchVectors(
      userId,
      queryEmb.vector,
      { k: 5 }
    );

    return results; // Returns vector IDs and similarities
  }

  // 4. Retrieve documents by blob IDs
  // Use useRetrieveEmbedding hook to fetch content
}
```

## Key Features

### `useStoreEmbedding`

✅ **Automatic embedding generation** (text → 768-dim vector)
✅ **Walrus storage** (decentralized, content-addressed)
✅ **Progress tracking** for UX
✅ **Error handling** with retry logic
✅ **Metadata support** for custom fields

### `useRetrieveEmbedding`

✅ **React Query caching** (5 min stale time)
✅ **Automatic refetch** on stale data
✅ **Loading/error states**
✅ **Retry logic** for network failures
✅ **TypeScript types** for safety

## Configuration

Both hooks accept configuration options:

```typescript
useStoreEmbedding({
  geminiApiKey: 'your-api-key',           // Gemini API key
  walrusAggregator: 'https://...',        // Walrus aggregator URL
  walrusPublisher: 'https://...',         // Walrus publisher URL
  epochs: 5,                              // Storage epochs
  onSuccess: (result) => {...},           // Success callback
  onError: (error) => {...}               // Error callback
});

useRetrieveEmbedding(blobId, {
  walrusAggregator: 'https://...',        // Walrus aggregator URL
  enabled: true,                          // Enable query
  staleTime: 5 * 60 * 1000,              // Cache stale time
  cacheTime: 10 * 60 * 1000,             // Cache GC time
  onSuccess: (data) => {...},             // Success callback
  onError: (error) => {...}               // Error callback
});
```

## Environment Variables

Add these to your `.env.local`:

```bash
NEXT_PUBLIC_GEMINI_API_KEY=your-gemini-api-key
NEXT_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
NEXT_PUBLIC_WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
```

## Next Steps

1. **Add HNSW indexing** for semantic search
2. **Implement chunking** for long documents
3. **Add LLM generation** (e.g., Gemini) for answers
4. **Cache embeddings** to reduce API calls
5. **Add re-ranking** for better results

## Resources

- [EmbeddingService Documentation](../src/services/EmbeddingService.ts)
- [BrowserHnswIndexService](../src/vector/BrowserHnswIndexService.ts)
- [React Query Docs](https://tanstack.com/query/latest)
- [Walrus Documentation](https://docs.walrus.site/)
