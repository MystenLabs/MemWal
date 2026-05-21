"""
Ranker smoke test — ingest synthetic memories with controlled ages
(by manually backdating `created_at` via direct DB UPDATE after ingest),
then run `/api/recall` with and without `scoring_weights` to prove the
two orderings differ.

Why this script:
- The benchmark harness's per-turn ingest doesn't surface `created_at`,
  so we'd need a real conversation across days to get age variance.
- Instead we ingest 5 short factual statements about a fictional user
  (so their semantic similarity differs but is close), then SQL UPDATE
  three of them backwards in time by 60, 180, and 365 days.
- A query like "tell me about Bob" should pull all 5; the ranker's
  recency signal should re-order the recent ones above the year-old ones
  once we pass `recency_heavy` weights.

NOT part of the harness — one-shot manual verification of the new
ranker. Safe to delete after the LOCOMO + LongMemEval runs prove the
plumbing on a real dataset.
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

# Make `core.*` importable when run from benchmarks/.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg
import yaml

from core.client import MemWalClient
from core.types import ScoringWeights


def load_cfg() -> dict:
    with open(Path(__file__).resolve().parent / "config.yaml") as f:
        return yaml.safe_load(f)


def db_url() -> str:
    """Match the server's .env DATABASE_URL — local docker compose."""
    return os.environ.get(
        "DATABASE_URL", "postgresql://memwal:memwal_secret@localhost:5432/memwal"
    )


def backdate_row(conn, blob_id_substring: str, days_ago: int) -> int:
    """
    UPDATE one vector_entries row's created_at by `days_ago`.
    Match by text substring so we can target specific facts; the table has
    a `plaintext` column in benchmark mode. Returns rowcount.
    """
    # psycopg uses %s placeholders. Build the ILIKE pattern in Python.
    sql = (
        "UPDATE vector_entries "
        "SET created_at = NOW() - (%s || ' days')::interval "
        "WHERE plaintext ILIKE %s "
        "  AND created_at > NOW() - INTERVAL '1 hour'"
    )
    pattern = f"%{blob_id_substring}%"
    with conn.cursor() as cur:
        cur.execute(sql, (str(days_ago), pattern))
        return cur.rowcount


def main() -> None:
    cfg = load_cfg()
    server_url = cfg["server"]["url"]
    delegate_key = cfg["server"]["delegate_key"]
    account_id = cfg["server"]["account_id"]

    namespace = f"ranker-smoke-{uuid.uuid4().hex[:8]}"
    print(f"[smoke] namespace = {namespace}")

    client = MemWalClient(server_url, delegate_key, account_id)

    # Clean-slate: forget the namespace first (no-op if empty).
    client.forget_namespace(namespace)

    # Five short factual statements about a fictional Bob. They share enough
    # vocabulary that all five will appear in a "tell me about Bob" recall;
    # differences in cosine distance should be small enough that recency
    # weighting can flip the order.
    facts = [
        ("FRESH", "Bob recently started a new job as a software engineer."),
        ("FRESH", "Bob enjoys hiking on weekends near his home in Seattle."),
        ("AGED60", "Bob was reading a book about climate science last winter."),
        ("AGED180", "Bob travelled to Japan with his family half a year ago."),
        ("AGED365", "Bob graduated from university a year ago."),
    ]

    print(f"[smoke] ingesting {len(facts)} facts via analyze ...")
    for tag, text in facts:
        # analyze takes free-text and extracts facts via LLM. In benchmark
        # mode this is synchronous — by the time analyze() returns, the
        # row(s) are in Postgres.
        # We use analyze (not remember) because that's the path the
        # benchmark harness uses and it goes through the same engine.
        result = client.analyze(text=text, namespace=namespace)
        print(f"  [{tag}] analyze: extracted {len(result.facts)} facts")

    # Backdate rows so we have age variance. Connect to Postgres directly
    # because the server has no /api/forge_created_at endpoint (and shouldn't).
    print("[smoke] backdating created_at on aged rows ...")
    with psycopg.connect(db_url()) as conn:
        backdate_row(conn, "climate science", 60)
        backdate_row(conn, "Japan", 180)
        backdate_row(conn, "graduated", 365)
        conn.commit()

        # Print the resulting row state so the smoke is auditable.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT substr(plaintext, 1, 60) as t, "
                "       EXTRACT(DAY FROM (NOW() - created_at))::int as age_days "
                "FROM vector_entries "
                "WHERE namespace = %s "
                "ORDER BY created_at DESC",
                (namespace,),
            )
            for t, age in cur.fetchall():
                print(f"  age={age:>4}d  text={t!r}")

    query = "Tell me about Bob's recent life."

    print(f"\n[smoke] querying: {query!r}")

    print("\n=== A) NO scoring_weights (today's default; should be cosine order) ===")
    a = client.recall(query=query, namespace=namespace, limit=10)
    for i, m in enumerate(a.memories):
        print(f"  {i + 1}. score={m.score:.4f}  text={m.text[:70]!r}")

    print("\n=== B) recency_heavy (semantic=0.4, recency=0.6) ===")
    weights = ScoringWeights(semantic=0.4, importance=0.0, recency=0.6, frequency=0.0)
    b = client.recall(
        query=query,
        namespace=namespace,
        limit=10,
        scoring_weights=weights,
    )
    for i, m in enumerate(b.memories):
        print(f"  {i + 1}. score={m.score:.4f}  text={m.text[:70]!r}")

    # Verdict: orderings should differ in at least one position. The FRESH
    # facts should rank higher in B than in A; the AGED365 fact should drop.
    a_ids = [m.memory_id for m in a.memories]
    b_ids = [m.memory_id for m in b.memories]
    if a_ids == b_ids:
        print("\n❌ FAIL: orderings are identical — ranker not active or weights ignored")
        sys.exit(1)

    print("\n✅ PASS: orderings differ — recency weighting changed the order")
    print(f"   A order: {a_ids}")
    print(f"   B order: {b_ids}")

    # Cleanup
    client.forget_namespace(namespace)
    print(f"[smoke] cleaned up namespace {namespace}")


if __name__ == "__main__":
    main()
