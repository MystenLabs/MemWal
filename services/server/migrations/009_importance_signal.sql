-- Per-fact importance score, set at extraction time and consumed
-- at recall-time composite scoring.
--
-- The extractor LLM categorises each extracted fact as vital / standard /
-- trivial; the server maps those to 0.9 / 0.5 / 0.2 and persists the float
-- here. CompositeRanker can weight this term to boost critical facts
-- (safety, hard constraints) above trivial ones, especially on benchmark
-- categories that mix vital and trivial memories (LongMemEval
-- knowledge_update, multi_session).
--
-- Default 0.5 is the "standard" bucket — a neutral middle value so:
--   1. Existing rows (pre-extract.v3) get a defensible default that doesn't
--      bias ranking either way. They were never scored, so treat them as
--      standard rather than guessing.
--   2. New rows where the extractor LLM somehow fails to emit an
--      importance value land at the same defensible default.
--
-- NOT NULL because every row must have a score for the ranker's sort key
-- (a NULL would force a fallback path in the ranker for every comparison).
-- Bounded informally to [0.0, 1.0]; the server clamps at the application
-- layer (no CHECK constraint here to keep migrations cheap and reversible).

ALTER TABLE vector_entries
    ADD COLUMN IF NOT EXISTS importance REAL NOT NULL DEFAULT 0.5;
