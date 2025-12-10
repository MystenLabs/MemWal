# Personal Data Wallet SDK - Documentation

Welcome to the complete documentation for the Personal Data Wallet SDK.

## 📚 Documentation Index

### Getting Started

- **[Main README](../README.md)** - Overview, installation, and quick start
- **[Quick Start Guide](./EMBEDDING_HOOKS_QUICKSTART.md)** - Get up and running in 5 minutes

### React Hooks

- **[React Hooks API Reference](./REACT_HOOKS_API.md)** - Complete guide to all React hooks
  - High-level hooks (useCreateMemory, useSearchMemories, etc.)
  - Browser-compatible hooks (useMemoryIndex, useKnowledgeGraph)
  - Vector embedding hooks (useStoreEmbedding, useRetrieveEmbedding)

- **[Embedding Hooks Guide](./EMBEDDING_HOOKS_GUIDE.md)** - Detailed guide for vector embeddings
  - Installation and setup
  - Complete API reference
  - RAG workflow examples
  - Best practices and troubleshooting

### Advanced Topics

- **[CLAUDE.md](../CLAUDE.md)** - SDK architecture and development guide
  - Directory structure
  - Service layer architecture
  - Memory processing pipeline
  - Development commands

## 🎯 Quick Navigation

### I want to...

**Create and manage memories**
→ [useCreateMemory](./REACT_HOOKS_API.md#usecreatememory)

**Search memories semantically**
→ [useSearchMemories](./REACT_HOOKS_API.md#usesearchmemories)

**List all user memories**
→ [useWalletMemories](./REACT_HOOKS_API.md#usewalletmemories)

**Build a memory-aware AI chat**
→ [useMemoryChat](./REACT_HOOKS_API.md#usememorychat)

**Store/retrieve vector embeddings**
→ [Embedding Hooks Guide](./EMBEDDING_HOOKS_GUIDE.md)

**Build a RAG workflow**
→ [RAG Example](./EMBEDDING_HOOKS_GUIDE.md#example-1-rag-retrieval-augmented-generation-workflow)

**Manage vector indices**
→ [useMemoryIndex](./REACT_HOOKS_API.md#usememoryindex)

**Work with knowledge graphs**
→ [useKnowledgeGraph](./REACT_HOOKS_API.md#useknowledgegraph)

**Access low-level services**
→ [useMemoryServices](./REACT_HOOKS_API.md#usememoryservices)

## 📖 Core Concepts

### Memory Management
Memories are the fundamental data unit in the SDK. Each memory consists of:
- **Content** - The actual data/text
- **Embedding** - 768-dimensional vector for semantic search
- **Metadata** - Category, timestamp, importance, etc.
- **Storage** - Decentralized storage on Walrus
- **Blockchain** - On-chain record on Sui

### Vector Search
The SDK uses HNSW (Hierarchical Navigable Small World) algorithm for fast, approximate nearest neighbor search:
- **Browser-compatible** - Runs via WebAssembly (hnswlib-wasm)
- **Persistent** - Stored in IndexedDB with Walrus backup
- **Fast** - 10-50ms query latency
- **Scalable** - Handles thousands of vectors

### RAG (Retrieval-Augmented Generation)
Combine vector search with AI to create context-aware responses:
1. User asks a question
2. Search memories for relevant context
3. Include top-N memories in AI prompt
4. AI generates response using context
5. Save conversation as new memories

### Knowledge Graph
Automatically extracted entities and relationships from memories:
- **Entities** - People, places, concepts
- **Relationships** - Connections between entities
- **Graph traversal** - Find related memories
- **Visualization** - Export for D3.js or similar

## 🛠️ Setup Requirements

### Prerequisites

```bash
npm install personal-data-wallet-sdk @mysten/sui @mysten/dapp-kit @tanstack/react-query react
```

### Environment Variables

```env
# Required
NEXT_PUBLIC_PACKAGE_ID=0xdac3ced3f5fd4e704b295f69f827a4e42596975fa9be0dcaf6f1dfb7a1acc7c3
NEXT_PUBLIC_GEMINI_API_KEY=your_api_key_here

# Optional (auto-detected if not provided)
NEXT_PUBLIC_ACCESS_REGISTRY_ID=0x11474bd9b832c2c3ce59d5015ae902a5c01d6dd46e5de5994f50b6071e7be211
NEXT_PUBLIC_WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.testnet.sui.io:443
```

### Providers Setup

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import '@mysten/dapp-kit/dist/index.css';

const queryClient = new QueryClient();

export default function App({ children }) {
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

## 🎨 Common Patterns

### Pattern 1: Basic Memory Workflow

```tsx
import { useCreateMemory, useSearchMemories } from 'personal-data-wallet-sdk/hooks';

function MemoryApp() {
  const { mutate: create } = useCreateMemory({
    config: { /* ... */ }
  });

  const { data: results } = useSearchMemories(address, query);

  return (
    <div>
      <button onClick={() => create({ content: 'text', ... })}>
        Create
      </button>
      {results?.map(r => <div key={r.memoryId}>{r.content}</div>)}
    </div>
  );
}
```

### Pattern 2: Memory-Aware Chat

```tsx
import { useMemoryChat } from 'personal-data-wallet-sdk/hooks';

function ChatApp() {
  const { messages, sendMessage, retrievedMemories } = useMemoryChat(address, {
    maxContextMemories: 5,
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={i}>{msg.content}</div>
      ))}
      <input onChange={e => sendMessage(e.target.value)} />
      {retrievedMemories && <p>Using {retrievedMemories.length} memories</p>}
    </div>
  );
}
```

### Pattern 3: RAG with Embeddings

```tsx
import { useStoreEmbedding, useRetrieveEmbedding } from 'personal-data-wallet-sdk/hooks';

function RAGWorkflow() {
  const { mutate: store, data } = useStoreEmbedding();
  const { data: embedding } = useRetrieveEmbedding(data?.blobId);

  const handleStore = () => {
    store({
      content: 'Document text...',
      type: 'document',
      signer: { /* ... */ }
    });
  };

  // Use embedding.vector for similarity computation
  return <div>{embedding && <p>Vector: {embedding.dimension}D</p>}</div>;
}
```

### Pattern 4: Batch Operations

```tsx
async function batchCreateMemories(documents: string[]) {
  for (const doc of documents) {
    await createMemory({ content: doc, ... });
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
}
```

## 🔧 Configuration Options

### Global Config

```typescript
interface SDKConfig {
  packageId: string;                    // PDW smart contract
  accessRegistryId?: string;            // Access control registry
  walletRegistryId?: string;            // Wallet registry
  walrusAggregator?: string;            // Walrus storage endpoint
  geminiApiKey: string;                 // AI API key
  suiRpcUrl?: string;                   // Sui RPC endpoint
  network?: 'mainnet' | 'testnet';      // Network (default: testnet)
}
```

### Hook-Specific Options

Each hook accepts specific options. See individual documentation:
- [useCreateMemory options](./REACT_HOOKS_API.md#usec

reatememory)
- [useSearchMemories options](./REACT_HOOKS_API.md#usesearchmemories)
- [useStoreEmbedding options](./EMBEDDING_HOOKS_GUIDE.md#options)

## 📊 Performance Benchmarks

| Operation | Time | Notes |
|-----------|------|-------|
| Create memory | 15-20s | Full pipeline with AI processing |
| Search memories | 50-200ms | Vector search + metadata lookup |
| Generate embedding | 500-1000ms | Gemini API call |
| Upload to Walrus | 10-15s | Decentralized storage |
| Retrieve from Walrus | 200-500ms | First fetch (cached afterward) |
| HNSW vector search | 10-50ms | Browser-based WebAssembly |

## 🐛 Troubleshooting

### Common Issues

**"Package ID is required"**
→ Set `NEXT_PUBLIC_PACKAGE_ID` in `.env.local`

**"Gemini API key is required"**
→ Set `NEXT_PUBLIC_GEMINI_API_KEY` in `.env.local`
→ Get key from: https://ai.google.dev/

**"Walrus upload failed"**
→ Check Walrus testnet status
→ Ensure `useUploadRelay: true` is set
→ SDK automatically retries

**"React Query not working"**
→ Ensure `QueryClientProvider` is wrapping your app

**Search returns no results**
→ Check if memories are indexed (`useMemoryIndex`)
→ Verify user address is correct
→ Try lowering `minSimilarity` threshold

For more troubleshooting, see [Embedding Hooks Guide - Troubleshooting](./EMBEDDING_HOOKS_GUIDE.md#troubleshooting).

## 🔐 Security Best Practices

### 1. Never expose API keys in client code

```tsx
// ❌ Bad
const apiKey = 'AIzaSy...'; // Exposed in browser

// ✅ Good
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
```

### 2. Validate user input

```tsx
if (!content || content.trim().length === 0) {
  throw new Error('Content cannot be empty');
}
```

### 3. Use environment-specific configs

```tsx
const config = {
  packageId: process.env.NODE_ENV === 'production'
    ? process.env.NEXT_PUBLIC_PROD_PACKAGE_ID
    : process.env.NEXT_PUBLIC_DEV_PACKAGE_ID
};
```

### 4. Implement rate limiting

```tsx
const rateLimiter = new Map();

function checkRateLimit(userId: string) {
  const lastCall = rateLimiter.get(userId);
  if (lastCall && Date.now() - lastCall < 1000) {
    throw new Error('Rate limit exceeded');
  }
  rateLimiter.set(userId, Date.now());
}
```

## 📚 Additional Resources

### Official Documentation

- [Sui Documentation](https://docs.sui.io)
- [Walrus Documentation](https://docs.walrus.site)
- [Google AI Studio](https://aistudio.google.com)
- [React Query Docs](https://tanstack.com/query/latest)

### SDK Resources

- [GitHub Repository](https://github.com/CommandOSSLabs/personal-data-wallet)
- [npm Package](https://www.npmjs.com/package/personal-data-wallet-sdk)
- [Example App](../example)

### Community

- [Discord](https://discord.gg/your-server)
- [Twitter](https://twitter.com/your-handle)
- [GitHub Issues](https://github.com/CommandOSSLabs/personal-data-wallet/issues)

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](../CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone repo
git clone https://github.com/CommandOSSLabs/personal-data-wallet.git
cd personal-data-wallet/packages/pdw-sdk

# Install dependencies
npm install

# Build SDK
npm run build

# Run tests
npm test

# Start example app
cd example
npm run dev
```

## 📄 License

MIT License - see [LICENSE](../LICENSE) file for details.

---

**Need help?** Check our [documentation](../README.md) or [open an issue](https://github.com/CommandOSSLabs/personal-data-wallet/issues).

**Ready to build?** Start with the [Quick Start Guide](./EMBEDDING_HOOKS_QUICKSTART.md)!
