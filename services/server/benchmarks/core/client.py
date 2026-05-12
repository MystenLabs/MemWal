"""
MemWal HTTP client for benchmark operations.

Handles Ed25519 request signing and provides typed methods for
the API endpoints used during benchmarking: analyze, recall, stats, cleanup.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import time
from dataclasses import dataclass

import httpx
from nacl.signing import SigningKey
from nacl.encoding import RawEncoder

from .types import RetrievedMemory, ScoringWeights

logger = logging.getLogger(__name__)


@dataclass
class AnalyzeResult:
    facts: list[dict]
    total: int


@dataclass
class RecallResult:
    memories: list[RetrievedMemory]
    total: int


class MemWalClient:
    """Synchronous HTTP client for MemWal server with Ed25519 auth."""

    def __init__(
        self,
        server_url: str,
        delegate_key_hex: str,
        account_id: str,
        timeout: float = 120.0,
    ):
        self.server_url = server_url.rstrip("/")
        self.account_id = account_id
        self.timeout = timeout

        # Derive signing key and public key from delegate private key
        seed = bytes.fromhex(delegate_key_hex)
        self._signing_key = SigningKey(seed)
        self._public_key_hex = self._signing_key.verify_key.encode().hex()

        self._http = httpx.Client(timeout=timeout)

    def close(self):
        self._http.close()

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def _sign_request(self, method: str, path: str, body_bytes: bytes) -> dict:
        """Build auth headers matching MemWal's Ed25519 verification."""
        body_hash = hashlib.sha256(body_bytes).hexdigest()
        timestamp = str(int(time.time()))
        message = f"{timestamp}.{method}.{path}.{body_hash}"

        signed = self._signing_key.sign(message.encode(), encoder=RawEncoder)

        return {
            "Content-Type": "application/json",
            "x-public-key": self._public_key_hex,
            "x-signature": signed.signature.hex(),
            "x-timestamp": timestamp,
            "x-account-id": self.account_id,
        }

    # Status codes considered transient and worth retrying.
    # 429: rate-limited — wait and retry.
    # 502/503/504: gateway/upstream issues (sidecar restart, transient
    #              network blip) — wait and retry.
    # 401 is intentionally NOT retried: it almost always means
    #     misconfigured auth (wrong account_id, expired delegate key).
    #     Retrying on 401 multiplies request load by N before failure
    #     without ever succeeding, so we fail fast instead.
    _RETRY_STATUS = (429, 502, 503, 504)

    def _post(self, path: str, body: dict, max_retries: int = 5) -> dict:
        """Signed POST request. Raises on non-2xx. Retries transient
        statuses (429/502/503/504) with jittered exponential backoff.
        Connection errors (network down, server restarting) also retry.
        """
        body_bytes = json.dumps(body, separators=(",", ":")).encode()
        url = f"{self.server_url}{path}"

        last_exc: Exception | None = None
        for attempt in range(max_retries):
            # Re-sign each attempt so timestamps stay fresh under retry backoff
            headers = self._sign_request("POST", path, body_bytes)
            try:
                resp = self._http.post(url, content=body_bytes, headers=headers)
            except (httpx.RequestError, httpx.TransportError) as e:
                last_exc = e
                if attempt < max_retries - 1:
                    delay = 0.5 * (2 ** attempt) + random.uniform(0, 0.5)
                    time.sleep(delay)
                    continue
                raise

            if resp.status_code in self._RETRY_STATUS and attempt < max_retries - 1:
                # exponential backoff with real jitter: ~0.5, 1, 2, 4 seconds
                delay = 0.5 * (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(delay)
                continue
            resp.raise_for_status()
            return resp.json()

        # should be unreachable — the loop above either returns, raises
        # via raise_for_status, or re-raises the last connection error.
        if last_exc is not None:
            raise last_exc
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # API methods
    # ------------------------------------------------------------------

    def health(self) -> dict:
        """GET /health — no auth required."""
        resp = self._http.get(f"{self.server_url}/health")
        resp.raise_for_status()
        return resp.json()

    def analyze(self, text: str, namespace: str) -> AnalyzeResult:
        """
        POST /api/analyze — feed conversation text, extract and store memories.

        This is the primary ingestion endpoint. The server:
        1. Extracts facts via LLM
        2. Embeds each fact
        3. Stores the memory (benchmark mode: plaintext in Postgres,
           synchronously — the response carries the stored ids and
           status "completed"; production: SEAL-encrypt + Walrus upload,
           via an async job).
        """
        data = self._post("/api/analyze", {
            "text": text,
            "namespace": namespace,
        })
        # Response shape varies between server versions:
        # - Synchronous (reference branch): {facts, total, owner}
        # - Async / benchmark-mode (dev + ENG-1747): {facts, fact_count,
        #   job_ids, status, owner} — "total" doesn't exist, "fact_count"
        #   is the count. In benchmark mode status == "completed" and the
        #   memories are already stored when this returns.
        facts = data.get("facts", [])
        total = data.get("total", data.get("fact_count", len(facts)))
        return AnalyzeResult(facts=facts, total=total)

    def recall(
        self,
        query: str,
        namespace: str,
        limit: int = 10,
        scoring_weights: ScoringWeights | None = None,
        memory_types: list[str] | None = None,
        min_importance: float | None = None,
    ) -> RecallResult:
        """
        POST /api/recall — retrieve memories ranked by composite scoring.

        Scoring weights are per-request parameters. The same stored memories
        can be recalled with different weight configurations without re-ingestion.
        """
        body: dict = {
            "query": query,
            "namespace": namespace,
            "limit": limit,
        }
        if scoring_weights:
            body["scoring_weights"] = scoring_weights.to_dict()
        if memory_types:
            body["memory_types"] = memory_types
        if min_importance is not None:
            body["min_importance"] = min_importance

        data = self._post("/api/recall", body)

        memories = []
        for hit in data.get("results", []):
            # Recall response shape varies between server versions:
            # - Pre-typed-memory branches return only {blob_id, text, distance}
            # - Branches with the typed-memory upgrade also include {id, score,
            #   memory_type, importance}
            # In benchmark mode the engine sets row id == blob_id (synthetic
            # UUID), so falling back to blob_id keeps recall metrics meaningful
            # on either server shape.
            memories.append(RetrievedMemory(
                memory_id=hit.get("id") or hit.get("blob_id", ""),
                text=hit.get("text", ""),
                score=hit.get("score", 1.0 - hit.get("distance", 0.0)),
                memory_type=hit.get("memory_type"),
                importance=hit.get("importance"),
            ))

        return RecallResult(memories=memories, total=data.get("total", 0))

    def stats(self, namespace: str) -> dict:
        """POST /api/stats — memory statistics for a namespace."""
        return self._post("/api/stats", {"namespace": namespace})

    def forget_namespace(self, namespace: str, limit: int = 1000) -> dict:
        """
        Soft-delete all memories in a namespace.
        Used for benchmark cleanup.
        """
        return self._post("/api/forget", {
            "query": "*",
            "namespace": namespace,
            "limit": limit,
        })
