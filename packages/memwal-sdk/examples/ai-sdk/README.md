# AI SDK Integration Examples

Examples demonstrating how to use PDW (Personal Data Wallet) with Vercel AI SDK.

## Overview

These examples show how to use PDW as a **decentralized vector database** with full blockchain integration, while using any AI SDK-compatible embedding provider (OpenAI, Google, Cohere, etc.).

## Prerequisites

```bash
# Install PDW SDK
npm install personal-data-wallet-sdk

# Install AI SDK core
npm install ai

# Install your preferred provider
npm install @ai-sdk/openai  # For OpenAI
npm install @ai-sdk/google  # For Google Gemini (included by default)
npm install @ai-sdk/cohere  # For Cohere (optional)
```

## Environment Variables

Create a `.env` file:

```bash
# Sui Configuration
SUI_PRIVATE_KEY=your_sui_private_key
PACKAGE_ID=your_pdw_package_id

# Walrus Configuration
WALRUS_AGGREGATOR=https://aggregator.walrus-testnet.walrus.space
WALRUS_PUBLISHER=https://publisher.walrus-testnet.walrus.space

# AI Provider Keys (choose one or more)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
COHERE_API_KEY=...
```

## Examples

### 1. Basic RAG (`basic-rag.ts`)

Complete RAG workflow:
- Store documents with embeddings
- Search by semantic similarity
- Generate answers with context

```bash
npx tsx examples/ai-sdk/basic-rag.ts
```

**What it demonstrates:**
- Using OpenAI embeddings with PDW
- Storing to Walrus + Sui blockchain
- Vector similarity search
- RAG with AI SDK `generateText`

### 2. Multi-Provider (`multi-provider.ts`)

Using different embedding providers with the same PDW backend.

```bash
npx tsx examples/ai-sdk/multi-provider.ts
```

**What it demonstrates:**
- OpenAI embeddings (3072 dimensions)
- Google Gemini embeddings (768 dimensions)
- Cohere embeddings (1024 dimensions)
- Provider-agnostic architecture

### 3. PDW Tools - Basic (`tools-basic.ts`) ⭐ NEW

AI agents with automatic memory management using `pdwTools()`:

```bash
npx tsx examples/ai-sdk/tools-basic.ts
```

**What it demonstrates:**
- 🤖 AI automatically saves information when user shares
- �� AI automatically searches memories when asked
- 🎯 Zero manual embedding generation
- 💬 Multi-turn conversations with memory context

**Key Features:**
```typescript
const tools = pdwTools({
  userId: 'user-123',
  embedModel: google.textEmbeddingModel('text-embedding-004'),
  pdwConfig: { /* ... */ }
});

// AI automatically uses tools
await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools, // ← Just pass tools!
  prompt: "Remember I love TypeScript"
});
```

### 4. PDW Tools - Advanced (`tools-advanced.ts`) ⭐ NEW

Advanced tool usage patterns:

```bash
npx tsx examples/ai-sdk/tools-advanced.ts
```

**What it demonstrates:**
- 📂 Categorical organization (fact, preference, todo, note)
- ⭐ Importance scoring (1-10 levels)
- 🌊 Streaming responses with tool calls
- 🔧 Selective tool enabling (read-only mode)
- 💬 Multi-turn conversations with context building

## PDW Tools API (Simplest Integration)

### Quick Start with `pdwTools()`

The easiest way to use PDW with AI SDK is through `pdwTools()`:

```typescript
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';
import { pdwTools } from 'personal-data-wallet-sdk/ai-sdk';

// 1. Create embedding model
const embedModel = google.textEmbeddingModel('text-embedding-004');

// 2. Create tools
const tools = pdwTools({
  userId: 'user-123',
  embedModel,
  pdwConfig: {
    walrus: { aggregator: process.env.WALRUS_AGGREGATOR! },
    sui: { network: 'testnet', packageId: process.env.PACKAGE_ID! },
    signer: keypair,
    userAddress: keypair.toSuiAddress(),
    dimensions: 768 // Gemini embedding dimensions
  }
});

// 3. Use with AI - that's it!
const result = await generateText({
  model: google('gemini-2.0-flash-exp'),
  tools,
  prompt: "Remember that I love TypeScript"
});
```

### Available Tools

1. **`search_memory`** - Search through personal memories
   - AI decides when to use based on user questions
   - Examples: "What did I say about...", "Do you remember..."

2. **`save_memory`** - Save information to memory
   - AI decides when information is worth saving
   - Supports categories: fact, preference, todo, note, general
   - Importance levels: 1-10

3. **`list_memories`** - Get memory statistics
   - Shows total memory count
   - Filterable by category

### Configuration Options

```typescript
interface PDWToolsConfig {
  userId: string;              // Required: User identifier
  embedModel: EmbeddingModel;  // Required: AI SDK embedding model
  pdwConfig: PDWVectorStoreConfig;  // Required: PDW config

  // Optional: Select which tools to enable
  enabledTools?: ['search_memory', 'save_memory', 'list_memories'] | 'all';

  // Optional: Custom tool descriptions
  customDescriptions?: {
    search_memory?: string;
    save_memory?: string;
    list_memories?: string;
  };
}
```

### Why Use PDW Tools?

| Feature | Traditional RAG | PDW Tools |
|---------|----------------|-----------|
| **Setup** | Manual embedding + storage | One function call |
| **Memory Management** | Manual save/search | AI decides automatically |
| **Embedding** | Manual generation | Automatic |
| **Context** | Manual injection | AI retrieves as needed |
| **Code** | 50+ lines | 3 lines |

## Key Concepts

### PDW + AI SDK Integration

```typescript
import { embed } from 'ai';
import { openai } from '@ai-sdk/openai';
import { PDWVectorStore } from 'personal-data-wallet-sdk/ai-sdk';

// 1. Create PDW vector store
const store = new PDWVectorStore({
  walrus: { aggregator: '...' },
  sui: { network: 'testnet', packageId: '...' },
  signer: keypair,
  userAddress: address,
  dimensions: 1536
});

// 2. Generate embedding with AI SDK
const { embedding } = await embed({
  model: openai.embedding('text-embedding-3-small'),
  value: 'Your text here'
});

// 3. Store to PDW (Walrus + Sui + HNSW)
await store.add({
  id: 'doc-1',
  vector: embedding,
  text: 'Your text here'
});

// 4. Search
const results = await store.search({ vector: queryEmbedding, limit: 5 });
```

### Why Use PDW with AI SDK?

| Feature | Traditional (Pinecone/Chroma) | PDW + AI SDK |
|---------|------------------------------|--------------|
| **Storage** | Centralized servers | Decentralized (Walrus) |
| **Ownership** | Vendor lock-in | You own your data |
| **Blockchain** | None | Sui blockchain indexing |
| **Encryption** | Basic | SEAL homomorphic encryption |
| **Providers** | Vendor-specific | Any AI SDK provider |
| **Cost** | Subscription fees | Pay for Walrus storage |

## Architecture

```
┌─────────────────┐
│   AI SDK User   │
│  (Your App)     │
└────────┬────────┘
         │
         │ embed() / generateText()
         │
┌────────▼────────────────────┐
│   Vercel AI SDK             │
│   - openai.embedding()      │
│   - google.textEmbedding()  │
│   - cohere.textEmbedding()  │
└────────┬────────────────────┘
         │
         │ Embedding vectors
         │
┌────────▼────────────────────┐
│   PDW Vector Store          │
│   - Add vectors             │
│   - Search vectors          │
│   - Get by ID               │
└────────┬────────────────────┘
         │
         ├──► Walrus (Decentralized Storage)
         ├──► Sui Blockchain (On-chain Index)
         └──► HNSW (Vector Search)
```

## Common Patterns

### Pattern 1: Simple Vector Store

```typescript
// Just store and search vectors
const store = new PDWVectorStore({
  walrus: { aggregator: '...' },
  sui: { network: 'testnet', packageId: '...' },
  signer,
  userAddress,
  dimensions: 1536,
  features: {
    encryption: false,
    extractKnowledgeGraph: false
  }
});
```

### Pattern 2: Full-Featured (Encryption + Graphs)

```typescript
// Enable all PDW features
const store = new PDWVectorStore({
  walrus: { aggregator: '...' },
  sui: { network: 'testnet', packageId: '...' },
  signer,
  userAddress,
  dimensions: 1536,
  features: {
    encryption: true,           // SEAL encryption
    extractKnowledgeGraph: true // Auto-extract entities
  },
  sealService,                  // Required for encryption
  geminiApiKey: '...'          // Required for graphs
});
```

### Pattern 3: Batch Operations

```typescript
// Store multiple documents efficiently
const results = await store.addBatch({
  vectors: [
    { id: 'doc-1', vector: emb1, text: 'Text 1' },
    { id: 'doc-2', vector: emb2, text: 'Text 2' },
    { id: 'doc-3', vector: emb3, text: 'Text 3' },
  ],
  onProgress: (progress) => {
    console.log(`${progress.current}/${progress.total}`);
  }
});
```

## Troubleshooting

### "API key not found"
Make sure your `.env` file has the correct API keys for your chosen provider.

### "Package not found"
Install the provider: `npm install @ai-sdk/openai` (or google, cohere, etc.)

### "Dimension mismatch"
Ensure the `dimensions` in `PDWVectorStoreConfig` matches your embedding model:
- OpenAI text-embedding-3-small: 1536
- OpenAI text-embedding-3-large: 3072
- Google text-embedding-004: 768
- Cohere embed-english-v3.0: 1024

### "Walrus upload failed"
Check that Walrus testnet is accessible and your aggregator/publisher URLs are correct.

## Next Steps

- See [PDW Documentation](../../CLAUDE.md) for full SDK capabilities
- Explore [LangChain integration](../langchain/) for more advanced RAG
- Check out [hooks examples](../hooks/) for React integration

## Support

- GitHub Issues: https://github.com/CommandOSSLabs/personal-data-wallet/issues
- Documentation: https://github.com/CommandOSSLabs/personal-data-wallet

## License

MIT
