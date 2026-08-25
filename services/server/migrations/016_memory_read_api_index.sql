-- services/server/migrations/016_memory_read_api_index.sql
--
-- Keyset pagination for GET /v1/owners/{owner}/memories needs
-- (owner, updated_at, id) so ORDER BY updated_at, id can use an index
-- instead of a sort. This is a SEPARATE migration file because
-- sqlx::raw_sql runs every statement in one file as a single implicit
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block at all.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vector_entries_owner_updated_id
    ON vector_entries (owner, updated_at, id);
