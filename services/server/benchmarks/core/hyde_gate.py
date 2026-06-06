"""
HyDE execution gate.

When the server runs with HyDE enabled, recall makes one extra LLM call per
query to generate a hypothetical answer before embedding. That call is
*infallible from the caller's side*: any failure (429, 5xx, timeout, transport
error) silently falls back to embedding the raw query. Graceful degradation is
correct for production, but it is a hazard for a benchmark — a busy OpenRouter
that 429s on, say, 30% of queries would quietly turn an HyDE arm back into a
near-baseline arm, and a real lift would read as noise.

This module scrapes the server's `/metrics` endpoint (Prometheus text format)
and counts the per-status outcomes of the `operation="hyde"` external-request
histogram before and after an eval. The delta tells us how many HyDE calls
actually ran and how many were healthy (status="200"). The harness stamps the
delta into the run artifact and prints a loud warning if the success share is
below threshold, so a confounded arm is caught at run time rather than puzzled
over after the fact.

When HyDE is OFF, no `operation="hyde"` series exist, the delta is all-zero,
and the gate is a transparent no-op.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger("benchmarks.hyde_gate")

# memwal_external_request_duration_seconds_count{service="openrouter",operation="hyde",status="200"} 1234
_COUNT_LINE = re.compile(
    r'^memwal_external_request_duration_seconds_count\{([^}]*)\}\s+([0-9.eE+-]+)\s*$'
)

# Below this share of status="200" among hyde calls, the arm is considered
# confounded (too many silent fallbacks to attribute a clean result).
SUCCESS_SHARE_THRESHOLD = 0.98


def _parse_labels(label_blob: str) -> dict[str, str]:
    """Parse a Prometheus label set `a="x",b="y"` into a dict."""
    out: dict[str, str] = {}
    for m in re.finditer(r'(\w+)="((?:[^"\\]|\\.)*)"', label_blob):
        out[m.group(1)] = m.group(2)
    return out


def scrape_hyde_counts(metrics_text: str) -> dict[str, int]:
    """
    Extract per-status hyde call counts from a /metrics text body.

    Returns a map {status: count} over the `operation="hyde"` histogram's
    `_count` series. Empty when HyDE is off (no such series exist).
    """
    counts: dict[str, int] = {}
    for line in metrics_text.splitlines():
        m = _COUNT_LINE.match(line.strip())
        if not m:
            continue
        labels = _parse_labels(m.group(1))
        if labels.get("operation") != "hyde":
            continue
        status = labels.get("status", "?")
        # histogram _count is an integer-valued float in the exposition
        counts[status] = counts.get(status, 0) + int(float(m.group(2)))
    return counts


@dataclass
class HydeGateResult:
    """Outcome of comparing hyde counts before/after an eval."""

    enabled: bool                      # were any hyde calls observed at all?
    total_calls: int                   # hyde calls during this eval (delta)
    by_status: dict[str, int] = field(default_factory=dict)  # status -> delta
    success_share: float = 1.0         # status="200" share of total_calls
    passed: bool = True                # success_share >= threshold (or N/A)
    threshold: float = SUCCESS_SHARE_THRESHOLD

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "total_calls": self.total_calls,
            "by_status": dict(self.by_status),
            "success_share": round(self.success_share, 4),
            "passed": self.passed,
            "threshold": self.threshold,
        }


def evaluate_gate(before: dict[str, int], after: dict[str, int]) -> HydeGateResult:
    """
    Compute the per-status delta between two scrapes and decide pass/fail.

    `passed` is True when HyDE didn't run at all (off — nothing to gate) or when
    the healthy share meets the threshold. It is False only when HyDE ran AND a
    meaningful fraction of calls fell back silently.
    """
    statuses = set(before) | set(after)
    delta = {s: max(0, after.get(s, 0) - before.get(s, 0)) for s in statuses}
    delta = {s: n for s, n in delta.items() if n > 0}
    total = sum(delta.values())

    if total == 0:
        # HyDE off (or no recalls happened) — nothing to gate.
        return HydeGateResult(enabled=False, total_calls=0, by_status={}, success_share=1.0, passed=True)

    ok = delta.get("200", 0)
    share = ok / total
    return HydeGateResult(
        enabled=True,
        total_calls=total,
        by_status=delta,
        success_share=share,
        passed=share >= SUCCESS_SHARE_THRESHOLD,
    )
