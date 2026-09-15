"""Parity with TS pollingDelayMs."""

from __future__ import annotations

import pytest

from memwal.client import _polling_delay_ms


def test_attempt_0_is_immediate() -> None:
    assert _polling_delay_ms(0, 0) == 0
    assert _polling_delay_ms(5000, 0) == 0


def test_grows_1_5x_from_100ms_floor_toward_3s(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 0.5)
    assert _polling_delay_ms(0, 1) == 100
    assert _polling_delay_ms(50, 1) == 100
    assert _polling_delay_ms(400, 1) == 400
    assert _polling_delay_ms(400, 2) == 600
    assert _polling_delay_ms(400, 20) == 3000
    assert _polling_delay_ms(5000, 1) == 5000
    assert _polling_delay_ms(5000, 15) == 5000
