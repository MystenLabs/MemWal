-- Same read-model the legacy indexer produced: account_id -> owner.
-- Kept identical so downstream auth lookups (O(1) owner -> account) are unchanged.
-- The framework's own watermark/pipeline tables are created by its bundled
-- migrations; this user migration only adds `accounts`.
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    owner      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner);
