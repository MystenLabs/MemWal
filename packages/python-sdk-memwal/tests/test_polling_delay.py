"""Remember-job poll delay (WALM-623). Parity with TS pollingDelayMs."""

from __future__ import annotations

import pytest

from memwal.client import _polling_delay_ms


def test_attempt_0_is_immediate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 1.0)
    assert _polling_delay_ms(1500, 0) == 0
    assert _polling_delay_ms(0, 0) == 0
    assert _polling_delay_ms(5000, 0) == 0


def test_poll_interval_ms_0_still_floors_at_100ms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 1.0)
    assert _polling_delay_ms(0, 1) == 125
    assert _polling_delay_ms(0, 1) != 0
    assert _polling_delay_ms(0, 15) != 0
    assert _polling_delay_ms(0, 1) == _polling_delay_ms(50, 1)


def test_later_polls_grow_1_5x_toward_3s_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 1.0)
    assert _polling_delay_ms(400, 1) == 500
    assert _polling_delay_ms(400, 2) == 750
    assert _polling_delay_ms(400, 3) == 1125
    assert _polling_delay_ms(400, 20) > _polling_delay_ms(400, 1)
    assert _polling_delay_ms(400, 20) == 3750


def test_default_1500_grows_toward_3000_not_flat(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 1.0)
    assert _polling_delay_ms(1500, 1) == 1875
    assert _polling_delay_ms(1500, 2) == 2812
    assert _polling_delay_ms(1500, 3) == 3750
    assert _polling_delay_ms(1500, 15) == 3750
    assert _polling_delay_ms(1500, 2) > _polling_delay_ms(1500, 1)


def test_explicit_interval_above_3s_is_not_clamped_below_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("memwal.client.random.random", lambda: 1.0)
    assert _polling_delay_ms(5000, 1) == 6250
    assert _polling_delay_ms(5000, 15) == 6250
