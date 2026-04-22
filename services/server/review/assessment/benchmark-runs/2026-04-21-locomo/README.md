# LOCOMO Benchmark Run — 2026-04-21 (per-turn ingestion)

| | |
|---|---|
| **Run ID** | `2026-04-21-175529` |
| **Benchmark** | LOCOMO (Snap Research, ICLR 2025) — 10 conversations, 1,986 QA pairs |
| **Branch** | `feat/benchmark-framework` |
| **Mode** | `BENCHMARK_MODE=true` |
| **Ingestion strategy** | **Per-turn** (one `/api/analyze` call per turn) |
| **Presets** | baseline, default (composite) — skipped recency_heavy (recency signal still dead without `created_at_override`) |
| **Judge** | GPT-4o via OpenRouter |
| **Answer model** | GPT-4o-mini via OpenRouter |
| **Total cost** | ~$4.42 OpenRouter |
| **Total runtime** | ~55 minutes (33 min ingestion + 22 min eval) |

---

## TL;DR

**Per-turn ingestion fixes a benchmark adapter flaw we discovered after the 2026-04-20 session-dump run.** The MemWal SDK (`withMemWal` wrapper) drives `/api/analyze` one user message at a time in production, and Mem0 evaluates LOCOMO the same way. Yesterday's session-dump adapter fed 17-23 turns at once into a single `/api/analyze` call — overwhelming the extractor and producing a 53% "no info" rate. Today's per-turn adapter matches real SDK behavior and closes roughly half the gap with Mem0.

| | Yesterday (session-dump) | Today (per-turn) | Δ |
|---|---|---|---|
| Overall J — baseline | 52.01 | **54.25** | **+2.24** |
| Overall J — default composite | 51.28 | **53.57** | **+2.29** |
| No-info rate (baseline) | 53.0% | **40.2%** | **-12.8 pp** |
| Memories extracted | 1,654 | **4,410** | **2.7×** |

Every substantive category improved. Adversarial regressed -7.8 (expected tradeoff — richer extraction means the LLM tries to answer unanswerable questions instead of correctly abstaining).

---

## Per-category comparison

| Category | Yesterday Baseline | **Today Baseline** | ΔB | Yesterday Default | **Today Default** | ΔD | Mem0 Paper |
|---|---|---|---|---|---|---|---|
| single_hop | 46.7 | **54.3** | **+7.6** | 45.3 | **50.9** | +5.6 | 67.13 |
| multi_hop | 50.2 | **52.9** | +2.7 | 49.6 | **53.4** | +3.8 | 51.15 |
| temporal | 32.5 | **36.6** | +4.1 | 30.6 | **37.3** | +6.6 | 55.51 |
| open_domain | 45.3 | **50.3** | +5.0 | 43.3 | **47.6** | +4.2 | 72.93 |
| adversarial | 82.5 | 74.7 | -7.8 | 85.2 | 78.3 | -6.9 | — |
| **Overall** | **52.01** | **54.25** | **+2.24** | **51.28** | **53.57** | **+2.29** | — |

**Headline on multi_hop**: **today's default (53.4) beats Mem0's reported 51.15 by +2.3** — first category where MemWal has a legitimate apples-to-apples edge.

Remaining gaps to Mem0 (single_hop -12.8, temporal -18.2, open_domain -22.6) are now almost entirely attributable to a specific architectural difference — see `root-cause.md`.

---

## What changed in the framework

This run is made possible by two code changes committed alongside this folder:

1. **`benchmarks/base.py`** — added `build_ingest_text_per_turn()` helper alongside the pre-existing `build_ingest_text_naive_concat()`. LOCOMO and LongMemEval adapters both opt into per-turn.
2. **`run.py` `stage_ingest`** — parallelism restructured: serial-within-conversation, parallel-across-conversations. Matches Mem0's eval protocol and avoids advisory-lock contention on shared namespaces.

---

## Documents in this folder

| Document | Purpose |
|---|---|
| [summary.md](./summary.md) | 2-page overview comparing vs yesterday + vs Mem0 |
| [detailed-report.md](./detailed-report.md) | Full analysis with per-category breakdown |
| [root-cause.md](./root-cause.md) | Why we still trail Mem0 on 3 of 4 categories |

---

## Raw artifacts

| File | Preset | Size |
|---|---|---|
| [results/baseline.json](./results/baseline.json) | `semantic=1.0, rest=0` | ~6.1 MB |
| [results/default.json](./results/default.json) | `0.5/0.2/0.2/0.1` | ~6.1 MB |
| [results/session_map.json](./results/session_map.json) | Session→memory-id mapping from ingestion | ~196 KB |

The session map lets Recall@K metrics resolve evidence (unused here since LOCOMO's evidence is turn-level, not session-level).

---

## Reproducing

```bash
cd services/server/benchmarks
source .venv/bin/activate
python run.py download locomo                           # one-time
python run.py full locomo --presets baseline,default    # ~55 min, ~$4.50
```
