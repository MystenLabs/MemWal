-- Keep this backfill in a separate migration. Migration 001 must commit the
-- capture trigger first so inserts concurrent with this scan cannot fall
-- between the vector_entries snapshot and trigger activation.
INSERT INTO delete_blobs_tracking (owner, blob_id, created_at, state)
SELECT canonical_sui_address(owner), blob_id, created_at, 'deletable'
FROM vector_entries
ON CONFLICT (owner, blob_id) DO NOTHING;
