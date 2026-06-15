-- Transient per-namespace DEK cache for the V2 backfill migration tool.
--
-- The backfill generates one random DEK per (namespace, key_version), Seal-wraps
-- it on-chain (MemoryNamespace.wrapped_deks), and AES-encrypts every blob of that
-- cohort under it. Previously the raw DEK only lived in the worker's memory for a
-- single HTTP call, so a second call -- or a retry after a partial failure --
-- could not recover it and skipped the namespace ("wrapped DEK already exists"),
-- permanently stranding the rest of its blobs. This table persists the raw DEK
-- for the migration window so backfill is resumable and idempotent.
--
-- SECURITY: this holds raw 32-byte DEKs at rest, which (combined with the Walrus
-- ciphertext) is sufficient to decrypt migrated data. It is a migration-only
-- artifact on the isolated migration DB and MUST be dropped once migration is
-- complete:   DROP TABLE migration_dek_cache;
-- Prod hardening: wrap the DEK to a server-controlled SEAL identity instead of
-- storing it raw (see the V2 migration status doc).
CREATE TABLE IF NOT EXISTS migration_dek_cache (
    namespace_id TEXT        NOT NULL,
    key_version  INTEGER     NOT NULL,
    dek          BYTEA       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (namespace_id, key_version)
);
