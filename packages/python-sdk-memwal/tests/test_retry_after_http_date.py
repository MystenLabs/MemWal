"""Tests for HTTP-date Retry-After header parsing and arithmetic overflow protection."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Optional

import pytest

from memwal.client import (
    MemWal,
    _clamped_retry_after_ms,
    _HttpStatusError,
    _positive_retry_ms,
    _retry_after_ms,
)


def _err(
    retry_after: Optional[str] = None,
    body: Optional[str] = None,
) -> _HttpStatusError:
    return _HttpStatusError(429, body or "{}", retry_after=retry_after)


def test_positive_retry_ms_delta_seconds() -> None:
    assert _positive_retry_ms("45") == 45000
    assert _positive_retry_ms(45) == 45000
    assert _positive_retry_ms("0.5") == 500
    assert _positive_retry_ms(0.25) == 250


def test_positive_retry_ms_invalid_or_non_positive() -> None:
    assert _positive_retry_ms(0) is None
    assert _positive_retry_ms("0") is None
    assert _positive_retry_ms("-5") is None
    assert _positive_retry_ms("invalid") is None
    assert _positive_retry_ms(None) is None
    assert _positive_retry_ms(float("nan")) is None
    assert _positive_retry_ms(float("inf")) is None


def test_positive_retry_ms_overflow_protection() -> None:
    # 1e308 is finite float, but 1e308 * 1000 overflows to infinity
    assert _positive_retry_ms("1e308") is None
    assert _positive_retry_ms(1e308) is None


def test_retry_after_http_date_in_future() -> None:
    future_time = datetime.now(timezone.utc) + timedelta(seconds=45)
    future_header = format_datetime(future_time, usegmt=True)

    err = _err(retry_after=future_header)
    delay = _retry_after_ms(err)
    # Delay should be approximately 45,000 ms (allowing slight test execution variance)
    assert 40000 <= delay <= 46000


def test_retry_after_http_date_takes_priority_over_json() -> None:
    future_time = datetime.now(timezone.utc) + timedelta(seconds=60)
    future_header = format_datetime(future_time, usegmt=True)
    body = '{"retry_after_seconds": 10}'

    err = _err(retry_after=future_header, body=body)
    delay = _retry_after_ms(err)
    assert 55000 <= delay <= 61000


def test_retry_after_http_date_in_past_falls_back_to_json() -> None:
    past_time = datetime.now(timezone.utc) - timedelta(seconds=10)
    past_header = format_datetime(past_time, usegmt=True)
    body = '{"retry_after_seconds": 15}'

    err = _err(retry_after=past_header, body=body)
    assert _retry_after_ms(err) == 15000


def test_retry_after_http_date_in_past_returns_zero_when_no_json() -> None:
    past_time = datetime.now(timezone.utc) - timedelta(seconds=10)
    past_header = format_datetime(past_time, usegmt=True)

    err = _err(retry_after=past_header)
    assert _retry_after_ms(err) == 0


def test_retry_after_malformed_header_falls_back_to_json() -> None:
    err = _err(retry_after="Not A Valid Date Or Number", body='{"retry_after_seconds": 25}')
    assert _retry_after_ms(err) == 25000


def test_retry_after_malformed_header_without_json_returns_zero() -> None:
    err = _err(retry_after="invalid-header")
    assert _retry_after_ms(err) == 0


def test_retry_after_overflowing_number_falls_back_to_json() -> None:
    err = _err(retry_after="1e308", body='{"retry_after_seconds": 30}')
    assert _retry_after_ms(err) == 30000


def test_clamped_retry_after_ms_with_http_date(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed_now = 1_000_000
    monkeypatch.setattr("memwal.client._now_ms", lambda: fixed_now)

    # Future date roughly 50s ahead
    future_time = datetime.now(timezone.utc) + timedelta(seconds=50)
    future_header = format_datetime(future_time, usegmt=True)
    err = _err(retry_after=future_header)

    # If remaining time is only 20s (deadline 1,020,000), clamped to 20,000
    clamped = _clamped_retry_after_ms(err, deadline_ms=fixed_now + 20_000)
    assert clamped == 20_000

    # If remaining time is 100s, delay (~50,000 ms) is used
    clamped_large = _clamped_retry_after_ms(err, deadline_ms=fixed_now + 100_000)
    assert 45_000 <= clamped_large <= 51_000


@pytest.mark.asyncio
async def test_wait_for_remember_job_honors_http_date_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed_ts = 1700000000.0
    monkeypatch.setattr("time.time", lambda: fixed_ts)
    clock = {"now": int(fixed_ts * 1000)}
    slept: list[int] = []

    def fake_now_ms() -> int:
        return clock["now"]

    async def fake_sleep_ms(ms: int) -> None:
        slept.append(ms)
        clock["now"] += ms

    monkeypatch.setattr("memwal.client._now_ms", fake_now_ms)
    monkeypatch.setattr("memwal.client._sleep_ms", fake_sleep_ms)

    client = MemWal.create(key="11" * 32, account_id="0x1", server_url="http://localhost:8000")
    calls = {"n": 0}

    # 429 Retry-After is 2 seconds into future
    future_dt = datetime.fromtimestamp(fixed_ts, tz=timezone.utc) + timedelta(seconds=2)
    http_date = format_datetime(future_dt, usegmt=True)

    async def status(*_args: object, **_kwargs: object) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise _HttpStatusError(429, "{}", retry_after=http_date)
        return {"job_id": "job-1", "status": "done", "blob_id": "b-1"}

    monkeypatch.setattr(client, "_signed_request", status)

    res = await client.wait_for_remember_job("job-1", timeout_ms=10_000)
    assert res.blob_id == "b-1"
    assert calls["n"] == 2
    # First sleep is attempt 0 (0 ms), second sleep should be 2000 ms from Retry-After
    assert len(slept) == 2
    assert slept[0] == 0
    assert slept[1] == 2000
