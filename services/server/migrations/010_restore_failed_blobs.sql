-- Per-owner negative cache of blobs that permanently fail to restore.
--
-- GH #501 / WALM-299: `/api/restore` discovers blob_ids purely by CURRENT
-- on-chain ownership (see `/walrus/query-blobs`). An attacker can transfer a
-- Walrus Blob object carrying `memwal_*` namespace metadata to a victim's
-- address; the victim's next restore() discovers it and attempts to
-- download + SEAL-decrypt it as if it were their own memory. SEAL correctly
-- rejects the decrypt (confirmed by the reporter's own PoC — not a
-- confidentiality break), but without this table the failed attempt was
-- never recorded anywhere, so the same foreign blob_id got re-downloaded
-- and re-decrypt-attempted on *every* future restore() call for that
-- owner+namespace, forever — an unbounded, repeated processing cost.
--
-- This table itself is a bounded-processing / retry-avoidance cache, NOT
-- an uploader/origin/relayer record. It is keyed purely by (owner,
-- namespace, blob_id) + the *outcome* of this owner's own decrypt/validation
-- attempt. It never inspects, stores, or reasons about who created,
-- uploaded, or relayed a blob (see Henry's Slack rejection of an uploader
-- allowlist on #501 — this table is deliberately "bounded processing +
-- rate limiting" only, and does not restrict the self-host-then-migrate-to-
-- a-managed-relayer path).
--
-- A *separate* mechanism, `verifyBlobUploaderProvenance` in
-- `sidecar/routes/walrus-query.ts`, does check the mint/transfer transaction
-- sender against `TRUSTED_UPLOADER_ADDRESSES` and excludes untrusted blobs
-- from `/walrus/query-blobs` results before they ever reach this table or
-- `restore()`. That gate operates independently, upstream of everything
-- described here — do not read this comment as "no part of this codebase
-- looks at who uploaded a blob."
--
-- Only *permanent* failures are recorded here (see
-- `seal::DecryptOutcome::permanent_from_error` — deterministic decrypt
-- rejections like "InvalidCiphertext" / "Not enough shares", or invalid
-- UTF-8 after a successful decrypt). Transient failures (SEAL service
-- timeout, 429/503, download errors) are never written, so a legitimate
-- blob can never be wrongly and permanently blacklisted during an infra
-- blip — it just gets retried on the next restore() call as before.
CREATE TABLE IF NOT EXISTS restore_failed_blobs (
    owner TEXT NOT NULL,
    namespace TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, namespace, blob_id)
);

CREATE INDEX IF NOT EXISTS idx_restore_failed_blobs_owner_ns
    ON restore_failed_blobs (owner, namespace);
