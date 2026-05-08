-- memwal — RAG index metadata
--
-- Keeps vector_entries backward compatible while allowing one Walrus blob to
-- have multiple derived index rows, such as whole-artifact and chunk rows.

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS artifact_id TEXT,
    ADD COLUMN IF NOT EXISTS index_kind TEXT NOT NULL DEFAULT 'whole',
    ADD COLUMN IF NOT EXISTS source_ref TEXT,
    ADD COLUMN IF NOT EXISTS indexed_text_kind TEXT NOT NULL DEFAULT 'raw',
    ADD COLUMN IF NOT EXISTS embedding_model TEXT,
    ADD COLUMN IF NOT EXISTS pipeline_version TEXT,
    ADD COLUMN IF NOT EXISTS lexical_document TEXT;

CREATE INDEX IF NOT EXISTS idx_vector_entries_owner_ns_artifact
    ON vector_entries (owner, namespace, artifact_id);

CREATE INDEX IF NOT EXISTS idx_vector_entries_owner_ns_kind
    ON vector_entries (owner, namespace, index_kind);

CREATE INDEX IF NOT EXISTS idx_vector_entries_lexical
    ON vector_entries USING gin (to_tsvector('english', COALESCE(lexical_document, '')));
