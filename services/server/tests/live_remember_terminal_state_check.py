#!/usr/bin/env python3
"""
Manual live check for the async single-remember job lifecycle.

This script validates the polling contract around `remember_jobs` using a
real delegate key + account id against a live relayer.

What it does:
1. submit `POST /api/remember`
2. poll `GET /api/remember/:job_id`
3. print every observed status transition
4. exit once the job becomes terminal

Why it is useful for PR #180:
- On a healthy relayer, the expected result is still `done`
- If the recovery enqueue failure path from PR #180 ever occurs, the
  important behavior is that polling returns terminal `failed` with an
  error instead of hanging forever in `running` / `uploaded`

Usage:
  TEST_ACCOUNT_ID=0x... \
  TEST_DELEGATE_KEY=abcd... \
  TEST_BASE_URL=https://relayer.dev.memwal.ai \
  python3 services/server/tests/live_remember_terminal_state_check.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid

REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
sys.path.insert(0, os.path.join(REPO_ROOT, "packages", "python-sdk-memwal"))

from memwal import MemWal  # noqa: E402


BASE_URL = os.environ.get("TEST_BASE_URL", "https://relayer.dev.memwal.ai").rstrip("/")
ACCOUNT_ID = os.environ.get("TEST_ACCOUNT_ID", "").strip()
DELEGATE_KEY = os.environ.get("TEST_DELEGATE_KEY", "").strip()
TIMEOUT_MS = int(os.environ.get("TEST_TIMEOUT_MS", "120000"))
POLL_INTERVAL_MS = int(os.environ.get("TEST_POLL_INTERVAL_MS", "1000"))


def require_env(name: str, value: str) -> None:
    if not value:
        raise SystemExit(f"{name} is required")


async def poll_with_status_log(client: MemWal, job_id: str) -> dict:
    deadline = time.monotonic() + (TIMEOUT_MS / 1000)
    seen: list[str] = []

    while time.monotonic() < deadline:
        status = await client._signed_request(  # type: ignore[attr-defined]
            "GET",
            f"/api/remember/{job_id}",
            {},
            accepted_statuses=(200, 404),
        )
        status_name = status.get("status", "<missing>")

        if not seen or seen[-1] != status_name:
            seen.append(status_name)
            print("STATUS", json.dumps(status))

        if status_name in {"done", "failed"}:
            print("TERMINAL", json.dumps({"result": status_name, "statuses": seen}))
            return status

        await asyncio.sleep(POLL_INTERVAL_MS / 1000)

    raise TimeoutError(
        f"remember job {job_id} did not reach terminal state within {TIMEOUT_MS}ms"
    )


async def main() -> int:
    require_env("TEST_ACCOUNT_ID", ACCOUNT_ID)
    require_env("TEST_DELEGATE_KEY", DELEGATE_KEY)

    unique = uuid.uuid4().hex[:8]
    namespace = f"remember-terminal-check-{unique}"
    text = (
        f"Live remember terminal-state check {unique}: "
        "jasmine tea is preferred over coffee."
    )

    print(
        "CONFIG",
        json.dumps(
            {
                "base_url": BASE_URL,
                "account_id": ACCOUNT_ID,
                "namespace": namespace,
            }
        ),
    )

    async with MemWal.create(
        key=DELEGATE_KEY,
        account_id=ACCOUNT_ID,
        server_url=BASE_URL,
    ) as client:
        accepted = await client.remember(text, namespace=namespace)
        print(
            "ACCEPTED",
            json.dumps({"job_id": accepted.job_id, "status": accepted.status}),
        )

        terminal = await poll_with_status_log(client, accepted.job_id)
        status = terminal.get("status")

        if status == "done":
            print(
                "RESULT",
                json.dumps(
                    {
                        "ok": True,
                        "job_id": accepted.job_id,
                        "blob_id": terminal.get("blob_id"),
                        "note": "Happy path completed. If PR #180's recovery enqueue failure occurs, this same poll path should return status=failed with error instead of hanging.",
                    }
                ),
            )
            return 0

        print(
            "RESULT",
            json.dumps(
                {
                    "ok": False,
                    "job_id": accepted.job_id,
                    "error": terminal.get("error"),
                    "note": "Terminal failure surfaced to polling. This is the behavior PR #180 protects when recovery enqueue handoff fails.",
                }
            ),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
