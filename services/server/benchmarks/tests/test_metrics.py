"""
Verify metric calculations against hand-computed known values.

These tests ensure our Recall@K, MRR, nDCG, and F1 implementations
produce correct results. If any of these fail, every benchmark result
computed with these metrics is suspect.
"""

import math
import pytest

from core.metrics import (
    compute_recall_at_k,
    compute_precision_at_k,
    compute_mrr,
    compute_ndcg,
    compute_f1,
    aggregate_metrics,
)


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
