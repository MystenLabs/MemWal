-- MemWal: Memory Structure Upgrade
-- Adds structured memory fields for typed, scored, temporal memories.
-- All columns have defaults — fully backward compatible with existing data.

-- Memory type classification
-- 'fact'         = factual statements ("User is allergic to peanuts")
-- 'preference'   = user preferences ("User prefers dark mode")
-- 'episodic'     = episode/event summaries ("User discussed project X on 2025-03-01")
-- 'procedural'   = how-to / workflows ("User's deploy process: git push → CI → staging")
-- 'biographical' = identity info ("User's name is Duc, lives in Hanoi")
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS memory_type TEXT DEFAULT 'fact';

-- Importance score: 0.0 = trivial, 1.0 = critical
-- Used in composite retrieval scoring alongside semantic similarity
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS importance FLOAT DEFAULT 0.5;

-- Access tracking — used for frequency-based scoring and decay
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

-- Source provenance — how this memory was created
-- 'user'      = direct remember() call
-- 'extracted' = from analyze() fact extraction
-- 'system'    = automated (decay, compaction, etc.)
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user';

-- Flexible metadata (tags, context, related memories, etc.)
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Content hash (SHA256 of plaintext before encryption)
-- Enables fast exact-duplicate detection without decrypting stored blobs
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Soft invalidation: points to the newer memory that superseded this one
-- NULL = active memory, non-NULL = superseded (still queryable with includeExpired)
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS superseded_by TEXT;

-- Temporal validity window (inspired by Graphiti)
-- valid_from  = when this fact became true (default: creation time)
-- valid_until = when this fact was superseded (NULL = still valid)
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- ============================================================
-- Indexes for new query patterns
-- ============================================================

-- Fast duplicate detection by content hash within owner+namespace scope (active rows only).
-- UNIQUE constraint prevents concurrent check-then-insert race conditions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ve_content_hash_active
    ON vector_entries (owner, namespace, content_hash)
    WHERE content_hash IS NOT NULL AND valid_until IS NULL AND superseded_by IS NULL;

-- Filter by memory type
CREATE INDEX IF NOT EXISTS idx_ve_memory_type
    ON vector_entries (owner, namespace, memory_type);

-- Sort/filter by importance (descending for top-K important memories)
CREATE INDEX IF NOT EXISTS idx_ve_importance
    ON vector_entries (owner, namespace, importance DESC);

-- Temporal queries (active memories only: valid_until IS NULL)
CREATE INDEX IF NOT EXISTS idx_ve_active
    ON vector_entries (owner, namespace)
    WHERE valid_until IS NULL AND superseded_by IS NULL;

-- Access frequency tracking
CREATE INDEX IF NOT EXISTS idx_ve_last_accessed
    ON vector_entries (owner, namespace, last_accessed_at DESC NULLS LAST);
