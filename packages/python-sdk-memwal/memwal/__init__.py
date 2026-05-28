"""
Walrus Memory — Privacy-first AI memory SDK

Ed25519 delegate key auth + server-side TEE processing.

Quick start::

    from memwal import MemWal

    memwal = MemWal.create(
        key="your-ed25519-private-key-hex",
        account_id="0x-your-account-id",
    )

    # Async
    result = await memwal.remember("I love coffee")
    matches = await memwal.recall(RecallParams(query="beverage preferences"))

    # Sync wrapper
    from memwal import MemWalSync
    client = MemWalSync.create(key="...", account_id="0x...")
    result = client.remember("I love coffee")
"""

from .client import (
    MemWal,
    MemWalCompatibilityError,
    MemWalError,
    MemWalRememberJobFailed,
    MemWalRememberJobNotFound,
    MemWalRememberJobTimeout,
    MemWalSync,
)
from .middleware import with_memwal_langchain, with_memwal_openai
from .types import (
    ENV_PRESETS,
    AnalyzedFact,
    AnalyzeResult,
    AnalyzeWaitResult,
    AskMemory,
    AskResult,
    EmbedResult,
    HealthResult,
    MemWalConfig,
    RecallManualHit,
    RecallManualOptions,
    RecallManualResult,
    RecallMemory,
    RecallParams,
    RecallResult,
    RememberAcceptedResult,
    RememberBulkAcceptedResult,
    RememberBulkItem,
    RememberBulkItemResult,
    RememberBulkOptions,
    RememberBulkResult,
    RememberBulkStatusItem,
    RememberBulkStatusResult,
    RememberJobStatus,
    RememberManualOptions,
    RememberManualResult,
    RememberResult,
    RestoreResult,
    ScoringWeights,
)
from .utils import delegate_key_to_public_key, delegate_key_to_sui_address

# JS-style alias for developers coming from the TypeScript SDK
withMemWal = with_memwal_langchain

__all__ = [
    # Core client
    "MemWal",
    "MemWalSync",
    "MemWalError",
    "MemWalCompatibilityError",
    "MemWalRememberJobFailed",
    "MemWalRememberJobNotFound",
    "MemWalRememberJobTimeout",
    # Delegate key utilities
    "delegate_key_to_sui_address",
    "delegate_key_to_public_key",
    # Middleware
    "with_memwal_langchain",
    "with_memwal_openai",
    "withMemWal",
    # Types
    "MemWalConfig",
    "ENV_PRESETS",
    "AskMemory",
    "AskResult",
    "RememberResult",
    "RememberAcceptedResult",
    "RememberJobStatus",
    "RememberBulkItem",
    "RememberBulkOptions",
    "RememberBulkAcceptedResult",
    "RememberBulkStatusItem",
    "RememberBulkStatusResult",
    "RememberBulkItemResult",
    "RememberBulkResult",
    "RecallParams",
    "RecallResult",
    "RecallMemory",
    "EmbedResult",
    "AnalyzeResult",
    "AnalyzeWaitResult",
    "AnalyzedFact",
    "HealthResult",
    "RestoreResult",
    "ScoringWeights",
    "RememberManualOptions",
    "RememberManualResult",
    "RecallManualOptions",
    "RecallManualHit",
    "RecallManualResult",
]

__version__ = "0.1.3"
