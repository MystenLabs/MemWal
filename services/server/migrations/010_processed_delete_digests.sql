-- WALM-264: single-use ledger for /api/delete-memories.
--
-- The delete handler binds an irreversible DB row-delete to a client-supplied
-- blob-id list that is NOT part of the signed transaction, trusting only that
-- the sponsored digest is single-use. A sponsored digest + the user signature
-- are both public on-chain (txSignatures), so without a server-side guard a
-- replay of a victim's past delete — with an attacker-chosen blob-id list —
-- could desync that victim's index if the upstream execute ever returned
-- success for an already-consumed digest. Claiming the digest here (PK, atomic
-- ON CONFLICT) makes the row-delete fire at most once per digest regardless of
-- upstream behaviour.
CREATE TABLE IF NOT EXISTS processed_delete_digests (
    digest TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
