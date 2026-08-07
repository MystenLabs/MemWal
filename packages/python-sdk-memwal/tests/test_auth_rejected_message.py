"""Tests for the AUTH_REJECTED_MESSAGE shown on a 401 from the relayer."""

from __future__ import annotations

from memwal.client import AUTH_REJECTED_MESSAGE


def test_auth_rejected_message_points_to_troubleshooting_guide() -> None:
    assert "docs.wal.app/walrus-memory/troubleshooting/overview" in AUTH_REJECTED_MESSAGE
