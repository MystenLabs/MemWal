-- Admin measurement store. Every statement re-runs on boot, so it stays
-- idempotent. Unknown byte fields are NULL, never zero.
--
-- Collection starts when this migration is deployed. Rows written before
-- that have no retrieval record, plaintext length, encoded size, snapshot,
-- or audit event. Those histories are not reconstructed here.
--
-- Encoded allocation is not in the Walrus upload response (blob id, object
-- id, transfer status, end epoch only), so encoded_bytes stays unset.
-- DelegateKeyAdded / DelegateKeyRemoved exist in account.move but the
-- indexer only consumes AccountCreated, so this file does not invent a
-- delegate ledger from the auth cache.
-- No provider billing source is configured, so provider_usage stays empty
-- until an import lands.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS plaintext_bytes BIGINT;

CREATE TABLE IF NOT EXISTS plaintext_observations (
    id              TEXT PRIMARY KEY,
    owner           TEXT NOT NULL,
    namespace       TEXT,
    plaintext_bytes BIGINT NOT NULL,
    schema_version  INTEGER NOT NULL,
    source          TEXT NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plaintext_observations_recorded_at_idx
    ON plaintext_observations (recorded_at);

CREATE TABLE IF NOT EXISTS retrieval_requests (
    id                    TEXT PRIMARY KEY,
    started_at            TIMESTAMPTZ NOT NULL,
    completed_at          TIMESTAMPTZ NOT NULL,
    network               TEXT,
    owner                 TEXT,
    operation             TEXT NOT NULL,
    route                 TEXT NOT NULL,
    namespace             TEXT,
    outcome               TEXT NOT NULL,
    returned_count        INTEGER,
    top_k                 INTEGER,
    cache_hits            INTEGER,
    cache_misses          INTEGER,
    duration_ms           BIGINT,
    relayer_body_bytes    BIGINT,
    upstream_bytes        BIGINT,
    node_bytes            BIGINT,
    schema_version        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS retrieval_requests_completed_at_idx
    ON retrieval_requests (completed_at);

CREATE TABLE IF NOT EXISTS retrieval_attempts (
    id              TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL,
    blob_id         TEXT NOT NULL,
    aggregator      TEXT,
    bytes_received  BIGINT,
    duration_ms     BIGINT,
    outcome         TEXT NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retrieval_attempts_request_id_idx
    ON retrieval_attempts (request_id);

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            TEXT PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    principal     TEXT NOT NULL,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    outcome       TEXT NOT NULL,
    summary       TEXT
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx
    ON admin_audit_log (created_at);

CREATE TABLE IF NOT EXISTS inventory_snapshots (
    snapshot_day              DATE PRIMARY KEY,
    snapshot_at               TIMESTAMPTZ NOT NULL,
    definition_version        INTEGER NOT NULL,
    logical_rows              BIGINT NOT NULL,
    distinct_blobs            BIGINT NOT NULL,
    known_plaintext_bytes     BIGINT,
    plaintext_known_rows      BIGINT NOT NULL,
    known_encrypted_bytes     BIGINT,
    encrypted_known_rows      BIGINT NOT NULL,
    known_encoded_bytes       BIGINT,
    unknown_size_rows         BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_usage (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    period_start  TIMESTAMPTZ NOT NULL,
    period_end    TIMESTAMPTZ NOT NULL,
    billed_bytes  BIGINT,
    charge_minor  BIGINT,
    currency      TEXT,
    source        TEXT NOT NULL,
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
