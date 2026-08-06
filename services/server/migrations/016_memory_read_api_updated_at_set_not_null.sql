-- services/server/migrations/016_memory_read_api_updated_at_set_not_null.sql
--
-- WALM-295: finalize `updated_at NOT NULL` now that migration 012 has
-- added and validated a CHECK (updated_at IS NOT NULL) constraint.
-- Since Postgres 12, `SET NOT NULL` detects a validated CHECK
-- constraint that already proves the column has no NULLs and skips its
-- own full-table validation scan -- so despite looking identical to the
-- single ALTER that migration 012 used to be, this one is metadata-only
-- (brief ACCESS EXCLUSIVE, no scan). All the scan cost happened earlier
-- in 012's VALIDATE CONSTRAINT, which only needed SHARE UPDATE
-- EXCLUSIVE and did not block concurrent reads/writes.
--
-- The now-redundant CHECK constraint is dropped for cleanliness once
-- SET NOT NULL is in place. Deliberately its own migration file/
-- transaction, separate from 012, for the same reason 011/012/013 are
-- already split: sqlx::raw_sql runs each file as one implicit
-- transaction, and keeping this small keeps the lock this ALTER
-- briefly takes short and isolated.
--
-- Idempotent: SET NOT NULL on an already-NOT-NULL column is a no-op;
-- DROP CONSTRAINT IF EXISTS is a no-op once 012's guard stops
-- re-adding the constraint (see 012's header).

ALTER TABLE vector_entries ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE vector_entries DROP CONSTRAINT IF EXISTS vector_entries_updated_at_not_null;
