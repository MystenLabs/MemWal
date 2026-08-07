-- services/server/migrations/014_memory_deleted_at.sql
--
-- WALM-295 review (ducnmm): "incremental sync cannot communicate
-- deletion" — forget() and the reactive Walrus-404 cleanup both
-- hard-DELETE vector_entries rows today, so a client polling
-- updated_after never learns a memory it already synced is gone; it
-- only finds out via a full (cursor-less) resync.
--
-- deleted_at is a plain nullable column with no DEFAULT clause, so this
-- is a pure metadata-only ADD COLUMN (no table rewrite, no long lock,
-- every existing row reads back NULL). Unlike updated_at in migration
-- 010, there is no NOT NULL constraint to add later and therefore no
-- rolling-deploy race to guard against — NULL is the correct steady
-- state for the overwhelming majority of rows (not deleted), not a
-- transient backfill placeholder.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
