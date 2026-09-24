"""Parity with TS pollingDelayMs, plus 429 wait behavior."""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest

from memwal.client import (
    MemWal,
    MemWalRememberJobTimeout,
    _HttpStatusError,
    _polling_delay_ms,
)


def test_attempt_0_is_immediate() -> None:
    assert _polling_delay_ms(0, 0) == 0
    assert _polling_delay_ms(5000, 0) == 0


def test_grows_1_5x_from_100ms_floor_toward_5s(monkeypatch: pytest.MonkeyPatch) -> None:
    # client.py does `import random`, so patching memwal.client.random.random hits stdlib.
    real_random = random.random
    monkeypatch.setattr("memwal.client.random", SimpleNamespace(random=lambda: 0.5))
    assert random.random is real_random
    assert _polling_delay_ms(0, 1) == 100
    assert _polling_delay_ms(50, 1) == 100
    assert _polling_delay_ms(400, 1) == 400
    assert _polling_delay_ms(400, 2) == 600
    assert _polling_delay_ms(1500, 4) == 5000
    assert _polling_delay_ms(1500, 20) == 5000
    assert _polling_delay_ms(8000, 1) == 8000
    assert _polling_delay_ms(8000, 15) == 8000


def _client() -> MemWal:
    return MemWal.create(key="11" * 32, account_id="0x1", server_url="http://localhost:8000")


def _patch_clock(monkeypatch: pytest.MonkeyPatch) -> tuple[dict[str, int], list[int]]:
    clock = {"now": 0}
    slept: list[int] = []

    def now_ms() -> int:
        return clock["now"]

    async def sleep_ms(ms: int) -> None:
        slept.append(ms)
        clock["now"] += ms

    monkeypatch.setattr("memwal.client._now_ms", now_ms)
    monkeypatch.setattr("memwal.client._sleep_ms", sleep_ms)
    return clock, slept


def _rate_limit(seconds: str) -> _HttpStatusError:
    return _HttpStatusError(
        429,
        f'{{"retry_after_seconds": {seconds}}}',
        retry_after=seconds,
    )


@pytest.mark.asyncio
async def test_429_longer_than_budget_is_clamped_and_named(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock, slept = _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def status(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        raise _rate_limit("600")

    monkeypatch.setattr(client, "_signed_request", status)

    with pytest.raises(MemWalRememberJobTimeout, match="429"):
        await client.wait_for_remember_job("job-1", poll_interval_ms=1500, timeout_ms=800)

    assert clock["now"] <= 800
    assert slept == [0, 800]
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_429_that_fits_delays_the_next_read(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def status(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _rate_limit("0.05")
        return {
            "job_id": "job-1",
            "status": "done",
            "blob_id": "blob-1",
            "owner": "0x1",
            "namespace": "default",
        }

    monkeypatch.setattr(client, "_signed_request", status)
    done = await client.wait_for_remember_job("job-1", poll_interval_ms=1500, timeout_ms=5_000)

    assert done.blob_id == "blob-1"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_bulk_timeout_names_429_and_keeps_unreturned_jobs_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_clock(monkeypatch)
    client = _client()
    seen: list[list[str]] = []

    async def status(job_ids: list[str]) -> SimpleNamespace:
        seen.append(list(job_ids))
        if len(seen) == 1:
            return SimpleNamespace(
                results=[
                    SimpleNamespace(job_id="job-1", status="done", blob_id="b1", error=None)
                ]
            )
        raise _rate_limit("600")

    monkeypatch.setattr(client, "get_remember_bulk_status", status)
    settled = await client.wait_for_remember_jobs(
        ["job-1", "job-2"],
        SimpleNamespace(poll_interval_ms=1500, timeout_ms=800),
    )

    assert seen[0] == ["job-1", "job-2"]
    assert seen[1] == ["job-2"]
    assert settled.results[0].status == "done"
    assert settled.results[1].status == "timeout"
    assert settled.results[1].error == (
        "polling timed out after 800ms; wait hit a rate limit (429)"
    )
