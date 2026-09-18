-- Partial index for GET /health's recent_write_outcomes probe.
--
-- The probe is `status IN ('failed','done','uploaded') AND updated_at >= $1`
-- with no owner. Existing indexes are (owner), (status), (owner, status,
-- updated_at DESC), and (owner, idempotency_key) — none of those can serve
-- a window scan on updated_at alone, and `done` is almost the whole table
-- so idx_remember_jobs_status is a near-seq-scan. remember_jobs is never
-- pruned. Without this index the 1s statement timeout always fires on a
-- large table and the probe fails open, so writes=degraded silently stops
-- working at the scale where it matters.
--
-- Own file: CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- (sqlx::raw_sql wraps a file as one), same reason as 016/018.
CREATE INDEX CONCURRENTLY IF NOT EXISTS remember_jobs_recent_outcomes_idx
    ON remember_jobs (updated_at DESC)
    WHERE status IN ('failed', 'done', 'uploaded');
