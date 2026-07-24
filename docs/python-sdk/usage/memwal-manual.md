---
title: "Manual Methods"
description: >-
  Lower-level remember_manual, recall_manual, and embed methods for callers that manage
  their own vectors or have pre-uploaded Walrus blobs in the Python SDK.
keywords:
  - Walrus Memory
  - MemWal
  - Python SDK
  - manual methods
  - embed
  - remember_manual
  - recall_manual
goal:
  description: Use the lower-level manual methods to register pre-uploaded blobs, search with pre-computed vectors, and compute embeddings without storage.
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
  - How do I use remember_manual and recall_manual in the MemWal Python SDK?
  - How do I compute an embedding without storing a memory in MemWal?
  - When should I use manual methods vs standard remember/recall in MemWal?
answer: >-
  The Python SDK provides lower-level manual methods on the same MemWal/MemWalSync client:
  `embed` computes a vector without storing anything, `remember_manual` registers a
  pre-uploaded blob with a pre-computed vector, and `recall_manual` searches with a
  pre-computed query vector returning raw blob IDs and distances.
---

<Note>
Unlike the TypeScript SDK there is **no separate `MemWalManual` class** in Python. The Python SDK is relayer-backed: the relayer always handles embedding, SEAL encryption, and Walrus storage. The "manual" methods are lower-level entry points on the same `MemWal` / `MemWalSync` client for callers that already have a vector or a pre-uploaded blob.
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

Register a pre-uploaded Walrus blob with a pre-computed vector. The relayer stores the `{blob_id, vector, owner, namespace}` mapping; it does not upload for you here.

```python
from memwal import RememberManualOptions

result = await memwal.remember_manual(
    RememberManualOptions(
        blob_id="<walrus-blob-id>",
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
| A vector + an already-uploaded blob | `remember_manual` |
| A query vector, want raw hits | `recall_manual` |
| Plain query text, want decrypted matches | `recall` |

All four manual entry points exist on both `MemWal` (async) and `MemWalSync` (sync) with identical signatures.
