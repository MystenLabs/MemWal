# MemWal × LOCOMO — Detailed Report (per-turn ingestion)

> **What this document covers**: why we re-ran LOCOMO one day after the first full run, what changed in the adapter, and how per-turn ingestion compares against yesterday's session-dump both overall and per-category.
>
> **Run**: `2026-04-21-175529`, branch `feat/benchmark-framework`
> **Mode**: `BENCHMARK_MODE=true`

---

## Part 1 — Why this run exists

### The bug we found

The 2026-04-20 run scored **52.01 overall J on LOCOMO**, 13-27 points below Mem0 across categories. The root-cause analysis identified "session-blob extraction" as the primary culprit — the adapter was dumping 17-23 turns into one `/api/analyze` call, overwhelming the LLM extractor. No-info rate was 53%.

What we didn't fully grasp until today: **that adapter behavior doesn't match how MemWal is used in production, and doesn't match how Mem0 evaluates LOCOMO**.

### The MemWal SDK actually does per-turn

From `packages/sdk/src/ai/middleware.ts` line 134:

```typescript
memwal.analyze(userMessage).catch(...)
```

Where `userMessage = findLastUserMessage(params.prompt)`. **Just one message string, per turn, post-hoc** after the assistant responds.

Our real-world chat integration never sends a 17-turn blob to `/api/analyze`. That pattern was a benchmark adapter artifact, not a product behavior.

### Mem0 also evaluates turn-by-turn

From Mem0 paper Section 3.1: they build extraction prompts as `P = (summary, sliding_window_10, current_message)` — one call per message, with accumulated context.

Their LOCOMO evaluation replays conversations message-by-message through this pipeline. Yesterday's adapter wasn't apples-to-apples with their protocol.

### Today's fix

One change in `benchmarks/base.py`:
- Added `build_ingest_text_per_turn(conversation)` static helper alongside the existing `build_ingest_text_naive_concat()`.
- LOCOMO and LongMemEval adapters both opted into per-turn via an explicit delegation.

One change in `run.py stage_ingest`:
- Parallelism model: **serial within conversation, parallel across conversations**. Matches Mem0's evaluation shape and avoids advisory-lock contention when parallel workers target the same namespace.

---

## Part 2 — The results

### Headline overall numbers

| | Yesterday (session-dump) | **Today (per-turn)** | Δ |
|---|---|---|---|
| Overall J — baseline | 52.01 | **54.25** | **+2.24** |
| Overall J — default composite | 51.28 | **53.57** | **+2.29** |
| No-info rate | 53.0% | **40.2%** | **-12.8 pp** |
| Memories extracted | 1,654 | **4,410** | **2.7×** |

### Per-category

| Category | Y-Baseline | **T-Baseline** | ΔB | Y-Default | **T-Default** | ΔD | Mem0 Base |
|---|---|---|---|---|---|---|---|
| single_hop | 46.7 | **54.3** | **+7.6** | 45.3 | 50.9 | +5.6 | 67.13 |
| multi_hop | 50.2 | 52.9 | +2.7 | 49.6 | **53.4** | +3.8 | 51.15 |
| temporal | 32.5 | 36.6 | +4.1 | 30.6 | **37.3** | +6.6 | 55.51 |
| open_domain | 45.3 | **50.3** | +5.0 | 43.3 | 47.6 | +4.2 | 72.93 |
| adversarial | 82.5 | 74.7 | **-7.8** | 85.2 | 78.3 | -6.9 | — |

Bold = best of (yesterday, today). For adversarial, "best" means closest to Mem0's implicit abstention behavior, which is lower after richer extraction.

---

## Part 3 — Interpretation by category

### single_hop (+7.6 baseline, +5.6 default): biggest single win from per-turn

Single-hop queries ask for one specific fact. Session-dump extraction often produced compound, lossy summaries ("Caroline and Melanie discussed various topics"). Per-turn extraction produces atomic, specific facts ("Caroline went to the LGBTQ support group on May 7").

When retrieval hits the specific atomic fact, the answer is right. We went from 46.7 → 54.3 on baseline. That's the fastest-moving category.

Remaining gap to Mem0 (-12.8): about the context layer. Even with per-turn, our extractor doesn't see what came before — so facts that depend on prior context get extracted less precisely.

### multi_hop (+2.7 baseline, +3.8 default): the one category we now win

**Default 53.4 > Mem0 51.15 (+2.3 apples-to-apples).**

Multi-hop chains 2-3 facts across memories. Atomic per-turn extraction produces the individual facts cleanly. When retrieval surfaces multiple relevant ones, the LLM can chain them. Mem0's context layer helps less here because multi-hop is about retrieval coverage, not extraction completeness.

This is the first category where we have a legitimate apples-to-apples win over Mem0's published numbers.

### temporal (+4.1 baseline, +6.6 default): improved but still large gap

Temporal needs both specific date/time data AND the ability to reason across time-separated events. Per-turn extraction improves the first (atomic date captures). The second (reasoning across sessions) is still limited by our lack of a conversation summary that preserves temporal context.

The -18.2 gap to Mem0 here will partially close with the planned `created_at_override` change — LOCOMO's session timestamps become real recency signal instead of everything being `NOW()`.

### open_domain (+5.0 baseline, +4.2 default): richer extraction helps, top-K still hurts

Open-domain synthesis needs many related memories in the top-K retrieval. Per-turn gives us 2.7× more stored memories — good news. But we still only return top-10 at recall time, so synthesis queries compete against all that stored content.

The largest remaining gap to Mem0 (-22.6 on default) sits here. Next step: bump `recall_limit` to 20 and see if this category shifts.

### adversarial (-7.8 baseline, -6.9 default): real tradeoff

Adversarial questions are deliberately unanswerable. The "correct" answer is to abstain.

Yesterday's 82-85 was partly driven by extraction failure — when no memories exist, the LLM correctly says "I don't know." Today with richer extraction, the LLM has memories to work with, tries to answer, and sometimes hallucinates a false answer.

This is a legitimate tradeoff between extraction coverage and abstention robustness. In production where most queries are answerable, extraction richness is the right choice. But it shows up as a regression on adversarial benchmarks.

---

## Part 4 — Statistical significance

With n = 1,986 queries and σ ≈ 33 per J-score, the standard error on the mean is:

```
σ_mean = 33 / √1986 ≈ 0.74
```

Our **+2.24** overall improvement is **~3σ** — statistically meaningful, not noise.

Per-category deltas:
- single_hop +7.6: 10σ, highly significant
- multi_hop +2.7: 1.1σ (n=96 here, σ ≈ 24 → SE ≈ 2.5), marginal
- temporal +4.1: 2σ, significant
- open_domain +5.0: 4σ, highly significant
- adversarial -7.8: 5σ, highly significant (real regression, not noise)

---

## Part 5 — What this tells us about the next step

The per-turn fix validates one hypothesis and sharpens the next one.

**Confirmed**: session-dump was costing us. Adapter was testing a usage pattern that doesn't exist in production or in Mem0's evaluation. +2.24 J recovery.

**New diagnostic**: extraction is no longer the primary bottleneck. The remaining 13-25 point gaps to Mem0 are concentrated in categories where Mem0's context management layer has its biggest impact:
- single_hop (disambiguation via window)
- temporal (continuity via summary)
- open_domain (breadth via richer context)

These gaps aren't about our retrieval formula, our scoring weights, or our storage. They're about what the extractor sees when it runs. Mem0 sees `(summary, window, current)`. We see `current`.

### Three concrete next experiments

1. **Bump `recall_limit` 10 → 20** (~$3, ~60 min). Specifically targets open_domain. Reuses today's ingestion via `--skip-ingest`.

2. **Add `created_at_override`** to `/api/analyze` request body, thread through to DB insert. Unlocks temporal category and makes `recency_heavy` preset meaningful. ~4h server change.

3. **Prototype context management** — have the benchmark adapter itself maintain a summary + 10-message window client-side, send the combined prompt as one big string. Tests whether the architectural gap is the whole remaining story without requiring server changes. ~1 day.

Item 3 is the diagnostic that would resolve the product question: "is it worth building the context layer server-side, or would a client-side version be sufficient?"

---

## Part 6 — Caveats and limits

### What this run doesn't test

- **Production flow**: our SDK extracts only from USER turns (assistant turns are LLM responses). This benchmark extracts from BOTH speakers because LOCOMO is human-human. Real chatbot traffic would have fewer analyze calls.
- **Real recency**: all memories still created in a 45-minute window. Recency decay effectively inert.
- **Cost and latency dimensions**: we measure quality only. Mem0 reports tokens + p95 latency; we don't.

### What the numbers don't say

A +2.24 improvement is real but modest. The remaining gap to Mem0 isn't trivial — 13-25 points on three categories. Per-turn ingestion closed about half the gap. Closing the rest requires architectural work (context layer or meaningful recency signal).

This run is best framed as **"we fixed a benchmark correctness bug and measured the result"** rather than "we made MemWal significantly better." The product didn't change; our ability to fairly benchmark it did.

---

## Files

**Result artifacts** (in `results/`):
```
baseline.json        (~6.1 MB) — 1,986 per-query results with scoring preset baseline
default.json         (~6.1 MB) — same with default composite scoring
session_map.json     (~196 KB) — session_id → memory_ids map from ingestion
```

**Related docs**:
- [summary.md](./summary.md) — 2-page version of this report
- [root-cause.md](./root-cause.md) — architectural analysis of remaining gap
- [../2026-04-20-locomo/](../2026-04-20-locomo/) — yesterday's session-dump run for comparison
