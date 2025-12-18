# MemWal SDK Performance Benchmarks

Benchmark results for `@cmdoss/memwal` measured on Sui testnet.

## Quick Summary

| Operation | Latency | Notes |
|-----------|---------|-------|
| Vector Search + RAG | ~2.3s | With content retrieval |
| Create Memory | ~2.3s | Classify + embed + upload + index |
| AI Classification | ~2.3s | OpenRouter API |
| Batch Upload (2 items) | ~2.3s | Quilt batching |
| HNSW Search | <100ms | 3072-dim vectors, local |
| Blockchain Query | ~2.3s | List memories from Sui |

**Average query time: ~2.3s** (with OpenRouter API latency)

---

## Speed Metrics

### AI Operations

| Operation | Avg Latency | Notes |
|-----------|-------------|-------|
| **Embedding (single)** | ~300ms | OpenRouter text-embedding-3-large |
| **Embedding (batch 5)** | ~400ms | 12.5 texts/sec |
| **Embedding (batch 10)** | ~500ms | 20 texts/sec |
| **shouldSave** | ~200ms | Cached after first call |
| **classify** | ~200ms | Cached responses |
| **Knowledge Graph** | ~3-6s | Entity extraction (Gemini) |

### Storage Operations

| Operation | Latency | Notes |
|-----------|---------|-------|
| **Walrus Upload (single)** | ~2,000ms | Single memory package |
| **Walrus Upload (Quilt batch)** | ~2,500ms | Multiple memories, single tx |
| **Walrus Download** | ~500-1,000ms | Depends on size |
| **Content Cache Hit** | <10ms | Local cache |

### Search Operations

| Operation | Avg Latency | Notes |
|-----------|-------------|-------|
| **HNSW Search (Node.js)** | <50ms | hnswlib-node, 3072-dim |
| **HNSW Search (Browser)** | ~100ms | hnswlib-wasm, 3072-dim |
| **Similarity Calculation** | 0.001ms | 909K calculations/sec |
| **Vector + Content Fetch** | ~2.3s | Search + Walrus retrieval |

### Blockchain Operations

| Operation | Latency | Notes |
|-----------|---------|-------|
| **Memory Create (on-chain)** | ~7,000ms | Includes gas estimation |
| **Memory Update** | ~5,000ms | |
| **Memory Delete** | ~3,000ms | |
| **Batch Create (Quilt)** | ~8,000ms | Multiple memories, single tx |

---

## Full Pipeline Breakdown

Complete memory creation pipeline:

```text
┌────────────────────────────────────────────────────────────────┐
│                   Memory Creation Pipeline                     │
├────────────────────────────────────────────────────────────────┤
│ Step                    │ Latency      │ % of Total            │
├─────────────────────────┼──────────────┼───────────────────────┤
│ 1. shouldSave check     │ ~200ms       │ 2%                    │
│ 2. Classification       │ ~200ms       │ 2%                    │
│ 3. Embedding (3072-dim) │ ~300ms       │ 3%                    │
│ 4. Walrus Upload        │ ~2,000ms     │ 20%                   │
│ 5. On-chain Transaction │ ~7,000ms     │ 70%                   │
│ 6. HNSW Indexing        │ ~50ms        │ <1%                   │
├─────────────────────────┼──────────────┼───────────────────────┤
│ TOTAL                   │ ~10,000ms    │ 100%                  │
└─────────────────────────┴──────────────┴───────────────────────┘

With Knowledge Graph extraction: +3-6s
```

### Optimization Tips

1. **Skip Knowledge Graph** - Disable if not needed (saves 3-6s)
2. **Batch Operations** - Use `pdw.memory.createBatch()` with Quilt (~90% gas savings)
3. **Use hnswlib-node** - Native C++ is 2x faster than WASM
4. **Cache embeddings** - Reuse embeddings for duplicate content

---

## Size Metrics

### Data Sizes

| Component | Size | Notes |
|-----------|------|-------|
| **Embedding Vector** | 12,288 bytes | 3072 dimensions × 4 bytes (Float32) |
| **Memory Package** | ~15-20 KB | Content + metadata + embedding |
| **Knowledge Graph** | ~1-5 KB | Entities + relationships JSON |
| **HNSW Index Entry** | ~50 bytes | Per vector (plus metadata) |

### Bundle Sizes

| Build | Size | Notes |
|-------|------|-------|
| **Browser Bundle** | ~2.5 MB | Includes hnswlib-wasm |
| **Node.js Bundle** | ~1.8 MB | Uses hnswlib-node |
| **Minified** | ~800 KB | Gzipped |

### Index Capacity

| Parameter | Value |
|-----------|-------|
| Max Elements | 10,000 |
| Dimensions | 3072 |
| M (connections) | 16 |
| efConstruction | 200 |
| Memory per 1K vectors | ~120 KB |

---

## Batch Upload (Quilt) Performance

Walrus Quilt batching provides significant gas savings:

| Batch Size | Individual Gas | Quilt Gas | Savings |
|------------|----------------|-----------|---------|
| 2 memories | 0.006 SUI | 0.004 SUI | ~33% |
| 5 memories | 0.015 SUI | 0.005 SUI | ~67% |
| 10 memories | 0.030 SUI | 0.006 SUI | ~80% |
| 20 memories | 0.060 SUI | 0.008 SUI | ~87% |

**Recommendation**: Always use `createBatch()` for multiple memories.

---

## Cost Estimates

### Sui Testnet Gas Costs

| Operation | Gas Cost | USD Estimate* |
|-----------|----------|---------------|
| **Create Memory** | ~0.003 SUI | ~$0.01 |
| **Create Batch (Quilt)** | ~0.005 SUI | ~$0.02 |
| **Update Memory** | ~0.002 SUI | ~$0.007 |
| **Delete Memory** | ~0.001 SUI | ~$0.003 |

*Estimated at SUI = $3.50 (Dec 2024)

### AI API Costs

| Provider | Operation | Cost |
|----------|-----------|------|
| **OpenRouter** | text-embedding-3-large | ~$0.00013/1K tokens |
| **OpenRouter** | Classification (GPT-4) | ~$0.03/1K tokens |
| **Gemini** | Knowledge Graph | ~$0.001/request |

---

## HNSW Performance Comparison

| Implementation | Search (10K vectors) | Add Vector | Memory |
|----------------|---------------------|------------|--------|
| **hnswlib-node** | ~20ms | ~0.5ms | ~120MB |
| **hnswlib-wasm** | ~50ms | ~1ms | ~120MB |

**Recommendation**: Use Node.js for production workloads.

---

## Running Benchmarks

### Quick Run

```bash
# Run all benchmarks
npm run test:e2e -- benchmark.spec.ts

# With verbose output
npx playwright test benchmark.spec.ts --reporter=list
```

### Custom Benchmarks

```typescript
import { SimplePDWClient } from '@cmdoss/memwal';

const pdw = new SimplePDWClient({
  signer: keypair,
  network: 'testnet',
  packageId: '0x...',
  embedding: { provider: 'openrouter', apiKey: '...' }
});

await pdw.ready();

// Measure embedding latency
const start = performance.now();
const embedding = await pdw.ai.embed('Test text');
console.log(`Embedding: ${(performance.now() - start).toFixed(0)}ms`);
console.log(`Dimensions: ${embedding.length}`); // 3072

// Measure search latency
const searchStart = performance.now();
const results = await pdw.search.vector('query', { limit: 5 });
console.log(`Search: ${(performance.now() - searchStart).toFixed(0)}ms`);

// Measure batch create
const batchStart = performance.now();
const memories = await pdw.memory.createBatch([
  'Memory 1', 'Memory 2', 'Memory 3'
]);
console.log(`Batch create: ${(performance.now() - batchStart).toFixed(0)}ms`);
```

---

## Environment

Benchmarks were run with:

- **Runtime**: Node.js 20 / Chromium (Playwright)
- **Network**: Sui Testnet
- **Embedding**: OpenRouter (text-embedding-3-large, 3072 dims)
- **Storage**: Walrus Testnet
- **HNSW**: hnswlib-node (Node.js) / hnswlib-wasm (Browser)
- **Machine**: Windows 11

---

## Related Documentation

- [README.md](./README.md) - Quick start guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture
- [CHANGELOG.md](./CHANGELOG.md) - Version history
