-- Walrus Memory V2 protocol migration support.
--
-- These columns let the relayer serve OLD and P2 blobs concurrently. Existing
-- rows remain legacy-compatible; the backfill writes P2 metadata next to copied
-- rows and records progress in the migration tables below.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS package_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS namespace_object_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS key_version INTEGER NULL,
    ADD COLUMN IF NOT EXISTS walrus_object_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS storage_end_epoch INTEGER NULL,
    ADD COLUMN IF NOT EXISTS migrated_from_blob_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_vector_entries_protocol
    ON vector_entries (protocol);

CREATE INDEX IF NOT EXISTS idx_vector_entries_package_id
    ON vector_entries (package_id);

CREATE INDEX IF NOT EXISTS idx_vector_entries_migrated_from_blob_id
    ON vector_entries (migrated_from_blob_id);

CREATE TABLE IF NOT EXISTS account_migrations (
    legacy_account_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    p2_account_id TEXT NULL,
    p2_namespace_id TEXT NULL,
    namespace_name TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT NULL,
    imported_at TIMESTAMPTZ NULL,
    verified_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (legacy_account_id, namespace_name)
);

ALTER TABLE account_migrations
    ADD COLUMN IF NOT EXISTS namespace_name TEXT NOT NULL DEFAULT 'default';

DO $$
DECLARE
    pk_cols TEXT[];
BEGIN
    SELECT array_agg(att.attname ORDER BY keys.ordinality)
    INTO pk_cols
    FROM pg_constraint con
    JOIN unnest(con.conkey) WITH ORDINALITY AS keys(attnum, ordinality) ON TRUE
    JOIN pg_attribute att
        ON att.attrelid = con.conrelid
       AND att.attnum = keys.attnum
    WHERE con.conrelid = 'account_migrations'::regclass
      AND con.contype = 'p';

    IF pk_cols IS DISTINCT FROM ARRAY['legacy_account_id', 'namespace_name'] THEN
        IF pk_cols IS NOT NULL THEN
            ALTER TABLE account_migrations DROP CONSTRAINT account_migrations_pkey;
        END IF;

        ALTER TABLE account_migrations
            ADD CONSTRAINT account_migrations_pkey
            PRIMARY KEY (legacy_account_id, namespace_name);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_migrations_owner
    ON account_migrations (owner);

CREATE INDEX IF NOT EXISTS idx_account_migrations_status
    ON account_migrations (status);

CREATE INDEX IF NOT EXISTS idx_account_migrations_owner_namespace
    ON account_migrations (owner, namespace_name);

CREATE TABLE IF NOT EXISTS blob_migrations (
    old_blob_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    namespace TEXT NOT NULL,
    old_package_id TEXT NULL,
    p2_package_id TEXT NULL,
    old_account_id TEXT NULL,
    p2_account_id TEXT NULL,
    p2_namespace_id TEXT NULL,
    p2_blob_id TEXT NULL,
    p2_walrus_object_id TEXT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT NULL,
    migrated_at TIMESTAMPTZ NULL,
    verified_at TIMESTAMPTZ NULL,
    deleted_old_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blob_migrations_status
    ON blob_migrations (status);

CREATE INDEX IF NOT EXISTS idx_blob_migrations_owner_ns
    ON blob_migrations (owner, namespace);

CREATE INDEX IF NOT EXISTS idx_blob_migrations_p2_blob_id
    ON blob_migrations (p2_blob_id);
