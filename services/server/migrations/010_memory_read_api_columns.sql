-- services/server/migrations/010_memory_read_api_columns.sql
--
-- WALM-295: owner-scoped read API needs a real "what changed since X"
-- cursor. vector_entries had no updated_at (only created_at, set once at
-- insert) — add it. agent_id/package_id are needed per-memory by the same
-- read API (WALM-295 acceptance criteria).
--
-- All three columns are added NULLable here (a plain ADD COLUMN with no
-- non-volatile default is a metadata-only change in Postgres — no table
-- rewrite, no long lock). Backfill and the NOT NULL constraint are
-- deliberately split into separate migrations (011, 012) so the
-- expensive parts don't run under the ACCESS EXCLUSIVE lock this
-- statement briefly holds — see 011/012's header comments. Do not
-- re-merge these into one file/transaction.
--
-- No DB trigger: vector_entries has zero UPDATE statements in this
-- codebase today, and every other updated_at column here (remember_jobs,
-- delete_blobs_tracking) is bumped with an explicit `SET updated_at =
-- NOW()` in application code, not a trigger. Matching that convention
-- also avoids introducing this codebase's first CREATE TRIGGER, which
-- would need to be idempotent across every server boot (migrations
-- re-run unconditionally) — Postgres has no CREATE TRIGGER IF NOT EXISTS.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS agent_id TEXT NULL;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS package_id TEXT NULL;
