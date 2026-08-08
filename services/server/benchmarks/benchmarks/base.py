"""
Abstract base class for benchmark adapters.

Each benchmark (LOCOMO, LongMemEval) implements this interface.
The adapter is responsible ONLY for:
  1. Downloading the dataset
  2. Parsing it into internal types (Conversation, Query)
  3. Choosing how to shape conversation text for /api/analyze

Everything else (ingestion, recall, evaluation, reporting) is handled
by the shared framework and never duplicated per benchmark.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from core.types import Conversation, Query


class BenchmarkAdapter(ABC):
    """Base class for benchmark dataset adapters."""

    # Human-readable name (e.g., "LOCOMO", "LongMemEval")
    name: str = ""

    # Query categories this benchmark defines
    categories: list[str] = []

    @abstractmethod
    def download(self, cache_dir: Path) -> None:
        """
        Download dataset to local cache. Must be idempotent —
        skip download if files already exist.
        """

    @abstractmethod
    def load(self, cache_dir: Path) -> tuple[list[Conversation], list[Query]]:
        """
        Parse cached dataset into internal types.

        Returns:
            (conversations, queries) — both in stable sorted order
            for reproducible ingestion and evaluation.
        """

    @abstractmethod
    def build_ingest_text(
        self, conversation: Conversation
    ) -> list[tuple[str, str, str | None]]:
        """
        Convert a conversation into (session_label, text, occurred_at)
        triples for /api/analyze.

        Each returned triple is fed as ONE /api/analyze call. The choice of
        chunking strategy is benchmark-specific and directly affects
        extraction quality:

          - Session-level chunking (see build_ingest_text_naive_concat) groups
            all turns of a session into one blob. Simple, but overwhelms the
            extractor on long sessions — this is the pattern that caused
            LOCOMO's 53% "no info" rate.

          - Sliding-window or message-pair chunking captures more facts from
            dense conversations.

        The adapter MUST choose explicitly. A helper for the naive default
        is provided below — adapters that use it should do so by delegation,
        so the choice is visible in the adapter's source.

        `occurred_at` is an RFC 3339 UTC string when the source
        dataset provides a per-turn (or per-session) timestamp, or None
        otherwise. The server uses it as the temporal anchor inside the
        extractor prompt — see `core.client.MemWalClient.analyze`.

        Returns:
            List of (label, text, occurred_at) triples.
        """

    @staticmethod
    def build_ingest_text_naive_concat(
        conversation: Conversation,
    ) -> list[tuple[str, str, str | None]]:
        """
        Helper: concatenate all turns in each session into one text blob.

        Suitable for benchmarks with short sessions (e.g., LongMemEval
        mini-haystacks). AVOID for long sessions — the extractor drops
        facts under large input contexts.

        this helper collapses many turns into one ingest call.
        That collapses temporal granularity — picking any single turn's
        timestamp to represent the whole session would be arbitrary. So
        this helper always returns `occurred_at=None`. Adapters that
        want per-turn timestamps should use `build_ingest_text_per_turn`.

        Returns:
            List of (label, text, occurred_at) triples, one per session.
        """
        result: list[tuple[str, str, str | None]] = []
        for session in conversation.sessions:
            lines: list[str] = []
            for turn in session.turns:
                prefix = "User" if turn.speaker == "user" else "Assistant"
                lines.append(f"{prefix}: {turn.text}")
            text = "\n".join(lines)
            label = f"{conversation.conversation_id}/{session.session_id}"
            # See docstring — naive_concat deliberately drops per-turn
            # timestamps because it collapses many turns into one blob.
            result.append((label, text, None))
        return result

    @staticmethod
    def build_ingest_text_per_turn(
        conversation: Conversation,
    ) -> list[tuple[str, str, str | None]]:
        """
        Helper: emit one ingest chunk per turn.

        This matches how the Walrus Memory SDK wrapper (withMemWal) actually
        drives /api/analyze in production — one call per user message —
        and the published LOCOMO evaluation style (turn-by-turn replay
        through a sliding-window context manager).

        Each turn becomes its own /api/analyze call. The text includes
        the speaker name so the extractor can attribute facts correctly
        (LOCOMO is human-human, LongMemEval is user-assistant; in both
        cases distinguishing the speaker matters).

        Speaker name handling: some adapters store turn.text already
        prefixed with the human-readable name (LOCOMO: "Caroline: ...").
        Others store raw text (LongMemEval: "I'm trying to..."). We
        detect the case with a simple prefix heuristic and avoid
        double-prefixing.

        Trade-off: no inter-turn context. "I went there on Monday" is
        fed to the extractor without the "there" referent. That matches
        what our SDK does in production — if context is load-bearing,
        that's a real product signal, not a benchmark artifact.

        Label shape: "{conversation_id}/{session_id}" — intentionally
        matches naive_concat so the session→memory map in run.py
        aggregates multiple turn-level chunks under the same session key.

        `occurred_at` is sourced from `turn.timestamp` (which
        the per-benchmark adapter normalises to RFC 3339 UTC, or sets to
        None when the source dataset has no timestamp / it failed to
        parse). The server uses it as the temporal anchor for resolving
        relative-time references inside the extracted fact text — see
        `core.client.MemWalClient.analyze` and the v6 extraction prompt.

        Returns:
            List of (label, text, occurred_at) triples, one per turn.
        """
        result: list[tuple[str, str, str | None]] = []
        for session in conversation.sessions:
            label = f"{conversation.conversation_id}/{session.session_id}"
            for turn in session.turns:
                # If adapter already baked the speaker name into the text
                # (e.g., LOCOMO stores "Caroline: Hey Mel!"), don't
                # double-prefix. Heuristic: first 40 chars contain ": "
                # and what comes before looks like a short name token.
                raw = turn.text
                prefix_matched = False
                if ": " in raw[:40]:
                    before, _, _ = raw.partition(": ")
                    # Rough "name-like" check: short token, no sentence
                    # punctuation, Title-cased or all-lowercase single word.
                    if len(before) <= 30 and not any(c in before for c in ".!?\n"):
                        prefix_matched = True

                if prefix_matched:
                    text = raw
                else:
                    # Fall back to role-based label. Capitalize for the prompt.
                    role = (turn.speaker or "User").strip()
                    role = role[:1].upper() + role[1:]
                    text = f"{role}: {raw}"

                result.append((label, text, turn.timestamp))
        return result
