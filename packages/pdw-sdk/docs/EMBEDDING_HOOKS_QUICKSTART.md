# Embedding Hooks - Quick Start

Get started with vector embeddings on Walrus in 5 minutes.

## Installation

```bash
npm install personal-data-wallet-sdk @mysten/dapp-kit @mysten/sui @tanstack/react-query
```

## Setup (3 steps)

### 1. Environment Variables

Create `.env.local`:

```env
NEXT_PUBLIC_PACKAGE_ID=0xdac3ced3f5fd4e704b295f69f827a4e42596975fa9be0dcaf6f1dfb7a1acc7c3
NEXT_PUBLIC_GEMINI_API_KEY=your_gemini_api_key_here
```

Get Gemini API key: https://ai.google.dev/

### 2. Providers Setup

```tsx
// app/layout.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import '@mysten/dapp-kit/dist/index.css';

const queryClient = new QueryClient();

export default function RootLayout({ children }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider defaultNetwork="testnet">
        <WalletProvider autoConnect>
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
```

### 3. Use the Hooks

```tsx
import { useStoreEmbedding, useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

function MyComponent() {
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  // Store embedding
  const { mutate: store, data: storeResult } = useStoreEmbedding();

  // Retrieve embedding
  const { data: embedding } = useRetrieveEmbedding(storeResult?.blobId);

  const handleStore = () => {
    if (!account) return;

    store({
      content: 'Hello, Walrus!',
      type: 'document',
      signer: {
        signAndExecuteTransaction: signAndExecute,
        toSuiAddress: () => account.address
      }
    });
  };

  return (
    <div>
      <button onClick={handleStore} disabled={!account}>
        Store Embedding
      </button>

      {storeResult && <p>Stored: {storeResult.blobId}</p>}
      {embedding && <p>Dimension: {embedding.dimension}</p>}
    </div>
  );
}
```

## What Happens?

1. **Generate**: Text → 768-dimensional vector (via Gemini API)
2. **Store**: Vector → Walrus decentralized storage (~10-15s)
3. **Retrieve**: Blob ID → Vector data (with caching)

## Next Steps

- 📖 [Complete Guide](./EMBEDDING_HOOKS_GUIDE.md) - Detailed documentation
- 🎯 [Examples](./EMBEDDING_HOOKS_GUIDE.md#complete-examples) - RAG workflow, batch processing
- 🔧 [Configuration](./EMBEDDING_HOOKS_GUIDE.md#configuration) - Advanced options
- 🐛 [Troubleshooting](./EMBEDDING_HOOKS_GUIDE.md#troubleshooting) - Common issues

## Key Features

✅ **Auto-retry** - Handles network failures
✅ **Caching** - React Query integration
✅ **Progress tracking** - Real-time status
✅ **TypeScript** - Full type safety
✅ **Decentralized** - Walrus storage

## Common Patterns

### Store Multiple Documents

```tsx
const { mutateAsync: store } = useStoreEmbedding();

async function storeBatch(documents: string[]) {
  for (const doc of documents) {
    await store({
      content: doc,
      signer: {...}
    });
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
}
```

### Search with Cosine Similarity

```tsx
function computeSimilarity(vec1: number[], vec2: number[]): number {
  let dot = 0, norm1 = 0, norm2 = 0;

  for (let i = 0; i < vec1.length; i++) {
    dot += vec1[i] * vec2[i];
    norm1 += vec1[i] * vec1[i];
    norm2 += vec2[i] * vec2[i];
  }

  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}
```

### Handle Errors

```tsx
const { mutate, error } = useStoreEmbedding({
  onError: (error) => {
    if (error.message.includes('API key')) {
      console.error('Invalid Gemini API key');
    } else if (error.message.includes('blob')) {
      console.error('Walrus upload failed - retrying...');
    }
  }
});
```

## Performance

| Operation | Time | Notes |
|-----------|------|-------|
| Generate embedding | ~500-1000ms | Depends on text length |
| Upload to Walrus | ~10-15s | Testnet, with retry |
| Retrieve from Walrus | ~200-500ms | Cached after first load |

## Need Help?

- 📚 Full docs: [EMBEDDING_HOOKS_GUIDE.md](./EMBEDDING_HOOKS_GUIDE.md)
- 🐛 Issues: [GitHub Issues](https://github.com/your-repo/issues)
- 💬 Discord: [Join Community](https://discord.gg/your-server)

---

**Ready to build?** Check out the [complete guide](./EMBEDDING_HOOKS_GUIDE.md) for advanced examples!
