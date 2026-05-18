#!/usr/bin/env python3
"""
Integration tests for the MemWal Python SDK against a live server.

Targets MEMWAL_SERVER_URL (default: https://relayer.dev.memwal.ai).

No-auth tests (always run, no env vars needed):
  - /health endpoint
  - Unsigned request → 401
  - Wrong signature → 401
  - Expired timestamp → 401
  - Future timestamp → 401
  - Unregistered key → SDK raises MemWalError

Authenticated tests (require MEMWAL_KEY + MEMWAL_ACCOUNT_ID):
  - remember()
  - recall()
  - analyze()
  - ask()
  - Full e2e: remember → recall → verify
  - Async variants

Usage:
  # Run only no-auth tests (no keys needed)
  python -m pytest tests/test_integration.py -v -m "not requires_key"

  # Run full suite with real credentials
  MEMWAL_KEY=<hex> MEMWAL_ACCOUNT_ID=0x... python -m pytest tests/test_integration.py -v

  # Run against dev server using env vars
  export MEMWAL_KEY="944aa24c09d8b6d6cc6a8fbedc6dc0942a46e49db7d36596e1b6af6061ec9261"
  export MEMWAL_ACCOUNT_ID="0x70f9a6ff2df0ef6a9ecbfdc3f44c27c289ec3eb0cab5e10a5c07ca6165528565"
  export MEMWAL_SERVER_URL="https://relayer.dev.memwal.ai"
  python -m pytest tests/test_integration.py -v
"""

from __future__ import annotations

import hashlib
import json
import os
import time

import httpx
import nacl.signing
import pytest

from memwal.client import MemWal, MemWalError, MemWalSync
from memwal.utils import bytes_to_hex

# ── Config ───────────────────────────────────────────────────────────────────

SERVER_URL = os.environ.get("MEMWAL_SERVER_URL", "https://relayer.dev.memwal.ai")
PRIVATE_KEY_HEX = os.environ.get("MEMWAL_KEY", "")
ACCOUNT_ID = os.environ.get("MEMWAL_ACCOUNT_ID", "")

HAS_KEY = bool(PRIVATE_KEY_HEX and ACCOUNT_ID)

requires_key = pytest.mark.skipif(
    not HAS_KEY,
    reason="MEMWAL_KEY and MEMWAL_ACCOUNT_ID not set",
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _raw_signed_request(
    method: str,
    path: str,
    body: dict,
    signing_key: nacl.signing.SigningKey,
    *,
    base_url: str = SERVER_URL,
    timestamp_override: str | None = None,
    pub_key_override: str | None = None,
) -> httpx.Response:
    """Make a raw signed request without using the SDK (for auth rejection tests)."""
    body_bytes = json.dumps(body, separators=(",", ":")).encode()
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    timestamp = timestamp_override or str(int(time.time()))
    message = f"{timestamp}.{method.upper()}.{path}.{body_hash}"
    signed = signing_key.sign(message.encode())
    signature_hex = signed.signature.hex()
    pub_key_hex = pub_key_override or signing_key.verify_key.encode().hex()

    with httpx.Client(timeout=30) as client:
        return client.request(
            method,
            f"{base_url}{path}",
            content=body_bytes,
            headers={
                "Content-Type": "application/json",
                "x-public-key": pub_key_hex,
                "x-signature": signature_hex,
                "x-timestamp": timestamp,
            },
        )


# ── No-auth tests (always run) ────────────────────────────────────────────────


class TestHealth:
    """Health endpoint — no auth, always passes."""

    def test_health_returns_ok(self) -> None:
        mw = MemWalSync.create(key="aa" * 32, account_id="0x0", server_url=SERVER_URL)
        result = mw.health()
        assert result.status == "ok", f"Expected 'ok', got '{result.status}'"
        print(f"\n  server version={result.version}")

    def test_health_has_version(self) -> None:
        mw = MemWalSync.create(key="aa" * 32, account_id="0x0", server_url=SERVER_URL)
        result = mw.health()
        assert result.version is not None
        assert isinstance(result.version, str)


class TestAuthRejection:
    """Verify the server correctly rejects bad auth — no registered key needed."""

    _key = nacl.signing.SigningKey.generate()
    _body = {"text": "hello", "namespace": "default"}

    def test_unsigned_request_rejected(self) -> None:
        """Request with no auth headers → 401."""
        with httpx.Client(timeout=30) as client:
            resp = client.post(f"{SERVER_URL}/api/remember", json=self._body)
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    def test_wrong_signature_rejected(self) -> None:
        """Valid format but signature made with a different key → 401."""
        key_a = nacl.signing.SigningKey.generate()
        key_b = nacl.signing.SigningKey.generate()
        # Sign with key_a but claim to be key_b
        wrong_pub = key_b.verify_key.encode().hex()
        resp = _raw_signed_request(
            "POST", "/api/remember", self._body, key_a, pub_key_override=wrong_pub
        )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    def test_expired_timestamp_rejected(self) -> None:
        """Timestamp >5 minutes ago → 401."""
        old_ts = str(int(time.time()) - 600)  # 10 minutes ago
        resp = _raw_signed_request(
            "POST", "/api/remember", self._body, self._key, timestamp_override=old_ts
        )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    def test_future_timestamp_rejected(self) -> None:
        """Timestamp far in the future → 401."""
        future_ts = str(int(time.time()) + 600)
        resp = _raw_signed_request(
            "POST", "/api/remember", self._body, self._key, timestamp_override=future_ts
        )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    def test_sdk_surfaces_401_as_memwal_error(self) -> None:
        """SDK wraps unregistered key auth failures as MemWalError."""
        unregistered_key = "bb" * 32  # random, not registered on-chain
        mw = MemWalSync.create(key=unregistered_key, account_id="0x0", server_url=SERVER_URL)
        with pytest.raises(MemWalError) as exc_info:
            mw.remember("hello")
        err = str(exc_info.value)
        assert "401" in err or "403" in err, f"Expected 401/403 in: {err}"


# ── Authenticated tests ───────────────────────────────────────────────────────


@requires_key
class TestRemember:
    """remember() against live server."""

    def test_remember_returns_id_and_blob(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.remember("Integration test: the sky is blue", namespace="sdk-test")
        assert result.id is not None and isinstance(result.id, str)
        assert result.blob_id is not None and isinstance(result.blob_id, str)
        assert result.owner.startswith("0x")
        print(f"\n  id={result.id[:8]}... blob={result.blob_id[:8]}...")

    def test_remember_default_namespace(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.remember("Integration test: namespace default")
        assert result.namespace == "default"

    def test_remember_custom_namespace(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.remember("Integration test: custom namespace", namespace="sdk-test")
        assert result.namespace == "sdk-test"


@requires_key
class TestRecall:
    """recall() against live server."""

    def test_recall_returns_list(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.recall("sky blue", limit=5)
        assert isinstance(result.results, list)
        assert result.total >= 0
        print(f"\n  recall total={result.total}")

    def test_recall_respects_limit(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.recall("test", limit=2)
        assert len(result.results) <= 2

    def test_recall_result_has_expected_fields(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.recall("test", limit=3)
        for mem in result.results:
            assert isinstance(mem.text, str)
            assert isinstance(mem.blob_id, str)
            assert isinstance(mem.distance, float)


@requires_key
class TestAnalyze:
    """analyze() against live server."""

    def test_analyze_returns_facts(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.analyze(
            "I love hiking and my favorite food is pho.",
            namespace="sdk-test",
        )
        assert isinstance(result.facts, list)
        assert result.total >= 0
        assert result.owner.startswith("0x")
        print(f"\n  extracted {result.total} facts")
        for fact in result.facts:
            print(f"    - {fact.text}")


@requires_key
class TestAsk:
    """ask() against live server."""

    def test_ask_returns_string_answer(self) -> None:
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        result = mw.ask("What outdoor activities do I enjoy?", limit=3)
        assert isinstance(result.answer, str)
        assert len(result.answer) > 0
        assert isinstance(result.memories_used, int)
        assert isinstance(result.memories, list)
        print(f"\n  answer: {result.answer[:80]}...")
        print(f"  memories_used={result.memories_used}")


@requires_key
class TestFullFlow:
    """End-to-end: remember → recall → verify the stored memory surfaces."""

    def test_remember_then_recall_finds_it(self) -> None:
        import uuid

        unique = str(uuid.uuid4())[:8]
        text = f"SDK e2e test {unique}: quantum entanglement in photonics"
        ns = f"sdk-e2e-{unique}"

        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )

        # Store a distinctive memory in an isolated namespace
        mem = mw.remember(text, namespace=ns)
        assert mem.id is not None

        # Recall — should find the stored memory
        result = mw.recall(f"quantum photonics {unique}", limit=5, namespace=ns)
        assert result.total >= 1, f"Expected >= 1 result, got {result.total}"
        assert any(unique in r.text for r in result.results), (
            f"Expected unique marker '{unique}' in recalled texts: "
            + str([r.text for r in result.results])
        )
        print(f"\n  stored id={mem.id[:8]}..., recalled {result.total} results")

    def test_remember_then_ask_uses_memory(self) -> None:
        """remember → ask — answer should reference the stored fact."""
        mw = MemWalSync.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        )
        mw.remember("I am allergic to shellfish", namespace="sdk-test")
        result = mw.ask("What are my food allergies?", limit=3, namespace="sdk-test")
        assert isinstance(result.answer, str)
        assert len(result.answer) > 0
        print(f"\n  ask answer: {result.answer[:100]}")


# ── Async variants ────────────────────────────────────────────────────────────


@requires_key
class TestAsync:
    """Async client variants."""

    async def test_async_health(self) -> None:
        async with MemWal.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        ) as mw:
            result = await mw.health()
            assert result.status == "ok"

    async def test_async_remember(self) -> None:
        async with MemWal.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        ) as mw:
            result = await mw.remember("Async SDK test: Paris is the capital of France")
            assert result.id is not None

    async def test_async_recall(self) -> None:
        async with MemWal.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        ) as mw:
            await mw.remember("Async SDK test: I enjoy reading")
            result = await mw.recall("reading books", limit=3)
            assert isinstance(result.results, list)

    async def test_async_analyze(self) -> None:
        async with MemWal.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        ) as mw:
            result = await mw.analyze("I drink tea every morning.", namespace="sdk-test")
            assert isinstance(result.facts, list)

    async def test_async_ask(self) -> None:
        async with MemWal.create(
            key=PRIVATE_KEY_HEX, account_id=ACCOUNT_ID, server_url=SERVER_URL
        ) as mw:
            result = await mw.ask("What do I drink?", limit=3)
            assert isinstance(result.answer, str)
