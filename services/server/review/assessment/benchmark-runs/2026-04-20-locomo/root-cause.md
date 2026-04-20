# LOCOMO Benchmark — Root Cause Analysis

> **Companion to**: `summary.md`, `detailed-report.md`
> **Focus**: Tracing the 52 J-score (vs Mem0's 55-73) back to specific code paths
> **Method**: cross-reference benchmark data with the exact implementation in `services/server/src/`

---

## The Two Signals From the Benchmark

From the run:
1. **53.1% of answers say "the memories don't contain this information"** — retrieval is missing the right memory
2. **Composite scoring (default, recency_heavy) is slightly worse than pure cosine (baseline)** — the extra signals aren't discriminating

Root causes trace back to three implementation choices. I'll walk through each with the exact code.

---

## Root Cause #1 — Session-Blob Extraction is Too Coarse

**Where**: `services/server/src/routes.rs:579-602` (the `analyze` endpoint)

The flow is:
```rust
pub async fn analyze(...) {
    // Stage 1: EXTRACT
    let extracted = extract_structured_facts_llm(
        &state.http_client, &state.config, &body.text
    ).await?;
```

**One LLM call gets the entire session's text at once.** The benchmark adapter (`benchmarks/base.py:52-62`) concatenates every turn in a session into one string:
```python
lines = []
for turn in session.turns:
    prefix = "User" if turn.speaker == "user" else "Assistant"
    lines.append(f"{prefix}: {turn.text}")
text = "\n".join(lines)
```

So a session with ~30 turns and ~1,000 words becomes one giant blob. GPT-4o-mini extracts ~6-10 facts from this per call, when there may be 20-30 atomic facts actually present.

**Evidence in the data**:
- LOCOMO has ~1,986 QA pairs across 10 conversations — **so the ground truth implies ~200 evidence facts per conversation**
- We stored **1,654 memories across 10 conversations** = **~165 per conversation**
- That's numerically close but conceptually different: Mem0's evidence covers specific facts at specific dialog turns. Our extraction is a lossy summary.

**Why it hurts**: When a question asks about a specific detail (`"When did Melanie paint a sunrise?"`), and Stage 1 only extracted high-level summaries (`"Melanie enjoys painting"`), the specific fact isn't in the database. Recall can't find what was never stored.

**What Mem0 does differently** (from the paper):
> *"We extract facts from (question, answer) message pairs with a sliding window of m=10 previous messages for context"*

They process smaller chunks with more context — finer granularity, more calls, more facts. We process larger chunks with less context — coarser granularity, fewer calls, fewer facts.

---

## Root Cause #2 — Importance Scores Are Flat by Distribution

**Where**: `services/server/src/routes.rs:980-1005` (the extraction prompt)

The prompt asks the LLM to self-assign importance:
```rust
const FACT_EXTRACTION_PROMPT: &str = r#"...
For each fact, return a JSON array of objects with:
- "text": the fact statement
- "type": one of "fact", "preference", "episodic", "procedural", "biographical"
- "importance": 0.0 to 1.0 (how critical this fact is for future interactions)

Examples:
Output: [{"importance": 0.9}, {"importance": 0.7}]
Output: [{"importance": 0.6}]
...
```

**Actual importance distribution from the run** (1,654 stored memories):
```
AVG: 0.67
MIN: 0.40
MAX: 0.90
```

The LLM assigns everything between **0.4 and 0.9** with most clustered around 0.5-0.7. This is the classic problem with LLM-assigned self-scores: no discrimination. Everything is "moderately important."

**Why composite scoring can't help**: With `importance` weight 0.2 and values between 0.4-0.9, the importance component of the composite score varies by at most `0.2 * (0.9 - 0.4) = 0.1`. That's not enough to re-rank against a semantic score that differentiates from 0.0 to 1.0.

**What would help**: either (a) make the LLM pick from a discrete set `{0.1, 0.5, 0.9}` instead of a continuous range, or (b) derive importance from objective signals — entity type, numeric vs qualitative, explicit vs implicit mention.

---

## Root Cause #3 — Recency Decay Is a No-Op on Cold-Start Benchmarks

**Where**: `services/server/src/routes.rs:326-338` (recall scoring)

```rust
let recency_score = if let Some(ref ca) = created_at {
    if let Ok(ts) = chrono::DateTime::parse_from_str(ca, ...) {
        let days_old = (chrono::Utc::now() - ts.with_timezone(&chrono::Utc))
            .num_hours() as f64 / 24.0;
        0.95_f64.powf(days_old) // decay 5% per day
```

**The problem**: all benchmark memories were created in the same ~40-minute window. `days_old` is essentially 0 for every memory. `0.95^0 = 1.0`. Every memory gets the maximum recency score.

**Actual recency spread**:
- Ingestion ran from `13:01` to `13:40` UTC
- All 1,654 memories have `created_at` within a 40-minute range
- With the 5%/day decay, the difference between the newest and oldest memory is `0.95^0 - 0.95^(40/60/24) = ~0.0000015`

**That's five zeroes after the decimal.** The recency score for every memory is identical to 6 decimal places.

**Why `recency_heavy` is slightly worse**: bumping recency weight to 0.4 doesn't add discrimination (all values identical) — but it takes weight AWAY from semantic similarity (0.5 → 0.3), which IS discriminative. So the preset throws away useful signal for a signal that doesn't exist on this benchmark.

LOCOMO has an in-conversation timeline but we're not using it. The `session_N_date_time` fields in the dataset say things like "1:56 pm on 8 May, 2023" — but we use `NOW()` for all `created_at` values. The recency signal MemWal was designed for (real-world time passing between messages) is collapsed to a single point.

---

## How The Three Causes Compound

The failure modes stack:

```
1. Session-blob extraction     →  many facts not extracted at all
   └─ 53% of answers: "no info"

2. Flat importance scores      →  can't rank what IS stored
   └─ default preset: -0.7 points vs baseline

3. Zero recency spread         →  recency weight wastes slot
   └─ recency_heavy preset: -1.8 points vs baseline
```

The adversarial score (82-86%) tells us the system CAN abstain correctly. What it can't do is find the right memory when one exists. That's not a ranking problem — it's a recall coverage problem, and ranking tweaks can't fix it.

---

## What This Means For The Upgrade

The memory structure upgrade added four signals to scoring:

| Signal | Status for LOCOMO | Why |
|---|---|---|
| Semantic similarity | ✅ Works (baseline) | pgvector cosine is sound |
| Importance | ❌ Flat distribution | LLM self-scores lack discrimination |
| Recency | ❌ No spread | Benchmark is cold-start |
| Frequency | ❌ All zero | No query-access history |

**None of the three "new" signals work on LOCOMO as currently implemented.** This is not a condemnation of the upgrade — the signals are genuinely useful for production workloads that accumulate over days/weeks with real access patterns. LOCOMO just doesn't exercise them.

**What the upgrade DID do well**:
- Typed memories are correctly classified (7 types across 1,654 memories, sensible distribution)
- Dedup works (content hashes prevent repeats)
- Soft deletion exists (though untested at this scale)
- The architecture is sound — scoring weights are per-request parameters, enabling exactly this kind of A/B comparison cheaply

---

## Prioritized Fixes (Ordered By Impact)

### Fix 1: Granular extraction — HIGH IMPACT
**Change**: Process sessions as sliding windows of turn pairs, not whole blobs.

**Where**: `benchmarks/base.py:34-62` (adapter ingestion path) and optionally `services/server/src/routes.rs:593` (if we want to change MemWal itself).

**Expected impact**: Directly addresses the 53% "no info" rate. Could add 10-15 points to J-score.

### Fix 2: Increase recall_limit for evaluation — LOW EFFORT
**Change**: Bump `recall_limit` from 10 to 20 or 30 in `config.yaml`.

**Expected impact**: If the right memory is in positions 11-20, we currently miss it. Cheap win, maybe 3-5 J-score points.

### Fix 3: Use LOCOMO's in-conversation timestamps for `created_at`
**Change**: Adapter passes each turn's `timestamp` through to the server; server uses it for `valid_from` instead of `NOW()`.

**Where**: `benchmarks/benchmarks/locomo.py:159-161` already parses timestamps; `core/client.py:analyze` doesn't currently expose a timestamp parameter.

**Expected impact**: Makes recency decay meaningful. Combined with Fix 1 and 2, could let `recency_heavy` genuinely outperform baseline on temporal queries.

### Fix 4: Tighten the answer prompt to encourage interpretation
**Where**: `benchmarks/core/judge.py:ANSWER_SYSTEM_PROMPT`

Currently says: *"If the memories do not contain enough information to answer, say so explicitly."*

This is too strict. Loosening it will reduce the 53% "no info" rate, but we need to be careful — too loose and the LLM hallucinates, which hurts factual_accuracy scores.

### Fix 5: Discretize importance assignments in the prompt
**Where**: `services/server/src/routes.rs:992`

Change from continuous 0.0-1.0 to discrete `{0.3: trivial, 0.6: notable, 0.9: critical}`. LLMs do better with categorical choices.

---

## Conclusion

**The 52 J-score is not a scoring problem.** It's a coverage problem dressed up as a scoring problem.

The composite scoring feature works as designed — it just can't improve retrieval of memories that were never extracted. Fix the extraction first, re-run, then compare presets again.

The right next step is NOT to tune scoring weights. It's to:
1. Re-ingest LOCOMO with per-turn extraction (Fix 1)
2. Bump recall_limit (Fix 2)
3. Re-run all three presets
4. Then see if composite scoring matters

That's a ~2-day effort and will give us a fair benchmark of the upgrade's actual value.
