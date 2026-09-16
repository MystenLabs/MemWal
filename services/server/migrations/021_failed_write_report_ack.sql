-- Acknowledge an accepted-then-failed write once it has been reported.
--
-- `POST /api/recall` attaches recently-failed writes so a user learns a fact
-- was silently lost. Without a marker the same rows ride along on EVERY recall
-- for the whole 24h window, and the text tells the agent to send them again —
-- so an agent that complies re-sends, the original row is still `failed` and
-- still in-window, and the next recall asks for the same thing. Each pass is a
-- fresh paid Walrus write.
--
-- Stamped when a report goes out, then filtered on, so each failure is
-- surfaced once. NULL means "not yet reported", which is what every existing
-- row should be.
ALTER TABLE remember_jobs
    ADD COLUMN IF NOT EXISTS failure_reported_at TIMESTAMPTZ;

-- The report query is on the hot recall path: owner + status + window, newest
-- first, unreported only. Partial so the index stays small — it only ever
-- serves rows that are failed and still unreported.
CREATE INDEX IF NOT EXISTS remember_jobs_unreported_failures_idx
    ON remember_jobs (owner, updated_at DESC)
    WHERE status = 'failed' AND failure_reported_at IS NULL;
