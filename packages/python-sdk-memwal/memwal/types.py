"""
memwal — Core Types

Dataclasses for all API request options and response types.
Ed25519 delegate key based SDK that communicates with
the MemWal Rust server (TEE).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

# ============================================================
# Config
# ============================================================


@dataclass
class MemWalConfig:
    """Configuration for creating a MemWal client.

    Attributes:
        key: Ed25519 private key (hex string). This is the delegate key from app.memwal.com.
        account_id: MemWalAccount object ID on Sui.
        server_url: Server URL (default: https://relayer.memwal.ai).
        namespace: Default namespace for memory isolation (default: "default").
    """

    key: str
    account_id: str
    server_url: str = "https://relayer.memwal.ai"
    namespace: str = "default"


# ============================================================
# API Response Types
# ============================================================


@dataclass
class RememberResult:
    """Result from remember()."""

    id: str
    blob_id: str
    owner: str
    namespace: str


@dataclass
class RecallMemory:
    """A single recalled memory."""

    blob_id: str
    text: str
    distance: float


@dataclass
class RecallResult:
    """Result from recall()."""

    results: List[RecallMemory]
    total: int


@dataclass
class AnalyzedFact:
    """A single extracted fact."""

    text: str
    id: str
    blob_id: str


@dataclass
class AnalyzeResult:
    """Result from analyze().

    Per PR #121: each extracted fact is enqueued as a background remember
    job. ``job_ids`` aligns with ``facts`` positionally; poll those
    job_ids (e.g. via :meth:`MemWal.wait_for_remember_jobs`) to know when
    the corresponding memory is fully persisted on Walrus.
    """

    facts: List[AnalyzedFact]
    fact_count: int
    job_ids: List[str]
    status: str
    owner: str

    @property
    def total(self) -> int:
        """Backward-compat alias for ``fact_count`` (v0.1 callers)."""
        return self.fact_count


@dataclass
class HealthResult:
    """Server health response."""

    status: str
    version: str


@dataclass
class RestoreResult:
    """Result from restore()."""

    restored: int
    skipped: int
    total: int
    namespace: str
    owner: str


@dataclass
class AskMemory:
    """A memory used to answer a question."""

    blob_id: str
    text: str
    distance: float


@dataclass
class AskResult:
    """Result from ask()."""

    answer: str
    memories_used: int
    memories: List[AskMemory]


# ============================================================
# Manual Flow Types
# ============================================================


@dataclass
class RememberManualOptions:
    """Options for remember_manual().

    Attributes:
        blob_id: Walrus blob ID (user already uploaded encrypted data).
        vector: Embedding vector (user already generated).
        namespace: Namespace (default: config namespace or "default").
    """

    blob_id: str
    vector: List[float]
    namespace: Optional[str] = None


@dataclass
class RememberManualResult:
    """Result from remember_manual()."""

    id: str
    blob_id: str
    owner: str
    namespace: str


@dataclass
class RecallManualOptions:
    """Options for recall_manual().

    Attributes:
        vector: Pre-computed query embedding vector.
        limit: Max number of results (default: 10).
        namespace: Namespace (default: config namespace or "default").
    """

    vector: List[float]
    limit: int = 10
    namespace: Optional[str] = None


@dataclass
class RecallManualHit:
    """A single search hit -- raw blob_id + distance (no decrypted text)."""

    blob_id: str
    distance: float


@dataclass
class RecallManualResult:
    """Result from recall_manual()."""

    results: List[RecallManualHit]
    total: int


# ============================================================
# Async remember (PR #121: ENG-1406 / ENG-1408)
# ============================================================


@dataclass
class RememberAcceptedResult:
    """Result from remember() / remember_async() — server returns 202 immediately.

    The actual upload + on-chain commit happen in a background worker.
    Poll ``GET /api/remember/{job_id}`` (via wait_for_remember_job) to follow
    progress until status reaches "done" or "failed".
    """

    job_id: str
    status: str


@dataclass
class RememberJobStatus:
    """One snapshot of an async remember job, returned by the status endpoint.

    ``status`` transitions: pending → running → uploaded → done, or → failed.
    ``not_found`` is returned when the job_id is unknown or not the caller's.
    """

    job_id: str
    status: str
    owner: Optional[str] = None
    namespace: Optional[str] = None
    blob_id: Optional[str] = None
    error: Optional[str] = None


# ============================================================
# Bulk remember (ENG-1408)
# ============================================================


@dataclass
class RememberBulkItem:
    """One item in a bulk remember request.

    ``namespace`` overrides the client default for this item only.
    """

    text: str
    namespace: Optional[str] = None


@dataclass
class RememberBulkAcceptedResult:
    """Result from remember_bulk() / remember_bulk_async() — 202 with job_ids.

    ``job_ids`` aligns positionally with the input ``items`` list.
    """

    job_ids: List[str]
    total: int
    status: str


@dataclass
class RememberBulkStatusItem:
    """Per-item status returned by the bulk status endpoint."""

    job_id: str
    status: str
    blob_id: Optional[str] = None
    error: Optional[str] = None


@dataclass
class RememberBulkStatusResult:
    """Result from get_remember_bulk_status()."""

    results: List[RememberBulkStatusItem]


@dataclass
class RememberBulkOptions:
    """Polling options for remember_bulk_and_wait() / wait_for_remember_jobs().

    ``poll_interval_ms`` is the base poll cadence (default 1500ms).
    ``timeout_ms`` is the total wait budget before raising TimeoutError
    (default 120_000ms).
    """

    poll_interval_ms: int = 1500
    timeout_ms: int = 120_000


@dataclass
class RememberBulkItemResult:
    """One settled item in a bulk-and-wait result."""

    id: str
    blob_id: str
    status: str  # "done" | "failed" | "timeout"
    error: Optional[str] = None


@dataclass
class RememberBulkResult:
    """Aggregate result from remember_bulk_and_wait() / wait_for_remember_jobs().

    ``succeeded + failed + timed_out == total``. ``results`` preserves input order.
    """

    results: List[RememberBulkItemResult]
    total: int
    succeeded: int
    failed: int
    timed_out: int


# ============================================================
# Embed + analyze
# ============================================================


@dataclass
class EmbedResult:
    """Result from embed() — raw embedding vector for a piece of text."""

    vector: List[float]


@dataclass
class AnalyzeWaitResult:
    """Result from analyze_and_wait().

    Combines the analyze fact-extraction output with the bulk-style settled
    results for each enqueued background remember job. Mirrors the TS SDK's
    ``AnalyzeWaitResult extends RememberBulkResult``.
    """

    results: List[RememberBulkItemResult]
    total: int
    succeeded: int
    failed: int
    timed_out: int
    facts: List[AnalyzedFact]
    owner: str
