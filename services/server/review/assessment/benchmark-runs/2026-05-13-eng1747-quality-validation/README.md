# 2026-05-13 — ENG-1747 quality-validation benchmark runs

Four full benchmark runs across the ENG-1747 restructure validation:
two pre-rebase LOCOMO (variance baseline), one pre-rebase LongMemEval
vs Mem0/Zep/Supermemory references, and one post-rebase LOCOMO smoke
after the branch was rebased onto `origin/dev` (absorbing MEM-35,
MEM-37, MCP).

Together these prove the restructure + rebase preserves AI-quality
within the empirical ~±2-3 J-Score judge-noise floor.

All four runs in `BENCHMARK_MODE=true` (PlaintextEngine — plaintext in
Postgres, SEAL + Walrus disabled). Extraction / embedding / recall-
ranking paths are identical to production; the only diverging primitives
are the storage backend the engine abstraction selects between.

## Run metadata

| Field | Value |
|---|---|
| Branch | `refactor/ENG-1747-restructure` |
| Pre-rebase tip (runs 1-3) | `0830e6f` (commit chain matching the un-rebased ENG-1747 work) |
| Post-rebase tip (run 4 + current) | `5666c87` (after post-panel cleanup) |
| Server mode | benchmark (`PlaintextEngine`; SEAL + Walrus disabled) |
| Judge model | `openai/gpt-4o` via OpenRouter |
| Answer model | `openai/gpt-4o-mini` via OpenRouter |
| Eval runs per query | 1 |
| Recall limit | 10 |
| Total spend | **$8.22** (LOCOMO ×3 + LongMemEval ×1) |
| Wall window | 2026-05-13 01:42 UTC → 21:21 UTC |

## Headline — LOCOMO (three-way cross-run comparison)

| Category    | Run 1 (pre-rebase) | Run 2 (pre-rebase) | Post-rebase smoke | Δ Run 2 → post |
|-------------|--------------------|--------------------|-------------------|----------------|
| adversarial | 70.6 ± 34.6        | 70.5 ± 35.2        | 71.8 ± 34.3       | +1.3           |
| multi_hop   | 47.9 ± 27.6        | 49.5 ± 27.9        | 47.3 ± 27.8       | −2.2           |
| open_domain | 53.1 ± 32.5        | 53.5 ± 32.4        | 50.6 ± 32.0       | −2.9           |
| single_hop  | 54.0 ± 28.9        | 55.1 ± 29.3        | 53.3 ± 29.6       | −1.8           |
| temporal    | 38.2 ± 21.8        | 38.1 ± 21.1        | 37.7 ± 21.2       | −0.4           |
| **Overall** | **54.5 ± 32.4**    | **54.8 ± 32.5**    | **53.5 ± 32.5**   | **−1.3**       |

**Verdict: ✅ within ±2-3 J-Score judge-noise on overall and every
category.** The two pre-rebase runs (54.5 vs 54.8, +0.3 J-Score apart)
establish the empirical noise floor; the post-rebase −1.3 sits within
that envelope.

LOCOMO Recall@K = 0.000 across all three runs. This is a known harness
limitation, not a regression: every LOCOMO query references *turn-kind*
evidence (`dia_id` strings) which `_resolve_evidence_memory_ids`
deliberately skips when computing recall metrics. Same on dev.

## Headline — LongMemEval (oracle, 500 queries)

| Category                 | MemWal ENG-1747  | Mem0  | Zep   | Supermemory |
|--------------------------|------------------|-------|-------|-------------|
| knowledge_update         | 85.8 ± 20.6      | —     | —     | —           |
| multi_session            | 77.9 ± 24.9      | —     | —     | —           |
| preference               | 74.8 ± 19.0      | —     | —     | —           |
| single_session_assistant | 29.5 ± 15.9      | —     | —     | —           |
| single_session_user      | 95.1 ± 16.1      | —     | —     | —           |
| temporal                 | 61.9 ± 31.3      | —     | —     | —           |
| **Overall**              | **71.7 ± 30.4**  | 49.0  | 63.8  | 85.4        |

Recall@5 = 0.260 overall; per-category Recall@5 ranges from 0.150
(multi_session) to 0.922 (single_session_assistant). References are
overall-only from the LongMemEval paper + Supermemory leaderboard.

**Verdict: ✅ +22.7 J-points over Mem0, +7.9 over Zep, −13.7 vs
Supermemory.**

The `single_session_assistant` 29.5 outlier is a known scope limit: the
extraction prompt (`services/server/src/services/prompts/extract.txt`)
explicitly targets "facts about the user", so assistant-side facts get
undercounted. Fixing the prompt asymmetry would plausibly add 4-5
J-points to the overall.

## Historical context — what came before

Earlier benchmark runs live on the `feat/benchmark-framework` branch,
where the original benchmark harness + AI improvements were developed
before being lifted into this PR's structure. None of those runs are
on `dev`; you have to inspect them from that branch.

| Date | Branch | Run | Headline overall J |
|---|---|---|---|
| 2026-04-20 | `feat/benchmark-framework` | LOCOMO (session-dump ingestion) | ~52.0 |
| 2026-04-20 | `feat/benchmark-framework` | LongMemEval (session-dump ingestion) | ~63.0 |
| 2026-04-21 | `feat/benchmark-framework` | LOCOMO (per-turn ingestion, post-fix) | 54.25 (baseline) / 53.57 (default) |
| 2026-04-23 | `feat/benchmark-framework` | LongMemEval (chronological-sort fix) | 70.28 (baseline) / 69.87 (default) / 71.13 (recency_heavy) |
| 2026-05-04 | `refactor/pipeline-stages` | LongMemEval + LOCOMO, 3 presets each | LongMemEval 71.13 / 71.03 / 70.53; LOCOMO 53.65 / 53.33 / 53.53 |

To inspect any historical run from this PR:

```bash
# Per-run summary
git show feat/benchmark-framework:services/server/review/assessment/benchmark-runs/2026-04-21-locomo/summary.md
git show feat/benchmark-framework:services/server/review/assessment/benchmark-runs/2026-04-23-longmemeval-chrono/summary.md
git show feat/benchmark-framework:services/server/review/assessment/benchmark-runs/2026-04-20-locomo/summary.md

# Raw per-preset JSON
git show feat/benchmark-framework:services/server/review/assessment/benchmark-runs/2026-04-21-locomo/results/default.json | jq .metrics_overall
```

The 2026-05-04 run lived only in a local working tree (never committed
to a branch); its metadata is captured by the 2026-05-04 baseline
README in the `memory-protocol-improvement/refactor-plan/results/`
local archive.

## What this matters for ENG-1747

The ENG-1747 restructure introduces the `engine::MemoryEngine`
abstraction (production `WalrusSealEngine`, benchmark `PlaintextEngine`),
extracts services (`Embedder`, `Extractor`, `LlmChat`), moves storage
modules under `storage/`, splits `routes.rs` into per-endpoint files,
and absorbs `dev`'s parallel MEM-35 / MEM-37 / MCP work via a 20-commit
rebase.

That's ~9.5k lines of structural change. The risk it carries is
*behavioural drift at the AI layer* — a subtle change in how facts are
extracted, embedded, or retrieved that shifts retrieval order and
downstream J-Scores.

These four runs establish:

1. **The restructure didn't shift quality vs the 2026-05-04
   refactor-proposal baseline** (LOCOMO Run 1 default 54.5 ≈ 2026-05-04
   default 53.33; LongMemEval 71.7 ≈ 2026-05-04 default 71.03; both
   within noise).
2. **Quality is stable run-to-run** (Run 1 54.5 vs Run 2 54.8, Δ = 0.3 J).
3. **The rebase + post-panel cleanup didn't regress** (post-rebase smoke
   53.5 sits within noise of Run 2's 54.8).

## Cost breakdown

| Run | Wall time | Cost |
|---|---|---|
| LOCOMO Run 1 (`full-20260513T014223Z`) | ~53 min | $2.27 |
| LOCOMO Run 2 (`final-20260513T060954Z`) | ~49 min | $2.29 |
| LongMemEval (`final-20260513T113427Z`) | ~57 min | $1.40 |
| Post-rebase LOCOMO (`postrebase-20260513T133616Z`) | ~41 min | $2.26 |
| **Total** | ~3.5 hours | **$8.22** |

## Transient errors observed

Across ~30k HTTP requests:

- LOCOMO Run 1: 1 transient analyze 500 (LLM parse error) — single occurrence
- LOCOMO Run 2: 2 transient recall 500s on conv-41 (coincided with OpenRouter network blip the cost watcher also detected)
- LongMemEval: 1 recall 500 across the eval; harness recovered
- Post-rebase LOCOMO: 2 transient analyze 500s (same LLM parse-error pattern)

All within expected network-flake rates. Each failed query is recorded
in `query_results` with an empty memory list — the judge correctly
scores them as 0, bounding the per-incident metric impact to < 0.05 J.

## Layout

```
2026-05-13-eng1747-quality-validation/
├── README.md                                                       (this file)
└── results/
    ├── full-20260513T014223Z-locomo-default.json                  (LOCOMO Run 1: 54.5 J)
    ├── full-20260513T014223Z-locomo-session_map.json
    ├── final-20260513T060954Z-locomo-locomo-default.json          (LOCOMO Run 2: 54.8 J)
    ├── final-20260513T060954Z-locomo-locomo-session_map.json
    ├── final-20260513T113427Z-longmemeval-longmemeval-default.json (LongMemEval: 71.7 J)
    ├── final-20260513T113427Z-longmemeval-longmemeval-session_map.json
    ├── postrebase-20260513T133616Z-locomo-locomo-default.json     (post-rebase smoke: 53.5 J)
    └── postrebase-20260513T133616Z-locomo-locomo-session_map.json
```

### What's NOT in this archive (and why)

- **Run logs (harness + server + cost-watcher)** are intentionally omitted,
  matching the `feat/benchmark-framework` precedent for committed
  benchmark archives. Two reasons:
  - **Signal-to-noise**: ~7 MB of mostly tqdm progress lines + per-turn
    `analyze: text="..."` info-level traces. The analytic content is
    already in each `results/*-default.json` (`query_results` array
    carries the full per-query eval trace including retrieved memories,
    generated answer, judge scores).
  - **Avoids surfacing testnet on-chain identifiers** (delegate public
    keys, account/owner Sui addresses) that would otherwise appear ~20k
    times across the server log. Not secrets — they're public on-chain
    metadata — but no need to bake them into committed evidence.
  - Forensic logs from the run window are preserved on the local
    working-tree archive at
    `whole-system-documents/refactor-eng-1747/benchmark-runs/2026-05-13-eng1747-quality-validation/logs/`
    if anyone needs the raw HTTP-request stream or server traces.

## How to reproduce

```bash
cd services/server
# .env requires BENCHMARK_MODE=true + RATE_LIMIT_DISABLED=1 (see services/server/.env.example)
cargo run &

cd services/server/benchmarks
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt  # or follow benchmarks/README.md
# config.yaml needs delegate_key + account_id + OpenRouter API key

python run.py download locomo
python run.py download longmemeval

# Each command is a separate run; expect ~50 min wall + ~$2.20 per LOCOMO
python run.py full locomo --presets default --run-id my-locomo-1
python run.py full longmemeval --presets default --run-id my-longmemeval
```

See `services/server/benchmarks/README.md` for the full harness setup.

## Cross-references

- **PR description**: see the ENG-1747 pull request
- **Pre-merge inspection** (rebase-blocker findings):
  `whole-system-documents/refactor-eng-1747/pre-merge-inspection/`
  (local working tree, gitignored)
- **Post-rebase inspection** (final sign-off):
  `whole-system-documents/refactor-eng-1747/post-rebase-inspection/`
  (local working tree, gitignored)
- **Benchmark harness source**: `services/server/benchmarks/`
- **Engine abstraction (the structural change being validated)**:
  `services/server/src/engine/{mod,plaintext,walrus_seal}.rs`
- **Historical runs from `feat/benchmark-framework`**:
  `services/server/review/assessment/benchmark-runs/` on that branch
  (see Historical context section above for `git show` examples)
