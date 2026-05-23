"""Interactive end-to-end demo of the new Python SDK against a live server.

Each step prints:

  • What is being called (method + URL)
  • Time-to-response (ms)
  • Server response (raw)
  • Server log lines emitted by that request (tailed from server.log)

So you see in real time:

  1. ``remember()``   → server returns 202 in ~500ms (PR #121 win)
  2. Background worker progresses through pending → running → uploaded → done
  3. ``wait_for_remember_job()`` polls until the blob_id is settled
  4. ``recall()``     → decrypted memory comes back
"""

from __future__ import annotations

import os
import sys
import time
import asyncio
from pathlib import Path

# .env loader
def _load_env() -> None:
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
sys.path.insert(0, str(Path(__file__).parent.parent))

from memwal import MemWal, RememberBulkItem, RememberBulkOptions  # noqa: E402

# Path to the running server's log so we can show what happens on the
# server side as each SDK call is made.
SERVER_LOG = Path(
    "/Users/harryphan/Documents/2026 vault/DEV_PROJECTS/active/memwal/MemWal/services/server/server.log"
)


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _hr(title: str) -> None:
    print()
    print("=" * 78)
    print(f"  {title}")
    print("=" * 78)


def _server_log_tail(start_offset: int, max_lines: int = 8) -> int:
    """Print server log lines added since `start_offset`. Returns new offset."""
    if not SERVER_LOG.exists():
        return start_offset
    with SERVER_LOG.open("rb") as f:
        f.seek(start_offset)
        chunk = f.read()
        new_offset = f.tell()
    if not chunk:
        return new_offset
    text = chunk.decode("utf-8", errors="replace")
    # Strip ANSI color escape sequences that tracing emits
    import re

    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    lines = [
        ln
        for ln in text.splitlines()
        if "memwal_server" in ln or "wallet-job" in ln or "[remember" in ln
    ][-max_lines:]
    if lines:
        print("    [server log]")
        for ln in lines:
            # Keep only "INFO memwal_server::route: actual message"
            after = ln.split("memwal_server", 1)[-1]
            print(f"      {after}")
    return new_offset


def _log_offset() -> int:
    """Current size of server.log so we can tail only new bytes per step."""
    return SERVER_LOG.stat().st_size if SERVER_LOG.exists() else 0


async def main() -> None:
    server_url = os.environ.get("MEMWAL_SERVER_URL", "http://localhost:8000")
    key = os.environ.get("MEMWAL_PRIVATE_KEY") or os.environ.get("MEMWAL_KEY")
    account_id = os.environ.get("MEMWAL_ACCOUNT_ID")
    namespace = os.environ.get("MEMWAL_NAMESPACE", "python-sdk-example")

    if not key or not account_id:
        print("ERROR: set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID in examples/.env")
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

        # ───────────────────────────────────────────────────────────
        # STEP 1 — health() — sanity check
        # ───────────────────────────────────────────────────────────
        _hr("STEP 1   GET /health")
        off = _log_offset()
        t = _now_ms()
        h = await memwal.health()
        print(f"  ← {_now_ms() - t} ms   status={h.status}  version={h.version}")
        _server_log_tail(off)

        # ───────────────────────────────────────────────────────────
        # STEP 2 — remember() — async accept (PR #121 main win)
        # ───────────────────────────────────────────────────────────
        _hr("STEP 2   POST /api/remember   (PR #121 async — should return 202 in <500ms)")
        text = "Demo memory: My favourite Vietnamese drink is cà phê sữa đá."
        print(f"  → text='{text}'")
        off = _log_offset()
        t = _now_ms()
        accepted = await memwal.remember(text)
        accept_ms = _now_ms() - t
        print(f"  ← {accept_ms} ms")
        print(f"     job_id  = {accepted.job_id}")
        print(f"     status  = {accepted.status}")
        verdict = "✅ FAST (async accept worked)" if accept_ms < 2000 else "⚠️ slow"
        print(f"     {verdict}")
        _server_log_tail(off)

        # ───────────────────────────────────────────────────────────
        # STEP 3 — wait_for_remember_job — polls until done
        # ───────────────────────────────────────────────────────────
        _hr(f"STEP 3   POLL  GET /api/remember/{accepted.job_id[:8]}...  until status=done")
        print("  (server worker is encrypting + uploading to Walrus + chain commit)")
        off = _log_offset()
        t = _now_ms()
        result = await memwal.wait_for_remember_job(accepted.job_id, timeout_ms=90_000)
        wait_ms = _now_ms() - t
        print(f"  ← {wait_ms} ms total worker time (polled with jittered backoff)")
        print(f"     blob_id = {result.blob_id}")
        print(f"     owner   = {result.owner[:14]}...")
        print(f"     ns      = {result.namespace}")
        _server_log_tail(off, max_lines=6)

        # ───────────────────────────────────────────────────────────
        # STEP 4 — recall — verify the memory came back through SEAL+Walrus
        # ───────────────────────────────────────────────────────────
        _hr("STEP 4   POST /api/recall   (search + decrypt the memory)")
        query = "vietnamese coffee"
        print(f"  → query='{query}'")
        off = _log_offset()
        t = _now_ms()
        rc = await memwal.recall(query, limit=3)
        rec_ms = _now_ms() - t
        print(f"  ← {rec_ms} ms   {len(rc.results)} results")
        for m in rc.results:
            print(f"     [{m.distance:.3f}] {m.text}")
        _server_log_tail(off, max_lines=4)

        # ───────────────────────────────────────────────────────────
        # STEP 5 — remember_bulk_and_wait — 3 items in one HTTP call
        # ───────────────────────────────────────────────────────────
        _hr("STEP 5   POST /api/remember/bulk   (3 items, then poll all)")
        items = [
            RememberBulkItem(text="Bulk demo A: Trees produce oxygen."),
            RememberBulkItem(text="Bulk demo B: The capital of Japan is Tokyo."),
            RememberBulkItem(text="Bulk demo C: Saturn has visible rings."),
        ]
        for it in items:
            print(f"  → {it.text}")
        off = _log_offset()
        t = _now_ms()
        bulk = await memwal.remember_bulk_and_wait(
            items,
            opts=RememberBulkOptions(poll_interval_ms=2000, timeout_ms=180_000),
        )
        bulk_ms = _now_ms() - t
        print(f"  ← {bulk_ms} ms total   ok={bulk.succeeded}/{bulk.total}  failed={bulk.failed}  timed_out={bulk.timed_out}")
        for r in bulk.results:
            print(f"     [{r.status}] id={r.id[:8]}... blob_id={r.blob_id}")
        _server_log_tail(off, max_lines=8)

        # ───────────────────────────────────────────────────────────
        # STEP 6 — recall a bulk item to prove they're searchable
        # ───────────────────────────────────────────────────────────
        _hr("STEP 6   POST /api/recall   query='japan'")
        off = _log_offset()
        rc2 = await memwal.recall("japan", limit=2)
        print(f"  ← {len(rc2.results)} results")
        for m in rc2.results:
            print(f"     [{m.distance:.3f}] {m.text}")
        _server_log_tail(off, max_lines=2)

    print()
    print("=" * 78)
    print("  ✅ demo complete — every new SDK method exercised against the live server")
    print("=" * 78)


if __name__ == "__main__":
    asyncio.run(main())
