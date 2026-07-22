-- Soft-delete tombstone for memory deletion / namespace clearing.
--
-- A deleted memory is marked here (deleted_at = NOW()) rather than removed,
-- so it stops surfacing in recall and the pre-extraction dedup context while
-- the row is RETAINED. Retention is load-bearing: the restore flow's
-- presence-check (get_blobs_by_namespace) reads vector_entries unfiltered, so
-- a retained tombstoned row still counts as "present" and restore won't
-- re-index its on-chain blob. (If a future task hard-purges old tombstoned
-- rows, that purge MUST add `AND deleted_at IS NULL` to get_blobs_by_namespace,
-- or restore will resurrect the purged memory.)
--
-- NULL default = not deleted. Additive + nullable, so no table rewrite and no
-- backfill (every existing row is live). Reads that must hide deleted rows add
-- `AND deleted_at IS NULL`: recall's search_similar (which also feeds the
-- pre-extraction context) and the analyze namespace-existence check.
--
-- The hard DELETE path (delete_by_namespace, via /api/forget) is intentionally
-- left as-is for the benchmark harness's inter-run cleanup — soft-delete is a
-- separate, user-facing path.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL DEFAULT NULL;

-- Partial index: the recall hot path filters `WHERE owner = ? AND namespace = ?
-- AND deleted_at IS NULL`. A partial index over only live rows keeps it small
-- (tombstones excluded) and matches the predicate.
CREATE INDEX IF NOT EXISTS idx_vector_entries_live
    ON vector_entries (owner, namespace)
    WHERE deleted_at IS NULL;
