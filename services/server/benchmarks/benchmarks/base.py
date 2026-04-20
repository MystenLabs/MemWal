"""
Abstract base class for benchmark adapters.

Each benchmark (LOCOMO, LongMemEval, ConvoMem) implements this interface.
The adapter is responsible ONLY for:
  1. Downloading the dataset
  2. Parsing it into internal types (Conversation, Query)
  3. Providing the answer-generation prompt template

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

    def build_ingest_text(self, conversation: Conversation) -> list[tuple[str, str]]:
        """
        Convert a conversation into (session_label, text) pairs for /api/analyze.

        Default: concatenate all turns in each session into one text block.
        Override if the benchmark needs different ingestion formatting.

        Returns:
            List of (label, text) pairs. Each text is fed as one /api/analyze call.
        """
        result = []
        for session in conversation.sessions:
            lines = []
            for turn in session.turns:
                prefix = "User" if turn.speaker == "user" else "Assistant"
                lines.append(f"{prefix}: {turn.text}")
            text = "\n".join(lines)
            label = f"{conversation.conversation_id}/{session.session_id}"
            result.append((label, text))
        return result
