"""
LOCOMO benchmark adapter.

Source: Snap Research, ICLR 2025
Access: github.com/snap-research/locomo/data/locomo10.json

10 extended conversations (2 speakers each), ~32-40 sessions per conversation,
~200 QA pairs per conversation. Categories (integer codes 1-5):
    1 = single_hop
    2 = temporal
    3 = multi_hop
    4 = open_domain
    5 = adversarial

This is the benchmark Mem0 used in their paper — running it gives
direct comparability against their published J-scores.

Format:
    [
      {
        "sample_id": "conv-0",
        "conversation": {
          "speaker_a": "Caroline",
          "speaker_b": "Melanie",
          "session_1_date_time": "...",
          "session_1": [{"speaker": "Caroline", "dia_id": "D1:1", "text": "..."}, ...],
          "session_2": [...],
          ...
        },
        "qa": [
          {"question": "...", "answer": "...", "evidence": ["D1:3"], "category": 2},
          ...
        ]
      },
      ...
    ]
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from core.types import Conversation, Session, Turn, Query

from .base import BenchmarkAdapter

logger = logging.getLogger(__name__)

# LOCOMO uses integer category codes — map to our internal names
CATEGORY_MAP: dict[int, str] = {
    1: "single_hop",
    2: "temporal",
    3: "multi_hop",
    4: "open_domain",
    5: "adversarial",
}

LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"


class LocomoBenchmark(BenchmarkAdapter):

    name = "LOCOMO"
    categories = ["single_hop", "multi_hop", "temporal", "open_domain", "adversarial"]

    def download(self, cache_dir: Path) -> None:
        """Download official LOCOMO dataset from the Snap Research GitHub repo."""
        target = cache_dir / "locomo" / "locomo10.json"
        if target.exists():
            logger.info("LOCOMO dataset already cached at %s", target)
            return

        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            import httpx
            logger.info("Downloading LOCOMO from %s ...", LOCOMO_URL)
            r = httpx.get(LOCOMO_URL, timeout=60.0, follow_redirects=True)
            r.raise_for_status()
            data = r.json()
            target.write_text(json.dumps(data, indent=2))
            logger.info("Saved %d conversations to %s", len(data), target)
        except Exception as e:
            logger.error("Download failed: %s", e)
            logger.info(
                "Fallback: manually download from %s and place at %s",
                LOCOMO_URL, target,
            )
            raise

    def load(self, cache_dir: Path) -> tuple[list[Conversation], list[Query]]:
        """Parse LOCOMO JSON into internal types."""
        target = cache_dir / "locomo" / "locomo10.json"
        if not target.exists():
            raise FileNotFoundError(
                f"LOCOMO dataset not found at {target}. Run 'python run.py download locomo' first."
            )

        raw = json.loads(target.read_text())
        if isinstance(raw, dict):
            raw = [raw]

        conversations: list[Conversation] = []
        queries: list[Query] = []

        for conv_idx, conv_data in enumerate(raw):
            conv_id = str(conv_data.get("sample_id", f"conv-{conv_idx:03d}"))

            sessions = self._parse_sessions(conv_data.get("conversation", {}), conv_id)
            conversations.append(Conversation(
                conversation_id=conv_id,
                sessions=sessions,
            ))

            qa_list = conv_data.get("qa", [])
            for qa_idx, qa in enumerate(qa_list):
                category_raw = qa.get("category", 0)
                category = CATEGORY_MAP.get(category_raw, f"category_{category_raw}")

                evidence_ids = [str(e) for e in qa.get("evidence", [])]
                answer = qa.get("answer", "")
                # Some LOCOMO answers are non-string (int, list, etc.)
                if not isinstance(answer, str):
                    answer = str(answer)

                queries.append(Query(
                    query_id=f"{conv_id}/q-{qa_idx:04d}",
                    conversation_id=conv_id,
                    question=str(qa.get("question", "")),
                    category=category,
                    ground_truth_answer=answer,
                    evidence_turn_ids=evidence_ids,
                ))

        conversations.sort(key=lambda c: c.conversation_id)
        queries.sort(key=lambda q: q.query_id)

        cat_counts = {
            cat: sum(1 for q in queries if q.category == cat)
            for cat in self.categories
        }
        logger.info(
            "Loaded LOCOMO: %d conversations, %d queries (%s)",
            len(conversations),
            len(queries),
            ", ".join(f"{c}: {n}" for c, n in cat_counts.items()),
        )

        return conversations, queries

    def _parse_sessions(self, conv: dict, conv_id: str) -> list[Session]:
        """
        Parse LOCOMO conversation block into Session/Turn objects.

        LOCOMO stores sessions as separate keys: session_1, session_2, ...
        Each session is a list of {speaker, dia_id, text} dicts.
        The speaker names are mapped via conv["speaker_a"] and conv["speaker_b"].
        """
        speaker_a = conv.get("speaker_a", "")
        speaker_b = conv.get("speaker_b", "")

        # Find all session keys, sorted numerically
        session_keys = sorted(
            (k for k in conv.keys() if re.fullmatch(r"session_\d+", k)),
            key=lambda k: int(k.split("_")[1]),
        )

        sessions = []
        for session_key in session_keys:
            session_turns_raw = conv.get(session_key, [])
            if not isinstance(session_turns_raw, list):
                continue

            session_num = session_key.split("_")[1]
            timestamp = conv.get(f"session_{session_num}_date_time")

            turns = []
            for turn_data in session_turns_raw:
                if not isinstance(turn_data, dict):
                    continue
                speaker_name = turn_data.get("speaker", "")

                # Map speaker_a → "user", speaker_b → "assistant" (convention)
                # LOCOMO conversations are human-human, but our system uses
                # user/assistant roles. Treating speaker_a as user is arbitrary
                # but consistent — the benchmark doesn't distinguish roles for QA.
                if speaker_name == speaker_a:
                    role = "user"
                elif speaker_name == speaker_b:
                    role = "assistant"
                else:
                    role = "user"

                text = turn_data.get("text", "")
                if not text:
                    continue

                turns.append(Turn(
                    speaker=role,
                    text=f"{speaker_name}: {text}",  # preserve speaker name in text
                    turn_id=str(turn_data.get("dia_id", "")),
                    timestamp=timestamp,
                ))

            if turns:
                sessions.append(Session(
                    session_id=f"s-{int(session_num):03d}",
                    turns=turns,
                ))

        if not sessions:
            logger.warning("No sessions parsed for conversation %s", conv_id)

        return sessions
