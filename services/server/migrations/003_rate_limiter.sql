-- memwal — Storage Quota Tracking
-- Rate limiting is handled by Redis (no PostgreSQL table needed).
-- Storage quota is tracked per-row in vector_entries.

-- ============================================================
-- Storage quota: track blob size in vector_entries
-- ============================================================
-- blob_size_bytes tracks the size of each encrypted blob uploaded.
-- Total storage per user = SUM(blob_size_bytes) WHERE owner = $1.
-- When blobs expire and are cleaned up (delete_by_blob_id), quota
-- is automatically reduced.
ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS blob_size_bytes BIGINT NOT NULL DEFAULT 0;
