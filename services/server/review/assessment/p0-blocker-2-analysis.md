# P0 Blocker 2: Transaction Held During Walrus Upload

> **File**: `services/server/src/routes.rs` — `store_memory_with_transaction` (line 1344)
> **Status**: Not yet fixed. Fix designed, ready for implementation.
> **Estimated effort**: 2–3 hours

---

## The Problem

`store_memory_with_transaction` holds a PostgreSQL connection and an advisory lock for the entire duration of a Walrus upload (5–20 seconds on testnet). The pool is hardcoded at `max_connections(10)`.

```
begin tx
  pg_advisory_xact_lock(hash)    ← acquires lock + holds DB connection
  INSERT vector_entries           ← row written (blob_id = "pending:uuid")

  walrus::upload_blob(...)        ← NETWORK I/O: 5–20 seconds
                                  ← DB connection held the entire time
                                  ← advisory lock held the entire time

  UPDATE SET blob_id = $real_id
commit tx
```

With 10+ concurrent writes the pool exhausts. New requests queue — including reads (`recall`, `stats`) which have nothing to do with Walrus. The `analyze` path makes this worse: it calls `store_memory_with_transaction` **sequentially in a loop** (one call per extracted fact), so a single `analyze` with 5 facts holds a connection for 25–100 seconds.

---

## The Fix — Two-Phase Commit

Split the transaction into three phases so no DB connection is held during the upload:

```
Phase 1 — Reserve row (DB only, ~1ms):
  begin tx
    pg_advisory_xact_lock(hash)        ← lock scope: INSERT only
    INSERT with blob_id = "pending:{id}"
  commit tx                            ← connection released immediately

Phase 2 — Upload to Walrus (slow, no DB connection held):
  walrus::upload_blob(...)             ← 5–20 seconds

  on failure:
    db.soft_delete_memory(&id)         ← unblock the content hash
    return Err(...)

Phase 3 — Finalize blob_id (DB only, ~1ms):
  UPDATE vector_entries SET blob_id = $real WHERE id = $id
```

Duplicate prevention still holds: after Phase 1 commits, the unique partial index on `(owner, namespace, content_hash)` blocks concurrent duplicate inserts without needing the advisory lock to span the upload.

**New DB method needed** — `update_blob_id` (non-transactional version of existing `update_blob_id_tx`):
```rust
pub async fn update_blob_id(&self, id: &str, blob_id: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE vector_entries SET blob_id = $2 WHERE id = $1")
        .bind(id)
        .bind(blob_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to finalize blob_id: {}", e)))?;
    Ok(())
}
```

---

## Issue Scorecard

| Issue | Severity | Introduced by fix? | Mitigation |
|---|---|---|---|
| Connection pool exhaustion | **P0** | No (existing) | Fix resolves it |
| Sequential uploads in analyze loop | **P1** | No (existing) | Fix resolves it |
| `pending:` row visible to analyze Stage 4 decrypt | Low | Fix widens window slightly | Filter `blob_id NOT LIKE 'pending:%'` in `find_similar_existing` |
| **Orphan `pending:` row if soft-delete fails** | **Medium** | **Fix introduces it** | See below |
| Supersede after upload not atomic | Low | No (existing) | Out of scope |
| Phase 3 `update_blob_id` failure | Low | No (existing) | Log as critical |

---

## Issue 4 — The Only New Risk Worth Noting

If the Walrus upload fails AND the subsequent `soft_delete_memory` also fails, the committed `pending:` row remains with `valid_until IS NULL`. The unique partial index:

```sql
CREATE UNIQUE INDEX idx_ve_content_hash_active
    ON vector_entries (owner, namespace, content_hash)
    WHERE content_hash IS NOT NULL AND valid_until IS NULL AND superseded_by IS NULL;
```

...means that content hash is **permanently blocked for that owner/namespace**. The user can never re-store that memory. This is a functional regression, not just garbage data.

### Required mitigations

**1. Never silently discard the soft-delete error:**
```rust
if let Err(cleanup_err) = state.db.soft_delete_memory(&id).await {
    tracing::error!(
        "CRITICAL: failed to clean up orphan pending row {}: {}. Manual cleanup required.",
        id, cleanup_err
    );
}
```

**2. Add a periodic or startup cleanup sweep:**
```sql
DELETE FROM vector_entries
WHERE blob_id LIKE 'pending:%'
AND created_at < NOW() - INTERVAL '1 hour'
```

Any `pending:` row older than 1 hour is guaranteed orphaned — Phase 3 completes in milliseconds under normal conditions. This can be added to the existing `cleanup_expired_blob` logic or run at server startup.

---

## Callers of `store_memory_with_transaction`

| Location | Context |
|---|---|
| `routes.rs:190` | `POST /api/remember` — single call |
| `routes.rs:842` | `POST /api/analyze` — sequential loop, one call per extracted fact |
| `routes.rs:1704` | `POST /api/consolidate` — UPDATE path |
| `routes.rs:1786` | `POST /api/consolidate` — ADD path |

All four callers benefit from the fix. No signature changes needed.
