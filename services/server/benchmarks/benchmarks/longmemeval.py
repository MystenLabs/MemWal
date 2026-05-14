"""
LongMemEval benchmark adapter.

Source: UMass/Microsoft, ICLR 2025
Access: HuggingFace xiaowu0162/longmemeval-cleaned
Paper:  https://arxiv.org/abs/2410.10813

500 QA pairs testing 6 memory abilities:
  - single-session-user        (fact from one user turn)
  - single-session-assistant   (fact from one assistant turn)
  - single-session-preference  (user preference from one session)
  - multi-session              (compose across sessions)
  - temporal-reasoning         (date arithmetic, event ordering)
  - knowledge-update           (user contradicts earlier info — recency test)

Each instance has:
  - question, answer, question_type, question_date
  - haystack_sessions: list[list[turn]] — sessions of turns
  - haystack_session_ids: list[str] — 1:1 with haystack_sessions
  - haystack_dates: list[str] — timestamps matching sessions
  - answer_session_ids: list[str] — which sessions contain the answer (ground truth)

Turn format: {role: "user"|"assistant", content: str, has_answer: bool}

Dataset variants available:
  - longmemeval_oracle.json  (smallest, evidence-only, used here)
  - longmemeval_s_cleaned.json  (~115K tokens per instance)
  - longmemeval_m_cleaned.json  (up to 1.5M tokens per instance)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from core.types import Conversation, Session, Turn, Query, Evidence

from .base import BenchmarkAdapter

logger = logging.getLogger(__name__)

# LongMemEval dates are formatted like "2023/04/10 (Mon) 17:50".
_DATE_FMT = "%Y/%m/%d (%a) %H:%M"


def _parse_haystack_date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, _DATE_FMT)
    except ValueError:
        return None

# Map LongMemEval question types to our internal category names
CATEGORY_MAP: dict[str, str] = {
    "single-session-user": "single_session_user",
    "single-session-assistant": "single_session_assistant",
    "single-session-preference": "preference",
    "multi-session": "multi_session",
    "temporal-reasoning": "temporal",
    "knowledge-update": "knowledge_update",
}


class LongMemEvalBenchmark(BenchmarkAdapter):

    name = "LongMemEval"
    categories = [
        "single_session_user",
        "single_session_assistant",
        "preference",
        "multi_session",
        "temporal",
        "knowledge_update",
    ]

    def build_ingest_text(self, conversation):
        # EXPLICIT CHOICE: per-turn chunking.
        # Switched from naive session-concat (2026-04-20 run, 65.90 overall)
        # to per-turn for consistency with LOCOMO and to match how the
        # MemWal SDK drives /api/analyze in production — one call per user
        # message. LongMemEval's small haystacks (~22 turns) were already
        # handled well by session-concat (19% "no info"), so we don't
        # expect a large delta here; the change is about methodology
        # alignment across benchmarks. LongMemEval turns are raw text
        # without speaker prefix, so the helper adds "User:"/"Assistant:".
        return self.build_ingest_text_per_turn(conversation)

    def download(self, cache_dir: Path) -> None:
        """Download LongMemEval oracle variant via the HuggingFace Hub."""
        target = cache_dir / "longmemeval" / "longmemeval_oracle.json"
        if target.exists():
            logger.info("LongMemEval already cached at %s", target)
            return

        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            from huggingface_hub import hf_hub_download
            logger.info("Downloading LongMemEval oracle from HuggingFace...")
            downloaded = hf_hub_download(
                repo_id="xiaowu0162/longmemeval-cleaned",
                filename="longmemeval_oracle.json",
                repo_type="dataset",
                local_dir=str(target.parent),
            )
            logger.info("Downloaded LongMemEval to %s", downloaded)
        except Exception as e:
            logger.error("LongMemEval download failed: %s", e)
            raise

    def load(self, cache_dir: Path) -> tuple[list[Conversation], list[Query]]:
        """Parse LongMemEval JSON into internal types."""
        target = cache_dir / "longmemeval" / "longmemeval_oracle.json"
        if not target.exists():
            raise FileNotFoundError(
                f"LongMemEval not found at {target}. Run 'python run.py download longmemeval' first."
            )

        raw = json.loads(target.read_text())
        if not isinstance(raw, list):
            raise ValueError(f"Expected list of instances, got {type(raw).__name__}")

        conversations: list[Conversation] = []
        queries: list[Query] = []

        for idx, item in enumerate(raw):
            conv_id = str(item.get("question_id", f"lme-{idx:04d}"))

            sessions_raw = item.get("haystack_sessions", [])
            session_ids = item.get("haystack_session_ids", [])
            session_dates = item.get("haystack_dates", [])

            # Sort sessions chronologically by haystack_dates before ingestion.
            # ~7% of oracle instances ship sessions out of date order (annotator
            # artefact, never >1 day off). Real users don't hand a memory system
            # turns out of sequence — sorting here keeps ingest-order realistic
            # and matches what Mem0's own runner does. Sessions whose date
            # fails to parse fall back to their original position, sorted last.
            sess_indices = list(range(len(sessions_raw)))
            sess_indices.sort(
                key=lambda i: (
                    _parse_haystack_date(session_dates[i]) if i < len(session_dates) else None
                ) or datetime.max
            )

            # Build sessions — each haystack_sessions entry is a list of turns.
            sessions: list[Session] = []
            for sess_idx in sess_indices:
                turns_raw = sessions_raw[sess_idx]
                # Prefer the real session_id from the dataset when available; fall back
                # to a positional id. Real ids let us match answer_session_ids later.
                session_id = (
                    session_ids[sess_idx]
                    if sess_idx < len(session_ids)
                    else f"{conv_id}-s{sess_idx:03d}"
                )
                session_date = (
                    session_dates[sess_idx]
                    if sess_idx < len(session_dates)
                    else None
                )

                turns: list[Turn] = []
                for turn_idx, turn_raw in enumerate(turns_raw):
                    if not isinstance(turn_raw, dict):
                        continue
                    role = turn_raw.get("role", "user")
                    content = turn_raw.get("content", "")
                    if not content:
                        continue
                    turns.append(Turn(
                        speaker=role,
                        text=content,
                        turn_id=f"{session_id}/t{turn_idx:03d}",
                        timestamp=session_date,
                    ))

                if turns:
                    sessions.append(Session(
                        session_id=session_id,
                        turns=turns,
                    ))

            if sessions:
                conversations.append(Conversation(
                    conversation_id=conv_id,
                    sessions=sessions,
                ))

            # Build the query. Evidence session IDs are in answer_session_ids.
            category_raw = item.get("question_type", "unknown")
            category = CATEGORY_MAP.get(category_raw, category_raw)

            # Some answers are integers (32 out of 500). Normalize to string.
            answer = item.get("answer", "")
            if not isinstance(answer, str):
                answer = str(answer)

            # LongMemEval evidence is session_ids — these match the session_id
            # values we use as ingestion namespaces, so Recall@K can be
            # computed by checking whether retrieved memories came from these
            # sessions (requires tracking the session → memory mapping during
            # ingestion, see run.py stage_ingest).
            evidence = [
                Evidence(kind="session", value=str(sid))
                for sid in item.get("answer_session_ids", [])
            ]

            queries.append(Query(
                query_id=conv_id,
                conversation_id=conv_id,
                question=str(item.get("question", "")),
                category=category,
                ground_truth_answer=answer,
                evidence=evidence,
            ))

        conversations.sort(key=lambda c: c.conversation_id)
        queries.sort(key=lambda q: q.query_id)

        cat_counts = {
            cat: sum(1 for q in queries if q.category == cat)
            for cat in self.categories
        }
        logger.info(
            "Loaded LongMemEval: %d conversations, %d queries (%s)",
            len(conversations),
            len(queries),
            ", ".join(f"{c}: {n}" for c, n in cat_counts.items()),
        )

        return conversations, queries
