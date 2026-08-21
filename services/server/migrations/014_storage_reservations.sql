-- Walrus Memory — Storage Quota Reservations
--
-- Closes the quota admission race (GH #532 / WALM-359).
--
-- Before this table, admission read SUM(blob_size_bytes) under a
-- pg_advisory_xact_lock and then COMMITTED that transaction. Advisory
-- *xact* locks are transaction scoped, so the lock died on that commit and
-- the caller's INSERT happened unprotected. Concurrent requests from one
-- owner all read the same pre-insert total, all passed, and all inserted.
--
-- A reservation is the missing "intent to write" record. Admission now
-- inserts the reservation inside the same transaction that holds the lock
-- and reads usage, so check and commit-of-intent are atomic. Usage during
-- admission is SUM(vector_entries.blob_size_bytes) + SUM(unexpired
-- reservations.bytes).
--
-- Why a table rather than one long transaction: the enqueued paths
-- (/api/remember, /api/remember/bulk, /api/analyze) admit the request, queue a
-- wallet job, upload to Walrus, and only then insert the row. That window is
-- documented in types.rs as running up to five minutes. A Postgres
-- transaction cannot be held across it. Inline paths could use a single
-- transaction, but sharing one mechanism keeps both groups on the same
-- accounting rather than letting them diverge.
--
-- `id` is the caller's own identifier, not a generated key:
--   * enqueued paths use the `remember_jobs.id` the row will be inserted with
--   * inline paths use a freshly minted UUID
-- Keying by an id the caller already owns means release sites need no extra
-- plumbing through the serialized wallet-job payloads, and makes release
-- idempotent: a retried job that already released simply deletes nothing.
-- There is deliberately no FK to remember_jobs, since inline reservations
-- have no job row.
--
-- `expires_at` is the backstop required by the acceptance criteria. If a
-- release is ever missed (process killed between admission and insert, job
-- lost, task cancelled), the reservation stops counting at expiry. The
-- failure mode is therefore temporary over-counting, never a permanently
-- unusable account.

CREATE TABLE IF NOT EXISTS storage_reservations (
    id         TEXT PRIMARY KEY,
    owner      TEXT   NOT NULL,
    bytes      BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admission reads live reservations for exactly one owner, so lead with owner
-- and carry expires_at for the range predicate.
CREATE INDEX IF NOT EXISTS idx_storage_reservations_owner_expires
    ON storage_reservations (owner, expires_at);

-- The periodic sweeper scans by expiry across all owners.
CREATE INDEX IF NOT EXISTS idx_storage_reservations_expires
    ON storage_reservations (expires_at);
