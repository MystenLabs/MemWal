# 2026-05-18 — Composite reranker (recency) re-benchmark

Re-benchmark after landing four post-review improvements on the
`feat/ranker-composite-scoring` branch:

1. `zip_created_at_onto_hydrated` helper — deduplicates the
   `created_at` zip between `recall.rs` and `admin.rs::ask`.
2. `ScoringWeights::validate()` — returns 400 for NaN / infinite /
   out-of-range / `recency_half_life_days <= 0 when recency > 0`.
3. `tracing::info!` breadcrumb when the ranker is active
   (`recency.abs() >= EPSILON`). Default (no-op) requests stay quiet.
4. `RecallResult.score: Option<f64>` exposed on the wire,
   `#[serde(skip_serializing_if = "Option::is_none")]` so the field
   only appears when the composite scoring actually ran.

Goal: confirm none of the improvements regress against the May 14
ranker run (LOCOMO 54.5 baseline / 54.5 recency_heavy; LongMemEval
72.4 baseline / 71.9 recency_heavy), and re-validate the no-op
short-circuit invariant.

## Run metadata

| Field | Value |
|---|---|
| Branch | `feat/ranker-composite-scoring` |
| Commit | `ad074f0` |
| Server mode | benchmark (`PlaintextEngine` — SEAL + Walrus disabled) |
| Judge model | `openai/gpt-4o` via OpenRouter |
| Answer model | `openai/gpt-4o-mini` via OpenRouter |
| Eval runs per query | 1 |
| Recall limit | 10 |
| LOCOMO run id | `ranker-improved-locomo-20260518T130013Z` |
| LongMemEval run id | `ranker-improved-lme-20260518T141441Z` |
| Total spend | **$8.27** (LOCOMO 3 presets + LongMemEval 2 presets) |
| Wall window | 2026-05-18 13:00 → 15:42 UTC |

## Preset definitions

All three presets use the same harness-default `half_life_days = 7`.

| Preset | semantic | importance | recency | frequency | Ranker active? |
|---|---|---|---|---|---|
| `baseline` | 1.0 | 0.0 | **0.0** | 0.0 | No — short-circuits to pure cosine order |
| `default` | 0.5 | 0.2 | **0.2** | 0.1 | Yes — light recency blend |
| `recency_heavy` | 0.3 | 0.2 | **0.4** | 0.1 | Yes — heavy recency blend |

`importance` + `frequency` are reserved namespace — the server's
`CompositeRanker` ignores them today (no signal computed). They are
sent on the wire so future runs can compare apples to apples.

## Headline — LOCOMO (3-way preset comparison)

| Category    | baseline         | default          | recency_heavy    | Δ baseline→default | Δ baseline→recency_heavy |
|-------------|------------------|------------------|------------------|---------------------|---------------------------|
| adversarial | 71.33 ± 34.44    | 70.72 ± 34.81    | 71.94 ± 34.37    | −0.61               | +0.61                     |
| multi_hop   | 47.08 ± 27.94    | 46.35 ± 26.92    | 48.02 ± 26.86    | −0.73               | +0.94                     |
| open_domain | 52.22 ± 32.22    | 52.07 ± 32.45    | 52.06 ± 32.47    | −0.15               | −0.16                     |
| single_hop  | 53.40 ± 29.26    | 53.49 ± 29.61    | 53.69 ± 29.82    | +0.09               | +0.29                     |
| temporal    | 36.42 ± 20.15    | 36.26 ± 20.20    | 35.93 ± 20.01    | −0.16               | −0.49                     |
| **Overall** | **53.88 ± 32.43**| **53.62 ± 32.58**| **53.96 ± 32.65**| **−0.26**           | **+0.07**                 |

**Verdict: ✅ within judge-noise envelope (±2–3 J on overall is the
empirical floor from the May 13 variance pair; ±32 stddev per query
makes individual category deltas this small statistically
indistinguishable from zero).**

Per-category pattern (consistent with the May 14 A.1 run):

- `multi_hop` + `adversarial` get small lifts from recency
  (+0.94, +0.61). Plausible: a recent re-affirmation of a fact
  helps cross-session reasoning and rejection of stale-but-plausible
  distractors.
- `temporal` loses a small amount (−0.49 vs baseline at
  recency_heavy). Plausible: LOCOMO temporal questions span the
  full session timeline; penalising older-but-still-relevant turns
  costs a sliver.
- `open_domain` is flat (−0.16). Recency genuinely doesn't help
  factual recall on stable knowledge.

## Headline — LongMemEval (2-way preset comparison)

| Category                 | baseline         | recency_heavy    | Δ        |
|--------------------------|------------------|------------------|----------|
| knowledge_update         | 86.10 ± 20.98    | 85.52 ± 21.78    | −0.58    |
| multi_session            | 78.57 ± 24.90    | 79.47 ± 23.65    | +0.90    |
| preference               | 77.83 ± 17.11    | 74.67 ± 20.12    | −3.16    |
| single_session_assistant | 29.91 ± 17.07    | 29.91 ± 16.52    | 0.00     |
| single_session_user      | 95.21 ± 16.40    | 95.00 ± 16.90    | −0.21    |
| temporal                 | 62.03 ± 31.46    | 61.17 ± 31.53    | −0.86    |
| **Overall**              | **72.15 ± 30.50**| **71.85 ± 30.50**| **−0.30**|

**Verdict: ✅ within judge-noise on overall; the per-category
−3.16 on `preference` is the only delta worth flagging.**

The `preference` dip echoes the May 14 run — recency_heavy
systematically underranks long-held user preferences when a newer
near-duplicate exists. Net effect on overall is washed out, but it's
a concrete reason **not** to ship `recency = 0.4` as a default. The
shipped server default (`recency = 0.0`) sidesteps this entirely.

Reference scores from external systems (Supermemory 85.4, Zep 63.8,
Mem0 49.0) are LongMemEval-published values, not re-measured here —
they sit alongside our numbers as orientation only.

## No-op invariant — verified

The `baseline` preset (recency=0.0) short-circuits in
`CompositeRanker::rank`. Its J on LOCOMO (53.88) is statistically
indistinguishable from the May 14 pre-improvements baseline (54.5),
which is itself statistically indistinguishable from the May 13
ENG-1747 baseline (54.5/54.8). The composite reranker code path
exists but **never alters retrieval order when sent the server's
default weights** — confirmed by:

- `services::ranker::tests::default_weights_preserve_input_order`
- `services::ranker::tests::recency_zero_is_short_circuit_no_reorder`
- `services::ranker::tests::short_circuit_returns_score_none`

End-to-end: LOCOMO baseline 53.88, three runs across two weeks all
within ±1 J → the no-op claim holds.

## Compared to May 14 ranker run

| | May 14 (pre-improvements) | May 18 (this run) | Δ |
|---|---|---|---|
| LOCOMO baseline | 54.5 | 53.9 | −0.6 |
| LOCOMO recency_heavy | 54.5 | 54.0 | −0.5 |
| LongMemEval baseline | 72.4 | 72.2 | −0.2 |
| LongMemEval recency_heavy | 71.9 | 71.9 | 0.0 |

All within judge noise. The four post-review improvements are
behavior-preserving — exactly the intent.

## Bottom line

The composite reranker (recency-only signal) is **safe to ship
behind the existing per-request `scoring_weights` opt-in**. Server
default keeps `recency = 0.0` (no-op short-circuit), so existing
clients see byte-identical responses except for the optional
`score` field which is omitted when the ranker doesn't run.
Clients that want recency blending can pass `scoring_weights`
explicitly per request — the validator rejects malformed input
with 400.

Next steps tracked under MEM-52 umbrella:
- Open PR for MEM-53 (this work) against `dev`.
- Then MEM-56 (prompt version pinning) before any further quality
  experiments — needed so future deltas attribute cleanly to the
  intended change, not prompt drift.
