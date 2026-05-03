-- Phase 3 of the AI-layer refactor: introduce a `plaintext` column on
-- vector_entries so the benchmark MemoryEngine can store plaintext memories
-- directly in Postgres, bypassing SEAL encryption and Walrus upload.
--
-- Production rows (WalrusSealEngine): plaintext IS NULL, blob_id is a real
-- Walrus blob ID, the actual ciphertext lives on Walrus.
--
-- Benchmark rows (PlaintextEngine): plaintext IS NOT NULL, blob_id is a
-- synthetic UUID used only as a row key (never sent to Walrus).
--
-- The column is nullable and additive — production reads/writes are
-- unchanged. Existing rows have plaintext = NULL by default.
--
-- BENCHMARK MODE IS NOT FOR PRODUCTION USE: storing plaintext memories
-- defeats SEAL's confidentiality guarantee. The PlaintextEngine is gated
-- behind the BENCHMARK_MODE config flag, off by default.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS plaintext TEXT NULL;

-- Note: we intentionally do NOT skip migration 004 here. The dev branch
-- introduced a 004_delegate_key_cache_expires.sql for a different concern
-- (auth cache TTL), which the refactor branch doesn't yet have. When we
-- reconcile with dev at the end of the refactor, both 004 and 005 land
-- naturally — they touch different tables.
