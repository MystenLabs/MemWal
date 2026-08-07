-- services/server/migrations/011_memory_read_api_backfill_updated_at.sql
--
-- WALM-295: backfill updated_at from created_at (not NOW()) so existing
-- rows keep their natural chronological order instead of clustering at
-- one deploy-time value, which would otherwise look like a
-- false-positive "everything changed" reset to Console's incremental
-- sync.
--
-- Deliberately its OWN migration file/transaction, separate from 010's
-- ADD COLUMN. Once 010 has committed, this UPDATE only needs a
-- ROW EXCLUSIVE lock on the rows it touches — it does not block SELECTs
-- on vector_entries the way holding 010's ACCESS EXCLUSIVE open across a
-- full-table UPDATE would. On every run after the first, this is a
-- fast no-op scan (WHERE updated_at IS NULL matches nothing).

UPDATE vector_entries SET updated_at = created_at WHERE updated_at IS NULL;
