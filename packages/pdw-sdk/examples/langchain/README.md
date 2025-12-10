# LangChain Integration Examples

This directory contains examples demonstrating the PDW LangChain integration.

## Quick Start

### 1. Set up your API key

```bash
export GEMINI_API_KEY="your-api-key-here"
```

Get your API key from: https://aistudio.google.com/app/apikey

### 2. Run the integration test

```bash
# From the pdw-sdk directory
npx tsx examples/langchain/test-integration.ts
```

This test verifies:
- ✅ PDWEmbeddings works with LangChain
- ✅ Embeddings generation (query and documents)
- ✅ VectorStore integration
- ✅ Similarity search
- ✅ Retriever pattern for RAG
- ✅ Semantic similarity calculation

## Available Examples

### `quickstart-demo.ts` ⭐ NEW! Quick Start
**Purpose**: Minimal working example (~50 lines) - perfect for getting started!

**What it demonstrates**:
- PDWEmbeddings initialization
- PDWVectorStore setup
- Adding documents
- Similarity search
- Simple RAG chain

**Run**:
```bash
npx tsx examples/langchain/quickstart-demo.ts
```

---

### `complete-rag-demo.ts` ⭐ NEW! Complete Demo
**Purpose**: Comprehensive demonstration of all LangChain integration features.

**What it demonstrates**:
- Full PDWEmbeddings API
- Advanced PDWVectorStore features (MMR search, filtering, stats)
- Complete RAG workflows with sources
- Factory methods (fromTexts, fromDocuments)
- Error handling and best practices

**Run**:
```bash
npx tsx examples/langchain/complete-rag-demo.ts
```

---

### `test-integration.ts` ⭐ Start here!

**Purpose**: Comprehensive test of the LangChain integration without requiring wallet or blockchain.

**What it tests**:
- PDWEmbeddings initialization
- LangChain VectorStore compatibility
- Similarity search with scores
- Retriever pattern for RAG chains

**Run**:
```bash
npx tsx examples/langchain/test-integration.ts
```

### `basic-embeddings.ts`

**Purpose**: Simple demonstration of generating embeddings.

**Features**:
- Single query embedding
- Batch document embedding
- Similarity calculation

**Run**:
```bash
npx tsx examples/langchain/basic-embeddings.ts
```

### `basic-rag.ts`

**Purpose**: Complete RAG example with PDWVectorStore.

**Requirements**:
- Sui wallet with testnet tokens
- Deployed PDW contracts

**Features**:
- PDWVectorStore with decentralized storage
- Document addition (blockchain transactions)
- Semantic search
- Full RAG chain

**Run**:
```bash
npx tsx examples/langchain/basic-rag.ts
```

### `react-hooks-example.tsx`

**Purpose**: React component examples using PDW hooks.

**Components**:
- `SimpleRAGApp` - Basic RAG UI
- `VectorStoreManager` - Document management
- `ConversationalRAGApp` - Chat interface

**Usage**:
Copy components into your Next.js/React app.

## Dependencies

The integration requires:

```json
{
  "@langchain/core": "^0.3.0",
  "@langchain/google-genai": "^0.1.12",
  "@google/genai": "^1.20.0"
}
```

These are already included in `personal-data-wallet-sdk`.

## Testing Different Scenarios

### Test 1: Embeddings Only
```bash
npx tsx examples/langchain/basic-embeddings.ts
```

### Test 2: Full Integration (without blockchain)
```bash
npx tsx examples/langchain/test-integration.ts
```

### Test 3: With Blockchain (requires wallet)
```bash
# Set up environment variables
export GEMINI_API_KEY="your-key"
export NEXT_PUBLIC_PACKAGE_ID="0x..."
export NEXT_PUBLIC_ACCESS_REGISTRY_ID="0x..."

# Run RAG example
npx tsx examples/langchain/basic-rag.ts
```

## Expected Output

When running `test-integration.ts`, you should see:

```
🚀 PDW LangChain Integration Test

============================================================
TEST 1: Initialize PDWEmbeddings
============================================================

🔧 Creating PDWEmbeddings instance...
✅ Model: text-embedding-004
✅ Dimensions: 768
✅ Provider: Google Gemini

============================================================
TEST 2: Generate Embeddings
============================================================

📝 Testing embedQuery()...
✅ Query embedded: "What is artificial intelligence?"
📊 Vector length: 768
📊 Sample values: [0.0234, -0.0156, 0.0432...]

... [more test output]

============================================================
SUMMARY
============================================================

All tests completed successfully!

✅ 1. PDWEmbeddings initialization
✅ 2. Query embedding generation
✅ 3. Document batch embedding
✅ 4. LangChain VectorStore integration
✅ 5. Similarity search
✅ 6. Score-based search
✅ 7. Retriever pattern
✅ 8. Semantic similarity

🎉 LangChain integration is working perfectly!
```

## Troubleshooting

### "GEMINI_API_KEY environment variable is required"
```bash
export GEMINI_API_KEY="your-api-key-here"
```

### "Module not found: langchain/vectorstores/memory"
```bash
npm install langchain @langchain/core @langchain/google-genai
```

### "Failed to generate embeddings"
- Check your API key is valid
- Check you have internet connection
- Check Gemini API quota: https://aistudio.google.com/app/apikey

## Next Steps

After running the tests:

1. **Build a RAG app**: Use `createPDWRAG()` helper
2. **Add React UI**: Use `usePDWRAG()` hook
3. **Integrate with chains**: PDWVectorStore works with any LangChain chain
4. **Customize**: Adjust `k`, filters, and prompt templates

## Learn More

- [LangChain Documentation](https://docs.langchain.com/)
- [PDW SDK Documentation](../../README.md)
- [LangChain Integration Guide](../../LANGCHAIN_INTEGRATION.md)
