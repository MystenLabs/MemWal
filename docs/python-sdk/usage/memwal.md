---
title: "Walrus Memory"
description: >-
  The recommended default Python client for Walrus Memory. The relayer handles embeddings,
  SEAL encryption, and Walrus storage while the SDK signs requests and sends text.
keywords:
  - Walrus Memory
  - MemWal
  - Python SDK
  - remember
  - recall
  - analyze
  - ask
  - restore
goal:
  description: Use the default MemWal client to store, recall, analyze, and ask questions against your agent's memory.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 300
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I use the MemWal Python client to store and recall memories?
  - What core methods does the MemWal Python client provide?
  - How do I restore missing indexed entries from Walrus in Python?
answer: >-
  The MemWal Python client is the recommended default that delegates embeddings, SEAL
  encryption, and Walrus storage to the relayer. Core methods include `remember`,
  `recall`, `analyze`, `ask`, and `restore`. Each method accepts an optional namespace
  override and works with both async MemWal and sync MemWalSync.
---

The recommended default client. The relayer handles embeddings, SEAL encryption, Walrus upload, and vector indexing. The SDK only signs requests and sends text.

## How It Works

1. The SDK signs each request with your delegate key (Ed25519 via PyNaCl)
2. The relayer verifies delegate access
3. `remember` returns an accepted job while the relayer encrypts, uploads, and indexes in the background
4. `recall` searches by namespace and returns decrypted matches

```python
from memwal import MemWal, RecallParams

memwal = MemWal.create(
    key="<your-ed25519-private-key>",
    account_id="<your-memwal-account-id>",
    env="prod",            # or server_url="https://your-relayer-url.com"
    namespace="chatbot-prod",
)
```

`MemWalSync.create(...)` takes the same arguments for synchronous code.

## Core Methods

```python
# Store a memory (async-accept; poll to completion)
done = await memwal.remember_and_wait("User prefers dark mode and works in Python.")
print(done.blob_id)

# Recall relevant memories
result = await memwal.recall(RecallParams(query="What do we know about this user?", limit=5))
for memory in result.results:
    print(memory.text, memory.distance)

# Extract and store facts from longer text
analyzed = await memwal.analyze(
    "I live in Hanoi, prefer dark mode, and usually work late at night."
)
print(analyzed.job_ids)

# Ask a question answered using your memories
answer = await memwal.ask("Where does this user live?")
print(answer.answer, answer.memories_used)

# Check relayer health (no auth)
await memwal.health()
```

Every memory method accepts an optional `namespace=` override that wins over the client default for that call.

## Restore

Rebuild missing indexed entries for one namespace from Walrus. Incremental and namespace-scoped — meant to repair PostgreSQL vector state from Walrus-backed memory.

```python
result = await memwal.restore("chatbot-prod", limit=10)
print(result.restored, result.skipped, result.total)
```

## Lower-Level Methods

Use these when you already have a vector or a pre-uploaded blob — see [Manual methods](/python-sdk/usage/memwal-manual):

- `remember_manual(RememberManualOptions(blob_id=..., vector=..., namespace=...))`
- `recall_manual(RecallManualOptions(vector=..., limit=..., namespace=...))`
- `embed(text)` — embedding vector only, no storage
- `get_public_key_hex()` — the delegate public key

## Errors

| Exception | Raised when |
| --- | --- |
| `MemWalError` | Base class for all SDK errors (also raised on a failed `health()`) |
| `MemWalRememberJobNotFound` | A polled `job_id` is unknown or not owned by the caller |
| `MemWalRememberJobFailed` | An async remember job reached terminal `status=failed` |
| `MemWalRememberJobTimeout` | A polling loop exceeded its `timeout_ms` budget |

Transient statuses (connection drop, `429`, `5xx`) are retried inside the polling loops rather than surfaced.
