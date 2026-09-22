"""
Tests for ``MemWal.list_namespaces()`` — owner-scoped namespace discovery.

Mirrors ``packages/sdk/test/list-namespaces.test.mjs`` so both SDKs pin the
same wire contract.
"""

from __future__ import annotations

import asyncio
from urllib.parse import parse_qs

import httpx
import nacl.signing
import pytest
import respx

from memwal import MemWal, MemWalError, MemWalSync, NamespacesResult, NamespaceSummary
from memwal.utils import build_signature_message, bytes_to_hex, sha256_hex

_SERVER = "https://relayer.example"
_OWNER = "0xowner0000000000000000000000000000000000000000000000000000000001"
_NAMESPACES_URL = f"{_SERVER}/v1/owners/{_OWNER}/namespaces"
_KEY_HEX = bytes_to_hex(bytes(nacl.signing.SigningKey(b"\x01" * 32)))

_STATS = {"memory_count": 0, "storage_bytes": 0, "namespace": "default", "owner": _OWNER}

_ONE_PAGE = {
    "namespaces": [
        {
            "id": "ns-1",
            "name": "work",
            "memory_count": 12,
            "storage_used": 2048,
            "updated_at": "2026-08-20T10:00:00Z",
        }
    ],
    "next_cursor": "eyJ1cGRhdGVkX2F0IjoiMjAyNi0wOC0yMFQxMDowMDowMFoifQ",
    "has_more": False,
    "snapshot_version": 2,
}


def _client() -> MemWal:
    return MemWal.create(key=_KEY_HEX, account_id="0x1", server_url=_SERVER)


def _stub_relayer(
    namespaces_body: dict = _ONE_PAGE,
    stats_body: dict | None = None,
) -> tuple[respx.Route, respx.Route]:
    """Stub the three calls a list_namespaces() round-trip makes: the
    compatibility preflight, the owner resolution, and the read itself.

    Anything else (``/config``, Sui GraphQL for a SEAL session) is unmocked,
    so respx fails the test if the client reaches for it.
    """
    respx.get(f"{_SERVER}/version").mock(
        return_value=httpx.Response(
            200,
            json={
                "apiVersion": "1.0.0",
                "relayerVersion": "1.0.0",
                "minSupportedSdk": {"typescript": "0.0.4", "python": "0.1.0", "mcp": "0.0.1"},
            },
        )
    )
    stats = respx.post(f"{_SERVER}/api/stats").mock(
        return_value=httpx.Response(
            200,
            json=stats_body if stats_body is not None else _STATS,
        )
    )
    namespaces = respx.get(_NAMESPACES_URL).mock(
        return_value=httpx.Response(200, json=namespaces_body)
    )
    return stats, namespaces


class TestListNamespaces:
    @respx.mock
    async def test_reads_the_owner_scoped_namespaces_path(self) -> None:
        _, namespaces = _stub_relayer()

        await _client().list_namespaces()

        assert namespaces.call_count == 1
        request = namespaces.calls[0].request
        assert request.method == "GET"
        assert request.url.path == f"/v1/owners/{_OWNER}/namespaces"

    @respx.mock
    async def test_resolves_the_owner_once_and_reuses_it(self) -> None:
        stats, namespaces = _stub_relayer()
        memwal = _client()

        await memwal.list_namespaces()
        await memwal.list_namespaces()

        assert stats.call_count == 1, "owner resolution must be memoised across calls"
        assert namespaces.call_count == 2

    @respx.mock
    async def test_concurrent_first_calls_share_one_owner_lookup(self) -> None:
        stats, namespaces = _stub_relayer()
        owner_response = stats.return_value

        async def slow_stats(request: httpx.Request) -> httpx.Response:
            # respx otherwise answers without yielding, so the two calls
            # would run back to back instead of overlapping.
            await asyncio.sleep(0.01)
            return owner_response

        stats.side_effect = slow_stats
        memwal = _client()

        await asyncio.gather(memwal.list_namespaces(), memwal.list_namespaces())

        assert stats.call_count == 1
        assert namespaces.call_count == 2

    @respx.mock
    async def test_forwards_cursor_as_updated_after_and_passes_limit(self) -> None:
        _, namespaces = _stub_relayer()

        await _client().list_namespaces(cursor="opaque-cursor_1", limit=25)

        params = parse_qs(namespaces.calls[0].request.url.query.decode())
        assert params == {"updated_after": ["opaque-cursor_1"], "limit": ["25"]}

    @respx.mock
    async def test_omits_query_params_that_were_not_supplied(self) -> None:
        _, namespaces = _stub_relayer()

        await _client().list_namespaces()

        assert namespaces.calls[0].request.url.query == b""

    @respx.mock
    async def test_signature_covers_the_query_string(self) -> None:
        # The relayer verifies against `path_and_query`, not `path`.
        _, namespaces = _stub_relayer()

        await _client().list_namespaces(cursor="abc", limit=5)

        request = namespaces.calls[0].request
        assert request.content == b""
        headers = request.headers
        message = build_signature_message(
            timestamp=headers["x-timestamp"],
            method="GET",
            path=f"/v1/owners/{_OWNER}/namespaces?updated_after=abc&limit=5",
            body_sha256=sha256_hex(""),
            nonce=headers["x-nonce"],
            account_id=headers["x-account-id"],
        )
        verify_key = nacl.signing.VerifyKey(bytes.fromhex(headers["x-public-key"]))
        verify_key.verify(message.encode("utf-8"), bytes.fromhex(headers["x-signature"]))

    @respx.mock
    async def test_returns_the_relayer_wire_shape(self) -> None:
        _stub_relayer()

        result = await _client().list_namespaces()

        assert result == NamespacesResult(
            namespaces=[
                NamespaceSummary(
                    id="ns-1",
                    name="work",
                    memory_count=12,
                    storage_used=2048,
                    updated_at="2026-08-20T10:00:00Z",
                )
            ],
            next_cursor=_ONE_PAGE["next_cursor"],
            has_more=False,
            snapshot_version=2,
        )

    @respx.mock
    async def test_sends_no_seal_session_on_a_metadata_only_read(self) -> None:
        stats, namespaces = _stub_relayer()

        await _client().list_namespaces()

        for route in (stats, namespaces):
            assert "x-seal-session" not in route.calls[0].request.headers

    @respx.mock
    async def test_raises_when_stats_returns_no_owner(self) -> None:
        _stub_relayer(stats_body={"memory_count": 0, "storage_bytes": 0, "namespace": "default"})

        with pytest.raises(MemWalError, match="owner"):
            await _client().list_namespaces()

    @respx.mock
    async def test_a_failed_owner_lookup_is_retried_on_the_next_call(self) -> None:
        stats, namespaces = _stub_relayer()
        stats.side_effect = [
            httpx.Response(503, text="busy"),
            httpx.Response(200, json=_STATS),
        ]
        memwal = _client()

        with pytest.raises(MemWalError):
            await memwal.list_namespaces()
        await memwal.list_namespaces()

        assert stats.call_count == 2
        assert namespaces.call_count == 1

    @respx.mock
    def test_sync_wrapper(self) -> None:
        _stub_relayer()
        client = MemWalSync.create(key=_KEY_HEX, account_id="0x1", server_url=_SERVER)

        result = client.list_namespaces(limit=10)

        assert [ns.name for ns in result.namespaces] == ["work"]
