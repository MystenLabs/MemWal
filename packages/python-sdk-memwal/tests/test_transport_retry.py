"""Tests for network transport error retry and deadline bounding during polling (WALM-696, GH #1000)."""

from __future__ import annotations

import httpx
import pytest

from memwal.client import (
    MemWal,
    MemWalRememberJobTimeout,
    RememberBulkOptions,
)


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


@pytest.mark.asyncio
async def test_wait_for_remember_job_retries_connect_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def status(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("simulated connection drop")
        return {
            "job_id": "job-1",
            "status": "done",
            "blob_id": "blob-1",
            "owner": "0x1",
            "namespace": "default",
        }

    monkeypatch.setattr(client, "_signed_request", status)

    done = await client.wait_for_remember_job("job-1", poll_interval_ms=100, timeout_ms=5000)
    assert done.blob_id == "blob-1"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_wait_for_remember_job_retries_read_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def status(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ReadTimeout("simulated socket read timeout")
        return {
            "job_id": "job-2",
            "status": "done",
            "blob_id": "blob-2",
            "owner": "0x1",
            "namespace": "default",
        }

    monkeypatch.setattr(client, "_signed_request", status)

    done = await client.wait_for_remember_job("job-2", poll_interval_ms=100, timeout_ms=5000)
    assert done.blob_id == "blob-2"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_wait_for_remember_job_times_out_with_http_0_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock, slept = _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def failing(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        clock["now"] += 100
        raise httpx.ConnectError("network unreachable")

    monkeypatch.setattr(client, "_signed_request", failing)

    with pytest.raises(MemWalRememberJobTimeout) as exc_info:
        await client.wait_for_remember_job("job-fail", poll_interval_ms=100, timeout_ms=500)

    err = exc_info.value
    assert err.last_refusal == 0
    assert err.status == 504
    assert "last poll: HTTP 0" in str(err)
    assert calls["n"] > 1


@pytest.mark.asyncio
async def test_wait_for_remember_job_bounds_poll_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    clock, _ = _patch_clock(monkeypatch)
    client = _client()
    captured_timeouts: list[float] = []

    async def capture(*_args: object, **kwargs: object) -> dict:
        timeout = kwargs.get("timeout")
        if timeout is not None:
            captured_timeouts.append(timeout)
        return {
            "job_id": "job-bound",
            "status": "done",
            "blob_id": "blob-bound",
            "owner": "0x1",
            "namespace": "default",
        }

    monkeypatch.setattr(client, "_signed_request", capture)

    clock["now"] = 1000
    # timeout_ms=2000 -> deadline=3000 -> remaining=2.0s
    await client.wait_for_remember_job("job-bound", timeout_ms=2000)
    assert len(captured_timeouts) == 1
    assert captured_timeouts[0] == pytest.approx(2.0, rel=1e-2)


@pytest.mark.asyncio
async def test_wait_for_remember_jobs_bulk_retries_transport_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_clock(monkeypatch)
    client = _client()
    calls = {"n": 0}

    async def bulk_status(job_ids: list[str], timeout: float | None = None):
        from memwal.types import RememberBulkStatusItem, RememberBulkStatusResult

        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("simulated bulk network drop")
        return RememberBulkStatusResult(
            results=[
                RememberBulkStatusItem(
                    job_id="bulk-1",
                    status="done",
                    blob_id="blob-bulk-1",
                )
            ]
        )

    monkeypatch.setattr(client, "get_remember_bulk_status", bulk_status)

    res = await client.wait_for_remember_jobs(
        ["bulk-1"],
        opts=RememberBulkOptions(poll_interval_ms=100, timeout_ms=5000),
    )
    assert len(res.results) == 1
    assert res.results[0].status == "done"
    assert res.results[0].blob_id == "blob-bulk-1"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_wait_for_remember_jobs_bulk_timeout_on_persistent_transport_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock, _ = _patch_clock(monkeypatch)
    client = _client()

    async def bulk_failing(job_ids: list[str], timeout: float | None = None):
        clock["now"] += 100
        raise httpx.ConnectError("persistent bulk network drop")

    monkeypatch.setattr(client, "get_remember_bulk_status", bulk_failing)

    res = await client.wait_for_remember_jobs(
        ["bulk-dead"],
        opts=RememberBulkOptions(poll_interval_ms=100, timeout_ms=500),
    )
    assert len(res.results) == 1
    assert res.results[0].status == "timeout"
    assert "last poll: HTTP 0" in (res.results[0].error or "")
