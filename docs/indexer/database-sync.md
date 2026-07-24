---
title: "Database Sync"
description: >-
  How the Walrus Memory indexer syncs account data into PostgreSQL with pgvector,
  including table schemas, indexes, and similarity search for recall queries.
keywords:
  - Walrus Memory
  - MemWal
  - indexer
  - PostgreSQL
  - pgvector
  - database sync
goal:
  description: Identify the PostgreSQL tables and indexes that power the indexer and relayer, explain how pgvector HNSW enables cosine similarity search, and locate relevant tables when debugging lookup failures.
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
  - "What database tables does the Walrus Memory indexer use?"
  - "How does MemWal perform similarity search with pgvector?"
  - "How does the MemWal indexer sync onchain data to PostgreSQL?"
answer: >-
  The indexer syncs account data into PostgreSQL so the relayer can resolve ownership
  without hitting the blockchain. Key tables include vector_entries (stores embeddings
  linked to encrypted Walrus blobs), delegate_key_cache, accounts, and indexer_state.
  Recall queries use pgvector's HNSW cosine distance index for fast similarity search.
---

The indexer syncs account data into PostgreSQL so the relayer can resolve ownership quickly without hitting the blockchain on every request.

## Database

Both the relayer and the indexer connect to the same PostgreSQL instance (with the `pgvector` extension enabled). Migrations run automatically on boot.

## Tables

### `vector_entries`

The primary search table — stores vector embeddings linked to encrypted Walrus blobs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT` (PK) | UUID for this entry |
| `owner` | `TEXT` | Owner's Sui address |
| `namespace` | `TEXT` | Namespace label (default: `"default"`) |
| `blob_id` | `TEXT` | Walrus blob ID pointing to the encrypted payload |
| `embedding` | `vector(1536)` | 1536-dimensional vector embedding (pgvector) |
| `created_at` | `TIMESTAMPTZ` | Insertion timestamp |

**Indexes:**
- `idx_vector_entries_owner` — B-tree on `owner`
- `idx_vector_entries_blob_id` — B-tree on `blob_id`
- `idx_vector_entries_owner_ns` — composite B-tree on `(owner, namespace)` for scoped queries
- `idx_vector_entries_embedding` — HNSW on `embedding` using `vector_cosine_ops` for fast similarity search

### `delegate_key_cache`

Auth optimization — caches the mapping from delegate public key to account, so the relayer doesn't need to scan the onchain registry on every request.

| Column | Type | Description |
|--------|------|-------------|
| `public_key` | `TEXT` (PK) | Hex-encoded Ed25519 public key |
| `account_id` | `TEXT` | MemWalAccount object ID |
| `owner` | `TEXT` | Owner's Sui address |
| `cached_at` | `TIMESTAMPTZ` | When this mapping was cached |

The cache is populated lazily during auth. If a cached entry becomes stale (key was removed onchain), the relayer re-resolves from the chain and updates the cache.

### `accounts`

Populated by the indexer — maps owner addresses to their MemWalAccount object IDs.

| Column | Type | Description |
|--------|------|-------------|
| `account_id` | `TEXT` (PK) | MemWalAccount object ID |
| `owner` | `TEXT` (unique) | Owner's Sui address |
| `created_at` | `TIMESTAMPTZ` | When this row was indexed |

### `indexer_state`

Tracks the indexer's cursor position so it can resume from where it left off after restarts.

| Column | Type | Description |
|--------|------|-------------|
| `key` | `TEXT` (PK) | State key (e.g., `"event_cursor"`) |
| `value` | `TEXT` | JSON-serialized cursor (`txDigest` + `eventSeq`) |

## How It Helps

- **Constant-time account lookup** — the relayer checks `delegate_key_cache` and `accounts` instead of scanning the onchain registry
- **Resumable event polling** — the indexer stores its cursor in `indexer_state`, so it picks up where it left off after restarts without re-processing old events
- **Reactive cleanup** — when Walrus returns 404 for an expired blob during recall, the relayer deletes the corresponding `vector_entries` rows automatically

## Similarity Search

Recall queries use pgvector's cosine distance operator (`<=>`) against the HNSW index:

```sql
SELECT blob_id, (embedding <=> $1)::float8 AS distance
FROM vector_entries
WHERE owner = $2 AND namespace = $3
ORDER BY embedding <=> $1
LIMIT $4
```

The HNSW index provides approximate nearest neighbor search, which is fast enough for interactive recall even with large numbers of stored memories.
