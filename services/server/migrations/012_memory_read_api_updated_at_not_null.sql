-- services/server/migrations/012_memory_read_api_updated_at_not_null.sql
--
-- Prove updated_at has no NULLs left (the Rust batched backfill in
-- db.rs's backfill_updated_at() must complete before this runs -- see
-- that function's doc comment) WITHOUT taking the ACCESS EXCLUSIVE +
-- full-table-scan that a bare `ALTER COLUMN ... SET NOT NULL` requires
-- when Postgres has nothing to trust it against.
--
-- This used to just be `SET NOT NULL` directly. Instead:
--   1. ADD CONSTRAINT ... CHECK (...) NOT VALID is metadata-only (brief
--      ACCESS EXCLUSIVE, no scan).
--   2. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE only -- it does
--      not block concurrent reads/writes on vector_entries the way the
--      old single-statement SET NOT NULL did.
-- Migration 016 then does the actual `SET NOT NULL`, which since PG 12
-- detects this validated CHECK constraint and skips its own validation
-- scan entirely, and drops the now-redundant CHECK constraint.
--
-- Both steps are guarded by `pg_attribute.attnotnull` so that once 016
-- has finished (in a prior boot), this migration does nothing at all on
-- every subsequent boot -- every migration file here re-runs
-- unconditionally on every `VectorDb::new()` call (no migrations
-- table), so without this guard the VALIDATE CONSTRAINT scan would
-- otherwise be re-paid, and the plain ADD CONSTRAINT (no
-- "IF NOT EXISTS" variant exists in Postgres) would error, on every
-- restart forever.
--
-- The column's DEFAULT is set by migration 010, not here -- see 010's
-- header for why it has to run before the backfill (closes a
-- rolling-deploy race: an old-code replica inserting between the
-- backfill and this migration's VALIDATE would otherwise crash-loop
-- every replica still applying migrations).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'vector_entries'::regclass
          AND attname = 'updated_at'
          AND attnotnull
    ) THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'vector_entries_updated_at_not_null'
        ) THEN
            ALTER TABLE vector_entries
                ADD CONSTRAINT vector_entries_updated_at_not_null
                CHECK (updated_at IS NOT NULL) NOT VALID;
        END IF;

        ALTER TABLE vector_entries
            VALIDATE CONSTRAINT vector_entries_updated_at_not_null;
    END IF;
END $$;
