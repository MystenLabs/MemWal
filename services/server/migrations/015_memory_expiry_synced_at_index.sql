-- services/server/migrations/015_memory_expiry_synced_at_index.sql
--
-- WALM-296: index vector_entries.expiry_synced_at so the periodic expiry
-- refresh sweep (main.rs) doesn't full-scan the table every 300s.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this is
-- its own migration file (mirrors migration 013's same requirement).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vector_entries_expiry_synced_at
    ON vector_entries (expiry_synced_at);
