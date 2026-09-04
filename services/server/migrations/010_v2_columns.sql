-- Additive V2 columns. V1 rows stay NULL.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS namespace_object_id TEXT,
    ADD COLUMN IF NOT EXISTS key_version BIGINT,
    ADD COLUMN IF NOT EXISTS storage_mode TEXT,
    ADD COLUMN IF NOT EXISTS oyster_bucket TEXT,
    ADD COLUMN IF NOT EXISTS oyster_key TEXT,
    ADD COLUMN IF NOT EXISTS pooled_blob_object_id TEXT,
    ADD COLUMN IF NOT EXISTS ciphertext_digest BYTEA,
    ADD COLUMN IF NOT EXISTS commitment BYTEA,
    ADD COLUMN IF NOT EXISTS fence_tx_digest TEXT;

ALTER TABLE remember_jobs
    ADD COLUMN IF NOT EXISTS namespace_object_id TEXT,
    ADD COLUMN IF NOT EXISTS key_version BIGINT,
    ADD COLUMN IF NOT EXISTS storage_mode TEXT,
    ADD COLUMN IF NOT EXISTS oyster_bucket TEXT,
    ADD COLUMN IF NOT EXISTS oyster_key TEXT,
    ADD COLUMN IF NOT EXISTS pooled_blob_object_id TEXT,
    ADD COLUMN IF NOT EXISTS ciphertext_digest BYTEA,
    ADD COLUMN IF NOT EXISTS commitment BYTEA,
    ADD COLUMN IF NOT EXISTS fence_tx_digest TEXT;
