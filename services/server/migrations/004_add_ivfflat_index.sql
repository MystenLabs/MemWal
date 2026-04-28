-- memwal — Add IVFFlat index for embedding column
-- IVFFlat is better suited for large datasets with frequent writes.
-- Complements the existing HNSW index — the query planner picks the optimal one.
-- Rollback: DROP INDEX IF EXISTS idx_vector_entries_embedding_ivfflat;

CREATE INDEX IF NOT EXISTS idx_vector_entries_embedding_ivfflat
ON vector_entries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
