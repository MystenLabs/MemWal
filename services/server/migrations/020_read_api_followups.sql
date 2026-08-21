-- Owner-scoped read API follow-ups (WALM-363 / WALM-364).
--
-- 1. namespace_watermarks: a stored recency timestamp that DELETE also
--    advances. Incremental /namespaces polling used MAX(updated_at) over
--    surviving rows, so deleting the row that held the max moved the
--    watermark backwards and the namespace never resurfaced.
-- 2. memory_tombstones: hard-deleted vector_entries rows still appear on
--    /memories as status=deleted so an incremental consumer can drop them
--    without a full resync.
-- 3. metadata_synced_at: distinguishes "not yet backfilled" from "on-chain
--    metadata genuinely had no memwal_agent_id". The refill script
--    (services/server/scripts/backfill-read-api-metadata.sh) stamps this.

CREATE TABLE IF NOT EXISTS namespace_watermarks (
    owner TEXT NOT NULL,
    namespace TEXT NOT NULL,
    last_mutated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner, namespace)
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    namespace TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_tombstones_owner_deleted_id
    ON memory_tombstones (owner, deleted_at, id);

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS metadata_synced_at TIMESTAMPTZ NULL;

-- Existing namespaces get a watermark equal to their current MAX(updated_at)
-- so incremental cursors stay stable across this deploy.
INSERT INTO namespace_watermarks (owner, namespace, last_mutated_at)
SELECT owner, namespace, MAX(updated_at)
FROM vector_entries
WHERE updated_at IS NOT NULL
GROUP BY owner, namespace
ON CONFLICT (owner, namespace) DO NOTHING;
