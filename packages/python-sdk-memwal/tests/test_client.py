"""
Tests for the MemWal async client.

Uses ``respx`` to mock ``httpx.AsyncClient`` requests and validate
that the client sends correct headers, body, and handles errors.
"""

from __future__ import annotations

import json

import httpx
import nacl.signing
import pytest
import respx

from memwal.client import MemWal, MemWalError
from memwal.types import RecallManualOptions, RememberManualOptions
from memwal.utils import bytes_to_hex, sha256_hex

# ============================================================
# Fixtures
# ============================================================

# Generate a deterministic test keypair
_TEST_SEED = b"\x01" * 32
_TEST_KEY = nacl.signing.SigningKey(_TEST_SEED)
_TEST_KEY_HEX = bytes_to_hex(bytes(_TEST_KEY))
_TEST_PUB_HEX = bytes_to_hex(bytes(_TEST_KEY.verify_key))
_TEST_ACCOUNT_ID = "0xabc123"
_TEST_SERVER = "http://localhost:8000"


@pytest.fixture
def memwal_client() -> MemWal:
    """Create a MemWal client with a test key."""
    return MemWal.create(
        key=_TEST_KEY_HEX,
        account_id=_TEST_ACCOUNT_ID,
        server_url=_TEST_SERVER,
    )


# ============================================================
# remember() tests
# ============================================================


class TestRemember:
    @respx.mock
    async def test_sends_correct_body(self, memwal_client: MemWal) -> None:
        """remember() should POST to /api/remember with text and namespace."""
        route = respx.post(f"{_TEST_SERVER}/api/remember").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "mem-1",
                    "blob_id": "blob-abc",
                    "owner": "0xowner",
                    "namespace": "default",
                },
            )
        )

        result = await memwal_client.remember("I love coffee")

        assert route.called
        request = route.calls[0].request
        body = json.loads(request.content)
        assert body["text"] == "I love coffee"
        assert body["namespace"] == "default"
        assert result.id == "mem-1"
        assert result.blob_id == "blob-abc"
        assert result.owner == "0xowner"
        assert result.namespace == "default"

    @respx.mock
    async def test_sends_correct_headers(self, memwal_client: MemWal) -> None:
        """remember() should include all required auth headers."""
        route = respx.post(f"{_TEST_SERVER}/api/remember").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "mem-1",
                    "blob_id": "blob-abc",
                    "owner": "0xowner",
                    "namespace": "default",
                },
            )
        )

        await memwal_client.remember("test")

        request = route.calls[0].request
        headers = request.headers

        # Required headers
        assert headers["x-public-key"] == _TEST_PUB_HEX
        assert "x-signature" in headers
        assert len(headers["x-signature"]) == 128  # 64 bytes = 128 hex chars
        assert "x-timestamp" in headers
        assert headers["x-timestamp"].isdigit()
        assert headers["x-delegate-key"] == _TEST_KEY_HEX
        assert headers["x-account-id"] == _TEST_ACCOUNT_ID
        assert headers["content-type"] == "application/json"

    @respx.mock
    async def test_signature_is_verifiable(self, memwal_client: MemWal) -> None:
        """The signature in headers should be verifiable with the public key."""
        route = respx.post(f"{_TEST_SERVER}/api/remember").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "mem-1",
                    "blob_id": "blob-abc",
                    "owner": "0xowner",
                    "namespace": "default",
                },
            )
        )

        await memwal_client.remember("verify me")

        request = route.calls[0].request
        headers = request.headers
        body_str = request.content.decode("utf-8")

        # Reconstruct the signing message
        timestamp = headers["x-timestamp"]
        body_hash = sha256_hex(body_str)
        message = f"{timestamp}.POST./api/remember.{body_hash}"

        # Verify signature
        verify_key = nacl.signing.VerifyKey(bytes.fromhex(headers["x-public-key"]))
        verify_key.verify(
            message.encode("utf-8"),
            bytes.fromhex(headers["x-signature"]),
        )

    @respx.mock
    async def test_custom_namespace(self, memwal_client: MemWal) -> None:
        """remember() should use custom namespace when provided."""
        route = respx.post(f"{_TEST_SERVER}/api/remember").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "mem-1",
                    "blob_id": "blob-abc",
                    "owner": "0xowner",
                    "namespace": "custom-ns",
                },
            )
        )

        result = await memwal_client.remember("test", namespace="custom-ns")

        body = json.loads(route.calls[0].request.content)
        assert body["namespace"] == "custom-ns"
        assert result.namespace == "custom-ns"


# ============================================================
# recall() tests
# ============================================================


class TestRecall:
    @respx.mock
    async def test_sends_correct_body(self, memwal_client: MemWal) -> None:
        """recall() should POST to /api/recall with query, limit, namespace."""
        route = respx.post(f"{_TEST_SERVER}/api/recall").mock(
            return_value=httpx.Response(
                200,
                json={
                    "results": [
                        {"blob_id": "b1", "text": "I love coffee", "distance": 0.1},
                        {"blob_id": "b2", "text": "I live in Tokyo", "distance": 0.3},
                    ],
                    "total": 2,
                },
            )
        )

        result = await memwal_client.recall("coffee", limit=5)

        assert route.called
        body = json.loads(route.calls[0].request.content)
        assert body["query"] == "coffee"
        assert body["limit"] == 5
        assert body["namespace"] == "default"

        assert len(result.results) == 2
        assert result.total == 2
        assert result.results[0].text == "I love coffee"
        assert result.results[0].distance == 0.1
        assert result.results[1].blob_id == "b2"

    @respx.mock
    async def test_sends_correct_headers(self, memwal_client: MemWal) -> None:
        """recall() should include all required auth headers."""
        route = respx.post(f"{_TEST_SERVER}/api/recall").mock(
            return_value=httpx.Response(
                200,
                json={"results": [], "total": 0},
            )
        )

        await memwal_client.recall("test")

        headers = route.calls[0].request.headers
        assert headers["x-public-key"] == _TEST_PUB_HEX
        assert len(headers["x-signature"]) == 128
        assert headers["x-account-id"] == _TEST_ACCOUNT_ID


# ============================================================
# Error handling tests
# ============================================================


class TestErrorHandling:
    @respx.mock
    async def test_non_200_raises_memwal_error(self, memwal_client: MemWal) -> None:
        """Non-200 responses should raise MemWalError with status and body."""
        respx.post(f"{_TEST_SERVER}/api/remember").mock(
            return_value=httpx.Response(
                401,
                text="Invalid signature",
            )
        )

        with pytest.raises(MemWalError, match="401"):
            await memwal_client.remember("test")

    @respx.mock
    async def test_500_raises_memwal_error(self, memwal_client: MemWal) -> None:
        """Server errors should raise MemWalError."""
        respx.post(f"{_TEST_SERVER}/api/recall").mock(
            return_value=httpx.Response(
                500,
                text="Internal server error",
            )
        )

        with pytest.raises(MemWalError, match="500"):
            await memwal_client.recall("test")

    @respx.mock
    async def test_health_non_200_raises(self, memwal_client: MemWal) -> None:
        """Health check should raise on non-200."""
        respx.get(f"{_TEST_SERVER}/health").mock(
            return_value=httpx.Response(503, text="Service unavailable")
        )

        with pytest.raises(MemWalError, match="Health check failed"):
            await memwal_client.health()


# ============================================================
# Other endpoint tests
# ============================================================


class TestAnalyze:
    @respx.mock
    async def test_analyze(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/analyze").mock(
            return_value=httpx.Response(
                200,
                json={
                    "facts": [
                        {"text": "User loves coffee", "id": "f1", "blob_id": "b1"},
                    ],
                    "total": 1,
                    "owner": "0xowner",
                },
            )
        )

        result = await memwal_client.analyze("I love coffee and live in Tokyo")

        body = json.loads(route.calls[0].request.content)
        assert body["text"] == "I love coffee and live in Tokyo"
        assert len(result.facts) == 1
        assert result.facts[0].text == "User loves coffee"
        assert result.owner == "0xowner"


class TestRestore:
    @respx.mock
    async def test_restore(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/restore").mock(
            return_value=httpx.Response(
                200,
                json={
                    "restored": 5,
                    "skipped": 2,
                    "total": 7,
                    "namespace": "my-app",
                    "owner": "0xowner",
                },
            )
        )

        result = await memwal_client.restore("my-app", limit=100)

        body = json.loads(route.calls[0].request.content)
        assert body["namespace"] == "my-app"
        assert body["limit"] == 100
        assert result.restored == 5
        assert result.skipped == 2


class TestHealth:
    @respx.mock
    async def test_health(self, memwal_client: MemWal) -> None:
        respx.get(f"{_TEST_SERVER}/health").mock(
            return_value=httpx.Response(
                200,
                json={"status": "ok", "version": "0.1.0"},
            )
        )

        result = await memwal_client.health()
        assert result.status == "ok"
        assert result.version == "0.1.0"


class TestManualAPI:
    @respx.mock
    async def test_remember_manual(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/remember/manual").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "m1",
                    "blob_id": "blob-xyz",
                    "owner": "0xowner",
                    "namespace": "default",
                },
            )
        )

        opts = RememberManualOptions(
            blob_id="blob-xyz",
            vector=[0.1, 0.2, 0.3],
        )
        result = await memwal_client.remember_manual(opts)

        body = json.loads(route.calls[0].request.content)
        assert body["blob_id"] == "blob-xyz"
        assert body["vector"] == [0.1, 0.2, 0.3]
        assert result.blob_id == "blob-xyz"

    @respx.mock
    async def test_recall_manual(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/recall/manual").mock(
            return_value=httpx.Response(
                200,
                json={
                    "results": [
                        {"blob_id": "b1", "distance": 0.15},
                    ],
                    "total": 1,
                },
            )
        )

        opts = RecallManualOptions(vector=[0.1, 0.2, 0.3], limit=5)
        result = await memwal_client.recall_manual(opts)

        body = json.loads(route.calls[0].request.content)
        assert body["vector"] == [0.1, 0.2, 0.3]
        assert body["limit"] == 5
        assert len(result.results) == 1
        assert result.results[0].blob_id == "b1"


class TestPublicKey:
    async def test_get_public_key_hex(self, memwal_client: MemWal) -> None:
        pub_hex = await memwal_client.get_public_key_hex()
        assert pub_hex == _TEST_PUB_HEX
        assert len(pub_hex) == 64  # 32 bytes = 64 hex chars


class TestAsk:
    @respx.mock
    async def test_ask(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/ask").mock(
            return_value=httpx.Response(
                200,
                json={
                    "answer": "You are allergic to peanuts.",
                    "memories_used": 1,
                    "memories": [
                        {"blob_id": "b1", "text": "User is allergic to peanuts", "distance": 0.05}
                    ],
                },
            )
        )

        result = await memwal_client.ask("What are my allergies?", limit=3)

        body = json.loads(route.calls[0].request.content)
        assert body["question"] == "What are my allergies?"
        assert body["limit"] == 3
        assert body["namespace"] == "default"
        assert result.answer == "You are allergic to peanuts."
        assert result.memories_used == 1
        assert len(result.memories) == 1
        assert result.memories[0].text == "User is allergic to peanuts"
        assert result.memories[0].distance == 0.05

    @respx.mock
    async def test_ask_empty_memories(self, memwal_client: MemWal) -> None:
        respx.post(f"{_TEST_SERVER}/api/ask").mock(
            return_value=httpx.Response(
                200,
                json={
                    "answer": "No memories found for this user yet.",
                    "memories_used": 0,
                    "memories": [],
                },
            )
        )

        result = await memwal_client.ask("Tell me about myself")
        assert result.memories_used == 0
        assert result.memories == []

    @respx.mock
    async def test_ask_custom_namespace(self, memwal_client: MemWal) -> None:
        route = respx.post(f"{_TEST_SERVER}/api/ask").mock(
            return_value=httpx.Response(
                200,
                json={"answer": "answer", "memories_used": 0, "memories": []},
            )
        )

        await memwal_client.ask("question", namespace="work")

        body = json.loads(route.calls[0].request.content)
        assert body["namespace"] == "work"


class TestContextManager:
    @respx.mock
    async def test_async_context_manager(self) -> None:
        """Client should work as an async context manager."""
        respx.get(f"{_TEST_SERVER}/health").mock(
            return_value=httpx.Response(
                200,
                json={"status": "ok", "version": "0.1.0"},
            )
        )

        async with MemWal.create(
            key=_TEST_KEY_HEX,
            account_id=_TEST_ACCOUNT_ID,
            server_url=_TEST_SERVER,
        ) as client:
            result = await client.health()
            assert result.status == "ok"
