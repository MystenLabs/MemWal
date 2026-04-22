"""
Information retrieval metrics.

All functions take the same pattern:
  - retrieved: ordered list of retrieved item IDs (rank 1 first)
  - relevant: set of ground-truth relevant item IDs

Standard metrics used across BEIR, LOCOMO, and LongMemEval benchmarks.
"""

from __future__ import annotations

import math

import numpy as np


def compute_recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    """
    Recall@K: fraction of relevant items found in the top K results.

    Recall@5 = |{retrieved[:5]} ∩ relevant| / |relevant|

    Returns 1.0 if relevant is empty (nothing to find = perfect recall).
    """
    if not relevant:
        return 1.0
    top_k = set(retrieved[:k])
    return len(top_k & relevant) / len(relevant)


def compute_precision_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    """
    Precision@K: fraction of top K results that are relevant.

    Precision@5 = |{retrieved[:5]} ∩ relevant| / K
    """
    if k == 0:
        return 0.0
    top_k = set(retrieved[:k])
    return len(top_k & relevant) / k


def compute_mrr(retrieved: list[str], relevant: set[str]) -> float:
    """
    Mean Reciprocal Rank: 1 / (rank of first relevant result).

    MRR = 1/rank if any relevant result is found, else 0.
    """
    for i, item_id in enumerate(retrieved):
        if item_id in relevant:
            return 1.0 / (i + 1)
    return 0.0


def compute_ndcg(retrieved: list[str], relevant: set[str], k: int) -> float:
    """
    Normalized Discounted Cumulative Gain @ K.

    Measures ranking quality — rewards relevant items appearing higher.
    Uses binary relevance (1 if relevant, 0 otherwise).

    nDCG@K = DCG@K / IDCG@K
    DCG@K  = sum(rel_i / log2(i + 2)) for i in 0..K-1
    IDCG@K = DCG of the ideal ranking (all relevant items first)
    """
    if not relevant:
        return 1.0

    # DCG of the actual ranking
    dcg = 0.0
    for i, item_id in enumerate(retrieved[:k]):
        if item_id in relevant:
            dcg += 1.0 / math.log2(i + 2)

    # IDCG: best possible DCG (all relevant items ranked first)
    ideal_count = min(len(relevant), k)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_count))

    if idcg == 0.0:
        return 0.0
    return dcg / idcg


def compute_f1(precision: float, recall: float) -> float:
    """Harmonic mean of precision and recall."""
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


# ============================================================
# Aggregate metrics across multiple queries
# ============================================================

def aggregate_metrics(
    per_query: list[dict],
) -> dict:
    """
    Aggregate per-query metrics into mean and std.

    Input: list of dicts, each with keys like "recall_at_5", "mrr", "j_score", etc.
    Output: dict of {"recall_at_5": {"mean": ..., "std": ...}, ...}

    Note: not every query has every field. For example, queries with
    unresolvable evidence skip the recall fields entirely. We compute the
    mean over whatever entries DO have a numeric value for each field,
    rather than treating missing values as zero. That's what makes skipping
    unresolvable queries honest rather than silently inflating scores.
    """
    if not per_query:
        return {}

    # Union of keys across ALL entries — the first entry may not carry
    # every field, since different query classes (e.g., session vs turn
    # evidence) populate different subsets.
    keys: set[str] = set()
    for q in per_query:
        keys.update(q.keys())

    result = {}
    for key in keys:
        # Only aggregate numeric fields; skip query_id, category, evidence_kinds, etc.
        values = [
            q[key] for q in per_query
            if key in q and q[key] is not None and isinstance(q[key], (int, float))
            and not isinstance(q[key], bool)  # bool is a subclass of int; exclude it
        ]
        if values:
            result[key] = {
                "mean": float(np.mean(values)),
                "std": float(np.std(values)),
            }
    return result


def aggregate_by_category(
    per_query: list[dict],
    categories: list[str],
) -> dict[str, dict]:
    """
    Group per-query metrics by category and aggregate each group.

    Input: list of dicts, each must have a "category" key.
    Output: {"single_hop": {"recall_at_5": {"mean": ..., "std": ...}, ...}, ...}
    """
    grouped: dict[str, list[dict]] = {cat: [] for cat in categories}
    for q in per_query:
        cat = q.get("category", "unknown")
        if cat in grouped:
            grouped[cat].append(q)
        else:
            grouped.setdefault(cat, []).append(q)

    return {cat: aggregate_metrics(queries) for cat, queries in grouped.items() if queries}
