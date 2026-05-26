-- Hosted app-auth dynamic client registration.
--
-- Third-party apps cannot reasonably ask Walrus Memory operators to install
-- APP_AUTH_CLIENTS_JSON for every deployment. This table stores confidential
-- app clients created through /api/app-auth/register.

CREATE TABLE IF NOT EXISTS app_auth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_sha256 TEXT NOT NULL CHECK (client_secret_sha256 ~ '^[0-9a-f]{64}$'),
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
    allowed_redirect_uris TEXT[] NOT NULL CHECK (COALESCE(array_length(allowed_redirect_uris, 1), 0) BETWEEN 1 AND 10),
    fallback_uri TEXT,
    allowed_fallback_uris TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_auth_clients_created_at
    ON app_auth_clients (created_at DESC);
