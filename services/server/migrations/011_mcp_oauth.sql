-- MCP OAuth 2.1 support for Claude (and future) native custom connectors.
--
-- Distinct from the unmerged WALM-30/ENG-1783 `app_auth_clients` table (that
-- branch never merged — see PR #193). This schema is scoped to the MCP
-- resource-server flow: RFC 7591 dynamic client registration, RFC 8707
-- resource-indexed authorization codes/tokens, and server-custodied delegate
-- keys encrypted at rest (AES-256-GCM, envelope `v1.<nonce>.<ciphertext>`,
-- see `services/server/src/oauth.rs`).
--
-- Every table here is short-lived-state-adjacent except `mcp_oauth_clients`,
-- `mcp_oauth_delegates`, and `mcp_oauth_grants`, which are the durable
-- records. Idempotent: this file re-runs on every server boot
-- (`services/server/src/storage/db.rs`, `VectorDb::new()`).

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
    client_id                  TEXT PRIMARY KEY,
    -- NULL for public clients (token_endpoint_auth_method = "none"), which is
    -- what Claude registers as per its connector docs.
    client_secret_sha256       TEXT CHECK (client_secret_sha256 IS NULL OR client_secret_sha256 ~ '^[0-9a-f]{64}$'),
    client_name                TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 80),
    redirect_uris               TEXT[] NOT NULL CHECK (COALESCE(array_length(redirect_uris, 1), 0) BETWEEN 1 AND 10),
    grant_types                 TEXT[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
    response_types              TEXT[] NOT NULL DEFAULT '{code}',
    token_endpoint_auth_method  TEXT NOT NULL DEFAULT 'none'
        CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
    scope                       TEXT NOT NULL DEFAULT 'memwal:read memwal:write offline_access',
    status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    registered_ip                TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at                 TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_created_at ON mcp_oauth_clients (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_status ON mcp_oauth_clients (status);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_last_used_at ON mcp_oauth_clients (last_used_at);

-- Server-custodied delegate keys. Distinct from the on-chain `DelegateKey`
-- struct (`services/contract/sources/account.move`) — a row here becomes
-- "active" only once its public key is verified on-chain via
-- `verify_delegate_key_onchain`, same as the existing `delegate_key_cache`
-- read path in `db.rs`.
CREATE TABLE IF NOT EXISTS mcp_oauth_delegates (
    delegate_ref            TEXT PRIMARY KEY,
    account_id              TEXT,
    owner_address            TEXT,
    delegate_public_key      TEXT NOT NULL UNIQUE CHECK (delegate_public_key ~ '^[0-9a-f]{64}$'),
    delegate_address         TEXT NOT NULL,
    encrypted_private_key    TEXT NOT NULL,
    label                    TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
    tx_digest                TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_delegates_account_status ON mcp_oauth_delegates (account_id, status);

-- Pre-consent record created by `GET /oauth/authorize`, consumed by the
-- consent SPA's `/api/oauth/session/{id}/complete` call.
CREATE TABLE IF NOT EXISTS mcp_oauth_authorize_sessions (
    session_id               TEXT PRIMARY KEY,
    client_id                TEXT NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri              TEXT NOT NULL,
    state                    TEXT,
    scope                    TEXT NOT NULL,
    resource                 TEXT NOT NULL,
    code_challenge            TEXT NOT NULL,
    code_challenge_method     TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
    delegate_ref              TEXT NOT NULL REFERENCES mcp_oauth_delegates (delegate_ref) ON DELETE CASCADE,
    status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_authorize_sessions_expires_at ON mcp_oauth_authorize_sessions (expires_at);

-- One-time authorization codes. Stored hashed (never plaintext), single-use
-- via `DELETE ... RETURNING` (same atomicity guarantee as the WALM-30 prior
-- art's Redis GETDEL, applied to Postgres per decision D3).
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
    code_sha256               TEXT PRIMARY KEY CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
    client_id                 TEXT NOT NULL,
    redirect_uri               TEXT NOT NULL,
    scope                     TEXT NOT NULL,
    resource                  TEXT NOT NULL,
    code_challenge             TEXT NOT NULL,
    code_challenge_method      TEXT NOT NULL,
    delegate_ref               TEXT NOT NULL,
    account_id                 TEXT NOT NULL,
    owner_address              TEXT NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                 TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expires_at ON mcp_oauth_codes (expires_at);

-- One row per consented (user, client) pair — the revocation unit. Revoking
-- a connector is one `UPDATE ... SET revoked_at`, which kills every token
-- derived from it.
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
    grant_id       TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES mcp_oauth_clients (client_id) ON DELETE CASCADE,
    delegate_ref   TEXT NOT NULL REFERENCES mcp_oauth_delegates (delegate_ref) ON DELETE CASCADE,
    account_id     TEXT NOT NULL,
    owner_address  TEXT NOT NULL,
    scope          TEXT NOT NULL,
    resource       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_account_id ON mcp_oauth_grants (account_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_client_id ON mcp_oauth_grants (client_id);

-- Access + refresh tokens, stored hashed. `token_type` distinguishes rows;
-- refresh-token rotation-reuse detection revokes the whole grant (see
-- `services/server/src/oauth.rs`).
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    token_sha256   TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    grant_id       TEXT NOT NULL REFERENCES mcp_oauth_grants (grant_id) ON DELETE CASCADE,
    token_type     TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
    expires_at     TIMESTAMPTZ NOT NULL,
    revoked_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_grant_type ON mcp_oauth_tokens (grant_id, token_type);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires_at ON mcp_oauth_tokens (expires_at);
