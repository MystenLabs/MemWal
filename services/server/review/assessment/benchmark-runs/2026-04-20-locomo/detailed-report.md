# MemWal × LOCOMO — Detailed Benchmark Report

> **What this document covers**: What LOCOMO is, what the test measures, how we ran it, and how MemWal performed — category by category, with per-query failure analysis.
>
> **Run**: `2026-04-20-130136`, branch `feat/memory-structure-upgrade`, commit `97f62ec`
> **Mode**: `BENCHMARK_MODE=true` (blockchain layer bypassed for retrieval quality isolation)

---

## Part 1 — What is LOCOMO?

### The benchmark in one paragraph

LOCOMO (Long Conversation Memory) is a benchmark from Snap Research, published at ICLR 2025. It evaluates how well an AI system can remember facts from long multi-session conversations and answer questions about them later. Unlike document-retrieval benchmarks (BEIR, MS MARCO), LOCOMO specifically targets **personal conversational memory** — the kind of memory an AI assistant needs to maintain about a user over weeks of interaction.

### The dataset structure

Each LOCOMO sample is a single conversation between two named speakers, split across many sessions over time:

```json
{
  "sample_id": "conv-26",
  "conversation": {
    "speaker_a": "Caroline",
    "speaker_b": "Melanie",
    "session_1_date_time": "1:56 pm on 8 May, 2023",
    "session_1": [
      {"speaker": "Caroline", "dia_id": "D1:1", "text": "Hey Mel! Good to see you!"},
      {"speaker": "Melanie",  "dia_id": "D1:2", "text": "Hi Caroline! I've been great."},
      ...
    ],
    "session_2_date_time": "7:30 pm on 15 May, 2023",
    "session_2": [...],
    ...
  },
  "qa": [
    {
      "question": "When did Caroline go to the LGBTQ support group?",
      "answer": "7 May 2023",
      "evidence": ["D1:3"],
      "category": 2
    },
    ...
  ]
}
```

**Scale:**
- **10 conversations** (public release; the full paper used 50)
- **~27 sessions per conversation** on average
- **~590 turns per conversation** on average
- **~200 QA pairs per conversation**
- **Total: 1,986 QA pairs across all 10 conversations**

### The five question categories

LOCOMO categorizes questions by the reasoning pattern required to answer them:

| Category | What it tests | Example |
|---|---|---|
| **1. Single-hop** | Find one specific fact from one dialogue turn | "When did Caroline go to the LGBTQ support group?" |
| **2. Temporal** | Date arithmetic, event ordering across time | "How many months after moving did she start the new job?" |
| **3. Multi-hop** | Compose multiple facts across different turns or sessions | "Who did she introduce her mother to after the wedding?" |
| **4. Open-domain** | Broad knowledge about the person — preferences, personality, life context | "What are Caroline's plans for the summer?" |
| **5. Adversarial** | Unanswerable questions deliberately designed to tempt hallucination | "What did Caroline's sister say about the trip?" (sister never mentioned) |

Each category stresses a different capability:
- Single-hop tests raw **recall** — can you find a needle in a haystack?
- Temporal tests **time awareness** — can you reason about when things happened?
- Multi-hop tests **composition** — can you chain facts together?
- Open-domain tests **synthesis** — can you generalize from episodic mentions?
- Adversarial tests **abstention** — can you say "I don't know" when appropriate?

### The evaluation methodology — LLM-as-Judge (J-score)

LOCOMO evaluation (following Mem0's protocol) uses **GPT-4o as an impartial judge**. For each QA pair:

1. Feed the conversation into the memory system (ingestion)
2. Ask the question via the memory system's retrieval + generation pipeline
3. The judge compares the generated answer against the ground-truth answer
4. The judge scores four dimensions on a 1-5 scale:
   - **factual_accuracy** — are the facts correct?
   - **relevance** — does it address the question?
   - **completeness** — does it cover all aspects of the ground truth?
   - **contextual_appropriateness** — is it grounded, not hallucinated?
5. Final J-score = `(sum of 4 dimensions / 20) × 100` → range 0-100

A J-score of 100 means perfect answer on all dimensions. 80+ is "strong," 50-79 is "partial," below 50 is "failed."

### Why LOCOMO matters for MemWal

Mem0 benchmarked against LOCOMO in their published paper. **Running this same benchmark gives us numbers directly comparable to theirs.** That comparability is the whole reason we chose LOCOMO first.

Mem0's published numbers (from arXiv 2504.19413, Table 3):

| Category | Mem0 Base | Mem0 Graph |
|---|---|---|
| Single-hop | 67.13 | 65.71 |
| Multi-hop | 51.15 | 47.19 |
| Temporal | 55.51 | 58.13 |
| Open-domain | 72.93 | 75.71 |

---

## Part 2 — How We Ran It

### Setup

**Server**: MemWal in `BENCHMARK_MODE=true`. The SEAL encryption and Walrus blob storage layers were stripped out — plaintext is stored directly in the `plaintext` column of Postgres. This isolates retrieval quality from storage infrastructure. (Production flow always goes through SEAL + Walrus.)

**Pipeline per query**:
```
question → POST /api/recall
        → embed query → vector search (Postgres pgvector)
        → top-10 memories returned with composite scores
        → LLM generates answer using memories as context (gpt-4o-mini)
        → LLM judge scores answer vs ground truth (gpt-4o)
```

**Three scoring configurations compared**:

| Preset | Semantic | Importance | Recency | Frequency | Intent |
|---|---|---|---|---|---|
| `baseline` | 1.0 | 0.0 | 0.0 | 0.0 | Pure cosine — what pgvector does without the upgrade |
| `default` | 0.5 | 0.2 | 0.2 | 0.1 | MemWal's suggested balanced config |
| `recency_heavy` | 0.3 | 0.2 | 0.4 | 0.1 | Optimized for temporal queries |

Key insight that made this affordable: **scoring weights are per-request parameters**. The same 1,654 ingested memories were evaluated under all 3 presets without re-ingesting. One expensive extraction, three cheap rankings.

### Actual execution

```
Phase                        Duration      Cost
────────────────────────────────────────────────────
Ingestion (analyze × 270)    40 min        $0.10
Eval baseline (1986 queries) 11 min        $2.00
Eval default (1986 queries)  12 min        $2.50
Eval recency_heavy (1986 q.) 11 min        $2.50
Wasted (v3 crash)                          $2.00
────────────────────────────────────────────────────
Total                        ~90 min       ~$9.10
```

Memories stored per conversation: 1,654 / 10 = **~165 per conversation**.

---

## Part 3 — How MemWal Performed

### Overall comparison

| Category | Baseline | Default | Recency_Heavy | Mem0 Paper | Gap vs Mem0 |
|---|---|---|---|---|---|
| Single-hop | **46.70** | 45.27 | 43.12 | 67.13 | **-20.4** |
| Multi-hop | **50.16** | 49.58 | 45.89 | 51.15 | **-0.99** |
| Temporal | **32.45** | 30.64 | 30.45 | 55.51 | **-23.1** |
| Open-domain | **45.33** | 43.34 | 41.41 | 72.93 | **-27.6** |
| Adversarial | 82.46 | 85.21 | **86.51** | — | — |
| **Overall** | **52.01** | 51.28 | 50.23 | — | — |

**Two observations**:

1. **Baseline (pure cosine) wins every substantive category.** The composite scoring system adds no value on LOCOMO and slightly hurts performance.
2. **The gap to Mem0 is dramatic on 3 of 4 categories.** Multi-hop is essentially tied (50.16 vs 51.15). But single-hop, temporal, and open-domain are all 20+ points behind.

### Per-category deep dive

For each category, we break down the distribution of J-scores:

- **High** (≥80) — strong answer, close to ground truth
- **Mid** (50-79) — partially right, missing details or slightly off
- **Low** (<50) — wrong, empty, or hallucinated
- **No-info** — generated answer says variant of "the memories do not contain this information"

---

#### Single-hop (n=282) — "find one specific fact"

| Preset | Mean | High (≥80) | Mid (50-79) | Low (<50) | No-info |
|---|---|---|---|---|---|
| baseline | 46.70 | 70 (25%) | 37 (13%) | 175 (62%) | 107 (38%) |
| default | 45.27 | 61 (22%) | 40 (14%) | 181 (64%) | 115 (41%) |
| recency_heavy | 43.12 | 55 (20%) | 35 (12%) | 192 (68%) | 124 (44%) |

**Mem0: 67.13 — gap ~20 points**

**Example success** (baseline, J=100):
```
Q: What is Caroline's favorite genre of music?
A: Caroline mentioned she enjoys classical music.
Ground truth: classical music
→ Retrieved the right memory, answered directly.
```

**Example failure** (baseline, J=20):
```
Q: What activities does Melanie partake in?
Ground truth: pottery, camping, painting, swimming
Generated:    "Melanie carves out me-time each day for running, reading, or playing the violin."
Top memory:   "Melanie carves out me-time each day for running, reading, or playing the violin"
```

The retrieved memory mentions OTHER activities. The ground-truth activities (pottery, camping, etc.) were never stored as memories — they were likely mentioned in passing during a session that got summarized into a different higher-level memory.

**Failure pattern**: ~38-44% of single-hop queries return "no information," meaning the right memory wasn't in the top 10 — likely because the specific fact wasn't extracted during ingestion.

---

#### Multi-hop (n=96) — "compose facts across turns"

| Preset | Mean | High (≥80) | Mid (50-79) | Low (<50) | No-info |
|---|---|---|---|---|---|
| baseline | 50.16 | 24 (25%) | 19 (20%) | 53 (55%) | 28 (29%) |
| default | 49.58 | 22 (23%) | 20 (21%) | 54 (56%) | 27 (28%) |
| recency_heavy | 45.89 | 17 (18%) | 18 (19%) | 61 (64%) | 35 (36%) |

**Mem0: 51.15 — gap ~1 point (effectively tied!)**

**This is our strongest category relative to Mem0.** We match them at 50 J. Why? Multi-hop questions typically involve several memories, and if even one contains the answer, the LLM can often synthesize it. Our ingestion may miss specific facts but captures enough of the relationship pattern.

**Example success** (baseline, J=100):
```
Q: Who introduced Caroline to the yoga studio she now attends?
A: Caroline's friend Sarah introduced her to the yoga studio after they met at the farmers market.
```

Two facts chained: (1) met Sarah at farmers market, (2) Sarah recommended yoga studio. Both were stored, LLM chained them.

---

#### Temporal (n=320) — "date arithmetic and ordering"

| Preset | Mean | High (≥80) | Mid (50-79) | Low (<50) | No-info |
|---|---|---|---|---|---|
| baseline | 32.45 | 23 (7%) | 11 (3%) | 286 (89%) | 185 (58%) |
| default | 30.64 | 15 (5%) | 10 (3%) | 295 (92%) | 186 (58%) |
| recency_heavy | 30.45 | 16 (5%) | 11 (3%) | 294 (92%) | 198 (62%) |

**Mem0: 55.51 — gap ~23 points**

**Our worst category.** 89% of queries score below 50. Over 58% explicitly say "no information."

**Example failure** (baseline, J=20):
```
Q: When did Melanie paint a sunrise?
Ground truth: 2022
Top memory:   "Caroline painted a sunset after visiting the beach last week."
Generated:    "The memories do not contain any information about Melanie painting a sunrise."
```

Two compounding failures:
1. The specific "Melanie painted a sunrise in 2022" fact wasn't extracted from her session.
2. Even if it were, we use `NOW()` for every memory's `created_at` instead of LOCOMO's in-conversation timestamps. Temporal reasoning has no real time axis to work with.

**Why recency_heavy doesn't help**: With the 5%/day decay formula `0.95^days`, and all memories created within the same 40-minute ingestion window, the recency score varies by 0.0000015 across 1,654 memories. Recency weight is effectively dead weight — it drains from semantic similarity without adding discrimination.

---

#### Open-domain (n=841) — "broad synthesis about the person"

| Preset | Mean | High (≥80) | Mid (50-79) | Low (<50) | No-info |
|---|---|---|---|---|---|
| baseline | 45.33 | 196 (23%) | 76 (9%) | 569 (68%) | 412 (49%) |
| default | 43.34 | 181 (22%) | 53 (6%) | 607 (72%) | 440 (52%) |
| recency_heavy | 41.41 | 168 (20%) | 43 (5%) | 630 (75%) | 488 (58%) |

**Mem0: 72.93 — gap ~28 points (largest gap)**

**This is the single largest gap to Mem0.** Open-domain questions ask for synthesis — "what kind of person is Caroline?" — which requires surfacing multiple related memories and composing an answer.

**Example failure** (baseline, J=20):
```
Q: What are Caroline's plans for the summer?
Ground truth: researching adoption agencies
Top memory:   "Caroline is continuing her education and exploring career options"
Generated:    "The memories do not contain specific information about Caroline's plans for the summer."
```

The retrieved memory is adjacent (future plans, but wrong future plans) — the specific "adoption research" memory wasn't in the top 10. The generation then refuses to speculate, per our strict answer prompt.

**Why we lose so hard here**:
- Synthesis needs many facts; our extraction loses many facts
- Even more than single-hop, open-domain rewards recall depth
- Mem0's graph variant wins by +2.78 points on open-domain specifically — they have a structural advantage we don't

---

#### Adversarial (n=445-446) — "correctly abstain on unanswerable questions"

| Preset | Mean | High (≥80) | Mid (50-79) | Low (<50) | No-info |
|---|---|---|---|---|---|
| baseline | 82.46 | 333 (75%) | 21 (5%) | 91 (20%) | 320 (72%) |
| default | 85.21 | 351 (79%) | 18 (4%) | 77 (17%) | 347 (78%) |
| recency_heavy | **86.51** | 362 (81%) | 13 (3%) | 71 (16%) | 375 (84%) |

**The only category where composite scoring wins.**

Adversarial questions are deliberately unanswerable — they ask about people, events, or topics the conversation never actually covered. The correct answer is "I don't know" or equivalent. When the judge sees "the memories do not contain this information," it scores a strong 4-5 on all dimensions because that's the right answer.

**Why composite wins here**: When there's NO correct memory, the composite score pulls in LESS-semantically-close memories (because importance + recency can override semantic). The LLM gets irrelevant context, correctly concludes "I can't answer this," and scores high for abstaining.

**Recency_heavy at 86.5 is genuinely good.** It edges out baseline by 4 points and default by 1.3 points.

---

## Part 4 — What The Numbers Say

### On MemWal overall

**The bottom line**: MemWal's retrieval works at a basic level — we score in the 50s on LOCOMO, which is real memory behavior, not random chance. But we're significantly behind Mem0 on the categories that matter for a memory system (single-hop, temporal, open-domain).

**Our strong category**: Multi-hop (50.16 vs Mem0's 51.15). Dead even.

**Our weak categories**:
- Single-hop: -20 points
- Open-domain: -28 points
- Temporal: -23 points

**Where we win**: Adversarial abstention. We correctly refuse to answer 72-84% of unanswerable questions. This is a property — MemWal doesn't hallucinate when memory is absent.

### On the memory structure upgrade specifically

The upgrade added four scoring signals: semantic, importance, recency, frequency. Looking at preset comparisons:

- **Semantic alone (baseline)**: 52.01
- **All four (default)**: 51.28 (-0.73)
- **Recency-boosted**: 50.23 (-1.78)

**The upgrade's scoring additions are net-negative on LOCOMO.** This is a harsh finding, but it's specific to this benchmark. Diagnosis (from `root-cause.md`):

1. **Importance distribution is flat** — LLM-assigned values cluster in 0.4-0.9, giving no discrimination
2. **Recency decay is inactive** — `NOW()` timestamps make all memories equally recent
3. **Frequency signal is zero** — cold start, no access history to leverage

None of the additional signals exercised their purpose here. Semantic similarity is the only useful signal on a cold-start benchmark, and bringing weight to other signals takes weight away from the one that works.

### On the comparison methodology

The benchmark is a **fair comparison of Mem0 vs MemWal on LOCOMO** — we used their protocol, their dataset, their metric. The 52 vs 55-73 gap is real.

However, it's not a fair comparison of MemWal's ceiling vs Mem0's ceiling:
- Mem0 likely uses finer-grained extraction (per-turn-pair sliding window vs our per-session blob)
- Mem0 likely uses larger top-K (paper uses k=10-20, we use 10)
- Mem0 has a graph layer; we don't

These are design differences in the upstream ingestion, not scoring flaws. Our scoring layer was never given a fair fight.

---

## Part 5 — What To Do About It

See `root-cause.md` for the prioritized fix list. In short:

1. **Before re-running benchmarks**: fix extraction granularity (per-turn-pair sliding window) — this will recover most of the 53% "no info" rate
2. **Cheap win**: bump recall_limit from 10 to 20
3. **Make recency real**: use LOCOMO's session timestamps instead of `NOW()`
4. **Re-run LongMemEval**: has "Knowledge Updates" category where composite scoring should shine

Until #1 is fixed, comparing scoring presets is measuring noise. The signal is drowned out by coverage failures.

---

## Appendix — Files

**Result artifacts** (each ~6MB, full per-query detail, kept in git as evidence):
```
results/
├── baseline.json         (semantic=1.0, rest=0)
├── default.json          (0.5/0.2/0.2/0.1)
└── recency_heavy.json    (0.3/0.2/0.4/0.1)
```

These are the original files from `services/server/benchmarks/results/2026-04-20-130136-locomo-*.json`, preserved verbatim.

**Reports in this folder**:
- `summary.md` — concise summary for stakeholders
- `root-cause.md` — engineering root cause analysis
- `detailed-report.md` — this document
- `README.md` — run metadata and reading order

**Benchmark framework source**:
```
services/server/benchmarks/
├── README.md               # How to run
├── run.py                  # CLI entry point
├── core/                   # Framework core (client, metrics, judge, report)
└── benchmarks/             # Per-benchmark adapters (locomo, longmemeval, convomem)
```
