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
        server_url: Server URL (default: http://localhost:8000).
        namespace: Default namespace for memory isolation (default: "default").
    """

    key: str
    account_id: str
    server_url: str = "http://localhost:8000"
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
    """Result from analyze()."""

    facts: List[AnalyzedFact]
    total: int
    owner: str


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
