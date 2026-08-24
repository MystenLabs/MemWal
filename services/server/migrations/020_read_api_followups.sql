-- WALM-363 / WALM-364 follow-ups for the owner-scoped read API.
--
-- WALM-363 (Linear, design approved 2026-08-18): separate tombstone table,
-- not deleted_at on vector_entries. 21 production queries read that table;
-- a missed soft-delete filter would leak content or over-count storage.
-- Deletes are one atomic CTE (DELETE ... RETURNING + INSERT tombstone).
--
-- WALM-364: metadata_synced_at distinguishes "not yet backfilled" from
-- "on-chain metadata had no memwal_agent_id".

CREATE TABLE IF NOT EXISTS memory_tombstones (
    memory_id  TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    namespace  TEXT NOT NULL,
    blob_id    TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_tombstones_owner_deleted
    ON memory_tombstones (owner, deleted_at, memory_id);

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS metadata_synced_at TIMESTAMPTZ NULL;

-- Previous draft of this migration created namespace_watermarks. The
-- approved design computes the namespace watermark as GREATEST(live
-- MAX(updated_at), tombstone MAX(deleted_at)) and does not need that table.
DROP TABLE IF EXISTS namespace_watermarks;
