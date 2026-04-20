"""
Internal data types for the benchmark framework.

Every benchmark adapter converts its source format into these types.
All downstream code (ingestion, recall, evaluation, reporting) works
exclusively with these types — never with benchmark-specific formats.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ============================================================
# Dataset types — output of benchmark adapters
# ============================================================

@dataclass
class Turn:
    """A single utterance in a conversation."""
    speaker: str            # "user" or "assistant"
    text: str
    turn_id: str            # unique within conversation
    timestamp: str | None = None


@dataclass
class Session:
    """A contiguous block of conversation turns (one sitting)."""
    session_id: str
    turns: list[Turn]


@dataclass
class Conversation:
    """A full multi-session conversation for one user."""
    conversation_id: str
    sessions: list[Session]


@dataclass
class Query:
    """A benchmark question with ground truth."""
    query_id: str
    conversation_id: str    # which conversation this question is about
    question: str
    category: str           # "single_hop", "multi_hop", "temporal", "open_domain", etc.
    ground_truth_answer: str
    evidence_turn_ids: list[str] = field(default_factory=list)


# ============================================================
# Scoring configuration
# ============================================================

@dataclass
class ScoringWeights:
    """Weights for MemWal's composite retrieval scoring."""
    semantic: float = 0.5
    importance: float = 0.2
    recency: float = 0.2
    frequency: float = 0.1

    def to_dict(self) -> dict:
        return {
            "semantic": self.semantic,
            "importance": self.importance,
            "recency": self.recency,
            "frequency": self.frequency,
        }


# ============================================================
# Retrieval and evaluation types
# ============================================================

@dataclass
class RetrievedMemory:
    """A single memory returned by /api/recall."""
    memory_id: str
    text: str
    score: float
    memory_type: str | None = None
    importance: float | None = None


@dataclass
class Judgment:
    """LLM-as-Judge evaluation of a generated answer."""
    factual_accuracy: int       # 1-5
    relevance: int              # 1-5
    completeness: int           # 1-5
    contextual_appropriateness: int  # 1-5

    @property
    def j_score(self) -> float:
        """Normalized to 0-100, matching Mem0 paper methodology."""
        raw = (
            self.factual_accuracy
            + self.relevance
            + self.completeness
            + self.contextual_appropriateness
        )
        return (raw / 20.0) * 100.0


@dataclass
class QueryResult:
    """Full result for a single benchmark query."""
    query: Query
    retrieved_memories: list[RetrievedMemory]
    generated_answer: str
    judgment: Judgment | None = None
    retrieval_metrics: dict = field(default_factory=dict)


# ============================================================
# Run artifact — the output of a full benchmark run
# ============================================================

@dataclass
class IngestionStats:
    """Statistics from the ingestion phase."""
    conversations_processed: int = 0
    memories_stored: int = 0
    duration_seconds: float = 0.0
    tokens_used: dict = field(default_factory=dict)
    cost_usd: float = 0.0


@dataclass
class CategoryMetrics:
    """Aggregate metrics for one query category."""
    j_score_mean: float = 0.0
    j_score_std: float = 0.0
    recall_at_5: float = 0.0
    recall_at_10: float = 0.0
    mrr: float = 0.0
    ndcg_at_10: float = 0.0
    count: int = 0


@dataclass
class RunArtifact:
    """Complete output of a benchmark run. Serialized to results/{run_id}.json."""
    run_id: str
    timestamp: str
    git_commit: str
    benchmark: str
    preset: str

    config: dict = field(default_factory=dict)
    ingestion: IngestionStats = field(default_factory=IngestionStats)
    metrics_overall: CategoryMetrics = field(default_factory=CategoryMetrics)
    metrics_by_category: dict[str, CategoryMetrics] = field(default_factory=dict)
    query_results: list[QueryResult] = field(default_factory=list)
    cost_usd: float = 0.0
