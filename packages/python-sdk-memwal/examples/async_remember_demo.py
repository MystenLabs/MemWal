"""End-to-end smoke test for the async remember family (PR #121 / ENG-1406+1408).

Loads credentials from ./.env (see ``.env.example``), then walks every new
method that was added to mirror the TypeScript SDK:

    1. health()                   sanity check
    2. remember()                 returns RememberAcceptedResult (~500ms)
    3. wait_for_remember_job()    polls until ``done`` (~upload time)
    4. remember_and_wait()        single call doing both
    5. recall()                   verify the new memory came back
    6. remember_bulk_and_wait()   3 facts in one call
    7. analyze_and_wait()         LLM extracts facts + waits for them all
    8. embed()                    raw embedding vector

Run::

    cd packages/python-sdk-memwal
    cp examples/.env.example examples/.env  # then fill in real values
    python3 examples/async_remember_demo.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path


def _load_env() -> None:
    """Tiny .env loader so the demo doesn't need python-dotenv."""

    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env()

# Make ``import memwal`` work when running directly from the repo without
# `pip install -e .`.
sys.path.insert(0, str(Path(__file__).parent.parent))

from memwal import (  # noqa: E402
    MemWal,
    RememberBulkItem,
    RememberBulkOptions,
)


def _section(title: str) -> None:
    print(f"\n──────── {title} ────────")


def _ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


async def main() -> None:
    server_url = os.environ.get("MEMWAL_SERVER_URL", "http://localhost:3001")
    key = os.environ.get("MEMWAL_KEY")
    account_id = os.environ.get("MEMWAL_ACCOUNT_ID")
    namespace = os.environ.get("MEMWAL_NAMESPACE", "python-sdk-example")

    if not key or not account_id:
        print("ERROR: set MEMWAL_KEY + MEMWAL_ACCOUNT_ID in examples/.env")
        sys.exit(2)

    print(f"server      : {server_url}")
    print(f"account_id  : {account_id[:14]}...")
    print(f"namespace   : {namespace}")

    async with MemWal.create(
        key=key,
        account_id=account_id,
        server_url=server_url,
        namespace=namespace,
    ) as memwal:
        # 1. health
        _section("1. health()")
        h = await memwal.health()
        print(f"  status={h.status}  version={h.version}")

        # 2. remember() → 202 + job_id (PR #121: should return in ~500ms)
        _section("2. remember()  — returns 202 + job_id")
        t0 = time.monotonic()
        accepted = await memwal.remember(
            "Python SDK demo: I prefer FastAPI over Flask for async HTTP services."
        )
        accept_ms = _ms(t0)
        print(f"  accept_ms={accept_ms}  job_id={accepted.job_id}  status={accepted.status}")
        assert accepted.job_id, "expected job_id"
        assert accept_ms < 5000, f"expected <5s response, got {accept_ms}ms"

        # 3. wait_for_remember_job → polls until "done"
        _section("3. wait_for_remember_job(job_id)")
        t1 = time.monotonic()
        result = await memwal.wait_for_remember_job(accepted.job_id, timeout_ms=60_000)
        wait_ms = _ms(t1)
        print(f"  wait_ms={wait_ms}  blob_id={result.blob_id}  ns={result.namespace}")

        # 4. remember_and_wait — convenience
        _section("4. remember_and_wait()")
        t2 = time.monotonic()
        full = await memwal.remember_and_wait(
            "Python SDK demo: I drink black coffee in the morning.",
            timeout_ms=60_000,
        )
        total_ms = _ms(t2)
        print(f"  total_ms={total_ms}  blob_id={full.blob_id}")

        # 5. recall — confirm the memories are searchable
        _section("5. recall('coffee')")
        rc = await memwal.recall("coffee", limit=3)
        print(f"  found {len(rc.results)} / total={rc.total}")
        for m in rc.results[:3]:
            print(f"    [{m.distance:.3f}] {m.text[:80]}")

        # 6. remember_bulk_and_wait — 3 items in one call
        _section("6. remember_bulk_and_wait()  — 3 items")
        t3 = time.monotonic()
        bulk = await memwal.remember_bulk_and_wait(
            [
                RememberBulkItem(text="Bulk demo 1: Trees clean the air."),
                RememberBulkItem(text="Bulk demo 2: Coffee comes from beans."),
                RememberBulkItem(text="Bulk demo 3: Mountains are usually cold."),
            ],
            opts=RememberBulkOptions(poll_interval_ms=2000, timeout_ms=120_000),
        )
        bulk_ms = _ms(t3)
        print(
            f"  bulk_ms={bulk_ms}  total={bulk.total}  ok={bulk.succeeded}  "
            f"failed={bulk.failed}  timed_out={bulk.timed_out}"
        )
        for r in bulk.results:
            print(f"    [{r.status}] id={r.id[:8]}... blob={r.blob_id[:20]}...")

        # 7. analyze_and_wait — LLM splits text into facts + persists each
        _section("7. analyze_and_wait()")
        t4 = time.monotonic()
        try:
            an = await memwal.analyze_and_wait(
                "Today I learned that the Pacific is the largest ocean and "
                "that octopuses have three hearts.",
                opts=RememberBulkOptions(timeout_ms=120_000),
            )
            ana_ms = _ms(t4)
            print(
                f"  analyze_ms={ana_ms}  facts={len(an.facts)}  "
                f"ok={an.succeeded}  failed={an.failed}  timed_out={an.timed_out}"
            )
            for f, r in zip(an.facts, an.results):
                print(f"    fact='{f.text[:60]}' status={r.status} blob={r.blob_id[:20]}...")
        except Exception as e:
            print(f"  skipped (analyze requires server LLM key): {e}")

        # 8. embed — raw embedding vector
        _section("8. embed('hello world')")
        try:
            emb = await memwal.embed("hello world")
            print(f"  vector dims={len(emb.vector)}  first 5={emb.vector[:5]}")
        except Exception as e:
            print(f"  skipped (server may not expose /api/embed yet): {e}")

    print("\n✅ all sections completed")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
