"""
LongMemEval benchmark adapter.

Source: UMass/Microsoft, ICLR 2025
Access: HuggingFace xiaowu0162/longmemeval-cleaned

500 QA pairs testing 5 memory abilities:
  extraction, multi_session, temporal, knowledge_updates, abstention

The "knowledge_updates" category directly tests recency decay and supersede logic.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from core.types import Conversation, Session, Turn, Query

from .base import BenchmarkAdapter

logger = logging.getLogger(__name__)


class LongMemEvalBenchmark(BenchmarkAdapter):

    name = "LongMemEval"
    categories = ["extraction", "multi_session", "temporal", "knowledge_updates", "abstention"]

    def download(self, cache_dir: Path) -> None:
        target = cache_dir / "longmemeval" / "oracle.json"
        if target.exists():
            logger.info("LongMemEval already cached at %s", target)
            return

        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            from datasets import load_dataset
            logger.info("Downloading LongMemEval from HuggingFace...")
            ds = load_dataset("xiaowu0162/longmemeval-cleaned")
            # Use the oracle variant (smallest, pure retrieval testing)
            oracle = ds.get("oracle", ds.get("train"))
            records = [dict(row) for row in oracle]
            target.write_text(json.dumps(records, indent=2))
            logger.info("Saved %d instances to %s", len(records), target)
        except Exception as e:
            logger.error("Download failed: %s", e)
            raise

    def load(self, cache_dir: Path) -> tuple[list[Conversation], list[Query]]:
        target = cache_dir / "longmemeval" / "oracle.json"
        if not target.exists():
            raise FileNotFoundError(
                f"LongMemEval not found at {target}. Run 'python run.py download longmemeval' first."
            )

        raw = json.loads(target.read_text())
        conversations: list[Conversation] = []
        queries: list[Query] = []

        # LongMemEval format: each instance has haystack sessions + a question
        for idx, item in enumerate(raw):
            conv_id = str(item.get("id", f"lme-{idx:04d}"))

            # Parse sessions from haystack
            sessions = []
            for sess_idx, sess in enumerate(item.get("haystack", [])):
                turns = []
                for turn in sess.get("turns", sess if isinstance(sess, list) else []):
                    role = turn.get("role", "user")
                    content = turn.get("content", "")
                    if content:
                        turns.append(Turn(
                            speaker=role,
                            text=content,
                            turn_id=f"{conv_id}/s{sess_idx}/t{len(turns)}",
                        ))
                if turns:
                    sessions.append(Session(session_id=f"s-{sess_idx:03d}", turns=turns))

            if sessions:
                conversations.append(Conversation(conversation_id=conv_id, sessions=sessions))

            # Parse question
            category = item.get("type", item.get("category", "unknown"))
            queries.append(Query(
                query_id=f"{conv_id}/q",
                conversation_id=conv_id,
                question=item.get("question", ""),
                category=category,
                ground_truth_answer=item.get("answer", ""),
            ))

        conversations.sort(key=lambda c: c.conversation_id)
        queries.sort(key=lambda q: q.query_id)

        logger.info("Loaded LongMemEval: %d conversations, %d queries", len(conversations), len(queries))
        return conversations, queries
