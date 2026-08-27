"""Tests for the AUTH_REJECTED_MESSAGE shown on a 401 from the relayer."""

from __future__ import annotations

from memwal.client import (
    AUTH_REJECTED_MESSAGE,
    AUTH_UPSTREAM_UNAVAILABLE,
    UPSTREAM_UNAVAILABLE_MESSAGE,
    _HttpStatusError,
)


def test_auth_rejected_message_points_to_troubleshooting_guide() -> None:
    assert "docs.wal.app/walrus-memory/troubleshooting/overview" in AUTH_REJECTED_MESSAGE


def test_auth_503_is_retryable_not_a_credential_failure() -> None:
    err = _HttpStatusError(
        503, "upstream unavailable", auth_error=AUTH_UPSTREAM_UNAVAILABLE, retry_after="5"
    )
    assert str(err) == UPSTREAM_UNAVAILABLE_MESSAGE
    assert "sign-in" in str(err)
    assert "401" not in str(err)
    assert err.retry_after == "5"


def test_non_auth_503_keeps_generic_body() -> None:
    err = _HttpStatusError(503, "Rate limiter temporarily unavailable")
    assert "Rate limiter temporarily unavailable" in str(err)
    assert "cannot verify credentials" not in str(err)
