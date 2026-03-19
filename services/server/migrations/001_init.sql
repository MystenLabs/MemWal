-- memwal Server — PostgreSQL Schema
-- Requires: pgvector extension

CREATE EXTENSION IF NOT EXISTS vector;

-- Vector entries for similarity search
CREATE TABLE IF NOT EXISTS vector_entries (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    embedding vector (1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vector_entries_owner ON vector_entries (owner);

CREATE INDEX IF NOT EXISTS idx_vector_entries_blob_id ON vector_entries (blob_id);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_vector_entries_embedding ON vector_entries USING hnsw (embedding vector_cosine_ops);

-- Delegate key cache (auth optimization)
CREATE TABLE IF NOT EXISTS delegate_key_cache (
    public_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexed accounts (populated by v2-indexer)
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts (owner);

-- Indexer state tracking
CREATE TABLE IF NOT EXISTS indexer_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);