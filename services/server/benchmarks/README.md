# MemWal Retrieval Quality Benchmarks

Measure and compare MemWal's retrieval quality against published baselines (Mem0, Zep, Supermemory) using industry-standard benchmarks.

## Benchmarks

| Benchmark | What it tests | Comparable to |
|---|---|---|
| **LOCOMO** | Core retrieval across 4 query types | Mem0 paper (J-scores) |
| **LongMemEval** | Knowledge updates, temporal reasoning, abstention | Supermemory, Zep, Mem0 |
| **ConvoMem** | Scale (1-300 conversations), preference handling | Salesforce baselines |

## Quick Start

```bash
# Setup
cd services/server/benchmarks
python -m venv .venv && source .venv/bin/activate
pip install -e .

# Configure
cp config.example.yaml config.yaml
# Edit config.yaml: fill in server URL, delegate key, account ID, API keys

# Download + run LOCOMO with 3 scoring presets
python run.py download locomo
python run.py full locomo --presets baseline,default,recency_heavy

# View results
python run.py report --benchmark locomo
```

## How It Works

### Pipeline

```
DOWNLOAD → INGEST → RECALL → EVALUATE → REPORT
   ↓          ↓        ↓         ↓          ↓
  fetch    /api/     /api/    LLM judge   markdown
  dataset  analyze   recall   (GPT-4o)    tables
```

### Key Design: Ingest Once, Recall Many

Scoring weights are per-request parameters in `/api/recall`. The same stored memories can be recalled with different weight configurations without re-ingestion.

```bash
# This ingests once, then evaluates 3 presets against the same memories
python run.py full locomo --presets baseline,default,recency_heavy
```

### Scoring Presets

| Preset | Semantic | Importance | Recency | Frequency | Tests |
|---|---|---|---|---|---|
| `baseline` | 1.0 | 0.0 | 0.0 | 0.0 | Pure cosine (pre-upgrade equivalent) |
| `default` | 0.5 | 0.2 | 0.2 | 0.1 | MemWal's default composite |
| `recency_heavy` | 0.3 | 0.2 | 0.4 | 0.1 | Temporal query optimization |
| `importance_heavy` | 0.3 | 0.4 | 0.2 | 0.1 | Critical fact retrieval |

### Evaluation Modes

**Retrieval-only** (`--mode retrieval`): Compute Recall@K, MRR, nDCG. Fast, cheap, diagnostic — tests whether the right memories surface.

**End-to-end** (`--mode e2e`, default): Generate answers from recalled memories, then judge against ground truth. Produces J-scores comparable to Mem0's published numbers.

## Commands

```bash
# Download a benchmark dataset
python run.py download locomo|longmemeval|convomem

# Ingest conversations (run once per benchmark)
python run.py ingest locomo --run-id my-run

# Evaluate with a single scoring preset
python run.py eval locomo --preset default --run-id my-run

# Compare multiple presets (reuses same ingestion)
python run.py compare locomo --presets baseline,default --run-id my-run

# Full run: ingest + compare
python run.py full locomo --presets baseline,default,recency_heavy

# View results
python run.py report --benchmark locomo

# Clean up benchmark data
python run.py cleanup --run-id my-run
```

## Results

Results are saved as JSON artifacts in `results/`. Each artifact contains:
- Full config (weights, models, limits)
- Per-query results (retrieved memories, generated answer, judgment scores)
- Aggregate metrics by category
- Cost tracking (tokens, estimated USD)

## Cost Estimates

| Benchmark | Ingestion | Eval per preset | Total (4 presets) |
|---|---|---|---|
| LOCOMO | ~$0.15 | ~$3 | ~$12 |
| LongMemEval | ~$0.10 | ~$1 | ~$4 |
| ConvoMem (subset) | ~$0.50 | ~$10 | ~$41 |

## Running Tests

```bash
# Verify metric calculations
pytest tests/ -v
```
