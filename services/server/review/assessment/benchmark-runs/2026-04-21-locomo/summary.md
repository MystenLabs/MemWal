# LOCOMO — Per-Turn Ingestion Summary

> **Run ID**: `2026-04-21-175529` • 1,986 queries • 2 scoring presets • ~$4.42 total
>
> **Companion to**: the 2026-04-20 session-dump run (previous baseline)

---

## Why this run exists

When we analyzed yesterday's LOCOMO results, we realized the benchmark adapter was dumping entire sessions (17-23 turns at a time) into a single `/api/analyze` call. That didn't match:

- **How our SDK actually drives the server** — `withMemWal` calls `memwal.analyze(userMessage)` once per user message. One turn per call.
- **How Mem0 evaluates on LOCOMO** — they replay conversations message-by-message through their context-management pipeline.

So yesterday's result (52.01 J, 53% "no info") was partly a benchmark-correctness issue, not a product quality issue. This run fixes the adapter to per-turn ingestion and retests under the right conditions.

---

## Headline numbers

| | Yesterday (session-dump) | **Today (per-turn)** | Δ |
|---|---|---|---|
| Overall J — baseline | 52.01 | **54.25** | **+2.24** |
| Overall J — default composite | 51.28 | **53.57** | **+2.29** |
| No-info rate | 53.0% | **40.2%** | **-12.8 pp** |
| Memories extracted | 1,654 | **4,410** | **2.7×** |

Every substantive category improved. **Multi-hop now beats Mem0's published score** (53.4 vs 51.15).

---

## Per-category breakdown

| Category | Baseline today | Default today | Mem0 Base | Gap to Mem0 (default) |
|---|---|---|---|---|
| single_hop | 54.3 | 50.9 | 67.13 | -16.2 |
| **multi_hop** | 52.9 | **53.4** | 51.15 | **+2.3** ✅ |
| temporal | 36.6 | 37.3 | 55.51 | -18.2 |
| open_domain | 50.3 | 47.6 | 72.93 | -25.3 |
| adversarial | 74.7 | 78.3 | — | — |

### The one interesting regression — adversarial (-7.8 vs yesterday)

Adversarial queries are deliberately unanswerable. Yesterday we scored 82-85 because our extractor missed so many facts that the LLM correctly said "I don't know" 72% of the time. Today we extracted 2.7× more memories → LLM has more context → tries harder to answer → sometimes confidently hallucinates → judge penalizes.

**This is a real tradeoff, not a bug.** There's tension between extraction richness (helps substantive queries) and principled abstention (helps adversarial queries). For production chatbot traffic where most questions are actually answerable, extraction richness wins.

---

## What the remaining Mem0 gap means

Three of four substantive categories still trail Mem0 by 16-25 points. **The root cause is one specific architectural difference**: Mem0 has a server-side context management layer that we don't.

For every extraction, Mem0 builds the prompt:

```
P = (conversation_summary, sliding_window_of_last_10_messages, current_message)
```

- **Conversation summary** — async-refreshed digest of the entire history
- **Sliding window** — last 10 messages for local coherence
- **Current message** — the one being ingested

Their extractor always sees prior context. Ours sees just the current message:

```typescript
memwal.analyze(userMessage)   // just one string, no history
```

See `root-cause.md` for the detailed analysis. **This is a deliberate stateless-server design choice on our part** — the LOCOMO gap is the cost of that choice on long multi-session benchmarks.

---

## Statistical significance

With n=1,986 queries and std ≈ 33, the standard error on the mean J is ~0.74. Our +2.24 overall improvement is ~3σ — meaningful, not noise. But also not dramatic. This is "hypothesis confirmed" not "massive breakthrough."

---

## What we tested vs Mem0 (apples-to-apples status)

| Aspect | Previous run | This run | Match with Mem0 |
|---|---|---|---|
| Dataset | LOCOMO | LOCOMO | ✅ identical |
| Judge model | GPT-4o | GPT-4o | ✅ identical |
| Judge prompt | 4-dim, fixed | 4-dim, fixed | ✅ identical |
| Answer model | GPT-4o-mini | GPT-4o-mini | ✅ comparable |
| Ingestion granularity | **session-dump ❌** | **per-turn ✅** | ✅ now matches |
| Context layer (summary, sliding window) | **absent** | **absent** | ❌ architectural gap |

The ingestion mismatch was the fix. The architectural gap (no context layer) is what remains — and it's a product design decision, not a benchmark flaw.

---

## Cost and time

| Phase | Duration | Cost |
|---|---|---|
| Ingestion (5,882 per-turn analyze calls, 10 parallel conversations) | 33 min | ~$0.50 |
| Eval baseline (1,986 queries, 20 parallel workers) | 11 min | ~$1.90 |
| Eval default (1,986 queries) | 11 min | ~$2.00 |
| **Total** | **~55 min** | **~$4.42** |

Budget was $7-9 — came in well under because per-turn calls are smaller (less input content per LLM invocation than session blobs).

---

## What's next

Three short-term items, roughly in cost/impact order:

1. **Bump `recall_limit` 10 → 20** (~$3, ~60 min). Targets the open_domain gap directly — synthesis queries need more memories in context.
2. **Add `created_at_override` to `/api/analyze`** so LOCOMO's session timestamps unlock real recency signal. Should move temporal category from 37 → 45+. Server change, ~4h effort.
3. **Investigate context management** — the bigger product conversation. Do we add a summary/window layer, or accept the stateless tradeoff?

This run's findings point to an clear diagnostic: **extraction is no longer the bottleneck; context absence is.**
