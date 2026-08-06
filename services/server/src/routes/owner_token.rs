//! WALM-297 Phase 1 — `POST /v1/owner-tokens` issuance + a minimal
//! token-gated probe route.
//!
//! Console has already proven (entirely on its own side — WALM-298, PR
//! #533; WM is never involved) that a user controls a WM owner address `Y`.
//! It then calls `POST /v1/owner-tokens`, authenticating itself as a
//! legitimate client via the team-decided **service credential** (a single
//! static shared secret WM generates and hands to Console out of band —
//! Slack thread, Henry + Harry Phan; mTLS and signed-client-assertion were
//! explicitly considered and NOT chosen), to mint a short-lived bearer
//! token scoped to `Y`. Console then presents that token as `Authorization:
//! Bearer <token>` to WM's owner-scoped read routes.
//!
//! `token_probe` is a minimal token-gated route added SPECIFICALLY so this
//! feature is testable end-to-end in this branch: PR #537 (WALM-295)'s real
//! `GET /v1/owners/{owner}/{namespaces,memories,agents}` handlers do not
//! exist here yet (this is a fresh branch off `dev`). Wiring the
//! `OwnerToken` extractor into those real handlers is the small follow-up
//! once this branch merges with / rebases onto PR #537's branch.

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::owner_token_auth::{self, OwnerToken, PERMISSION_MEMORIES_READ};
use crate::rate_limit::{self, SponsorRlResult};
use crate::routes::sponsor::validate_sui_address;
use crate::security_delete_auth::same_owner;
use crate::types::{AppError, AppState};

/// Header Console sends the shared WM↔Console service credential on.
/// Not specified by the ticket text; chosen to read clearly on the wire and
/// to follow this crate's existing lowercase-`x-*` convention for
/// auth-adjacent headers (`x-public-key`, `x-signature`, `x-account-id`,
/// ... — see `auth.rs`), same family as the sidecar's own shared-secret
/// header (`X-Sidecar-Secret`, `Config::sidecar_secret`).
pub const SERVICE_CREDENTIAL_HEADER: &str = "x-service-credential";

// ============================================================
// Constant-time secret comparison
// ============================================================

/// Constant-time equality for the service-credential comparison below. This
/// workspace has no `subtle` crate dependency (checked `Cargo.toml` — the
/// only crypto deps are `ed25519-dalek`, `sha2`, `hmac`, `hex`), and none of
/// the existing secret comparisons in this crate (`deletion_token_secret`
/// verification goes through HMAC `verify_slice`, which is already
/// constant-time; there is no existing *plain-secret* comparison to
/// mirror) provide one either. Rather than pull in a new dependency for a
/// single byte comparison, this hand-rolls the standard
/// equal-length-then-XOR-accumulate technique: unlike `==`, it does not
/// short-circuit on the first differing byte, so response timing cannot be
/// used to learn how many leading bytes of the guess were correct.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Axum middleware gating the whole `POST /v1/owner-tokens` router group.
/// Reads [`SERVICE_CREDENTIAL_HEADER`] and compares it against
/// `Config::owner_token_service_credential`. Missing header, wrong value,
/// or an unconfigured (empty) secret all collapse to a bare 401 with no
/// body — matching this crate's existing convention for auth failures (see
/// `auth::verify_signature`'s bare `StatusCode` rejections): no detail is
/// leaked about *why* the request was rejected.
pub async fn service_credential_gate(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let provided = request
        .headers()
        .get(SERVICE_CREDENTIAL_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let configured = state.config.owner_token_service_credential.as_str();
    if configured.is_empty() || !constant_time_eq(provided.as_bytes(), configured.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

// The per-service-credential rate-limit middleware
// (`rate_limit::owner_token_credential_rate_limit_middleware`) lives in
// `rate_limit.rs` alongside every other limiter in this crate
// (`sponsor_rate_limit_middleware`, `accounts_rate_limit_middleware`) —
// wired directly from `main.rs`, not re-exported through this module.

// ============================================================
// POST /v1/owner-tokens
// ============================================================

#[derive(Debug, Deserialize)]
pub struct IssueOwnerTokenRequest {
    pub owner: String,
}

#[derive(Debug, Serialize)]
pub struct IssueOwnerTokenResponse {
    pub token: String,
    /// RFC 3339 / ISO 8601 UTC timestamp, e.g. `"2026-08-04T12:15:00Z"`.
    pub expires_at: String,
    pub permissions: Vec<String>,
}

/// `POST /v1/owner-tokens` — mint a short-lived, owner-scoped bearer token.
///
/// Request: `{ "owner": "<sui address>" }`
/// Response (200): `{ "token": "...", "expires_at": "<ISO8601>",
/// "permissions": ["memories.read"] }`
///
/// Ordering: address format validation → configuration check → per-owner
/// rate limit → MemWalAccount existence check → mint. Format validation
/// runs first (cheapest, and avoids charging the rate-limit budget or
/// touching the DB for garbage input); the existence check runs last
/// (most expensive, a DB round trip) so it only runs for requests that
/// already cleared every cheaper gate.
pub async fn issue_token(
    State(state): State<Arc<AppState>>,
    Json(request): Json<IssueOwnerTokenRequest>,
) -> Result<Json<IssueOwnerTokenResponse>, AppError> {
    if !validate_sui_address(&request.owner) {
        return Err(AppError::BadRequest(
            "owner must be a 0x-prefixed 32-byte Sui address (66 characters)".into(),
        ));
    }
    // Same case-normalization rationale as `routes::accounts::account_exists`:
    // the indexed `accounts.owner` column is always lowercase hex (populated
    // via `hex::encode` in the v2-indexer), and lowercasing here (rather than
    // `LOWER(owner) = LOWER($1)` in SQL) keeps the plain btree index usable.
    let owner = request.owner.to_ascii_lowercase();

    if state.config.owner_token_secret.is_empty() {
        // Feature not configured for this deployment (`OWNER_TOKEN_SECRET`
        // unset). Distinct from an auth failure — this is a deployment
        // configuration gap, not a bad caller — so it gets a 503 rather
        // than folding into the bare-401 auth-failure convention used
        // elsewhere in this file.
        return Err(AppError::UpstreamUnavailable(
            "owner-token issuance is not configured".into(),
        ));
    }

    match rate_limit::check_owner_token_owner_rate_limit(
        &state,
        &owner,
        state.config.owner_token_rate_limit.owner_per_minute,
        state.config.owner_token_rate_limit.owner_per_hour,
    )
    .await
    {
        Ok(SponsorRlResult::Allowed) => {}
        Ok(SponsorRlResult::MinuteLimitExceeded) | Ok(SponsorRlResult::HourLimitExceeded) => {
            return Err(AppError::RateLimited(
                "too many owner-token requests for this owner; retry later".into(),
            ));
        }
        Err(()) => {
            return Err(AppError::UpstreamUnavailable(
                "rate limiter temporarily unavailable".into(),
            ));
        }
    }

    // Design decision (flagged for review, not explicitly demanded by the
    // WALM-297 ticket's literal ACs): reject up front, with 400, when the
    // owner has no MemWalAccount at all, rather than minting a token for a
    // nonexistent account. Justification: a token scoped to an address with
    // no account is nonsensical — every real read route it would be used
    // against is itself scoped to an existing account's data — and this
    // mirrors WALM-298's own `GET /api/accounts/{owner}/exists` design
    // (an explicit existence-check primitive Console is expected to use
    // before this call anyway). Reuses the exact same DB helper accounts.rs
    // calls (`db.find_account_by_owner`), not a second implementation.
    let exists = state.db.find_account_by_owner(&owner).await?.is_some();
    if !exists {
        return Err(AppError::BadRequest("owner has no MemWalAccount".into()));
    }

    let now = chrono::Utc::now().timestamp();
    let ttl = state.config.owner_token_ttl_secs;
    let token =
        owner_token_auth::mint_token(state.config.owner_token_secret.as_bytes(), &owner, ttl, now);
    let expires_at =
        chrono::DateTime::<chrono::Utc>::from_timestamp(now.saturating_add(ttl as i64), 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    Ok(Json(IssueOwnerTokenResponse {
        token,
        expires_at,
        permissions: vec![PERMISSION_MEMORIES_READ.to_string()],
    }))
}

// ============================================================
// GET /v1/owners/{owner}/_token_probe
// ============================================================

#[derive(Debug, Serialize)]
pub struct TokenProbeResponse {
    pub ok: bool,
    pub owner: String,
    pub permissions: Vec<String>,
}

/// `GET /v1/owners/{owner}/_token_probe` — minimal token-gated route.
///
/// This route exists SPECIFICALLY so owner-token auth is testable
/// end-to-end in this branch even though PR #537 (WALM-295)'s real
/// `GET /v1/owners/{owner}/{namespaces,memories,agents}` handlers aren't
/// present here (this is a fresh branch off `dev`). It is not itself a
/// WALM-295 read endpoint. Wiring the `OwnerToken` extractor into the real
/// handlers is the small follow-up once this branch merges with / rebases
/// onto PR #537's branch — this handler is the template for that: extract
/// `OwnerToken`, compare the `{owner}` path segment against
/// `claims.owner_address` via `same_owner` (403 on mismatch), and check the
/// required permission string is present in `claims.permissions` (403
/// "insufficient scope" if not).
///
/// No separate rate-limit / auth middleware needed here — `OwnerToken` is a
/// pure `FromRequestParts` extractor, so axum resolves it (and rejects
/// unauthenticated calls) before this handler body ever runs.
pub async fn token_probe(
    OwnerToken(claims): OwnerToken,
    Path(owner): Path<String>,
) -> Result<Json<TokenProbeResponse>, StatusCode> {
    // Reuse `security_delete_auth::same_owner` (WALM-295's memory_read.rs
    // does not exist in this branch to grep — see module doc — but
    // `security_delete_auth.rs` already has the identical canonical-address
    // comparison helper) rather than writing a second implementation.
    if !same_owner(Some(owner.as_str()), &claims.owner_address) {
        return Err(StatusCode::FORBIDDEN);
    }
    // Trivially always true in Phase 1 (only `memories.read` is ever
    // minted — see `owner_token_auth::mint_token`), but wired as a real
    // check against `claims.permissions` rather than hardcoded so it's not
    // dead code once a future phase mints additional scopes.
    if !claims
        .permissions
        .iter()
        .any(|permission| permission == PERMISSION_MEMORIES_READ)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(TokenProbeResponse {
        ok: true,
        owner: claims.owner_address.clone(),
        permissions: claims.permissions.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_std_eq_semantics() {
        assert!(constant_time_eq(b"same-secret", b"same-secret"));
        assert!(!constant_time_eq(b"same-secret", b"different"));
        assert!(!constant_time_eq(b"short", b"a-much-longer-value"));
        assert!(!constant_time_eq(b"", b"nonempty"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn service_credential_header_name_is_lowercase_x_prefixed() {
        // Header name comparisons in `HeaderMap::get` are already
        // case-insensitive, but keep the constant itself lowercase to match
        // every other custom header in this crate (`x-public-key`,
        // `x-signature`, ...).
        assert_eq!(SERVICE_CREDENTIAL_HEADER, "x-service-credential");
        assert!(SERVICE_CREDENTIAL_HEADER.starts_with("x-"));
        assert_eq!(
            SERVICE_CREDENTIAL_HEADER,
            SERVICE_CREDENTIAL_HEADER.to_ascii_lowercase()
        );
    }
}
