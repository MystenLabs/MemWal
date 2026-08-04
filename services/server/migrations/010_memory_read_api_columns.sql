-- services/server/migrations/010_memory_read_api_columns.sql
--
-- WALM-295: owner-scoped read API needs a real "what changed since X"
-- cursor. vector_entries had no updated_at (only created_at, set once at
-- insert) — add it, backfilled from created_at (not NOW()) so existing rows
-- keep their natural chronological order instead of clustering at one
-- deploy-time value, which would otherwise look like a false-positive
-- "everything changed" reset to Console's incremental sync.
--
-- agent_id/package_id are needed per-memory by the same read API
-- (WALM-295 acceptance criteria). Nullable + backfilled lazily for rows
-- written before this migration; new rows populate them at write time
-- (see Task 3/4).
--
-- No DB trigger: vector_entries has zero UPDATE statements in this
-- codebase today, and every other updated_at column here (remember_jobs,
-- delete_blobs_tracking) is bumped with an explicit `SET updated_at =
-- NOW()` in application code, not a trigger. Matching that convention
-- also avoids introducing this codebase's first CREATE TRIGGER, which
-- would need to be idempotent across every server boot (migrations
-- re-run unconditionally) — Postgres has no CREATE TRIGGER IF NOT EXISTS.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE vector_entries SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE vector_entries ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE vector_entries ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS agent_id TEXT NULL;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS package_id TEXT NULL;
