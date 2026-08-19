-- Walrus Memory — Atomic Storage Quota Admission (GH #532 / WALM-359)
--
-- Before this migration, quota admission read SUM(blob_size_bytes) under a
-- per-owner advisory lock, then released the lock before the caller inserted.
-- Concurrent requests from one owner all observed the same pre-insert total
-- and all passed, collectively exceeding the quota.
--
-- A reservation row is claimed inside the same locked transaction as the
-- usage read, so admission and commitment are atomic. Reserved bytes are
-- counted alongside vector_entries during admission, released once the row
-- lands (or the write fails), and expire on their own as a backstop so a
-- missed release cannot strand an owner's quota permanently.

CREATE TABLE IF NOT EXISTS storage_quota_reservations (
    -- For enqueued writes this is the remember_jobs id, so the wallet worker
    -- can release without extra plumbing. For inline writes it is a synthetic
    -- id owned by the request handler.
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    bytes       BIGINT NOT NULL CHECK (bytes >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Backstop only. Normal releases are explicit; this bounds the damage of
    -- a process that dies between admission and insertion.
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Admission sums live reservations for one owner; expiry sweeps use the same
-- index from the other direction.
CREATE INDEX IF NOT EXISTS idx_storage_quota_reservations_owner_expires
    ON storage_quota_reservations (owner, expires_at);
