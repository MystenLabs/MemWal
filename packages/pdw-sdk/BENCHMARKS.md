# PDW SDK Performance Benchmarks

Benchmark results measured on Sui testnet using Chromium browser with Playwright E2E tests.

## Quick Summary

| Operation | Latency | Notes |
|-----------|---------|-------|
| Embedding | ~324 ms | Single text, Gemini API |
| Classification | ~200 ms | Cached after first call |
| Knowledge Graph | ~6.7 s | Complex AI extraction |
| Similarity Calc | ~0.001 ms | Local, 909K/sec |
| HNSW Search | ~262 ms | 768-dim vectors |
| Full Pipeline | ~20 s | All steps combined |

---

## Speed Metrics

### AI Operations

| Operation | Avg Latency | Min | Max | Notes |
|-----------|-------------|-----|-----|-------|
| **Embedding (single)** | 324 ms | 255 ms | 587 ms | Gemini text-embedding-004 |
| **Embedding (batch 2)** | 410 ms | - | - | 4.88 texts/sec |
| **Embedding (batch 5)** | 253 ms | - | - | 19.73 texts/sec |
| **Embedding (batch 10)** | 378 ms | - | - | 26.48 texts/sec |
| **shouldSave** | 247 ms | 0.3 ms* | 488 ms | *cached responses |
| **classify** | 194 ms | 0 ms* | 254 ms | *cached responses |
| **importance** | 190 ms | 0.1 ms* | 241 ms | *cached responses |
| **Knowledge Graph** | 6,690 ms | 3,464 ms | 10,126 ms | Entity extraction |

### Storage Operations

| Operation | Latency | Notes |
|-----------|---------|-------|
| **Walrus Upload (100B)** | ~2,000 ms | Small payload |
| **Walrus Upload (1KB)** | ~2,500 ms | Medium payload |
| **Walrus Upload (10KB)** | ~3,500 ms | Large payload |
| **Walrus Download** | ~500-1,000 ms | Depends on size |

### Search Operations

| Operation | Avg Latency | Notes |
|-----------|-------------|-------|
| **HNSW Search** | 262 ms | 768-dim, top-5 results |
| **Similarity Calculation** | 0.001 ms | 909,091 calculations/sec |

### Blockchain Operations

| Operation | Latency | Notes |
|-----------|---------|-------|
| **Memory Create (on-chain)** | ~7,000 ms | Includes gas estimation |
| **Memory Update** | ~5,000 ms | |
| **Memory Delete** | ~3,000 ms | |
| **Create MemoryCap** | ~5,000 ms | SEAL context |

---

## Full Pipeline Breakdown

Complete memory creation pipeline (~20 seconds total):

```text
┌────────────────────────────────────────────────────────────────┐
│                   Memory Creation Pipeline                     │
├────────────────────────────────────────────────────────────────┤
│ Step                    │ Latency      │ % of Total            │
├─────────────────────────┼──────────────┼───────────────────────┤
│ 1. shouldSave check     │ 533 ms       │ 2.7%                  │
│ 2. Classification       │ 310 ms       │ 1.6%                  │
│ 3. Embedding            │ 247 ms       │ 1.2%                  │
│ 4. Knowledge Graph      │ 8,155 ms     │ 40.8%                 │
│ 5. Memory Create        │ 10,745 ms    │ 53.7%                 │
│    ├─ Walrus Upload     │ ~3,000 ms    │                       │
│    └─ On-chain Tx       │ ~7,000 ms    │                       │
├─────────────────────────┼──────────────┼───────────────────────┤
│ TOTAL                   │ ~20,000 ms   │ 100%                  │
└─────────────────────────┴──────────────┴───────────────────────┘
```

### Optimization Tips

1. **Skip Knowledge Graph** - Disable if not needed (`enableKnowledgeGraph: false`)
2. **Batch Operations** - Use `embeddings.batch()` for multiple texts
3. **Pre-classify** - Cache classification results for repeated content types
4. **Local Index** - HNSW search is fast (~262ms) vs on-chain queries

---

## Size Metrics

### Data Sizes

| Component | Size | Notes |
|-----------|------|-------|
| **Embedding Vector** | 3,072 bytes | 768 dimensions × 4 bytes (Float32) |
| **Memory Package** | ~5-10 KB | Content + metadata + embedding |
| **Knowledge Graph** | ~1-5 KB | Entities + relationships JSON |
| **HNSW Index Entry** | ~30 bytes | Per vector (plus metadata) |

### Bundle Sizes

| Build | Size | Notes |
|-------|------|-------|
| **Browser Bundle** | ~2.5 MB | Includes hnswlib-wasm |
| **Node.js Bundle** | ~1.8 MB | Without WASM |
| **Minified** | ~800 KB | Gzipped |

### Index Capacity

| Parameter | Value |
|-----------|-------|
| Max Elements | 10,000 |
| Dimensions | 768 |
| M (connections) | 16 |
| efConstruction | 200 |
| Memory per 1K vectors | ~30 KB |

---

## Cost Estimates

### Sui Testnet Gas Costs

| Operation | Gas Cost | USD Estimate* |
|-----------|----------|---------------|
| **Create Memory** | ~0.003 SUI | ~$0.003 |
| **Update Memory** | ~0.002 SUI | ~$0.002 |
| **Delete Memory** | ~0.001 SUI | ~$0.001 |
| **Create MemoryCap** | ~0.005 SUI | ~$0.005 |
| **Grant Permission** | ~0.002 SUI | ~$0.002 |
| **Revoke Permission** | ~0.001 SUI | ~$0.001 |

*Estimated at SUI = $1.00. Actual costs vary with network conditions.

### Walrus Storage Costs

| Size | Estimated Cost |
|------|----------------|
| 1 KB | Free (testnet) |
| 10 KB | Free (testnet) |
| 100 KB | Free (testnet) |
| 1 MB | Free (testnet) |

> Note: Walrus testnet is currently free. Mainnet pricing TBD.

### AI API Costs (Gemini)

| Operation | Cost |
|-----------|------|
| Embedding (per 1K tokens) | ~$0.00001 |
| Classification (per request) | ~$0.0001 |
| Knowledge Graph (per request) | ~$0.001 |

---

## Throughput

### Operations per Second

| Operation | Throughput | Notes |
|-----------|------------|-------|
| **Embedding (batch)** | 26 texts/sec | 10-text batches |
| **Similarity calculations** | 909,091/sec | Local computation |
| **HNSW search** | ~4 queries/sec | 768-dim vectors |
| **Classification** | ~5/sec | With caching |

### Concurrency

| Scenario | Recommendation |
|----------|----------------|
| Single user | Sequential operations |
| Multi-user | Separate client instances |
| High throughput | Batch embedding + async ops |

---

## Running Benchmarks

### Quick Run

```bash
# Run all benchmarks
npm run test:e2e -- benchmark.spec.ts

# With verbose output
npx playwright test benchmark.spec.ts --reporter=list
```

### Individual Benchmarks

```bash
# Embedding only
npx playwright test benchmark.spec.ts -g "Embedding"

# Full pipeline
npx playwright test benchmark.spec.ts -g "Pipeline"

# Search
npx playwright test benchmark.spec.ts -g "Search"
```

### Custom Benchmarks

```typescript
import { SimplePDWClient } from 'personal-data-wallet-sdk';

// Measure embedding latency
const start = performance.now();
const embedding = await pdw.embeddings.generate('Test text');
const latency = performance.now() - start;
console.log(`Embedding latency: ${latency.toFixed(2)} ms`);

// Measure search latency
const searchStart = performance.now();
const results = await pdw.search.vector('query', { k: 5 });
const searchLatency = performance.now() - searchStart;
console.log(`Search latency: ${searchLatency.toFixed(2)} ms`);
```

---

## Environment

Benchmarks were run with:

- **Browser**: Chromium (Playwright)
- **Network**: Sui Testnet
- **AI Provider**: Google Gemini
- **Storage**: Walrus Testnet
- **Machine**: Windows 11 - WSL

---

## Related Documentation

- [README.md](./README.md) - Quick start guide
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Workflow diagrams
