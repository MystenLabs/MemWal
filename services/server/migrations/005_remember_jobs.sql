-- ENG-1406 v3: Job status tracking for async remember pipeline
-- Each row tracks one remember request from enqueue → done/failed.
--
-- Status transitions:
--   pending  → running  (worker picked up the job)
--   running  → uploaded (blob certified on Walrus + vector indexed; transfer still pending)
--   uploaded → done     (metadata+transfer to user wallet succeeded)
--   running  → failed   (any error before upload completed)
--   uploaded → failed   (metadata+transfer permanently failed after retries)

CREATE TABLE IF NOT EXISTS remember_jobs (
    id          TEXT PRIMARY KEY,          -- UUID, returned as jobId in 202 response
    owner       TEXT NOT NULL,             -- Sui address of the calling user
    namespace   TEXT NOT NULL DEFAULT 'default',
    status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'uploaded', 'done', 'failed')),
    blob_id     TEXT,                      -- set once status reaches 'uploaded'
    error_msg   TEXT,                      -- set when status = 'failed'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remember_jobs_owner  ON remember_jobs (owner);
CREATE INDEX IF NOT EXISTS idx_remember_jobs_status ON remember_jobs (status);
