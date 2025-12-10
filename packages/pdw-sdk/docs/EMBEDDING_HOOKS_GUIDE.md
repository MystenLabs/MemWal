# Embedding Hooks - Complete Usage Guide

This guide provides detailed instructions for using the Personal Data Wallet SDK's embedding hooks to store and retrieve vector embeddings on Walrus decentralized storage.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Detailed Usage](#detailed-usage)
  - [useStoreEmbedding](#usestoreembedding)
  - [useRetrieveEmbedding](#useretrieveembedding)
- [Complete Examples](#complete-examples)
- [Configuration](#configuration)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

The embedding hooks provide a React-friendly interface for:
- **Generating embeddings** from text using Google's Gemini API (768-dimensional vectors)
- **Storing embeddings** on Walrus decentralized storage with automatic retry logic
- **Retrieving embeddings** with caching and error handling via React Query

### Key Features

✅ **Automatic embedding generation** - Text-to-vector conversion using `text-embedding-004`
✅ **Decentralized storage** - Leverages Walrus network via StorageService
✅ **Built-in retry logic** - Handles transient network failures automatically
✅ **React Query integration** - Automatic caching, refetching, and state management
✅ **TypeScript support** - Full type safety with comprehensive interfaces
✅ **Progress tracking** - Real-time status updates during operations

---

## Installation

### 1. Install the SDK

```bash
npm install personal-data-wallet-sdk @mysten/dapp-kit @mysten/sui @tanstack/react-query
```

### 2. Environment Variables

Create a `.env.local` file in your project root:

```env
# Sui Network Configuration
NEXT_PUBLIC_SUI_NETWORK=testnet

# PDW Smart Contract Configuration
NEXT_PUBLIC_PACKAGE_ID=0xdac3ced3f5fd4e704b295f69f827a4e42596975fa9be0dcaf6f1dfb7a1acc7c3
NEXT_PUBLIC_ACCESS_REGISTRY_ID=0x11474bd9b832c2c3ce59d5015ae902a5c01d6dd46e5de5994f50b6071e7be211
NEXT_PUBLIC_WALLET_REGISTRY_ID=0x1f2725a72967c7654c471cfab0839e04bc7c827ed1d7eb2f6834e088ce6faa7d

# Google Gemini API for embeddings
NEXT_PUBLIC_GEMINI_API_KEY=your_gemini_api_key_here

# Walrus Configuration (optional - uses defaults if not provided)
NEXT_PUBLIC_WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space
NEXT_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space

# Sui RPC URL (optional - uses testnet default)
NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.testnet.sui.io:443

# Your wallet credentials (for testing)
WALLET_ADDRESS=0x...
PRIVATE_KEY_ADDRESS=suiprivkey1...
```

### 3. Setup React Query Provider

Wrap your app with React Query and Sui providers:

```tsx
// app/layout.tsx or _app.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { getFullnodeUrl } from '@mysten/sui/client';
import '@mysten/dapp-kit/dist/index.css';

const queryClient = new QueryClient();

const networks = {
  testnet: { url: getFullnodeUrl('testnet') },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryClientProvider client={queryClient}>
          <SuiClientProvider networks={networks} defaultNetwork="testnet">
            <WalletProvider autoConnect>
              {children}
            </WalletProvider>
          </SuiClientProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
```

---

## Quick Start

### Store an Embedding

```tsx
import { useStoreEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

function EmbeddingUploader() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const { mutate: storeEmbedding, isPending, data, error } = useStoreEmbedding({
    onSuccess: (result) => {
      console.log('✅ Embedding stored!', result.blobId);
    }
  });

  const handleStore = () => {
    if (!account) return;

    storeEmbedding({
      content: 'The quick brown fox jumps over the lazy dog',
      type: 'document',
      signer: {
        signAndExecuteTransaction: signAndExecute,
        toSuiAddress: () => account.address
      }
    });
  };

  return (
    <div>
      <button onClick={handleStore} disabled={isPending || !account}>
        {isPending ? 'Storing...' : 'Store Embedding'}
      </button>
      {error && <p>Error: {error.message}</p>}
      {data && <p>Stored with Blob ID: {data.blobId}</p>}
    </div>
  );
}
```

### Retrieve an Embedding

```tsx
import { useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';

function EmbeddingViewer({ blobId }: { blobId: string }) {
  const { data, isLoading, error, refetch } = useRetrieveEmbedding(blobId);

  if (isLoading) return <div>Loading embedding...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return null;

  return (
    <div>
      <h3>Embedding Details</h3>
      <p><strong>Dimension:</strong> {data.dimension}</p>
      <p><strong>Model:</strong> {data.model}</p>
      <p><strong>Type:</strong> {data.embeddingType}</p>
      <p><strong>Content Preview:</strong> {data.contentPreview}</p>
      <p><strong>Vector Length:</strong> {data.vector.length}</p>
      <button onClick={() => refetch()}>Refresh</button>
    </div>
  );
}
```

---

## Detailed Usage

### useStoreEmbedding

Generate and store vector embeddings on Walrus.

#### Hook Signature

```typescript
function useStoreEmbedding(
  options?: UseStoreEmbeddingOptions
): UseStoreEmbeddingReturn
```

#### Options

```typescript
interface UseStoreEmbeddingOptions {
  // Gemini API key (defaults to NEXT_PUBLIC_GEMINI_API_KEY env var)
  geminiApiKey?: string;

  // PDW package ID (defaults to NEXT_PUBLIC_PACKAGE_ID env var)
  packageId?: string;

  // Sui RPC URL (defaults to NEXT_PUBLIC_SUI_RPC_URL or testnet)
  suiRpcUrl?: string;

  // Walrus network (default: 'testnet')
  network?: 'mainnet' | 'testnet';

  // Storage epochs (default: 5)
  epochs?: number;

  // Use upload relay (default: true, recommended for testnet)
  useUploadRelay?: boolean;

  // Success callback
  onSuccess?: (result: StoreEmbeddingResult) => void;

  // Error callback
  onError?: (error: Error) => void;
}
```

#### Input Parameters

```typescript
interface StoreEmbeddingInput {
  // Text content to convert to embedding (required)
  content: string;

  // Signer for Walrus transaction (required)
  signer: Signer;

  // Type of embedding (default: 'document')
  type?: 'document' | 'query' | 'metadata';

  // Additional metadata to store
  metadata?: Record<string, any>;

  // Whether blob should be deletable (default: false)
  deletable?: boolean;
}
```

#### Return Value

```typescript
interface UseStoreEmbeddingReturn {
  // Function to trigger embedding storage
  mutate: (input: StoreEmbeddingInput) => void;

  // Async version
  mutateAsync: (input: StoreEmbeddingInput) => Promise<StoreEmbeddingResult>;

  // Loading state
  isPending: boolean;

  // Success state
  isSuccess: boolean;

  // Error state
  isError: boolean;

  // Result data
  data?: StoreEmbeddingResult;

  // Error object
  error: Error | null;

  // Progress message
  progress?: string;

  // Reset mutation state
  reset: () => void;
}
```

#### Complete Example

```tsx
import { useStoreEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useState } from 'react';

function DocumentUploader() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [content, setContent] = useState('');

  const {
    mutate: storeEmbedding,
    isPending,
    isSuccess,
    data,
    error,
    progress,
    reset
  } = useStoreEmbedding({
    epochs: 10, // Store for longer
    useUploadRelay: true,
    onSuccess: (result) => {
      console.log('✅ Success!');
      console.log('Blob ID:', result.blobId);
      console.log('Embedding time:', result.embeddingTime, 'ms');
      console.log('Upload time:', result.uploadTime, 'ms');
    },
    onError: (error) => {
      console.error('❌ Failed:', error.message);
    }
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account || !content.trim()) return;

    storeEmbedding({
      content: content.trim(),
      type: 'document',
      metadata: {
        source: 'user-upload',
        timestamp: new Date().toISOString()
      },
      signer: {
        signAndExecuteTransaction: signAndExecute,
        toSuiAddress: () => account.address
      }
    });
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">Store Embedding</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Enter text to create embedding..."
          rows={5}
          className="w-full p-2 border rounded"
          disabled={isPending}
        />

        <button
          type="submit"
          disabled={isPending || !account || !content.trim()}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {isPending ? progress || 'Processing...' : 'Store Embedding'}
        </button>

        {isSuccess && (
          <button
            type="button"
            onClick={reset}
            className="ml-2 px-4 py-2 bg-gray-500 text-white rounded"
          >
            Reset
          </button>
        )}
      </form>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-red-800">Error: {error.message}</p>
        </div>
      )}

      {isSuccess && data && (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded">
          <h3 className="font-bold text-green-800">✅ Embedding Stored!</h3>
          <dl className="mt-2 space-y-1 text-sm">
            <div>
              <dt className="font-semibold">Blob ID:</dt>
              <dd className="font-mono text-xs break-all">{data.blobId}</dd>
            </div>
            <div>
              <dt className="font-semibold">Vector Dimension:</dt>
              <dd>{data.dimension}</dd>
            </div>
            <div>
              <dt className="font-semibold">Model:</dt>
              <dd>{data.model}</dd>
            </div>
            <div>
              <dt className="font-semibold">Embedding Time:</dt>
              <dd>{data.embeddingTime}ms</dd>
            </div>
            <div>
              <dt className="font-semibold">Upload Time:</dt>
              <dd>{data.uploadTime}ms</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
```

---

### useRetrieveEmbedding

Retrieve stored embeddings from Walrus with automatic caching.

#### Hook Signature

```typescript
function useRetrieveEmbedding(
  blobId: string | undefined,
  options?: UseRetrieveEmbeddingOptions
): UseRetrieveEmbeddingReturn
```

#### Options

```typescript
interface UseRetrieveEmbeddingOptions {
  // PDW package ID (defaults to NEXT_PUBLIC_PACKAGE_ID env var)
  packageId?: string;

  // Sui RPC URL (defaults to NEXT_PUBLIC_SUI_RPC_URL or testnet)
  suiRpcUrl?: string;

  // Walrus network (default: 'testnet')
  network?: 'mainnet' | 'testnet';

  // Whether to fetch immediately (default: true)
  enabled?: boolean;

  // Stale time in milliseconds (default: 5 minutes)
  staleTime?: number;

  // Cache time in milliseconds (default: 10 minutes)
  cacheTime?: number;

  // Success callback
  onSuccess?: (data: RetrievedEmbedding) => void;

  // Error callback
  onError?: (error: Error) => void;
}
```

#### Return Value

```typescript
interface UseRetrieveEmbeddingReturn {
  // Retrieved embedding data
  data?: RetrievedEmbedding;

  // Loading state
  isLoading: boolean;

  // Fetching state (includes background refetch)
  isFetching: boolean;

  // Success state
  isSuccess: boolean;

  // Error state
  isError: boolean;

  // Error object
  error: Error | null;

  // Manual refetch function
  refetch: () => Promise<any>;
}
```

#### Retrieved Embedding Structure

```typescript
interface RetrievedEmbedding {
  // 768-dimensional vector
  vector: number[];

  // Embedding dimension
  dimension: number;

  // Model used
  model: string;

  // First 200 characters of original content
  contentPreview: string;

  // Original content length
  contentLength: number;

  // Type of embedding
  embeddingType: 'document' | 'query' | 'metadata';

  // Additional metadata
  metadata: Record<string, any>;

  // Creation timestamp
  timestamp: number;
}
```

#### Complete Example

```tsx
import { useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useState } from 'react';

function EmbeddingExplorer() {
  const [blobId, setBlobId] = useState('');
  const [queryBlobId, setQueryBlobId] = useState<string | undefined>();

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch
  } = useRetrieveEmbedding(queryBlobId, {
    enabled: !!queryBlobId, // Only fetch when blobId is set
    staleTime: 10 * 60 * 1000, // 10 minutes
    onSuccess: (data) => {
      console.log('✅ Retrieved embedding:', data);
    },
    onError: (error) => {
      console.error('❌ Failed to retrieve:', error.message);
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (blobId.trim()) {
      setQueryBlobId(blobId.trim());
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">Retrieve Embedding</h2>

      <form onSubmit={handleSearch} className="space-y-4">
        <input
          type="text"
          value={blobId}
          onChange={(e) => setBlobId(e.target.value)}
          placeholder="Enter Blob ID..."
          className="w-full p-2 border rounded"
        />

        <button
          type="submit"
          disabled={isLoading || !blobId.trim()}
          className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {isLoading ? 'Loading...' : 'Retrieve'}
        </button>

        {data && (
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="ml-2 px-4 py-2 bg-gray-500 text-white rounded disabled:opacity-50"
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
        )}
      </form>

      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
          <p className="text-red-800">Error: {error.message}</p>
        </div>
      )}

      {data && (
        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded">
          <h3 className="font-bold text-blue-800 mb-2">Embedding Details</h3>

          <dl className="space-y-2 text-sm">
            <div>
              <dt className="font-semibold">Model:</dt>
              <dd>{data.model}</dd>
            </div>

            <div>
              <dt className="font-semibold">Dimension:</dt>
              <dd>{data.dimension}</dd>
            </div>

            <div>
              <dt className="font-semibold">Type:</dt>
              <dd className="capitalize">{data.embeddingType}</dd>
            </div>

            <div>
              <dt className="font-semibold">Content Preview:</dt>
              <dd className="italic">{data.contentPreview}</dd>
            </div>

            <div>
              <dt className="font-semibold">Original Length:</dt>
              <dd>{data.contentLength} characters</dd>
            </div>

            <div>
              <dt className="font-semibold">Vector Sample:</dt>
              <dd className="font-mono text-xs">
                [{data.vector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]
              </dd>
            </div>

            {Object.keys(data.metadata).length > 0 && (
              <div>
                <dt className="font-semibold">Metadata:</dt>
                <dd>
                  <pre className="text-xs mt-1 p-2 bg-white rounded">
                    {JSON.stringify(data.metadata, null, 2)}
                  </pre>
                </dd>
              </div>
            )}

            <div>
              <dt className="font-semibold">Created:</dt>
              <dd>{new Date(data.timestamp).toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
```

---

## Complete Examples

### Example 1: RAG (Retrieval-Augmented Generation) Workflow

```tsx
import { useStoreEmbedding, useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useState } from 'react';

interface StoredDocument {
  id: string;
  content: string;
  blobId: string;
  createdAt: Date;
}

function RAGWorkflow() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [newDocument, setNewDocument] = useState('');
  const [selectedBlobId, setSelectedBlobId] = useState<string>();

  // Store embedding hook
  const {
    mutate: storeEmbedding,
    isPending: isStoring,
    data: storeResult
  } = useStoreEmbedding({
    onSuccess: (result) => {
      // Add to documents list
      const doc: StoredDocument = {
        id: crypto.randomUUID(),
        content: newDocument,
        blobId: result.blobId,
        createdAt: new Date()
      };
      setDocuments(prev => [...prev, doc]);
      setNewDocument('');

      // Save to localStorage
      localStorage.setItem('rag-documents', JSON.stringify([...documents, doc]));
    }
  });

  // Retrieve embedding hook
  const {
    data: retrievedEmbedding,
    isLoading: isRetrieving
  } = useRetrieveEmbedding(selectedBlobId, {
    enabled: !!selectedBlobId
  });

  // Store new document
  const handleStoreDocument = async () => {
    if (!account || !newDocument.trim()) return;

    storeEmbedding({
      content: newDocument.trim(),
      type: 'document',
      metadata: {
        source: 'user-input',
        category: 'knowledge-base'
      },
      signer: {
        signAndExecuteTransaction: signAndExecute,
        toSuiAddress: () => account.address
      }
    });
  };

  // Compute similarity (cosine similarity)
  const computeSimilarity = (vec1: number[], vec2: number[]): number => {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  };

  // Search similar documents
  const handleSearch = async (query: string) => {
    if (!account) return;

    // Generate query embedding
    const queryResult = await storeEmbedding({
      content: query,
      type: 'query',
      signer: {
        signAndExecuteTransaction: signAndExecute,
        toSuiAddress: () => account.address
      }
    });

    // Retrieve and compare with stored documents
    // (In production, use HNSW index for efficient search)
    const similarities = await Promise.all(
      documents.map(async (doc) => {
        const embedding = await useRetrieveEmbedding(doc.blobId);
        const similarity = computeSimilarity(queryResult.vector, embedding.vector);
        return { doc, similarity };
      })
    );

    // Sort by similarity
    const ranked = similarities.sort((a, b) => b.similarity - a.similarity);
    console.log('Search results:', ranked);
  };

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">RAG Workflow</h1>

      {/* Store Document Section */}
      <div className="border rounded p-4">
        <h2 className="text-xl font-bold mb-2">Store Document</h2>
        <textarea
          value={newDocument}
          onChange={(e) => setNewDocument(e.target.value)}
          placeholder="Enter document content..."
          rows={4}
          className="w-full p-2 border rounded"
          disabled={isStoring}
        />
        <button
          onClick={handleStoreDocument}
          disabled={isStoring || !account || !newDocument.trim()}
          className="mt-2 px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {isStoring ? 'Storing...' : 'Store Document'}
        </button>
      </div>

      {/* Documents List */}
      <div className="border rounded p-4">
        <h2 className="text-xl font-bold mb-2">Stored Documents ({documents.length})</h2>
        <div className="space-y-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="p-3 border rounded cursor-pointer hover:bg-gray-50"
              onClick={() => setSelectedBlobId(doc.blobId)}
            >
              <p className="text-sm text-gray-600">
                {doc.content.substring(0, 100)}...
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {doc.createdAt.toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Retrieved Embedding Details */}
      {retrievedEmbedding && (
        <div className="border rounded p-4 bg-blue-50">
          <h2 className="text-xl font-bold mb-2">Embedding Details</h2>
          <dl className="space-y-1 text-sm">
            <div><strong>Dimension:</strong> {retrievedEmbedding.dimension}</div>
            <div><strong>Model:</strong> {retrievedEmbedding.model}</div>
            <div><strong>Type:</strong> {retrievedEmbedding.embeddingType}</div>
          </dl>
        </div>
      )}
    </div>
  );
}
```

### Example 2: Batch Document Processing

```tsx
import { useStoreEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useState } from 'react';

function BatchProcessor() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [documents, setDocuments] = useState<string[]>([]);
  const [results, setResults] = useState<Array<{ doc: string; blobId: string }>>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const { mutateAsync: storeEmbedding } = useStoreEmbedding();

  const processBatch = async () => {
    if (!account) return;

    setIsProcessing(true);
    const batchResults: Array<{ doc: string; blobId: string }> = [];

    for (let i = 0; i < documents.length; i++) {
      setCurrentIndex(i);

      try {
        const result = await storeEmbedding({
          content: documents[i],
          type: 'document',
          metadata: { batchIndex: i },
          signer: {
            signAndExecuteTransaction: signAndExecute,
            toSuiAddress: () => account.address
          }
        });

        batchResults.push({
          doc: documents[i],
          blobId: result.blobId
        });
      } catch (error) {
        console.error(`Failed to process document ${i}:`, error);
      }

      // Add delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    setResults(batchResults);
    setIsProcessing(false);
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-4">Batch Document Processor</h2>

      <textarea
        value={documents.join('\n---\n')}
        onChange={(e) => setDocuments(e.target.value.split('\n---\n'))}
        placeholder="Enter documents separated by '---'"
        rows={10}
        className="w-full p-2 border rounded"
        disabled={isProcessing}
      />

      <button
        onClick={processBatch}
        disabled={isProcessing || !account || documents.length === 0}
        className="mt-2 px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
      >
        {isProcessing
          ? `Processing ${currentIndex + 1}/${documents.length}...`
          : `Process ${documents.length} Documents`
        }
      </button>

      {results.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="font-bold">Results:</h3>
          {results.map((result, i) => (
            <div key={i} className="p-2 border rounded text-sm">
              <p className="font-mono">{result.blobId}</p>
              <p className="text-gray-600 text-xs mt-1">
                {result.doc.substring(0, 50)}...
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Configuration

### Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_PACKAGE_ID` | ✅ Yes | - | PDW smart contract package ID on Sui |
| `NEXT_PUBLIC_GEMINI_API_KEY` | ✅ Yes | - | Google Gemini API key for embeddings |
| `NEXT_PUBLIC_SUI_RPC_URL` | ❌ No | `https://fullnode.testnet.sui.io:443` | Sui RPC endpoint |
| `NEXT_PUBLIC_SUI_NETWORK` | ❌ No | `testnet` | Sui network (mainnet/testnet) |
| `NEXT_PUBLIC_WALRUS_PUBLISHER` | ❌ No | Auto-detected | Walrus publisher URL |
| `NEXT_PUBLIC_WALRUS_AGGREGATOR` | ❌ No | Auto-detected | Walrus aggregator URL |

### Runtime Configuration

Both hooks accept configuration options that override environment variables:

```tsx
const { mutate } = useStoreEmbedding({
  geminiApiKey: 'custom-api-key',
  packageId: 'custom-package-id',
  suiRpcUrl: 'https://custom-rpc.sui.io',
  network: 'mainnet',
  epochs: 10,
  useUploadRelay: true
});

const { data } = useRetrieveEmbedding(blobId, {
  packageId: 'custom-package-id',
  suiRpcUrl: 'https://custom-rpc.sui.io',
  network: 'mainnet',
  staleTime: 15 * 60 * 1000, // 15 minutes
  cacheTime: 30 * 60 * 1000 // 30 minutes
});
```

---

## Best Practices

### 1. Handle Loading States

Always provide feedback during operations:

```tsx
function MyComponent() {
  const { mutate, isPending, progress } = useStoreEmbedding();

  return (
    <button disabled={isPending}>
      {isPending ? (progress || 'Processing...') : 'Store Embedding'}
    </button>
  );
}
```

### 2. Use Error Boundaries

Wrap components in error boundaries:

```tsx
import { ErrorBoundary } from 'react-error-boundary';

function App() {
  return (
    <ErrorBoundary fallback={<div>Something went wrong</div>}>
      <EmbeddingComponent />
    </ErrorBoundary>
  );
}
```

### 3. Optimize React Query Cache

Configure cache times based on your use case:

```tsx
// Frequently accessed embeddings - longer cache
useRetrieveEmbedding(blobId, {
  staleTime: 30 * 60 * 1000, // 30 minutes
  cacheTime: 60 * 60 * 1000  // 1 hour
});

// One-time retrieval - shorter cache
useRetrieveEmbedding(blobId, {
  staleTime: 5 * 60 * 1000,  // 5 minutes
  cacheTime: 10 * 60 * 1000  // 10 minutes
});
```

### 4. Batch Operations

For multiple documents, implement batching with delays:

```tsx
async function batchStore(documents: string[]) {
  for (const doc of documents) {
    await storeEmbedding({ content: doc, ... });
    await new Promise(r => setTimeout(r, 1000)); // 1s delay
  }
}
```

### 5. Monitor Performance

Track embedding and upload times:

```tsx
const { mutate, data } = useStoreEmbedding({
  onSuccess: (result) => {
    console.log('Performance metrics:', {
      embeddingTime: result.embeddingTime,
      uploadTime: result.uploadTime,
      totalTime: result.embeddingTime + result.uploadTime
    });
  }
});
```

### 6. Secure API Keys

Never expose API keys in client code. Use environment variables and server-side proxies:

```tsx
// ❌ Bad - API key exposed
const { mutate } = useStoreEmbedding({
  geminiApiKey: 'AIzaSy...' // Visible in browser
});

// ✅ Good - Use environment variables
const { mutate } = useStoreEmbedding({
  geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY
});
```

---

## Troubleshooting

### Common Issues

#### 1. "Package ID is required" Error

**Problem**: Missing `NEXT_PUBLIC_PACKAGE_ID` environment variable.

**Solution**:
```env
# Add to .env.local
NEXT_PUBLIC_PACKAGE_ID=0xdac3ced3f5fd4e704b295f69f827a4e42596975fa9be0dcaf6f1dfb7a1acc7c3
```

#### 2. "Gemini API key is required" Error

**Problem**: Missing or invalid Gemini API key.

**Solution**:
```env
# Add to .env.local
NEXT_PUBLIC_GEMINI_API_KEY=your_api_key_here
```

Get your API key from: https://ai.google.dev/

#### 3. "Too many failures while writing blob" Error

**Problem**: Walrus network congestion or connectivity issues.

**Solution**: The StorageService automatically retries. If persistent:
- Check network status: https://testnet.walrus.space/
- Ensure `useUploadRelay: true` is set (default)
- Try again in a few minutes

#### 4. "Signer is required" Error

**Problem**: Missing or invalid signer object.

**Solution**:
```tsx
const account = useCurrentAccount();
const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

// Correct signer format
storeEmbedding({
  content: 'text',
  signer: {
    signAndExecuteTransaction: signAndExecute,
    toSuiAddress: () => account.address
  }
});
```

#### 5. "Blob not found" Error

**Problem**: Invalid blob ID or blob expired.

**Solution**:
- Verify blob ID format (43-44 characters, base64)
- Check if blob storage period hasn't expired
- Ensure correct network (testnet vs mainnet)

#### 6. React Query Not Working

**Problem**: Missing QueryClientProvider.

**Solution**:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourComponent />
    </QueryClientProvider>
  );
}
```

### Debug Mode

Enable detailed logging:

```tsx
// Check console for detailed logs from hooks
// Both hooks use console.log for operation tracking

const { mutate } = useStoreEmbedding({
  onSuccess: (result) => console.log('Success:', result),
  onError: (error) => console.error('Error:', error)
});
```

### Performance Tips

1. **Optimize embedding size**: Shorter text = faster generation
2. **Use upload relay**: Always keep `useUploadRelay: true` for testnet
3. **Batch operations**: Add delays between multiple stores
4. **Cache aggressively**: Set longer `staleTime` for immutable data
5. **Monitor network**: Check Walrus testnet status before large uploads

---

## API Reference

For complete API documentation, see:
- [useStoreEmbedding TypeScript definitions](../src/hooks/useStoreEmbedding.ts)
- [useRetrieveEmbedding TypeScript definitions](../src/hooks/useRetrieveEmbedding.ts)
- [StorageService documentation](../src/services/StorageService.ts)

---

## Support

For issues, questions, or contributions:
- GitHub Issues: https://github.com/your-repo/issues
- Documentation: https://docs.personal-data-wallet.com
- Discord: https://discord.gg/your-server

---

## License

MIT License - See LICENSE file for details
