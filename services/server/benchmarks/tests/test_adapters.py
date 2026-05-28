"""
Adapter smoke tests against committed golden fixtures.

These tests parse small hand-picked samples of each benchmark's real
dataset (saved in tests/fixtures/) and assert the adapter produces
the expected internal types. If a HuggingFace release changes the
dataset schema, these tests still pass on the fixtures — but a fresh
download will fail, which is the signal we want.

Purpose:
  1. Regression protection on adapter refactors (e.g., the evidence
     typing change) — confirms nothing silently broke existing parses.
  2. Example-based documentation of the expected shape.

Intentionally NOT:
  - Full HuggingFace download (slow, flaky network).
  - End-to-end ingestion (needs server + LLM API).
"""

from pathlib import Path

import pytest

from benchmarks.locomo import LocomoBenchmark
from benchmarks.longmemeval import LongMemEvalBenchmark
from core.types import Evidence

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ============================================================
# LOCOMO
# ============================================================

class TestLocomoAdapter:
    """LOCOMO adapter tests against the committed fixture."""

    @pytest.fixture
    def adapter_and_data(self):
        adapter = LocomoBenchmark()
        convs, queries = adapter.load(FIXTURES_DIR)
        return adapter, convs, queries

    def test_loads_single_conversation(self, adapter_and_data):
        _, convs, _ = adapter_and_data
        assert len(convs) == 1, "fixture was built with exactly 1 conversation"

    def test_parses_both_sessions(self, adapter_and_data):
        _, convs, _ = adapter_and_data
        conv = convs[0]
        # Fixture kept session_1 and session_2 with 3 turns each
        assert len(conv.sessions) == 2
        assert all(len(s.turns) == 3 for s in conv.sessions)

    def test_turn_speakers_mapped(self, adapter_and_data):
        _, convs, _ = adapter_and_data
        # All turns should have one of the two roles our framework knows
        for session in convs[0].sessions:
            for turn in session.turns:
                assert turn.speaker in ("user", "assistant"), (
                    f"unexpected speaker: {turn.speaker!r}"
                )

    def test_timestamps_preserved_on_turns(self, adapter_and_data):
        _, convs, _ = adapter_and_data
        # LOCOMO timestamps come from session_N_date_time fields and should
        # be propagated down to each turn for the new recency code paths.
        for session in convs[0].sessions:
            for turn in session.turns:
                assert turn.timestamp, "LOCOMO turns should carry timestamps"

    def test_evidence_is_turn_kind(self, adapter_and_data):
        _, _, queries = adapter_and_data
        # LOCOMO evidence is dialog IDs like "D1:3" — MUST be tagged "turn"
        # so the metric pipeline knows they're unresolvable to memory IDs.
        for q in queries:
            for ev in q.evidence:
                assert isinstance(ev, Evidence)
                assert ev.kind == "turn", (
                    f"LOCOMO evidence should be kind='turn', got {ev.kind!r}"
                )

    def test_category_mapping(self, adapter_and_data):
        _, _, queries = adapter_and_data
        # Fixture has 3 QA pairs across categories 1, 2, 3 → single_hop,
        # temporal, multi_hop.
        cats = sorted({q.category for q in queries})
        assert cats == ["multi_hop", "single_hop", "temporal"]

    def test_build_ingest_text_yields_one_chunk_per_turn(self, adapter_and_data):
        adapter, convs, _ = adapter_and_data
        chunks = adapter.build_ingest_text(convs[0])
        # Per-turn chunking: 2 sessions × 3 turns each (fixture) = 6 chunks
        total_turns = sum(len(s.turns) for s in convs[0].sessions)
        assert len(chunks) == total_turns
        # WALM-55: chunks are 3-tuples (label, text, occurred_at).
        for label, text, occurred_at in chunks:
            assert "/" in label, "label format is conv_id/session_id"
            # LOCOMO text already has the speaker name baked in
            # ("Caroline: " / "Melanie: ") — the helper detects this
            # and skips double-prefixing.
            assert ": " in text[:30], "turn text should begin with a speaker name"
            # occurred_at is either None or an RFC 3339 UTC string. The
            # fixture's LOCOMO date "1:56 pm on 8 May, 2023" parses to
            # "2023-05-08T13:56:00+00:00". We don't assert the exact
            # value (that's a separate normaliser test) but the shape.
            if occurred_at is not None:
                assert "T" in occurred_at and ("+" in occurred_at or "Z" in occurred_at), \
                    f"occurred_at must be RFC 3339, got {occurred_at!r}"

    def test_multiple_chunks_share_session_label(self, adapter_and_data):
        """
        All turns from one session must produce chunks with the same label.
        This is what lets the session→memory map aggregate memories back
        to the correct session during Recall@K resolution.
        """
        adapter, convs, _ = adapter_and_data
        chunks = adapter.build_ingest_text(convs[0])
        from collections import defaultdict
        by_label = defaultdict(int)
        # WALM-55: unpack the 3-tuple, ignore text + occurred_at.
        for label, _text, _occurred_at in chunks:
            by_label[label] += 1
        # Every session should have produced at least one chunk
        assert len(by_label) == len(convs[0].sessions)
        # And each session's chunk count should equal its turn count
        for session in convs[0].sessions:
            expected_label = f"{convs[0].conversation_id}/{session.session_id}"
            assert by_label[expected_label] == len(session.turns)


# ============================================================
# LongMemEval
# ============================================================

class TestLongMemEvalAdapter:
    """LongMemEval adapter tests against the committed fixture."""

    @pytest.fixture
    def adapter_and_data(self):
        adapter = LongMemEvalBenchmark()
        convs, queries = adapter.load(FIXTURES_DIR)
        return adapter, convs, queries

    def test_instance_count(self, adapter_and_data):
        _, convs, queries = adapter_and_data
        # Fixture has 6 instances (one per question type)
        assert len(convs) == 6
        assert len(queries) == 6

    def test_all_six_categories_present(self, adapter_and_data):
        _, _, queries = adapter_and_data
        # Framework category names (after mapping from LongMemEval's raw types)
        expected = {
            "single_session_user",
            "single_session_assistant",
            "preference",
            "multi_session",
            "temporal",
            "knowledge_update",
        }
        assert {q.category for q in queries} == expected

    def test_evidence_is_session_kind(self, adapter_and_data):
        _, _, queries = adapter_and_data
        # LongMemEval evidence are session IDs (from answer_session_ids) —
        # MUST be kind='session' so the Recall@K pipeline can resolve them.
        for q in queries:
            assert q.evidence, "every LongMemEval query has evidence"
            for ev in q.evidence:
                assert isinstance(ev, Evidence)
                assert ev.kind == "session"

    def test_non_string_answers_coerced(self, adapter_and_data):
        _, _, queries = adapter_and_data
        # Some LongMemEval answers are ints (~32 of 500 in full dataset).
        # Adapter should coerce to str for consistent downstream handling.
        for q in queries:
            assert isinstance(q.ground_truth_answer, str)

    def test_session_ids_match_evidence(self, adapter_and_data):
        _, convs, queries = adapter_and_data
        # For each query, every evidence session_id must appear in the
        # conversation's parsed sessions. This is the invariant that makes
        # Recall@K possible later.
        conv_sessions = {c.conversation_id: {s.session_id for s in c.sessions} for c in convs}
        for q in queries:
            available = conv_sessions.get(q.conversation_id, set())
            for ev in q.evidence:
                assert ev.value in available, (
                    f"evidence session_id {ev.value!r} not found in "
                    f"conversation {q.conversation_id!r}'s parsed sessions"
                )

    def test_build_ingest_text_yields_one_chunk_per_turn(self, adapter_and_data):
        adapter, convs, _ = adapter_and_data
        chunks = adapter.build_ingest_text(convs[0])
        total_turns = sum(len(s.turns) for s in convs[0].sessions)
        assert len(chunks) == total_turns
        # WALM-55: chunks are 3-tuples (label, text, occurred_at).
        for label, text, occurred_at in chunks:
            assert text.strip(), "ingest text should be non-empty"
            # LongMemEval turns are raw content (no embedded speaker name)
            # so the helper prefixes them with "User: " / "Assistant: ".
            assert text.startswith(("User:", "Assistant:")), (
                f"LongMemEval turn should have role prefix; got {text[:40]!r}"
            )
            # occurred_at is either None or an RFC 3339 UTC string. LME
            # haystack_dates "2023/04/10 (Mon) 17:50" parses to
            # "2023-04-10T17:50:00+00:00".
            if occurred_at is not None:
                assert "T" in occurred_at and ("+" in occurred_at or "Z" in occurred_at), \
                    f"occurred_at must be RFC 3339, got {occurred_at!r}"


# ── WALM-55: per-benchmark timestamp normalisation ────────────────────

class TestLocomoTimestampNormalisation:
    """Pin the LOCOMO date-string → RFC 3339 conversion shape.

    The server expects RFC 3339 UTC strings on AnalyzeRequest.occurred_at.
    If a future LOCOMO release changes its date format, these tests fail
    loudly rather than silently shipping unparsed strings to the server.
    """

    def test_canonical_format_parses_to_rfc3339_utc(self):
        from benchmarks.locomo import _normalize_locomo_timestamp

        # The canonical LOCOMO format, sampled from the cached fixture.
        out = _normalize_locomo_timestamp("1:56 pm on 8 May, 2023")
        assert out == "2023-05-08T13:56:00+00:00", (
            f"LOCOMO normaliser produced {out!r} for the canonical format; "
            "if this fails, the format string in _LOCOMO_DATE_FMT drifted"
        )

    def test_unparseable_input_returns_none(self):
        # Graceful degradation: the harness shouldn't crash on a malformed
        # date — the turn just goes through without a temporal anchor.
        from benchmarks.locomo import _normalize_locomo_timestamp

        assert _normalize_locomo_timestamp("not a date") is None
        assert _normalize_locomo_timestamp("") is None

    def test_none_input_returns_none(self):
        from benchmarks.locomo import _normalize_locomo_timestamp

        assert _normalize_locomo_timestamp(None) is None


class TestLongMemEvalTimestampNormalisation:
    """The LME adapter does inline normalisation rather than via a helper.
    This test goes through the adapter's full parse path to confirm the
    RFC 3339 conversion fires correctly on the cached fixture's data.
    """

    def test_fixture_session_dates_become_rfc3339_on_turns(self, tmp_path):
        from benchmarks.longmemeval import LongMemEvalBenchmark

        fixture_dir = Path(__file__).parent / "fixtures"
        adapter = LongMemEvalBenchmark()
        convs, _ = adapter.load(fixture_dir)
        # Every turn that has a timestamp should now have it in RFC 3339
        # UTC form (T separator, +00:00 suffix).
        seen_any = False
        for conv in convs:
            for session in conv.sessions:
                for turn in session.turns:
                    if turn.timestamp is not None:
                        seen_any = True
                        assert "T" in turn.timestamp
                        assert turn.timestamp.endswith("+00:00"), (
                            f"LME turn timestamp must be UTC-normalised; "
                            f"got {turn.timestamp!r}"
                        )
        # The fixture must include at least one timestamped session
        # (otherwise we're not actually testing the conversion path).
        assert seen_any, "fixture should contain at least one timestamped session"
