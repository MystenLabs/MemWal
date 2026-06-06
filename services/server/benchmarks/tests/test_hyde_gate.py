"""
Verify the HyDE execution gate parses /metrics correctly and decides
pass/fail on the healthy-call share.

The gate guards benchmark validity: an HyDE arm where many recalls silently
fell back to the raw query (429/5xx/timeout) is confounded and must be flagged,
not silently averaged into a null result.
"""

from core.hyde_gate import (
    scrape_hyde_counts,
    evaluate_gate,
    SUCCESS_SHARE_THRESHOLD,
)

_METRIC = "memwal_external_request_duration_seconds_count"


def _line(operation: str, status: str, n: int, service: str = "openrouter") -> str:
    return f'{_METRIC}{{service="{service}",operation="{operation}",status="{status}"}} {n}'


class TestScrape:
    def test_picks_only_hyde_operation(self):
        text = "\n".join([
            _line("hyde", "200", 100),
            _line("hyde", "429", 5),
            _line("embed", "200", 9999),   # different operation — ignored
            _line("extract", "500", 3),     # ignored
            "# HELP something else",
            "memwal_db_pool_connections{state=\"idle\"} 4",
        ])
        counts = scrape_hyde_counts(text)
        assert counts == {"200": 100, "429": 5}

    def test_empty_when_hyde_absent(self):
        # HyDE off: no operation="hyde" series exist at all.
        text = "\n".join([_line("embed", "200", 500), _line("extract", "200", 120)])
        assert scrape_hyde_counts(text) == {}

    def test_float_count_coerced_to_int(self):
        # Prometheus exposition writes histogram _count as a float-looking value.
        text = _line("hyde", "200", 0).replace(" 0", " 42.0")
        assert scrape_hyde_counts(text) == {"200": 42}


class TestEvaluate:
    def test_off_is_a_noop_pass(self):
        r = evaluate_gate({}, {})
        assert not r.enabled
        assert r.total_calls == 0
        assert r.passed  # nothing to gate

    def test_all_healthy_passes(self):
        before = {"200": 10}
        after = {"200": 1010}
        r = evaluate_gate(before, after)
        assert r.enabled
        assert r.total_calls == 1000
        assert r.success_share == 1.0
        assert r.passed

    def test_high_fallback_rate_fails(self):
        # 700 healthy / 300 rate-limited over the eval → 70% < threshold.
        before = {"200": 0, "429": 0}
        after = {"200": 700, "429": 300}
        r = evaluate_gate(before, after)
        assert r.enabled
        assert r.total_calls == 1000
        assert abs(r.success_share - 0.7) < 1e-9
        assert not r.passed
        assert r.by_status == {"200": 700, "429": 300}

    def test_threshold_boundary_passes(self):
        # Exactly at threshold should pass (>=).
        total = 1000
        ok = int(round(SUCCESS_SHARE_THRESHOLD * total))
        bad = total - ok
        r = evaluate_gate({}, {"200": ok, "transport_error": bad})
        assert r.success_share >= SUCCESS_SHARE_THRESHOLD
        assert r.passed

    def test_delta_only_counts_this_eval(self):
        # Pre-existing hyde calls (e.g. from a smoke test) must not count.
        before = {"200": 5000}
        after = {"200": 5050}
        r = evaluate_gate(before, after)
        assert r.total_calls == 50
        assert r.passed
