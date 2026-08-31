"""Tests for plaintext HTTP server_url guarding (WALM-452 / #748).

No network: ``MemWal.create`` only stores config, and
``normalize_server_url`` is a pure parse + log helper.
"""

from __future__ import annotations

import logging

import pytest

from memwal.client import MemWal, normalize_server_url

_KEY = "ab" * 32
_ACCOUNT = "0xdummy"


def test_plaintext_remote_warns_and_strips(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="memwal")
    assert (
        normalize_server_url("http://relayer.example.com/")
        == "http://relayer.example.com"
    )
    assert "plaintext" in caplog.text


def test_https_remote_does_not_warn(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="memwal")
    assert (
        normalize_server_url("https://relayer.memory.walrus.xyz")
        == "https://relayer.memory.walrus.xyz"
    )
    assert caplog.text == ""


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://foo.localhost",
        "http://[::1]:8000",
    ],
)
def test_plaintext_local_does_not_warn(
    url: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING, logger="memwal")
    assert normalize_server_url(url) == url
    assert caplog.text == ""


def test_create_warns_on_plaintext_remote(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="memwal")
    client = MemWal.create(
        key=_KEY,
        account_id=_ACCOUNT,
        server_url="http://relayer.example.com/",
    )
    assert client._server_url == "http://relayer.example.com"
    assert "plaintext" in caplog.text
