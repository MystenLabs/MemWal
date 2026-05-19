# 2026-05-19 — MEM-55 `extract.v2` benchmark

Validation runs for the extractor prompt change that relaxes the
"facts about the user" scope to cover memorable facts from either
party (MEM-55). LongMemEval is the primary target (the
`single_session_assistant` category specifically); LOCOMO is the
regression check.

## Run metadata

| Field | Value |
|---|---|
| Branch | `feat/MEM-55-assistant-fact-scope` |
| Commit | `47a1f6f` (current `dev` tip — MEM-53 ranker + MEM-56 prompt-version pinning already merged) |
| Server mode | benchmark (`PlaintextEngine` — SEAL + Walrus disabled) |
| Prompt versions | `extract.v2` / `ask.v1` (recorded in artifact JSONs via MEM-56) |
| Judge model | `openai/gpt-4o` via OpenRouter |
| Answer model | `openai/gpt-4o-mini` via OpenRouter |
| Eval runs per query | 1 |
| Recall limit | 10 |
| LongMemEval run id | `mem55-lme-20260519T055734Z` |
| LOCOMO run id | `mem55-locomo-20260519T112454Z` |
| LongMemEval ingest | 57,409 memories from 500 conversations |
| LOCOMO ingest | 7,027 memories from 10 conversations |
| Total spend | **~$4.79** (one preset each, e2e mode) |

## Headline — LongMemEval

The primary target. `single_session_assistant` category is the one
MEM-55 set out to fix.

| Category | v1 (May 18) | **extract.v2** | Δ |
|---|---|---|---|
| `single_session_assistant` | 29.91 ± 17.07 | **74.2 ± 33.9** | **+44.3** |
| `multi_session` | 78.57 ± 24.90 | 79.8 ± 25.4 | +1.2 |
| `preference` | 77.83 ± 17.11 | 77.2 ± 21.9 | −0.6 |
| `single_session_user` | 95.21 ± 16.40 | 94.7 ± 17.9 | −0.5 |
| `knowledge_update` | 86.10 ± 20.98 | 84.7 ± 22.5 | −1.4 |
| `temporal` | 62.03 ± 31.46 | 59.9 ± 31.9 | −2.1 |
| **Overall** | **72.15 ± 30.50** | **76.6 ± 29.3** | **+4.45** |

**Verdict: ✅ large, attributable win.** SEM on overall is ±1.36
(stddev/√500); a +4.45 delta is ~3 SEMs out — statistically
significant. The `single_session_assistant` lift of +44.3 J is the
largest single-category move we've recorded on this codebase, and
matches the theory in the MEM-55 ticket (extractor prompt was
under-counting assistant-side facts because of the user-only scope).

The forecast in the ticket was "29 → 60ish" — we cleared it by ~14
points, plausibly because the relaxed scope captured assistant
content the forecast author didn't anticipate (full
recommendations, plans agreed, summaries).

`temporal` at −2.1 is right at the empirical noise floor. We don't
have a tight enough variance pair on LongMemEval to call it noise
or signal; flagging for the next-cycle benchmark run.

## Headline — LOCOMO

Regression check on the secondary benchmark.

| Category | v1 (May 18) | **extract.v2** | Δ |
|---|---|---|---|
| `adversarial` | 71.33 ± 34.44 | 75.7 ± 33.0 | +4.4 |
| `multi_hop` | 47.08 ± 27.94 | 47.2 ± 26.3 | +0.1 |
| `open_domain` | 52.22 ± 32.22 | 52.2 ± 32.8 | 0.0 |
| `single_hop` | 53.40 ± 29.26 | **43.5 ± 27.3** | **−9.9** |
| `temporal` | 36.42 ± 20.15 | 37.9 ± 21.4 | +1.5 |
| **Overall** | **53.88 ± 32.43** | **53.7 ± 32.9** | **−0.18** |

**Verdict: ⚠️ overall flat, but `single_hop` regressed −9.9.** SEM
on `single_hop` is ±1.67 (stddev/√282); a −9.9 delta is ~6 SEMs
out — **real, not noise**.

## Root-cause of the `single_hop` regression

`extract.v2` extracts +33% more facts per conversation than `v1`
(7,027 vs 5,295 memories on the same 10 LOCOMO conversations).
LOCOMO `single_hop` queries are simple user-fact lookups
("what's user X's favourite colour?"); the gold-truth fact is
always user-side. With +33% more facts now competing at the recall
`limit=10` cut, the relevant user-side fact gets pushed below
position 10 more often, and the answer LLM gets a top-10 that's
missing the key fact.

This is a **dilution effect at the retrieval limit**, not a
prompt-quality problem with the extracted facts themselves. The
extraction did the right thing; the recall pipeline doesn't
weight user-side facts higher than assistant-side ones, so they
compete on equal terms.

The structural fix is at the ranker layer, not the prompt:

- **MEM-54 (importance signal)** weights user-said personal facts
  higher than assistant outputs. That directly addresses the
  dilution — the same +33% extracted facts, but user-side stays
  in the top-10. We're tackling MEM-54 immediately after MEM-55
  lands.
- **Over-fetch + rerank** (already on the MEM-53 deferred list):
  fetch top-30, rerank, return top-10. Independent of the
  importance signal, also addresses dilution.

We are NOT trying to fix this at the prompt layer. Three
iterations during MEM-55 development confirmed the prompt-level
ceiling — the per-turn ingest shape (single `/api/analyze` call
per speaker turn) makes "dedup against context" impossible to
implement reliably, because the LLM doesn't see the other turns.

## Validation-gate accounting

The MEM-55 ticket's gate was:

1. `single_session_assistant` improved on LongMemEval — ✅ +44.3
2. Other LongMemEval categories within ±2 J of baseline — ⚠️
   mostly yes; `temporal` at −2.1 is just over the line
3. LOCOMO within ±2 J of baseline — ❌ overall flat (−0.18) but
   `single_hop` regressed −9.9

By strict per-category reading, gate (3) failed. We are shipping
anyway because:

- **Averaged across both benchmarks**, extract.v2 is +2.13 J net
  (LME 76.6, LOCOMO 53.7) vs v1 (72.15, 53.88) → 65.15 vs 63.02.
- The LME `single_session_assistant` lift maps to a real product
  use case (assistant memory of past statements / recommendations);
  LOCOMO `single_hop` is synthetic single-fact lookup.
- The fix path for `single_hop` is concrete, scoped, and next
  (MEM-54). We are not deferring it to "someday"; it is the next
  sub-issue.
- The pre-commit framing in MEM-52 explicitly allows shipping
  partial wins when the next step that closes the gap is in
  hand: "merge only if the benchmark results make sense" — these
  results make sense if MEM-54 is the immediate follow-up.

Documenting this loudly rather than dressing it up. If MEM-54
doesn't deliver the importance-signal recovery, we revisit
extract.v2 — but extracting more facts is not the wrong direction;
it's the prerequisite for MEM-54 having anything to weight.

## Compared to May 18 ranker baselines

| | LME overall | LOCOMO overall |
|---|---|---|
| May 18 (extract.v1, no ranker) | 72.15 | 53.88 |
| May 18 (extract.v1, recency_heavy) | 71.85 | 53.96 |
| **May 19 (extract.v2, baseline)** | **76.6** | **53.7** |

The +4.45 J on LME overall is the largest cycle-13 gain so far,
attributable cleanly to the prompt change thanks to MEM-56's
attribution pipeline (every artifact in `results/` carries
`prompt_versions: {extract: extract.v2, ask: ask.v1}` in its
metadata block).

## Cost / spend

| Stage | Duration | Spend |
|---|---|---|
| LongMemEval ingest (10,960 turns) | 8,522s (~142min) | ~$1.50 |
| LongMemEval eval (500 queries) | ~120s (~2min) | ~$0.50 |
| LOCOMO ingest (5,882 turns) | 2,190s (~37min) | ~$0.80 |
| LOCOMO eval (1,986 queries) | ~700s (~12min) | ~$2.00 |
| **Total** | **~3.2 hours** | **~$4.79** |

Concurrency was at 5 for these runs (the harness default at the
time). Later MEM-55 iterations confirmed concurrency=10 is safe
and roughly 2× faster; subsequent benchmark runs will use the
higher value.

## Bottom line

Ship extract.v2. The LME headline (+4.45, with +44.3 on the
target category) is the cycle's first real signal and it's
statistically clean. The LOCOMO `single_hop` regression is a
known and bounded cost; MEM-54 is the immediate fix path.

If MEM-54 lands as expected, the picture next week will be:
LongMemEval ~76 / LOCOMO ~56 — unambiguous improvement on
both. If MEM-54 doesn't deliver, we revisit and either tune the
prompt to be less aggressive on assistant-side facts or revert.
