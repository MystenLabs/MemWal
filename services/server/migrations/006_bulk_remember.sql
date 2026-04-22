-- ENG-1408: Bulk remember support
--
-- Thêm composite index để poll nhiều job_ids theo owner+status hiệu quả.
-- GET /api/remember/:job_id chỉ cần 1 row, nhưng client có thể poll
-- N job_ids liên tục — index này giúp ORDER BY updated_at DESC nhanh hơn.
CREATE INDEX IF NOT EXISTS remember_jobs_status_owner_idx
    ON remember_jobs (owner, status, updated_at DESC);

-- Add 'uploaded' as a permitted status for the staged transfer flow:
--   running → uploaded (vector indexed, metadata+transfer pending)
--   uploaded → done    (transfer succeeded)
--   uploaded → failed  (transfer permanently failed)
-- Drop & re-add the CHECK constraint to extend the allowed set.
ALTER TABLE remember_jobs DROP CONSTRAINT IF EXISTS remember_jobs_status_check;
ALTER TABLE remember_jobs ADD CONSTRAINT remember_jobs_status_check
    CHECK (status IN ('pending', 'running', 'uploaded', 'done', 'failed'));
