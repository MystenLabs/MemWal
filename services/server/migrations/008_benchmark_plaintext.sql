-- Adds a `plaintext` column on vector_entries so the
-- benchmark MemoryEngine (PlaintextEngine) can store memories directly in
-- Postgres, bypassing SEAL encryption and Walrus upload.
--
-- Production rows (WalrusSealEngine): plaintext IS NULL, blob_id is a real
-- Walrus blob ID, the actual ciphertext lives on Walrus.
--
-- Benchmark rows (PlaintextEngine): plaintext IS NOT NULL, blob_id is a
-- synthetic UUID equal to the row id (never sent to Walrus).
--
-- The column is nullable and additive — production reads/writes are
-- unchanged. Existing rows have plaintext = NULL by default.
--
-- BENCHMARK MODE IS NOT FOR PRODUCTION USE: storing plaintext memories
-- defeats SEAL's confidentiality guarantee. The PlaintextEngine is gated
-- behind the BENCHMARK_MODE config flag, off by default.

ALTER TABLE vector_entries ADD COLUMN IF NOT EXISTS plaintext TEXT NULL;
