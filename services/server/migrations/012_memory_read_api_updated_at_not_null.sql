-- services/server/migrations/012_memory_read_api_updated_at_not_null.sql
--
-- WALM-295: finalize updated_at once 011 has backfilled every row.
-- Deliberately its own migration file/transaction (not bundled with 011)
-- so the ACCESS EXCLUSIVE this ALTER briefly takes to validate NOT NULL
-- is a short constraint-check scan, not held open across the (larger)
-- backfill UPDATE. SET DEFAULT is metadata-only and safe to bundle here.
--
-- Idempotent: SET NOT NULL / SET DEFAULT on a column that already has
-- them is a no-op, matching every other migration's re-run-on-boot
-- expectation.

ALTER TABLE vector_entries ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE vector_entries ALTER COLUMN updated_at SET DEFAULT NOW();
