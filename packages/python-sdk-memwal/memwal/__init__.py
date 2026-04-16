"""
memwal — Privacy-first AI memory SDK

Ed25519 delegate key auth + server-side TEE processing.

Quick start::

    from memwal import MemWal

    memwal = MemWal.create(
        key="your-ed25519-private-key-hex",
        account_id="0x-your-account-id",
    )

    # Async
    result = await memwal.remember("I love coffee")
    matches = await memwal.recall("beverage preferences")

    # Sync wrapper
    from memwal import MemWalSync
    client = MemWalSync.create(key="...", account_id="0x...")
    result = client.remember("I love coffee")
"""

from .client import MemWal, MemWalError, MemWalSync
from .middleware import with_memwal_langchain, with_memwal_openai
from .utils import delegate_key_to_sui_address, delegate_key_to_public_key
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

# JS-style alias for developers coming from the TypeScript SDK
withMemWal = with_memwal_langchain

__all__ = [
    # Core client
    "MemWal",
    "MemWalSync",
    "MemWalError",
    # Delegate key utilities
    "delegate_key_to_sui_address",
    "delegate_key_to_public_key",
    # Middleware
    "with_memwal_langchain",
    "with_memwal_openai",
    "withMemWal",
    # Types
    "MemWalConfig",
    "AskMemory",
    "AskResult",
    "RememberResult",
    "RecallResult",
    "RecallMemory",
    "AnalyzeResult",
    "AnalyzedFact",
    "HealthResult",
    "RestoreResult",
    "RememberManualOptions",
    "RememberManualResult",
    "RecallManualOptions",
    "RecallManualHit",
    "RecallManualResult",
]

__version__ = "0.1.0"
