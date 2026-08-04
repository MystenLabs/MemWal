-- services/server/migrations/011_memory_read_api_index.sql
--
-- WALM-295: keyset pagination for GET /v1/owners/{owner}/memories needs
-- (owner, updated_at, id) so ORDER BY updated_at, id can use an index
-- instead of a sort. This is a SEPARATE migration file (not bundled into
-- 010) because sqlx::raw_sql runs every statement in one file as a single
-- implicit transaction, and CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block at all — bundling it with 010's ALTER TABLE
-- statements would either error outright or (if downgraded to a plain
-- CREATE INDEX) hold ACCESS EXCLUSIVE for the whole build, blocking reads
-- on vector_entries for its duration.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vector_entries_owner_updated_id
    ON vector_entries (owner, updated_at, id);
