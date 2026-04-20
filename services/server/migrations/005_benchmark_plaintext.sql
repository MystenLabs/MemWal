-- Benchmark mode support: optional plaintext column for retrieval quality testing.
--
-- When the server runs with BENCHMARK_MODE=true, it skips the SEAL encryption
-- and Walrus upload path entirely and writes plaintext directly to this column.
-- Recall and consolidation read from this column instead of downloading +
-- decrypting blobs.
--
-- Production rows always have plaintext = NULL (nullable column, no default
-- value = existing data untouched). Benchmark rows have blob_id like "bench:*"
-- and plaintext populated.
--
-- This isolation means there's no way for benchmark data to be mistaken for
-- production data: the row is tagged both by its blob_id prefix and by the
-- presence of a non-NULL plaintext value.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS plaintext TEXT;
