-- Admin spend view. The balance monitor already reads uploader and sponsor
-- balances, but nothing kept them, so the admin page could not tell a faster
-- drain from a one-off low balance. Remember jobs and tombstones already
-- answer "what ran"; sponsored account transactions did not.
--
-- Both tables are new and empty. A normal CREATE INDEX is enough — there is
-- no existing writer to block. Statements stay idempotent because every
-- migration file re-runs on boot.

CREATE TABLE IF NOT EXISTS wallet_balance_samples (
    sampled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploader_wal_frost  BIGINT,
    uploader_sui_mist   BIGINT,
    sponsor_sui_mist    BIGINT
);

CREATE INDEX IF NOT EXISTS wallet_balance_samples_sampled_at_idx
    ON wallet_balance_samples (sampled_at);

CREATE TABLE IF NOT EXISTS sponsored_tx_log (
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sender      TEXT NOT NULL,
    kind        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sponsored_tx_log_created_at_idx
    ON sponsored_tx_log (created_at);
