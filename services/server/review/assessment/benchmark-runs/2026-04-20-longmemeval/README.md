# LongMemEval Benchmark Run — 2026-04-20

| | |
|---|---|
| **Run ID** | `2026-04-20-164601` |
| **Benchmark** | LongMemEval oracle (UMass/Microsoft, ICLR 2025) — 500 QA pairs |
| **Branch** | `feat/benchmark-framework` |
| **Mode** | `BENCHMARK_MODE=true` |
| **Judge** | GPT-4o via OpenRouter |
| **Answer model** | GPT-4o-mini via OpenRouter |
| **Total cost** | ~$2.20 OpenRouter |
| **Total runtime** | ~30 minutes (22 min ingest + ~8 min eval) |

---

## TL;DR

**MemWal beats Mem0 and Zep on LongMemEval.** Overall J-score 65.90 for the default composite scoring preset — above Mem0 (49.0) and Zep (63.8), below Supermemory (85.4).

More importantly: **composite scoring now works**. Unlike LOCOMO where baseline beat every composite preset, on LongMemEval the composite default wins (65.90 vs 65.17 baseline). The difference is that LongMemEval has real timestamps and focused haystacks, so MemWal's recency and importance signals actually have discriminative power.

| Category | Baseline | Default | Recency | Best |
|---|---|---|---|---|
| single_session_user | 84.9 | 83.6 | 83.8 | Baseline |
| single_session_assistant | 30.4 | 30.7 | 30.8 | Recency |
| preference | 68.5 | **72.7** | 71.7 | Default |
| multi_session | 74.7 | **75.7** | 72.7 | Default |
| temporal | 54.7 | **55.9** | 55.5 | Default |
| knowledge_update | 72.7 | **73.1** | 73.0 | Default |
| **Overall** | 65.17 | **65.90** | 64.98 | Default |

Bold = best score per row. Default composite wins 4 of 6 categories.

---

## Documents in this folder

| Document | Purpose |
|---|---|
| [summary.md](./summary.md) | 2-page overview + comparison with LOCOMO findings |
| [detailed-report.md](./detailed-report.md) | Full analysis — what LongMemEval is, per-category breakdown |

---

## Raw artifacts

| File | Preset | Size |
|---|---|---|
| [results/baseline.json](./results/baseline.json) | `semantic=1.0, rest=0` | ~1.4 MB |
| [results/default.json](./results/default.json) | `0.5/0.2/0.2/0.1` | ~1.4 MB |
| [results/recency_heavy.json](./results/recency_heavy.json) | `0.3/0.2/0.4/0.1` | ~1.4 MB |

---

## Reproducing

```bash
cd services/server/benchmarks
source .venv/bin/activate
python run.py download longmemeval
python run.py full longmemeval --presets baseline,default,recency_heavy
```
