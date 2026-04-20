# LOCOMO Benchmark Results — MemWal Memory Structure Upgrade

> **Run date**: 2026-04-20
> **Run ID**: `2026-04-20-130136`
> **Branch**: `feat/memory-structure-upgrade` (commit `97f62ec`)
> **Benchmark**: LOCOMO (Snap Research, ICLR 2025) — 10 conversations, 1,986 QA pairs
> **Mode**: `BENCHMARK_MODE=true` (SEAL + Walrus bypassed — pure retrieval evaluation)
> **Evaluator**: GPT-4o (LLM-as-Judge, 4-dimension scoring → J-score 0-100)
> **Answer model**: GPT-4o-mini

---

## Executive Summary

**TL;DR**: MemWal's composite scoring does NOT outperform pure cosine similarity on LOCOMO. Our overall J-score is ~52 — significantly below Mem0's published numbers (55-73 across categories). The primary failure mode is **retrieval miss** (right memory not in the top K), not ranking quality. This points to issues upstream of scoring — either extraction quality or embedding coverage.

### Headline numbers

| Category | Baseline (cosine) | Default (composite) | Recency Heavy | Mem0 Paper |
|---|---|---|---|---|
| single_hop | **46.7** | 45.3 | 43.1 | 67.13 |
| multi_hop | **50.2** | 49.6 | 45.9 | 51.15 |
| temporal | **32.5** | 30.6 | 30.5 | 55.51 |
| open_domain | **45.3** | 43.3 | 41.4 | 72.93 |
| adversarial | 82.5 | 85.2 | **86.5** | — |
| **Overall** | **52.01** | 51.28 | 50.23 | — |

Bold = best non-adversarial score per row. Baseline wins every substantive category.

---

## What We Measured

### Setup

```
Ingestion:  1,654 memories stored from 10 LOCOMO conversations
            (~270 analyze calls across 27 avg sessions per conversation)
            Ingestion time: ~40 minutes

Evaluation: 1,986 queries × 3 scoring presets = 5,958 total evaluations
            Per query: recall (top 10) → generate answer → LLM-as-Judge
            Evaluation time: ~35 minutes (8-way parallelism)

Total cost: ~$10.50 OpenRouter (embedding + extraction + answer + judge)
```

### Scoring Presets

| Preset | Semantic | Importance | Recency | Frequency |
|---|---|---|---|---|
| `baseline` | 1.0 | 0.0 | 0.0 | 0.0 |
| `default` | 0.5 | 0.2 | 0.2 | 0.1 |
| `recency_heavy` | 0.3 | 0.2 | 0.4 | 0.1 |

---

## Key Findings

### 1. Composite scoring provides no uplift over pure cosine

On every substantive category (single-hop, multi-hop, temporal, open-domain), the pure cosine baseline scores equal to or higher than either composite preset. Additional signals (importance, recency, frequency) don't help retrieval quality for LOCOMO queries.

The delta is small (~1-2 J-score points) but directionally consistent: composite scoring slightly **hurts** performance. This suggests the additional signals are introducing noise rather than useful re-ranking.

### 2. Composite scoring DOES help on adversarial queries

Recency-heavy wins on adversarial queries (86.5 vs 82.5 baseline). Adversarial queries are deliberately unanswerable — asking about things the conversation never covered. Higher score here means the system is better at saying "I don't know" rather than hallucinating.

Interpretation: when there's no relevant memory, composite scoring may surface less-relevant memories, leading the LLM to correctly abstain. This is actually a useful property for production.

### 3. The dominant failure mode is retrieval miss, not ranking

Out of 1,984 evaluated queries on the baseline preset:
- **53.1% (1,054)** of generated answers say some variant of "the memories don't contain this information"
- **35.4% (702)** scored J < 30 (effectively failed)
- **76.6% of low-scoring responses** explicitly said "no info"

**This is not a scoring problem — it's a retrieval problem.** When the LLM says "no information available," changing the scoring weights won't help because the right memory isn't in the top 10 regardless of how you rank what IS there.

### 4. Example failures show the pattern clearly

**Temporal query (J=20):**
```
Question:    When did Melanie paint a sunrise?
Ground truth: 2022
Top memory:  "Caroline painted a sunset after visiting the beach last week."
Generated:   "The memories do not contain any information about Melanie painting a sunrise."
```

The wrong person and wrong event surfaced. The correct memory may not have been extracted from the source conversation, or if extracted, it didn't embed close enough to the query.

**Single-hop query (J=20):**
```
Question:    What activities does Melanie partake in?
Ground truth: pottery, camping, painting, swimming
Top memory:  "Melanie carves out me-time each day for running, reading, or playing the violin"
Generated:   "Melanie carves out me-time each day for running, reading, or playing the violin."
```

The retrieval found Melanie's activities, but not the ones the query was about. This is either an extraction gap (other activities weren't stored as memories) or a semantic coverage gap (multiple activity types should be found but only one was).

**Open-domain query (J=20):**
```
Question:    What are Caroline's plans for the summer?
Ground truth: researching adoption agencies
Top memory:  "Caroline is continuing her education and exploring career options"
Generated:   "The memories do not contain specific information about Caroline's plans for the summer."
```

Adjacent but wrong. The key memory about adoption research wasn't surfaced.

---

## Analysis: Why Composite Scoring Doesn't Help

Three reasons:

**A) LOCOMO conversations are event-sparse over time.**
LOCOMO sessions are timestamped but the timestamps are all relatively recent. Recency decay (`0.95^days`) barely differentiates between memories that are hours vs days apart. The signal has no discriminative power.

**B) Importance is LLM-assigned during extraction.**
MemWal's extraction pipeline assigns an `importance` score to each fact when storing it. For LOCOMO's casual conversations, the LLM tends to assign similar importance (0.5-0.8) to most facts. Weight doesn't matter if the underlying signal is uniform.

**C) Frequency needs established query patterns.**
`access_count` requires memories to be accessed repeatedly. This is a fresh run — every memory has `access_count=0` or 1. Frequency weight is effectively inactive.

**The verdict**: MemWal's composite scoring is designed for **long-running production workloads** where memories accumulate temporal and access history. LOCOMO is a cold-start benchmark — it doesn't exercise these signals.

---

## Analysis: Why We Underperform Mem0's Published Numbers

Our overall ~52 vs Mem0's 55-73 gap is larger than can be explained by implementation differences alone. Root causes:

**1. Extraction pipeline may be missing facts.**
LOCOMO conversations are dense (hundreds of turns per session). MemWal's `analyze` endpoint extracts facts via a single LLM call per session. If the session is long or information-rich, many facts get missed. Mem0's paper uses a sliding 10-message window with conversation summaries — more thorough extraction context.

**2. We ingest full sessions; Mem0 uses message pairs.**
From the paper: Mem0 processes (question, answer) pairs from the conversation, not whole session transcripts. Our ingestion concatenates all turns into one blob per session, which may hurt the LLM's ability to extract discrete facts.

**3. Recall returns top 10; Mem0 uses top 20+.**
We set `recall_limit=10`. Mem0's paper uses larger K values for retrieval. With 1,600 memories across 10 conversations and similar facts appearing in multiple phrasings, top-10 may miss the precise evidence.

**4. Our answer-generation prompt is stricter.**
Our prompt says "if the memories do not contain enough information to answer, say so explicitly." Mem0 likely uses a prompt that encourages more interpretive answers. Our abstention rate (53%) is likely higher than theirs, dragging down J-scores.

---

## Recommendations

### Immediate (this sprint)
1. **Fix retrieval coverage first** — scoring tweaks are premature while 53% of queries hit "no info". Action: increase `recall_limit` from 10 → 20 or 30 and re-run.
2. **Compare extraction output against LOCOMO evidence IDs** — for each ground-truth evidence turn `D1:3`, verify that SOME memory was extracted from it. If not, extraction is the bottleneck.
3. **Tune the answer prompt** — allow more interpretive answers; our strict "say no info" instruction is too conservative for a benchmark.

### Medium-term
4. **Re-run LongMemEval** — it tests knowledge updates explicitly. If composite scoring works anywhere, it's there.
5. **Extraction strategy experiment** — ingest LOCOMO using (user-turn, assistant-turn) pairs instead of full sessions. Compare extraction rate.
6. **Scoring weight sweep** — if retrieval coverage is fixed, redo the preset comparison. Current results don't prove composite scoring is bad — they prove it can't overcome a retrieval miss.

### Long-term
7. **Graph layer** — Mem0's own data shows Graph variant wins on temporal (+2.6 points) and open-domain (+2.8 points). For the categories where we lag most (temporal -23 points, open-domain -28 points), the missing graph is likely a contributor.

---

## Notes on Methodology

### What the J-score measures

LLM-as-Judge (GPT-4o) scores 4 dimensions 1-5 each, averaged to 0-100:
- **Factual accuracy**: Is the answer factually correct?
- **Relevance**: Does the answer address the question?
- **Completeness**: Does it cover all aspects of the ground truth?
- **Contextual appropriateness**: Is it grounded in conversation context?

Lower scores usually mean the answer was wrong, evasive, or missed key content.

### Why adversarial scores are so high

Adversarial queries have ground-truth answer = something like "no information available" or "not mentioned." When the LLM says "the memories don't contain this information," the judge scores it 5/5 on all dimensions. That's correct behavior — just saying "I don't know" is the right answer for adversarial queries.

The 82-86% adversarial score means we correctly abstain ~80%+ of the time on questions we shouldn't answer. That's genuinely good.

### Result reproducibility

Full results are archived alongside this report in the [`results/`](./results/) folder:
- `baseline.json`
- `default.json`
- `recency_heavy.json`

Each artifact contains per-query: question, ground truth, retrieved memories, generated answer, judgment scores. Fully inspectable.

---

## What's Next

This run answered one question definitively and opened several new ones.

**Answered**: Does MemWal's composite scoring help on LOCOMO? **No.** Pure cosine is slightly better in every substantive category. The scoring upgrade neither helps nor seriously hurts — it's mostly inert on this benchmark.

**New questions**:
- Would fixing retrieval coverage (larger K, better extraction) raise scores enough to close the gap with Mem0?
- Does composite scoring win on LongMemEval (where "knowledge updates" is an explicit category)?
- How much of the gap is extraction quality vs. ranking quality?

The path forward is to run LongMemEval next. That benchmark has categories (knowledge updates, temporal reasoning) where composite scoring is specifically designed to shine. If it doesn't win there either, we have a stronger signal that the composite scoring design needs rethinking — not just tuning.
