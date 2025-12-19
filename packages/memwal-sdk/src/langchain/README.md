# LangChain Integration for Personal Data Wallet SDK

This module provides standard LangChain interfaces for PDW's decentralized storage, SEAL encryption, and Sui blockchain integration.

## Features

- ✅ **PDWEmbeddings** - LangChain embeddings adapter using Google Gemini
- ✅ **PDWVectorStore** - VectorStore with Walrus storage + Sui blockchain + HNSW search
- 🚧 **createPDWRAG** - Coming soon (Simple RAG helper function)

## Installation

The LangChain integration is included in the main PDW SDK package:

```bash
npm install personal-data-wallet-sdk @langchain/core @langchain/google-genai
```

## Quick Start

### Complete Example with PDWVectorStore

```typescript
import { PDWEmbeddings, PDWVectorStore } from 'personal-data-wallet-sdk/langchain';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';

// Initialize embeddings
const embeddings = new PDWEmbeddings({
  geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!
});

// Initialize PDW VectorStore (decentralized storage)
const vectorStore = new PDWVectorStore(embeddings, {
  userAddress: account.address,
  packageId: '0x...',
  walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
  geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!
});

// Add documents (creates memories on Walrus + Sui blockchain)
await vectorStore.addDocuments([
  { pageContent: 'Meeting notes...', metadata: { category: 'work' } }
], {
  account,
  signAndExecute,
  client
});

// Search (HNSW vector search)
const results = await vectorStore.similaritySearch('meetings', 5);

// Use as retriever in RAG chains
const retriever = vectorStore.asRetriever({ k: 5 });
```

## API Reference

### PDWEmbeddings

LangChain Embeddings adapter using PDW's EmbeddingService (Google Gemini).

#### Constructor

```typescript
new PDWEmbeddings(params: {
  geminiApiKey: string;      // Required: Your Gemini API key
  model?: string;            // Optional: Model name (default: 'text-embedding-004')
  dimensions?: number;       // Optional: Embedding dimensions (default: 768)
  requestsPerMinute?: number;// Optional: Rate limit (default: 1500)
})
```

#### Methods

**`embedQuery(text: string): Promise<number[]>`**

Embed a single query text. Optimized for search queries.

**`embedDocuments(texts: string[]): Promise<number[][]>`**

Embed multiple document texts. Uses batch processing for efficiency.

**`getModelInfo(): { model: string; dimensions: number; provider: string }`**

Get information about the embedding model.

## Examples

See the [examples directory](../../examples/langchain/) for complete examples:

- `basic-embeddings.ts` - Simple embedding generation
- More examples coming soon!

## Why Use PDW with LangChain?

1. **Decentralized Storage**: Store embeddings on Walrus (decentralized blob storage)
2. **Blockchain Ownership**: Track ownership via Sui blockchain
3. **SEAL Encryption**: Privacy-preserving encryption for sensitive data
4. **Standard Interface**: Works with entire LangChain ecosystem
5. **Browser Compatible**: All operations work in browser (WebAssembly HNSW)

## Roadmap

- ✅ PDWEmbeddings adapter
- 🚧 PDWVectorStore (Walrus + Sui + HNSW)
- 🚧 PDWRetriever (with SEAL decryption)
- 🚧 createPDWRAG helper
- 🚧 React hooks for LangChain components
- 🚧 Advanced retrievers (MMR, compression, etc.)

## Learn More

- [LangChain Documentation](https://docs.langchain.com/)
- [PDW SDK Documentation](../../README.md)
- [Walrus Storage](https://docs.walrus.site/)
- [Sui Blockchain](https://docs.sui.io/)
