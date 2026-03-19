-- memwal — Add namespace to vector_entries
-- Supports multi-tenant/multi-app memory isolation

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'default';

-- Composite index for namespace-scoped queries
CREATE INDEX IF NOT EXISTS idx_vector_entries_owner_ns ON vector_entries (owner, namespace);