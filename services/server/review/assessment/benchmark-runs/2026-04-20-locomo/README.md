# LOCOMO Benchmark Run — 2026-04-20

| | |
|---|---|
| **Run ID** | `2026-04-20-130136` |
| **Benchmark** | LOCOMO (Snap Research, ICLR 2025) — 10 conversations, 1,986 QA pairs |
| **Branch** | `feat/benchmark-framework` (from `feat/memory-structure-upgrade`) |
| **Commit** | `97f62ec` (SQL injection P0 fix) + benchmark framework (uncommitted at run time) |
| **Mode** | `BENCHMARK_MODE=true` — blockchain layer stripped (see [code review](../../benchmark-mode-code-review.md)) |
| **Judge** | GPT-4o via OpenRouter (LLM-as-Judge, 4-dimension J-score 0-100) |
| **Answer model** | GPT-4o-mini via OpenRouter |
| **Total cost** | ~$10.50 OpenRouter |
| **Total runtime** | ~90 minutes (40 min ingestion + ~35 min eval) |

---

## TL;DR

MemWal's composite scoring does NOT outperform pure cosine similarity on LOCOMO. Our overall J-score is ~52, significantly below Mem0's published numbers (55-73 across categories). The primary failure mode is **retrieval miss** (right memory not in the top K), not ranking quality. This points to issues upstream of scoring — either extraction quality or embedding coverage.

| Category | Baseline | Default | Recency | Mem0 Paper |
|---|---|---|---|---|
| single_hop | **46.7** | 45.3 | 43.1 | 67.13 |
| multi_hop | **50.2** | 49.6 | 45.9 | 51.15 |
| temporal | **32.5** | 30.6 | 30.5 | 55.51 |
| open_domain | **45.3** | 43.3 | 41.4 | 72.93 |
| adversarial | 82.5 | 85.2 | **86.5** | — |
| **Overall** | **52.01** | 51.28 | 50.23 | — |

Bold = best non-adversarial score per row. Baseline (pure cosine) wins every substantive category.

---

## Documents in this folder

| Document | Purpose | Audience |
|---|---|---|
| [summary.md](./summary.md) | 2-page overview + headline numbers | Stakeholders, quick read |
| [detailed-report.md](./detailed-report.md) | Full analysis — what LOCOMO is, how we ran it, per-category breakdown with example failures | Engineering review |
| [root-cause.md](./root-cause.md) | Why we underperform — traced to 3 specific code paths | Fix planning |

**Reading order** depends on your goal:
- **Quick read (5 min)**: [summary.md](./summary.md)
- **Understand the findings (20 min)**: [detailed-report.md](./detailed-report.md)
- **Plan improvements (15 min)**: [root-cause.md](./root-cause.md) + relevant sections of detailed-report.md

---

## Raw artifacts

`results/` contains the full JSON artifacts from each of the three preset evaluations.

| File | Preset | Size | Contents |
|---|---|---|---|
| [results/baseline.json](./results/baseline.json) | `semantic=1.0, rest=0` | ~6.2 MB | All 1,986 queries with retrieved memories, generated answer, judge scores |
| [results/default.json](./results/default.json) | `0.5/0.2/0.2/0.1` | ~6.1 MB | Same |
| [results/recency_heavy.json](./results/recency_heavy.json) | `0.3/0.2/0.4/0.1` | ~6.2 MB | Same |

### Artifact schema

Each file is a `RunArtifact` from `benchmarks/core/types.py`:

```json
{
  "run_id": "2026-04-20-130136",
  "timestamp": "2026-04-20T...",
  "git_commit": "...",
  "benchmark": "locomo",
  "preset": "baseline",
  "config": { "scoring_weights": {...}, "recall_limit": 10, ... },
  "metrics_overall": { "j_score_mean": 52.01, ... },
  "metrics_by_category": { "single_hop": {...}, ... },
  "query_results": [
    {
      "query": { "query_id": "conv-26/q-0000", "question": "...", "category": "temporal", ... },
      "retrieved_memories": [
        { "memory_id": "...", "text": "...", "score": 0.823, ... }
      ],
      "generated_answer": "The memories do not contain...",
      "judgment": { "factual_accuracy": 1, "relevance": 1, ..., "j_score": 20.0 },
      "retrieval_metrics": {...}
    }
  ]
}
```

These files are the evidence supporting every claim in the reports. If someone questions "is MemWal really scoring 32 on temporal?", the answer is in `results/baseline.json`.

---

## Reproducing this run

```bash
cd services/server/benchmarks
source .venv/bin/activate

# 1. Start MemWal server with BENCHMARK_MODE=true (see services/server/.env.example)
# 2. Fill in config.yaml (delegate key, account ID, OpenRouter key)
# 3. Download LOCOMO
python run.py download locomo

# 4. Run with the same 3 presets
python run.py full locomo --presets baseline,default,recency_heavy
```

**Notes**:
- Run-to-run variance: the ingestion phase's LLM fact extraction is non-deterministic (temperature=0.1). Expect J-score mean to vary by ±2-3 points between runs.
- The LLM judge (GPT-4o) is also slightly non-deterministic. We ran `eval_runs=1` per query to save cost; bump to 3+ for variance bars on published results.
- Ingestion can be reused across preset comparisons via `--skip-ingest --run-id <id>` (scoring weights are per-request).
