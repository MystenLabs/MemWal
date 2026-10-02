-- Index for the admin activity view's memory-delete counts.
--
-- /api/admin/activity counts `memory_tombstones WHERE deleted_at > $1 AND
-- deleted_at <= $2` for the current and the previous window, with no owner.
-- The only index on the table is (owner, deleted_at, memory_id), which
-- cannot serve a range on deleted_at alone, so every call scanned the whole
-- table twice, and the dashboard polls it every 60s per open admin tab.
--
-- Own file: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- (sqlx::raw_sql wraps a file as one), same reason as 016/018/022.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memory_tombstones_deleted_at
    ON memory_tombstones (deleted_at);
