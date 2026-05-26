-- Blob-expiry tracking on `vector_entries`. Walrus storage leases are
-- denominated in EPOCHS (integers), not wall-clock time, and epoch duration
-- drifts (advances via on-chain events, not a fixed clock). Any
-- created_at-based heuristic drifts in both directions — too-late serves a
-- dead blob (404), too-early prunes a still-alive memory (data loss). Working
-- in exact epoch numbers removes the drift entirely: each blob is sealed
-- until a fixed `end_epoch`, and "is it expired?" is the integer test
-- `end_epoch <= current_epoch`.
--
-- `end_epoch`  — the blob's on-chain `storage.end_epoch` (a u32 on chain;
--   stored BIGINT for headroom). Recorded at write time from the upload
--   result (no extra chain call) and filled in for legacy rows by a separate
--   re-runnable backfill script. NULL means "no expiry tracked" — benchmark
--   rows and any row not yet backfilled. The recall filter treats NULL as
--   ALWAYS-SERVED, so this migration is purely additive: behaviour doesn't
--   change for any row until a real `end_epoch` is written.
--
-- `object_id` — the blob's Sui object id. Already returned by the upload but
--   previously discarded. Persisting it lets the backfill (and any future
--   on-chain re-read) skip the expensive blob_id → object_id resolution
--   scan, leaving that cost only for the pre-existing legacy backlog.
--
-- Both columns are NULLABLE with no default and no data backfill here: the
-- migration is pure DDL and must stay cheap (it runs at every server boot).
-- The data step is the standalone backfill script, deliberately separate so
-- a chain-read failure can't block startup.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS end_epoch BIGINT NULL;

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS object_id TEXT NULL;

-- No dedicated end_epoch index. The recall filter
--   WHERE owner=$ AND namespace=$ AND (end_epoch IS NULL OR end_epoch > $)
-- is driven by the existing (owner, namespace) index from migration 002;
-- end_epoch is a cheap recheck on the already-narrow per-owner row set.
-- A standalone partial index on `(end_epoch) WHERE end_epoch IS NOT NULL`
-- can't serve this query because the `OR end_epoch IS NULL` branch
-- contradicts the index predicate — confirmed via EXPLAIN; the planner
-- rechecks regardless. It would just add write-maintenance cost. If a
-- prune (`DELETE WHERE end_epoch <= current`) is ever added, a tuned
-- index can come with it.
--
-- DROP an index left over from an earlier draft of this migration.
DROP INDEX IF EXISTS idx_vector_entries_end_epoch;
