# MemWal Retrieval Quality Benchmarks

A Python harness that runs industry-standard memory benchmarks (LOCOMO, LongMemEval) against MemWal and compares composite scoring presets against pure cosine similarity. Results are saved as JSON artifacts with per-query detail for inspection.

**Current supported benchmarks:**

| Benchmark | Status | Typical cost | Runtime |
|---|---|---|---|
| LOCOMO | ✅ Validated | ~$9 | 90 min |
| LongMemEval | ✅ Validated | ~$2 | 30 min |

**Completed runs** are archived in `../review/assessment/benchmark-runs/`.

---

## The two-config story

Running a benchmark involves two cooperating systems, each with its own config:

```
┌──────────────────────────┐          ┌──────────────────────────┐
│   MemWal server (Rust)   │  ◄────── │   Benchmark harness      │
│                          │   HTTP    │   (this directory)       │
│   config: ../.env        │          │   config: config.yaml    │
└──────────────────────────┘          └──────────────────────────┘
        must run first                      runs against it
```

**MemWal server** reads from `services/server/.env`. For benchmarks this needs `BENCHMARK_MODE=true` and bumped rate limits. See `services/server/.env.example` for the benchmark section at the bottom.

**Benchmark harness** reads from `benchmarks/config.yaml`. This holds credentials for the MemWal server (delegate key + account ID) and the LLM provider (API key for GPT-4o judge). See `benchmarks/config.example.yaml`.

Don't confuse the two. The benchmark harness does **not** read the server's `.env`, and the server does **not** read `config.yaml`.

---

## Prerequisites

1. **MemWal server running locally with `BENCHMARK_MODE=true`.** This is critical — see [Server setup for benchmarks](#server-setup-for-benchmarks) below.
2. **Postgres + Redis.** Start via `docker compose -f services/server/docker-compose.yml up -d`.
3. **Python 3.9+** (tested on 3.9).
4. **A registered MemWal account** with a delegate key. Get one from the memwal app or via the SDK.
5. **An OpenRouter or OpenAI API key** with GPT-4o access.

---

## Server setup for benchmarks

Benchmarks need the MemWal server configured specifically. In `services/server/.env`:

```bash
# Required — enables the plaintext storage backend that bypasses
# SEAL encryption and Walrus upload. This makes the server safe to
# benchmark (no real blockchain interactions) but UNSAFE for
# production data.
BENCHMARK_MODE=true

# Required — default rate limits are too low for parallel
# benchmark workers. These override the defaults in rate_limit.rs.
RATE_LIMIT_REQUESTS_PER_MINUTE=100000
RATE_LIMIT_REQUESTS_PER_HOUR=1000000
RATE_LIMIT_DELEGATE_KEY_PER_MINUTE=100000
```

Apply migration 005 (adds the `plaintext` column):

```bash
cd services/server
DATABASE_URL=postgresql://memwal:memwal_secret@localhost:5432/memwal cargo sqlx migrate run
```

Start the server:

```bash
cd services/server && cargo run
```

Look for this in the startup logs — the loud warning banner confirms benchmark mode is active:

```
WARN BENCHMARK_MODE=true — blockchain layer DISABLED
  - SEAL encryption: SKIPPED
  - Walrus upload/download: SKIPPED
  - Plaintext stored directly in Postgres
DO NOT RUN THIS CONFIGURATION IN PRODUCTION
```

---

## Benchmark harness setup

```bash
cd services/server/benchmarks

# Create venv (Python 3.9+)
python3 -m venv .venv
source .venv/bin/activate

# Install deps directly (don't use pip install -e on Python 3.9)
pip install datasets openai httpx pynacl numpy pyyaml tabulate tqdm pytest huggingface_hub

# Configure
cp config.example.yaml config.yaml
# Edit config.yaml: delegate_key, account_id, OpenRouter API key
```

Verify your config and server connection:

```bash
python run.py report  # lists what's in results/
```

If the harness can't reach the server, you'll see `ERROR: Cannot reach server at http://localhost:3001`.

---

## Running a benchmark

One-time per benchmark — download the dataset:

```bash
python run.py download locomo
python run.py download longmemeval
```

The `full` command runs ingestion + evaluation for all specified presets:

```bash
python run.py full locomo --presets baseline,default,recency_heavy
python run.py full longmemeval --presets baseline,default,recency_heavy
```

Available presets (in `presets/`):
- `baseline` — pure cosine (`semantic=1.0`, rest=0)
- `default` — MemWal's recommended weights (`0.5/0.2/0.2/0.1`)
- `recency_heavy` — for temporal-focused benchmarks (`0.3/0.2/0.4/0.1`)
- `importance_heavy` — prioritizes high-importance memories (`0.3/0.4/0.2/0.1`)

### Splitting ingestion and eval

Ingestion is expensive (~20-40 min). Evaluation is cheap (~3-10 min per preset). Split them if you want to iterate on scoring:

```bash
# Run ingestion once
python run.py ingest longmemeval --run-id my-run
# Reuse that ingestion across multiple eval passes
python run.py compare longmemeval --presets baseline,default --run-id my-run --skip-ingest
python run.py compare longmemeval --presets recency_heavy,importance_heavy --run-id my-run --skip-ingest
```

### Cleaning up

```bash
python run.py cleanup --run-id my-run
```

This soft-deletes all memories in the run's benchmark namespaces.

---

## Interpreting results

Each preset run produces a JSON artifact in `results/` with:
- Full config (scoring weights, models, timestamp)
- Per-query details (question, ground truth, retrieved memories, generated answer, judge scores)
- Aggregate metrics overall and by category

Read the run's `summary.md` and `detailed-report.md` in `../review/assessment/benchmark-runs/<date>-<benchmark>/` for:
- Comparison tables across presets
- Comparison with published numbers (Mem0, Zep, Supermemory)
- Per-category analysis and failure examples
- Root cause analysis when numbers don't match expectations

### J-score interpretation

The LLM judge scores 4 dimensions (1-5 each), normalized to 0-100:

| J-score | Meaning |
|---|---|
| 80+ | Strong — answer is factually correct and complete |
| 50-79 | Partial — right direction, missing details |
| <50 | Failed — wrong, empty, or hallucinated |

Variance across runs is ~±2-3 points due to judge non-determinism. Retrieval itself is deterministic given fixed weights.

---

## Troubleshooting

### 401 Unauthorized
- Delegate key not registered on-chain for the account_id — use the app or SDK to register
- Account ID mismatch — double-check `x-account-id` matches the account where the key is registered

### 429 Too Many Requests
- Rate limits too low — add the `RATE_LIMIT_*` overrides in `services/server/.env`
- Reduce `eval_concurrency` in `config.yaml`

### Server unreachable
- Server not running — check `cargo run` output in `services/server/`
- Wrong URL in `config.yaml`

### BENCHMARK_MODE warnings missing from startup
- `.env` didn't load — check you're in `services/server/` when running `cargo run`
- Typo — it's `BENCHMARK_MODE=true`, case-sensitive

### Python 3.9 install errors
- `pip install -e .` fails — don't use editable install on 3.9
- Use the direct install in the setup section

---

## Architecture

```
benchmarks/
  run.py                   # CLI: download / ingest / eval / compare / full / report / cleanup
  config.example.yaml      # Template — copy to config.yaml and fill in
  config.yaml              # Your credentials (gitignored)
  pyproject.toml

  core/
    types.py               # Shared dataclasses (Conversation, Query, ...)
    client.py              # MemWal HTTP client with Ed25519 signing
    metrics.py             # Recall@K, MRR, nDCG, F1
    judge.py               # LLM-as-Judge with fixed prompts (don't modify between runs)
    report.py              # Markdown comparison table generator

  benchmarks/              # One adapter per benchmark
    base.py                # BenchmarkAdapter contract
    locomo.py              # ✅ validated
    longmemeval.py         # ✅ validated

  presets/                 # Scoring weight configurations
    baseline.yaml
    default.yaml
    recency_heavy.yaml
    importance_heavy.yaml

  datasets/                # Downloaded datasets (gitignored)
  results/                 # Raw run artifacts (gitignored — archived copies live
                           # in ../review/assessment/benchmark-runs/ instead)
  tests/
    test_metrics.py        # Unit tests for metric implementations
```

### Key design choice: ingest once, score many

Scoring weights are **per-request parameters** in `/api/recall`. Ingestion is done once, then any number of scoring presets can be evaluated against the same stored memories without re-ingesting. This is why `full` command runs ingestion then loops over presets.

### Adding a new benchmark

1. Download a sample of the real dataset — **never** guess schema
2. Create `benchmarks/<name>.py` subclassing `BenchmarkAdapter`
3. Implement `download()` and `load()` — `load()` must return `(list[Conversation], list[Query])` with correct category names matching your `categories` class attribute
4. Add to `benchmarks/__init__.py` `BENCHMARKS` dict
5. Add `VALIDATED = True` once you've run at least 10 queries end-to-end
6. Run `python run.py full <name> --presets baseline` on a small slice to sanity check

See `locomo.py` and `longmemeval.py` for reference implementations. Both had schema surprises vs the HuggingFace documentation — inspecting the real files first prevented wasted API calls.

---

## Running the tests

```bash
source .venv/bin/activate
PYTHONPATH=. pytest tests/ -v
```

All 20 metric tests should pass.
