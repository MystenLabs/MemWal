# MemWal Retrieval Quality Benchmark — Design Document

> **Purpose**: Measure and compare MemWal's retrieval quality against published baselines (Mem0, Zep, Supermemory) using industry-standard benchmarks.
>
> **Audience**: Engineering team, for pre-launch quality validation.
>
> **Date**: April 2026

---

## 1. What We're Testing

Henry's memory structure upgrade adds four signals to retrieval scoring:

| Signal | Formula | What it rewards |
|---|---|---|
| Semantic similarity | `1 - cosine_distance` | Relevant content |
| Importance | `0.0 - 1.0` | Critical memories over trivial ones |
| Recency | `0.95 ^ days_old` | Fresh memories over stale ones |
| Frequency | `ln(1 + access_count) / ln(101)` | Frequently accessed memories |

**The core question**: does composite scoring improve retrieval quality over pure cosine similarity, and how does it compare to Mem0's published numbers?

---

## 2. Benchmarks

Three industry-standard datasets, ordered by priority:

### LOCOMO (must-run)

The benchmark Mem0 used in their paper. Direct comparability.

| | |
|---|---|
| **Source** | Snap Research, ICLR 2025 |
| **Access** | `github.com/snap-research/locomo` or HuggingFace `Aman279/Locomo` |
| **Size** | 10 conversations, ~300 turns each, ~1,500 QA pairs |
| **Categories** | Single-hop, Multi-hop, Temporal, Open-domain, Adversarial |
| **Primary metric** | LLM-as-Judge (J-score, 0-100) |
| **License** | CC BY-NC 4.0 |
| **Est. cost per run** | ~$3 (LLM judge) + ~$0.15 (ingestion) |

Mem0's published numbers (J-score):

| Category | Mem0 Base | Mem0 Graph |
|---|---|---|
| Single-hop | 67.13 | 65.71 |
| Multi-hop | 51.15 | 47.19 |
| Temporal | 55.51 | 58.13 |
| Open-domain | 72.93 | 75.71 |

### LongMemEval (important)

500 hand-curated questions. The "Knowledge Updates" category directly tests recency decay and supersede logic.

| | |
|---|---|
| **Source** | UMass/Microsoft, ICLR 2025 |
| **Access** | HuggingFace `xiaowu0162/longmemeval-cleaned` |
| **Size** | 500 QA pairs, 3 variants (oracle / standard / stress) |
| **Categories** | Extraction, Multi-session, Temporal, Knowledge Updates, Abstention |
| **Primary metric** | GPT-4o judge accuracy (%), Recall@K, nDCG@K |
| **License** | MIT |
| **Est. cost per run** | ~$1 (LLM judge) + ~$0.10 (ingestion) |

Published reference: Supermemory 85.4%, Zep 63.8%, Mem0 49.0%.

### ConvoMem (scale validation)

75K QA pairs. Pre-mixed at 15 context sizes. Finds the crossover point where MemWal beats naive full-context.

| | |
|---|---|
| **Source** | Salesforce Research, 2025 |
| **Access** | HuggingFace `Salesforce/ConvoMem` |
| **Size** | 75,336 QA pairs, 100 personas |
| **Categories** | User facts, Changing evidence, Abstention, Preferences, Implicit connections |
| **Primary metric** | Accuracy, F1 |
| **License** | CC BY-NC 4.0 |
| **Est. cost per run** | ~$10 (LLM judge, running a subset) |

---

## 3. Architecture

### Pipeline

```
DOWNLOAD → INGEST → RECALL → EVALUATE → REPORT
```

**DOWNLOAD**: Fetch dataset from HuggingFace, cache locally. Parse source format into internal types. Run once, reuse across runs.

**INGEST**: Feed conversations through `/api/analyze`. MemWal extracts and stores memories. Run once per benchmark, reuse across scoring presets.

**RECALL**: For each query, call `/api/recall` with scoring weight preset. Scoring weights are per-request parameters, not stored on memories — so one ingestion supports all preset comparisons.

**EVALUATE**: Two modes:
- **Retrieval-only**: Compare recalled memory texts against ground-truth evidence. Compute Recall@K, MRR, nDCG. Isolates the scoring formula from generation quality.
- **End-to-end**: Feed recalled memories as context to an LLM, generate an answer, judge against ground truth. Produces J-score (comparable to Mem0's published numbers).

**REPORT**: Generate comparison tables across presets. Compare against published baselines.

### Key design decisions

**Python, not TypeScript.** All three benchmarks provide Python evaluation code. HuggingFace datasets library, numpy for metrics, standard ML tooling. The harness talks to MemWal's REST API directly — no SDK dependency.

**Ingest once, recall with multiple presets.** MemWal's scoring weights are passed as request parameters in `/api/recall`. This means ingestion (the expensive step) only happens once per benchmark run. Each scoring preset just re-queries the same memories with different weights.

**Fixed LLM judge prompt.** The judge prompt is a constant. Never modify it between runs or between preset comparisons. Judge variance is measured by running 3+ evaluations per configuration.

**Namespaces for isolation.** Each benchmark run uses namespace `bench-{benchmark}-{conversation_id}-{run_id}`. Prevents cross-contamination. Teardown cleans all namespaces for a run.

---

## 4. Directory Structure

```
services/server/benchmarks/
  README.md                        # How to install, run, interpret results
  pyproject.toml                   # Python dependencies
  config.example.yaml              # Template config (no secrets)
  .gitignore                       # datasets/, results/, config.yaml, .venv/

  run.py                           # CLI entry point

  core/                            # Framework internals
    __init__.py
    types.py                       # Dataclasses: Conversation, Session, Turn, Query,
                                   #   GroundTruth, RetrievedMemory, EvalResult, RunArtifact
    client.py                      # MemWal HTTP client (Ed25519 signing, analyze, recall)
    metrics.py                     # Recall@K, MRR, nDCG@K, J-score, F1
    judge.py                       # LLM-as-Judge (fixed prompt, structured scoring)
    report.py                      # Markdown table generation, preset comparison

  benchmarks/                      # One module per benchmark
    __init__.py
    base.py                        # Abstract class: download(), load(), ingest(), query(), evaluate()
    locomo.py                      # LOCOMO adapter
    longmemeval.py                 # LongMemEval adapter
    convomem.py                    # ConvoMem adapter

  presets/                         # Scoring weight configurations
    baseline.yaml                  # semantic=1.0, rest=0 (pure cosine, no composite)
    default.yaml                   # semantic=0.5, importance=0.2, recency=0.2, frequency=0.1
    recency_heavy.yaml             # semantic=0.3, importance=0.2, recency=0.4, frequency=0.1
    importance_heavy.yaml          # semantic=0.3, importance=0.4, recency=0.2, frequency=0.1

  datasets/                        # Downloaded data (gitignored)
    .gitkeep

  results/                         # Run artifacts (gitignored)
    .gitkeep

  tests/                           # Framework self-tests
    test_metrics.py                # Verify metric formulas against known values
    test_client.py                 # Verify Ed25519 signing matches server expectations
```

---

## 5. Internal Data Types

Every benchmark, regardless of source format, maps to these types. Downstream code (ingestion, recall, evaluation) never touches benchmark-specific formats.

```python
@dataclass
class Turn:
    speaker: str                    # "user" or "assistant"
    text: str
    turn_id: str                    # unique within conversation
    timestamp: str | None = None

@dataclass
class Session:
    session_id: str
    turns: list[Turn]

@dataclass
class Conversation:
    conversation_id: str
    sessions: list[Session]

@dataclass
class Query:
    query_id: str
    conversation_id: str
    question: str
    category: str                   # "single_hop", "multi_hop", "temporal", etc.
    ground_truth_answer: str
    evidence_turn_ids: list[str]    # which turns contain the answer

@dataclass
class RetrievedMemory:
    memory_id: str
    text: str
    score: float
    memory_type: str | None
    importance: float | None

@dataclass
class Judgment:
    factual_accuracy: int           # 1-5
    relevance: int                  # 1-5
    completeness: int               # 1-5
    contextual_appropriateness: int # 1-5
    j_score: float                  # normalized 0-100

@dataclass
class QueryResult:
    query: Query
    retrieved_memories: list[RetrievedMemory]
    generated_answer: str
    judgment: Judgment
    retrieval_metrics: dict         # recall@k, mrr for this query
```

---

## 6. Benchmark Adapter Interface

Each benchmark implements:

```python
class BenchmarkAdapter(ABC):

    @abstractmethod
    def download(self, cache_dir: str) -> None:
        """Download dataset to local cache. Idempotent."""

    @abstractmethod
    def load(self, cache_dir: str) -> tuple[list[Conversation], list[Query]]:
        """Parse cached dataset into internal types."""

    @abstractmethod
    def answer_prompt(self, question: str, memories: list[str]) -> str:
        """Build the answer-generation prompt for this benchmark's style."""
```

The adapter does NOT handle ingestion or recall — that's the framework's job using `client.py`. The adapter only handles:
1. Downloading and parsing the dataset's specific format
2. Mapping it to internal types
3. Providing the answer-generation prompt template (some benchmarks specify how to prompt)

---

## 7. Evaluation Protocol

### Retrieval-only mode (fast, cheap, diagnostic)

For each query:
1. Call `/api/recall` with the query text and scoring preset
2. Compare retrieved memory texts against `evidence_turn_ids` ground truth
3. Compute Recall@K, MRR, nDCG

This tells you: **did the right memories surface?** Isolates scoring quality from LLM generation.

### End-to-end mode (slower, costs LLM calls, publishable)

For each query:
1. Call `/api/recall` to get relevant memories
2. Prompt an LLM with: memories as context + the question → generate answer
3. LLM-as-Judge scores the generated answer against ground truth

The judge prompt (fixed across all runs):

```
You are evaluating the quality of an answer about a user, based on
their conversation history.

Question: {question}
Ground truth answer: {ground_truth}
Generated answer: {generated_answer}

Score each dimension from 1 (worst) to 5 (best):

1. Factual accuracy: Are the facts in the answer correct and grounded
   in the conversation?
2. Relevance: Does the answer address the question asked?
3. Completeness: Does it cover all relevant aspects of the ground truth?
4. Contextual appropriateness: Is the answer grounded in actual
   conversation history, not hallucinated?

Respond as JSON:
{"factual_accuracy": N, "relevance": N, "completeness": N,
 "contextual_appropriateness": N}
```

J-score = mean of 4 dimensions, normalized to 0-100.

### Statistical rigor

- Run each evaluation 3 times (LLM judge variance)
- Report mean +/- standard deviation
- Mem0 reports 10 runs; 3 is sufficient for our purposes since MemWal retrieval is deterministic (only judge calls vary)

---

## 8. Comparison Matrix

For each benchmark, we compare these configurations:

| Preset | Semantic | Importance | Recency | Frequency | Purpose |
|---|---|---|---|---|---|
| `baseline` | 1.0 | 0.0 | 0.0 | 0.0 | Pure cosine (pre-upgrade equivalent) |
| `default` | 0.5 | 0.2 | 0.2 | 0.1 | MemWal's default composite |
| `recency_heavy` | 0.3 | 0.2 | 0.4 | 0.1 | Optimized for temporal queries |
| `importance_heavy` | 0.3 | 0.4 | 0.2 | 0.1 | Optimized for critical fact retrieval |

Plus published baselines:

| System | Source |
|---|---|
| Mem0 Base | Paper (arXiv 2504.19413) |
| Mem0 Graph | Paper |
| Zep | LongMemEval paper |
| Supermemory | MemoryBench |

The output table looks like:

```
LOCOMO J-scores (mean +/- std, 3 runs)

| Category    | Baseline | Default  | Recency  | Importance | Mem0 Paper |
|-------------|----------|----------|----------|------------|------------|
| Single-hop  |    —     |    —     |    —     |     —      |   67.13    |
| Multi-hop   |    —     |    —     |    —     |     —      |   51.15    |
| Temporal    |    —     |    —     |    —     |     —      |   55.51    |
| Open-domain |    —     |    —     |    —     |     —      |   72.93    |
```

---

## 9. CLI Interface

```bash
# One-time setup
cd services/server/benchmarks
python -m venv .venv && source .venv/bin/activate
pip install -e .
cp config.example.yaml config.yaml   # fill in credentials

# Download datasets
python run.py download locomo
python run.py download longmemeval
python run.py download convomem

# Ingest a benchmark (one-time per run)
python run.py ingest locomo

# Evaluate with a single preset
python run.py eval locomo --preset default

# Compare multiple presets (runs retrieval + eval for each)
python run.py compare locomo --presets baseline,default,recency_heavy

# Full run: ingest + compare + report
python run.py full locomo --presets baseline,default,recency_heavy,importance_heavy

# View results
python run.py report --run latest
python run.py report --run 2026-04-20-001

# Cleanup test data
python run.py cleanup --run 2026-04-20-001
```

---

## 10. Result Artifact

Each run produces `results/{run_id}.json` containing:

```json
{
  "run_id": "2026-04-20-001",
  "timestamp": "2026-04-20T07:30:00Z",
  "git_commit": "97f62ec",
  "benchmark": "locomo",
  "preset": "default",

  "config": {
    "server_url": "http://localhost:3001",
    "embedding_model": "text-embedding-3-small",
    "scoring_weights": { "semantic": 0.5, "importance": 0.2, "recency": 0.2, "frequency": 0.1 },
    "recall_limit": 10,
    "judge_model": "gpt-4o",
    "answer_model": "gpt-4o-mini"
  },

  "ingestion": {
    "conversations_processed": 10,
    "memories_stored": 1523,
    "extraction_recall": 0.83,
    "duration_seconds": 245,
    "tokens": { "embedding": 45000, "extraction": 120000 },
    "cost_usd": 0.15
  },

  "metrics": {
    "overall": {
      "j_score": { "mean": 64.2, "std": 1.3 },
      "recall_at_5": 0.68,
      "mrr": 0.73
    },
    "by_category": {
      "single_hop": { "j_score": { "mean": 69.1, "std": 1.1 }, "recall_at_5": 0.74 },
      "multi_hop": { "j_score": { "mean": 52.3, "std": 2.0 }, "recall_at_5": 0.55 },
      "temporal": { "j_score": { "mean": 59.8, "std": 1.8 }, "recall_at_5": 0.62 },
      "open_domain": { "j_score": { "mean": 75.6, "std": 0.9 }, "recall_at_5": 0.80 }
    }
  },

  "cost": {
    "ingestion_usd": 0.15,
    "evaluation_usd": 2.50,
    "total_usd": 2.65
  },

  "queries": [ "... per-query detail ..." ]
}
```

---

## 11. Pitfalls and Mitigations

| Pitfall | Risk | Mitigation |
|---|---|---|
| Embedding model changes between runs | Scores not comparable | Lock model version in config, record in artifact |
| LLM judge variance | +/- 2-3 points per run | 3 evaluation runs, report mean +/- std |
| Recency decay depends on wall clock | Scores shift day to day | Run all presets in same session; record ingestion timestamp |
| Ingestion order affects access_count | Frequency scores differ | Fixed conversation ordering (sort by ID) |
| Rate limiting during benchmark | Ingestion fails or throttles | Use high-quota test account or disable limits for `bench-*` namespaces |
| Analyze extracts different facts per run | Ingestion non-deterministic | Ingest once, reuse across presets; log extraction recall |
| Pending blob rows during ingestion | Recall skips mid-upload memories | Wait for ingestion to fully complete before running recall |

---

## 12. Timeline and Cost

| Phase | Work | Cost | Time |
|---|---|---|---|
| Framework scaffold | `core/`, `run.py`, `types.py`, `client.py`, `metrics.py` | $0 | 2 days |
| LOCOMO adapter | `locomo.py`, download, parse, ingest, eval | ~$3 per run | 1 day |
| LongMemEval adapter | `longmemeval.py` | ~$1 per run | 1 day |
| ConvoMem adapter | `convomem.py` | ~$10 per run (subset) | 1 day |
| Comparison runs | 4 presets x 3 repeats x 2 benchmarks | ~$25 total | 1 day |
| Report and analysis | Interpret results, write assessment | $0 | 1 day |
| **Total** | | **~$25** | **~7 days** |
