"""
ConvoMem benchmark adapter.

Source: Salesforce Research, 2025
Access: HuggingFace Salesforce/ConvoMem

75,336 QA pairs, 100 personas, 15 context sizes (1-300 conversations).
Categories: user_evidence, assistant_evidence, changing_evidence,
            abstention, preference, implicit_connection

The "changing_evidence" category tests recency decay and update handling.
The context-size scaling reveals when memory retrieval outperforms full context.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from core.types import Conversation, Session, Turn, Query

from .base import BenchmarkAdapter

logger = logging.getLogger(__name__)


class ConvoMemBenchmark(BenchmarkAdapter):

    name = "ConvoMem"
    categories = [
        "user_evidence", "assistant_evidence", "changing_evidence",
        "abstention", "preference", "implicit_connection",
    ]

    def download(self, cache_dir: Path) -> None:
        target = cache_dir / "convomem" / "data.json"
        if target.exists():
            logger.info("ConvoMem already cached at %s", target)
            return

        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            from datasets import load_dataset
            logger.info("Downloading ConvoMem from HuggingFace (this is ~27 GB, may take a while)...")
            ds = load_dataset("Salesforce/ConvoMem")
            # Save a manageable subset — full dataset is very large
            # Default: use the smallest context size for initial runs
            subset = ds.get("train", ds.get("test"))
            records = [dict(row) for row in subset]
            target.write_text(json.dumps(records, indent=2))
            logger.info("Saved %d instances to %s", len(records), target)
        except Exception as e:
            logger.error("Download failed: %s", e)
            raise

    def load(self, cache_dir: Path) -> tuple[list[Conversation], list[Query]]:
        target = cache_dir / "convomem" / "data.json"
        if not target.exists():
            raise FileNotFoundError(
                f"ConvoMem not found at {target}. Run 'python run.py download convomem' first."
            )

        raw = json.loads(target.read_text())
        conversations: list[Conversation] = []
        queries: list[Query] = []

        for idx, item in enumerate(raw):
            conv_id = str(item.get("id", f"cm-{idx:06d}"))
            persona_id = str(item.get("persona_id", ""))

            # Parse conversations
            raw_convs = item.get("conversations", [])
            sessions = []
            for sess_idx, conv in enumerate(raw_convs):
                turns = []
                messages = conv if isinstance(conv, list) else conv.get("messages", [])
                for msg in messages:
                    speaker = msg.get("speaker", msg.get("role", "user")).lower()
                    text = msg.get("text", msg.get("content", ""))
                    if text:
                        turns.append(Turn(
                            speaker=speaker,
                            text=text,
                            turn_id=f"{conv_id}/s{sess_idx}/t{len(turns)}",
                        ))
                if turns:
                    sessions.append(Session(session_id=f"s-{sess_idx:03d}", turns=turns))

            if sessions:
                conversations.append(Conversation(conversation_id=conv_id, sessions=sessions))

            # Parse QA
            for qi, evidence in enumerate(item.get("evidence_items", [])):
                category = evidence.get("type", evidence.get("category", "unknown"))
                queries.append(Query(
                    query_id=f"{conv_id}/q-{qi:03d}",
                    conversation_id=conv_id,
                    question=evidence.get("question", ""),
                    category=category,
                    ground_truth_answer=evidence.get("answer", ""),
                ))

        conversations.sort(key=lambda c: c.conversation_id)
        queries.sort(key=lambda q: q.query_id)

        logger.info("Loaded ConvoMem: %d conversations, %d queries", len(conversations), len(queries))
        return conversations, queries
