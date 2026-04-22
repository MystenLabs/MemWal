# LOCOMO Per-Turn — Root Cause Analysis

> **Companion to**: `summary.md`, `detailed-report.md`
> **Focus**: Why we still trail Mem0 on 3 of 4 substantive categories after fixing the ingestion pattern
> **Method**: trace each remaining gap to a specific architectural difference

---

## The gap that closed (ingestion granularity)

### Yesterday's problem

The benchmark adapter used `build_ingest_text_naive_concat()` — one `/api/analyze` call per session, with 17-23 turns concatenated into one text blob. This didn't match:

- **Our SDK in production**: `withMemWal` at `middleware.ts:134` calls `memwal.analyze(userMessage)` with a single string (one user message).
- **Mem0's LOCOMO evaluation**: they replay conversations message-by-message through their context pipeline.

The adapter was stress-testing a code path that no production or competitive evaluation actually uses.

### What per-turn ingestion fixed

| Metric | Session-dump | Per-turn | Δ |
|---|---|---|---|
| Memories extracted | 1,654 | 4,410 | +2.7× |
| No-info rate | 53.0% | 40.2% | -12.8 pp |
| single_hop J | 46.7 | 54.3 | +7.6 |
| multi_hop J | 50.2 | 52.9 | +2.7 |
| temporal J | 32.5 | 36.6 | +4.1 |
| open_domain J | 45.3 | 50.3 | +5.0 |

Every substantive category improved. The extractor was indeed being overwhelmed by session-length input. Per-turn gives it one atomic message per call — which is the shape the prompt was designed for.

---

## The gap that remains (context management layer)

### What Mem0 has that we don't

From the Mem0 paper (Section 3.1), their server maintains three sources of context per conversation:

```
P = (S, {m_{t-10}, ..., m_{t-2}, m_{t-1}}, m_t)
    summary  ─ sliding window ─                current
```

- **Summary `S`** — async-refreshed digest of the entire conversation history. Covers messages older than the 10-message window.
- **Sliding window `m=10`** — recent messages for local coherence (pronoun resolution, topic continuity).
- **Current message `m_t`** — the one being ingested.

Every time their extractor runs, it sees all three. A message like "I went there on Monday" has "there" resolved via the window, and the conversation context via the summary.

Extraction on such a prompt produces cleaner, more complete facts.

### What we have

Our SDK wrapper, `packages/sdk/src/ai/middleware.ts` lines 132-137:

```typescript
const userMessage = findLastUserMessage(params.prompt);
if (userMessage) {
    memwal.analyze(userMessage).catch(...);
}
```

Just one string. No summary. No window. No history. The server is stateless — whatever the caller sends is what the extractor sees.

This is a deliberate design choice (simpler server, caller-managed context, composable with any caller pattern). **But it has a measurable cost on benchmarks like LOCOMO** where context-dependent extraction matters.

---

## Mapping remaining category gaps to this cause

### single_hop (-12.8 to Mem0)

Single-hop queries ask for one specific fact from one turn. Example:

> "When did Caroline go to the LGBTQ support group?" → "May 7, 2023"

Our extractor sees just the turn where Caroline mentioned it ("I went yesterday"). Without the prior turn establishing the topic or the session's date context, it may extract "went somewhere yesterday" rather than "went to LGBTQ support group on May 7, 2023."

Mem0 sees the window + summary → extracts the full fact the first time. Higher retrieval precision follows.

### temporal (-18.2 to Mem0)

Temporal queries need date reasoning. Example:

> "How long after moving did Caroline start her new job?" → "3 months"

This requires knowing (a) when she moved and (b) when she started the job. Both facts live in different sessions. Mem0's summary preserves the move date; their sliding window catches the job start. We extract each fact in isolation from a single turn — dates may or may not be embedded in each turn verbatim.

This category also suffers from our `created_at = NOW()` limitation — recency signal is still dead because all memories were created in the same 45-minute window. Fix planned for next cycle (server-side `created_at_override`).

### open_domain (-22.6 to Mem0, biggest gap)

Open-domain queries require synthesis across many memories. Example:

> "What are Caroline's plans for the summer?" → "researching adoption agencies"

With our richer extraction (4,410 memories), the adoption memory IS stored — but it has to compete with 4,409 others to rank in the top-10 retrieval. Synthesis categories are limited by K, and pure semantic similarity ≠ relevance for broad questions.

Mem0 likely retrieves more memories per query (larger K or a different ranking signal that favors thematic relevance). We hit top-10 semantically, which for synthesis questions is often not enough.

---

## The one category we won — multi_hop (+2.3 over Mem0)

Multi-hop queries chain 2-3 facts across memories. Example:

> "Who introduced Caroline to the yoga studio she now attends?"
> → Step 1: "Caroline attends yoga at Y" (Session 5)
> → Step 2: "Sarah recommended yoga studio Y" (Session 7)
> → Answer: Sarah

Per-turn extraction captures atomic, specific facts. Stored memories look like:
- `"Caroline's coworker Sarah recommended yoga studio Y"`
- `"Caroline now attends yoga at studio Y after Sarah's suggestion"`

When retrieved together, the LLM can chain them. Session-dump extraction (yesterday) tended to produce summarized compound statements like `"Caroline discusses yoga and life events with Melanie"` — lossy.

**This is the category where richer extraction most clearly pays off.** The Mem0 context layer helps less here because multi-hop is about retrieval coverage, not extraction completeness.

---

## The adversarial regression — a legitimate tradeoff

Adversarial queries are designed to be unanswerable. They test whether the system correctly abstains rather than hallucinating.

Yesterday (session-dump): adversarial baseline 82.5 — we scored well because our extractor dropped so many facts that the LLM correctly said "I don't know" ~72% of the time.

Today (per-turn): adversarial baseline 74.7 — we have 2.7× more memories, LLM sees more context, tries harder to answer, sometimes confidently says wrong things.

**This is a fundamental tension in memory system design**:
- More stored facts → better recall on answerable questions
- More stored facts → more opportunity to hallucinate on unanswerable ones

A well-designed system needs to:
1. Extract thoroughly when there's signal
2. Abstain cleanly when the retrieved memories don't actually support an answer

Right now the abstention logic lives implicitly in the answer-generation LLM. With more context, it hedges less. A dedicated "is there enough here to answer?" gate would help — possibly tied to the summary layer (summaries are natural "what do we know" filters).

---

## Summary — what each next step targets

| Next step | Targets | Expected improvement |
|---|---|---|
| Bump `recall_limit` 10 → 20 | open_domain gap | +3-5 J on open_domain |
| `created_at_override` server flag | temporal gap, recency signal spread | +5-8 J on temporal, enables recency_heavy preset |
| Context management layer (summary + window) | single_hop gap, adversarial robustness | +8-15 J across categories; closes most remaining Mem0 gap |

The first two are cheap and targeted. The third is a bigger product conversation:

> **Do we keep the stateless SDK contract (current) and accept the LOCOMO gap, or build a context management layer and trade simplicity for quality?**

This is a product decision, not an engineering one. The benchmark simply surfaces the cost of the current choice. Real-world usage (chatbot with short exchanges, not 600-turn multi-month transcripts) may not exercise the missing layer as much as LOCOMO does.
