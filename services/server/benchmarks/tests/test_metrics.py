"""
Verify metric calculations against hand-computed known values.

These tests ensure our Recall@K, MRR, nDCG, and F1 implementations
produce correct results. If any of these fail, every benchmark result
computed with these metrics is suspect.
"""

import math
import sys
from pathlib import Path

import pytest

from core.metrics import (
    compute_recall_at_k,
    compute_precision_at_k,
    compute_mrr,
    compute_ndcg,
    compute_f1,
    aggregate_metrics,
)

# run.py isn't importable as a package; add its directory to sys.path
# just for the session_map_key test below.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from run import session_map_key  # noqa: E402


class TestRecallAtK:
    def test_perfect_recall(self):
        retrieved = ["a", "b", "c", "d", "e"]
        relevant = {"a", "b", "c"}
        assert compute_recall_at_k(retrieved, relevant, 5) == 1.0

    def test_partial_recall(self):
        retrieved = ["a", "x", "y", "b", "z"]
        relevant = {"a", "b", "c"}
        # top 3: {a, x, y} ∩ {a, b, c} = {a} → 1/3
        assert abs(compute_recall_at_k(retrieved, relevant, 3) - 1 / 3) < 1e-9

    def test_zero_recall(self):
        retrieved = ["x", "y", "z"]
        relevant = {"a", "b"}
        assert compute_recall_at_k(retrieved, relevant, 3) == 0.0

    def test_empty_relevant(self):
        retrieved = ["a", "b"]
        relevant = set()
        assert compute_recall_at_k(retrieved, relevant, 5) == 1.0

    def test_k_larger_than_retrieved(self):
        retrieved = ["a", "b"]
        relevant = {"a", "c"}
        # top 5 from ["a", "b"]: {a, b} ∩ {a, c} = {a} → 1/2
        assert compute_recall_at_k(retrieved, relevant, 5) == 0.5


class TestMRR:
    def test_first_position(self):
        retrieved = ["a", "b", "c"]
        relevant = {"a"}
        assert compute_mrr(retrieved, relevant) == 1.0

    def test_second_position(self):
        retrieved = ["x", "a", "c"]
        relevant = {"a"}
        assert compute_mrr(retrieved, relevant) == 0.5

    def test_third_position(self):
        retrieved = ["x", "y", "a"]
        relevant = {"a"}
        assert abs(compute_mrr(retrieved, relevant) - 1 / 3) < 1e-9

    def test_not_found(self):
        retrieved = ["x", "y", "z"]
        relevant = {"a"}
        assert compute_mrr(retrieved, relevant) == 0.0

    def test_multiple_relevant_returns_first(self):
        retrieved = ["x", "a", "b"]
        relevant = {"a", "b"}
        # First relevant is "a" at position 2 → 1/2
        assert compute_mrr(retrieved, relevant) == 0.5


class TestNDCG:
    def test_perfect_ranking(self):
        # All relevant items at the top
        retrieved = ["a", "b", "x", "y"]
        relevant = {"a", "b"}
        assert abs(compute_ndcg(retrieved, relevant, 4) - 1.0) < 1e-9

    def test_worst_ranking(self):
        # Relevant items at the bottom
        retrieved = ["x", "y", "a", "b"]
        relevant = {"a", "b"}
        # DCG = 1/log2(4+1) + 1/log2(5+1) = 1/log2(5) + 1/log2(6)
        # IDCG = 1/log2(2) + 1/log2(3)
        dcg = 1 / math.log2(4) + 1 / math.log2(5)
        idcg = 1 / math.log2(2) + 1 / math.log2(3)
        expected = dcg / idcg
        assert abs(compute_ndcg(retrieved, relevant, 4) - expected) < 1e-9

    def test_empty_relevant(self):
        retrieved = ["a", "b"]
        relevant = set()
        assert compute_ndcg(retrieved, relevant, 5) == 1.0

    def test_no_relevant_found(self):
        retrieved = ["x", "y", "z"]
        relevant = {"a", "b"}
        assert compute_ndcg(retrieved, relevant, 3) == 0.0


class TestF1:
    def test_perfect(self):
        assert compute_f1(1.0, 1.0) == 1.0

    def test_zero(self):
        assert compute_f1(0.0, 0.0) == 0.0

    def test_balanced(self):
        # precision=0.5, recall=0.5 → F1=0.5
        assert compute_f1(0.5, 0.5) == 0.5

    def test_imbalanced(self):
        # precision=1.0, recall=0.5 → F1 = 2*1*0.5/(1+0.5) = 2/3
        assert abs(compute_f1(1.0, 0.5) - 2 / 3) < 1e-9


class TestAggregateMetrics:
    def test_basic_aggregation(self):
        per_query = [
            {"recall_at_5": 0.8, "mrr": 1.0},
            {"recall_at_5": 0.6, "mrr": 0.5},
            {"recall_at_5": 1.0, "mrr": 1.0},
        ]
        result = aggregate_metrics(per_query)
        assert abs(result["recall_at_5"]["mean"] - 0.8) < 1e-9
        assert abs(result["mrr"]["mean"] - 5 / 6) < 1e-9
        assert result["recall_at_5"]["std"] > 0  # non-zero std

    def test_empty_input(self):
        assert aggregate_metrics([]) == {}

class TestSessionMapKey:
    """
    Regression tests for the canonical session-map key format.

    This helper is the single source of truth used by BOTH the ingestion
    writer (run.py stage_ingest) and the evaluation reader
    (_resolve_evidence_memory_ids). If its format changes, both producer
    and consumer update in lockstep. The tests here document the contract.
    """

    def test_format_is_separator_joined(self):
        assert session_map_key("conv-1", "session-A") == "conv-1::session-A"

    def test_empty_strings_allowed(self):
        # Edge case: adapter might produce these during development.
        # The helper shouldn't crash; correctness is the adapter's problem.
        assert session_map_key("", "session-A") == "::session-A"
        assert session_map_key("conv-1", "") == "conv-1::"

    def test_roundtrip_consistency(self):
        # Same inputs always produce the same key. Trivial but guards
        # against someone adding entropy (timestamp, random, etc.) later.
        k1 = session_map_key("c", "s")
        k2 = session_map_key("c", "s")
        assert k1 == k2


class TestAggregateMetricsMissingFields:
    def test_queries_missing_recall_metrics_are_skipped(self):
        """
        Regression test: when some per-query entries have no recall fields
        (because the evidence couldn't be resolved), aggregation must
        compute the mean from only the queries that HAVE the field, not
        treat missing as zero or one.

        Matches run.py's current behavior of omitting recall fields when
        the relevant set is empty after evidence resolution.
        """
        per_query = [
            # Three resolvable queries
            {"recall_at_5": 0.8, "mrr": 0.9},
            {"recall_at_5": 0.6, "mrr": 0.5},
            {"recall_at_5": 1.0, "mrr": 1.0},
            # Two unresolvable queries — missing recall fields
            {"j_score": 70.0},
            {"j_score": 50.0, "recall_skipped_reason": "no_resolvable_memories"},
        ]
        result = aggregate_metrics(per_query)
        # Recall mean is over the 3 queries that have it, not all 5
        assert abs(result["recall_at_5"]["mean"] - 0.8) < 1e-9
        assert abs(result["mrr"]["mean"] - (0.9 + 0.5 + 1.0) / 3) < 1e-9
        # j_score comes from the other 2
        assert abs(result["j_score"]["mean"] - 60.0) < 1e-9
