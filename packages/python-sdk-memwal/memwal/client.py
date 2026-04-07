"""
memwal — SDK Client

Ed25519 delegate key based client that communicates with the MemWal
Rust server (TEE). All data processing (encryption, embedding, Walrus)
happens server-side -- the SDK just signs requests and sends text.

The SDK only needs a single Ed25519 private key (the "delegate key").
The server derives the owner address from the public key via onchain
lookup in MemWalAccount.delegate_keys.

Example::

    from memwal import MemWal

    memwal = MemWal.create(
        key="abcdef...",
        account_id="0x...",
    )

    # Async usage
    result = await memwal.remember("I'm allergic to peanuts")
    matches = await memwal.recall("food allergies")
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional, TypeVar

import httpx

from .types import (
    AnalyzedFact,
    AnalyzeResult,
    AskMemory,
    AskResult,
    HealthResult,
    MemWalConfig,
    RecallManualHit,
    RecallManualOptions,
    RecallManualResult,
    RecallMemory,
    RecallResult,
    RememberManualOptions,
    RememberManualResult,
    RememberResult,
    RestoreResult,
)
from .utils import (
    build_signature_message,
    build_signing_key,
    bytes_to_hex,
    sha256_hex,
    sign_message,
)

T = TypeVar("T")


class MemWal:
    """Async-native MemWal client.

    All API methods are ``async``. For synchronous usage, wrap calls with
    ``asyncio.run()`` or use the :class:`MemWalSync` convenience wrapper.
    """

    def __init__(self, config: MemWalConfig) -> None:
        self._signing_key = build_signing_key(config.key)
        self._private_key_hex = config.key if not config.key.startswith("0x") else config.key[2:]
        self._account_id = config.account_id
        self._server_url = config.server_url.rstrip("/")
        self._namespace = config.namespace
        self._client: Optional[httpx.AsyncClient] = None

    @classmethod
    def create(
        cls,
        key: str,
        account_id: str,
        server_url: str = "http://localhost:8000",
        namespace: str = "default",
    ) -> "MemWal":
        """Create a new MemWal client instance.

        Args:
            key: Ed25519 private key hex string (the delegate key).
            account_id: MemWalAccount object ID on Sui.
            server_url: Server URL (default: ``http://localhost:8000``).
            namespace: Default namespace for memory isolation (default: ``"default"``).

        Returns:
            A configured :class:`MemWal` instance.
        """
        config = MemWalConfig(
            key=key,
            account_id=account_id,
            server_url=server_url,
            namespace=namespace,
        )
        return cls(config)

    @property
    def _http(self) -> httpx.AsyncClient:
        """Lazily create the async HTTP client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "MemWal":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ============================================================
    # Core API
    # ============================================================

    async def remember(self, text: str, namespace: Optional[str] = None) -> RememberResult:
        """Remember something.

        Server handles: verify -> embed -> encrypt -> Walrus upload -> store.

        Args:
            text: The text to remember.
            namespace: Override the default namespace.

        Returns:
            :class:`RememberResult` with id, blob_id, owner, namespace.
        """
        data = await self._signed_request("POST", "/api/remember", {
            "text": text,
            "namespace": namespace or self._namespace,
        })
        return RememberResult(
            id=data["id"],
            blob_id=data["blob_id"],
            owner=data["owner"],
            namespace=data["namespace"],
        )

    async def recall(
        self,
        query: str,
        limit: int = 10,
        namespace: Optional[str] = None,
    ) -> RecallResult:
        """Recall memories similar to a query.

        Server handles: verify -> embed query -> search -> Walrus download -> decrypt.

        Args:
            query: Search query.
            limit: Max number of results (default: 10).
            namespace: Override the default namespace.

        Returns:
            :class:`RecallResult` with decrypted text results.
        """
        data = await self._signed_request("POST", "/api/recall", {
            "query": query,
            "limit": limit,
            "namespace": namespace or self._namespace,
        })
        memories = [
            RecallMemory(
                blob_id=m["blob_id"],
                text=m["text"],
                distance=m["distance"],
            )
            for m in data.get("results", [])
        ]
        return RecallResult(results=memories, total=data.get("total", len(memories)))

    async def analyze(self, text: str, namespace: Optional[str] = None) -> AnalyzeResult:
        """Analyze conversation text.

        Server uses LLM to extract facts, then stores each one
        (embed -> encrypt -> Walrus -> store).

        Args:
            text: Conversation text to analyze.
            namespace: Override the default namespace.

        Returns:
            :class:`AnalyzeResult` with extracted and stored facts.
        """
        data = await self._signed_request("POST", "/api/analyze", {
            "text": text,
            "namespace": namespace or self._namespace,
        })
        facts = [
            AnalyzedFact(text=f["text"], id=f["id"], blob_id=f["blob_id"])
            for f in data.get("facts", [])
        ]
        return AnalyzeResult(
            facts=facts,
            total=data.get("total", len(facts)),
            owner=data.get("owner", ""),
        )

    async def ask(
        self,
        question: str,
        limit: int = 5,
        namespace: Optional[str] = None,
    ) -> AskResult:
        """Ask a question answered using your memories.

        Server recalls relevant memories, injects them as context,
        and calls an LLM to produce a personalized answer.

        Args:
            question: The question to ask.
            limit: Max memories to use as context (default: 5).
            namespace: Override the default namespace.

        Returns:
            :class:`AskResult` with answer, memories_used count, and memories list.
        """
        data = await self._signed_request("POST", "/api/ask", {
            "question": question,
            "limit": limit,
            "namespace": namespace or self._namespace,
        })
        memories = [
            AskMemory(blob_id=m["blob_id"], text=m["text"], distance=m["distance"])
            for m in data.get("memories", [])
        ]
        return AskResult(
            answer=data["answer"],
            memories_used=data["memories_used"],
            memories=memories,
        )

    async def restore(self, namespace: str, limit: int = 50) -> RestoreResult:
        """Restore a namespace.

        Server downloads all blobs from Walrus, decrypts with delegate key,
        re-embeds, and re-indexes.

        Args:
            namespace: Namespace to restore.
            limit: Max entries to restore (default: 50).

        Returns:
            :class:`RestoreResult` with count of restored entries.
        """
        data = await self._signed_request("POST", "/api/restore", {
            "namespace": namespace,
            "limit": limit,
        })
        return RestoreResult(
            restored=data["restored"],
            skipped=data["skipped"],
            total=data["total"],
            namespace=data["namespace"],
            owner=data["owner"],
        )

    async def health(self) -> HealthResult:
        """Check server health. No authentication required.

        Returns:
            :class:`HealthResult` with status and version.
        """
        response = await self._http.get(f"{self._server_url}/health")
        if response.status_code != 200:
            raise MemWalError(f"Health check failed: {response.status_code}")
        data = response.json()
        return HealthResult(status=data["status"], version=data["version"])

    # ============================================================
    # Manual API (user handles SEAL + embedding + Walrus)
    # ============================================================

    async def remember_manual(self, opts: RememberManualOptions) -> RememberManualResult:
        """Remember (manual mode).

        User handles SEAL encrypt, embedding, and Walrus upload externally.
        Server only stores the vector <-> blobId mapping.

        Args:
            opts: :class:`RememberManualOptions` with blob_id, vector, and optional namespace.

        Returns:
            :class:`RememberManualResult` with id, blob_id, owner, namespace.
        """
        data = await self._signed_request("POST", "/api/remember/manual", {
            "blob_id": opts.blob_id,
            "vector": opts.vector,
            "namespace": opts.namespace or self._namespace,
        })
        return RememberManualResult(
            id=data["id"],
            blob_id=data["blob_id"],
            owner=data["owner"],
            namespace=data["namespace"],
        )

    async def recall_manual(self, opts: RecallManualOptions) -> RecallManualResult:
        """Recall (manual mode).

        User provides a pre-computed query vector. Server returns matching
        blobIds + distances. User then downloads from Walrus + SEAL decrypts.

        Args:
            opts: :class:`RecallManualOptions` with vector, optional limit and namespace.

        Returns:
            :class:`RecallManualResult` with blob_id + distance pairs.
        """
        data = await self._signed_request("POST", "/api/recall/manual", {
            "vector": opts.vector,
            "limit": opts.limit,
            "namespace": opts.namespace or self._namespace,
        })
        hits = [
            RecallManualHit(blob_id=h["blob_id"], distance=h["distance"])
            for h in data.get("results", [])
        ]
        return RecallManualResult(results=hits, total=data.get("total", len(hits)))

    async def get_public_key_hex(self) -> str:
        """Get the Ed25519 public key as a hex string.

        Returns:
            Public key hex string.
        """
        return bytes_to_hex(bytes(self._signing_key.verify_key))

    # ============================================================
    # Internal: Signed HTTP Requests
    # ============================================================

    async def _signed_request(
        self,
        method: str,
        path: str,
        body: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Make a signed request to the server.

        Signature format: ``{timestamp}.{method}.{path}.{body_sha256}``

        Headers sent:
            - ``x-public-key``: Ed25519 public key hex
            - ``x-signature``: Ed25519 signature hex
            - ``x-timestamp``: Unix seconds string
            - ``x-delegate-key``: Private key hex
            - ``x-account-id``: MemWalAccount object ID
            - ``Content-Type``: application/json
        """
        timestamp = str(int(time.time()))
        body_str = json.dumps(body, separators=(",", ":"))
        body_hash = sha256_hex(body_str)

        message = build_signature_message(timestamp, method.upper(), path, body_hash)
        signature_hex, public_key_hex = sign_message(message, self._signing_key)

        url = f"{self._server_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "x-public-key": public_key_hex,
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
            "x-delegate-key": self._private_key_hex,
            "x-account-id": self._account_id,
        }

        response = await self._http.request(
            method=method.upper(),
            url=url,
            headers=headers,
            content=body_str,
        )

        if response.status_code != 200:
            err_text = response.text
            raise MemWalError(
                f"MemWal API error ({response.status_code}): {err_text}"
            )

        return response.json()


class MemWalError(Exception):
    """Exception raised for MemWal API errors."""

    pass


class MemWalSync:
    """Synchronous wrapper around the async :class:`MemWal` client.

    Provides the same API surface but runs everything through ``asyncio.run()``.
    Useful for scripts, notebooks, and non-async applications.

    Example::

        from memwal import MemWalSync

        client = MemWalSync.create(key="...", account_id="0x...")
        result = client.remember("I love coffee")
        matches = client.recall("coffee preferences")
    """

    def __init__(self, inner: MemWal) -> None:
        self._inner = inner

    @classmethod
    def create(
        cls,
        key: str,
        account_id: str,
        server_url: str = "http://localhost:8000",
        namespace: str = "default",
    ) -> "MemWalSync":
        """Create a synchronous MemWal client.

        Same parameters as :meth:`MemWal.create`.
        """
        inner = MemWal.create(
            key=key,
            account_id=account_id,
            server_url=server_url,
            namespace=namespace,
        )
        return cls(inner)

    def _run(self, coro: Any) -> Any:
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop is not None and loop.is_running():
            # Already inside an event loop (e.g. Jupyter).
            # Create a new loop in a thread.
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, coro).result()
        else:
            # Reset the httpx client before each asyncio.run() so it is
            # recreated fresh inside the new event loop.  Without this,
            # reusing a MemWalSync instance across multiple calls raises
            # "RuntimeError: Event loop is closed" because the client's
            # transport is still bound to the previous (now-closed) loop.
            self._inner._client = None
            return asyncio.run(coro)

    def remember(self, text: str, namespace: Optional[str] = None) -> RememberResult:
        """Synchronous version of :meth:`MemWal.remember`."""
        return self._run(self._inner.remember(text, namespace))

    def recall(
        self, query: str, limit: int = 10, namespace: Optional[str] = None
    ) -> RecallResult:
        """Synchronous version of :meth:`MemWal.recall`."""
        return self._run(self._inner.recall(query, limit, namespace))

    def analyze(self, text: str, namespace: Optional[str] = None) -> AnalyzeResult:
        """Synchronous version of :meth:`MemWal.analyze`."""
        return self._run(self._inner.analyze(text, namespace))

    def ask(self, question: str, limit: int = 5, namespace: Optional[str] = None) -> AskResult:
        """Synchronous version of :meth:`MemWal.ask`."""
        return self._run(self._inner.ask(question, limit, namespace))

    def restore(self, namespace: str, limit: int = 50) -> RestoreResult:
        """Synchronous version of :meth:`MemWal.restore`."""
        return self._run(self._inner.restore(namespace, limit))

    def health(self) -> HealthResult:
        """Synchronous version of :meth:`MemWal.health`."""
        return self._run(self._inner.health())

    def remember_manual(self, opts: RememberManualOptions) -> RememberManualResult:
        """Synchronous version of :meth:`MemWal.remember_manual`."""
        return self._run(self._inner.remember_manual(opts))

    def recall_manual(self, opts: RecallManualOptions) -> RecallManualResult:
        """Synchronous version of :meth:`MemWal.recall_manual`."""
        return self._run(self._inner.recall_manual(opts))

    def get_public_key_hex(self) -> str:
        """Synchronous version of :meth:`MemWal.get_public_key_hex`."""
        return self._run(self._inner.get_public_key_hex())

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._run(self._inner.close())

    def __enter__(self) -> "MemWalSync":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
