-- Drop the failed-write-report ack column that a PR #921 preview deploy
-- created on relayer.dev and then left behind.
--
-- History: 021_failed_write_report_ack.sql (feature #918) added
-- remember_jobs.failure_reported_at so a failed write is reported to the
-- user once. origin/dev shipped the SQL file and the queries but never
-- wired the file into VectorDb::new(), so a fresh schema never grew the
-- column. PR #921 briefly wired it (d71efdbb), deployed that build to
-- relayer.dev.memwal.ai, then reverted the feature (da73a486) without a
-- down-migration. The revert is the right code fix; this file is the
-- leftover schema. Idempotent: DROP IF EXISTS is a no-op on databases
-- that never ran the ADD (CI, local, any env that only ever ran origin/dev).
--
-- Index first: it is a partial index ON this column.
DROP INDEX IF EXISTS remember_jobs_unreported_failures_idx;
ALTER TABLE remember_jobs DROP COLUMN IF EXISTS failure_reported_at;
