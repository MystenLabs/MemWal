---
title: "Manual Methods"
description: >-
  Lower-level remember_manual, recall_manual, and embed methods for callers that manage
  their own vectors or already have SEAL-encrypted payloads in the Python SDK.
keywords:
  - Walrus Memory
  - MemWal
  - Python SDK
  - manual methods
  - embed
  - remember_manual
  - recall_manual
goal:
  description: Call the manual Python SDK methods to register SEAL-encrypted bytes with a pre-computed embedding vector, search with a pre-computed vector, and compute embeddings independently from storage.
  requires:
    - has_frontmatter:
        - title
        - description
        - keywords
      label: Has required frontmatter fields
    - min_words: 200
      label: Needs more content depth
    - has_questions: true
      label: Needs questions for AI search visibility
    - has_answer: true
      label: Needs answer summary for AI citation
questions:
  - How do I use remember_manual and recall_manual in the MemWal Python SDK?
  - How do I compute an embedding without storing a memory in MemWal?
  - When should I use manual methods vs standard remember/recall in MemWal?
answer: >-
  The Python SDK provides lower-level manual methods on the same MemWal/MemWalSync client:
  `embed` computes a vector without storing anything, `remember_manual` sends
  base64 SEAL-encrypted bytes plus a pre-computed vector (the relayer uploads to
  Walrus), and `recall_manual` searches with a pre-computed query vector returning
  raw blob IDs and distances.
---

<Note>
Unlike the TypeScript SDK there is **no separate `MemWalManual` class** in Python. The Python SDK is relayer-backed for the standard `remember` / `recall` flow. The "manual" methods are lower-level entry points on the same `MemWal` / `MemWalSync` client for callers that already have a vector and SEAL-encrypted bytes.
</Note>

Use these when you want to control indexing or do your own vector math. For the standard flow, prefer [`remember` / `recall`](/python-sdk/usage/memwal).

## `embed`

Compute the embedding vector for text without storing anything.

```python
from memwal import MemWal

memwal = MemWal.create(key="...", account_id="0x...", env="prod")

vec = await memwal.embed("User prefers dark mode.")
print(len(vec.vector))
```

## `remember_manual`

Send base64 SEAL-encrypted bytes plus a pre-computed vector. The relayer uploads the ciphertext to Walrus and stores the `{blob_id, vector, owner, namespace}` mapping.

```python
from memwal import RememberManualOptions

result = await memwal.remember_manual(
    RememberManualOptions(
        encrypted_data="<base64-seal-ciphertext>",
        vector=vec.vector,
        namespace="chatbot-prod",   # optional; falls back to client default
    )
)
print(result.id, result.blob_id, result.owner, result.namespace)
```

## `recall_manual`

Search with a pre-computed query vector. Returns `{blob_id, distance}` hits only — no decrypted text (you fetch/decrypt the blobs yourself).

```python
from memwal import RecallManualOptions

q = await memwal.embed("What do we know about this user?")
hits = await memwal.recall_manual(
    RecallManualOptions(vector=q.vector, limit=5, namespace="chatbot-prod")
)
for hit in hits.results:
    print(hit.blob_id, hit.distance)
```

## When to use which

| You have… | Use |
| --- | --- |
| Plain text, want it stored | `remember` / `remember_and_wait` |
| Plain text, want only the vector | `embed` |
| A vector + SEAL-encrypted bytes | `remember_manual` |
| A query vector, want raw hits | `recall_manual` |
| Plain query text, want decrypted matches | `recall` |

All four manual entry points exist on both `MemWal` (async) and `MemWalSync` (sync) with identical signatures.
