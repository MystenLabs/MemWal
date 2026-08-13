-- Durable idempotency and recovery state for paid remember writes.
-- All columns are nullable/additive so existing rows remain readable. Legacy
-- paid rows without an original preparation payload fail closed and require
-- manual reconciliation rather than unsafe re-encryption.
ALTER TABLE remember_jobs
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS blob_object_id TEXT,
    ADD COLUMN IF NOT EXISTS upload_wallet_index INTEGER,
    ADD COLUMN IF NOT EXISTS upload_wallet_address TEXT,
    ADD COLUMN IF NOT EXISTS upload_execution_identity JSONB,
    ADD COLUMN IF NOT EXISTS upload_resume_step JSONB,
    ADD COLUMN IF NOT EXISTS upload_register_transaction JSONB,
    ADD COLUMN IF NOT EXISTS prepare_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS prepare_claim_token TEXT,
    ADD COLUMN IF NOT EXISTS recovery_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recovery_claim_token TEXT,
    ADD COLUMN IF NOT EXISTS preparation_encrypted_b64 TEXT,
    ADD COLUMN IF NOT EXISTS preparation_vector JSONB,
    ADD COLUMN IF NOT EXISTS preparation_importance REAL,
    ADD COLUMN IF NOT EXISTS preparation_account_id TEXT,
    ADD COLUMN IF NOT EXISTS preparation_public_key TEXT;
