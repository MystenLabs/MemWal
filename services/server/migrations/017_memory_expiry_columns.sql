-- services/server/migrations/017_memory_expiry_columns.sql
--
-- Per-memory storage expiry. end_epoch is the on-chain Walrus epoch the
-- blob's storage lease ends at; expires_at is the computed wall-clock
-- equivalent (see services/server/src/sui/client.rs's staking-state
-- epoch_duration/first_epoch_start read). expiry_synced_at is
-- bookkeeping for the lazy/periodic refresh sweep — NOT touched by
-- anything else, and this migration does NOT touch updated_at.
--
-- All three columns are nullable with no non-volatile default, so this
-- ADD COLUMN is metadata-only (no table rewrite, no long lock) — unlike
-- the updated_at migration (014), no backfill/NOT NULL step is needed
-- here, so a single transaction is safe.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS end_epoch INTEGER NULL;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS expiry_synced_at TIMESTAMPTZ NULL;
