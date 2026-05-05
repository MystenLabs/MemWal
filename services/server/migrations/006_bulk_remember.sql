-- ENG-1408: Bulk remember support
--
-- Composite index for owner-scoped job listing/sweeper queries.
CREATE INDEX IF NOT EXISTS remember_jobs_status_owner_idx
    ON remember_jobs (owner, status, updated_at DESC);
