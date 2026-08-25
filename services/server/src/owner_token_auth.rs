//! Owner-scoped bearer tokens for the read API (phase 1).
//!
//! Console proves control of a WM owner address entirely on its own side
//! (via Enoki Connect or a wallet signature — WM is never involved in that
//! proof). Once Console has done so, it calls `POST /v1/owner-tokens`
//! (see `routes::owner_token`), authenticating itself as a legitimate
//! client via the **service credential** (one static shared
//! secret WM hands Console — see `routes::owner_token::SERVICE_CREDENTIAL_HEADER`),
//! to mint a short-lived bearer token scoped to that owner. Console then
//! presents that token as `Authorization: Bearer <token>` to WM's owner-
//! scoped read routes (`GET /v1/owners/{owner}/...`).
//!
//! This module is deliberately modeled on `security_delete_auth.rs`'s
//! `mint_token`/`verify_token`/`SdOwner` triad — same HMAC-SHA256
//! construction, same base64 encoding, same `FromRequestParts` extractor
//! pattern — rather than inventing a new token format. The two differ only
//! in claims shape and in what they're used for: `security_delete_auth`
//! tokens gate a destructive, wallet-signature-authenticated flow;
//! `OwnerToken`s gate a read-only flow whose caller (Console) authenticates
//! via the service credential instead of a wallet signature.

use std::sync::Arc;

use axum::extract::{FromRef, FromRequestParts};
use axum::http::{header, request::Parts};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::types::AppState;

type HmacSha256 = Hmac<Sha256>;

/// Fixed audience value stamped into every minted token and checked on
/// verify. Rejecting a mismatched audience up front means this signing
/// secret can never be reused to forge a token for a different token
/// family that might one day share the same HMAC key by operator mistake.
pub const OWNER_TOKEN_AUDIENCE: &str = "memwal";

/// Fixed subject value: the token's issuer/client identity (Console),
/// **not** a user or the owner address. Every Phase 1 token has this exact
/// subject, since Console is the only client of this endpoint.
pub const OWNER_TOKEN_SUBJECT: &str = "console";

/// Phase 1 mints exactly this one permission, always. `OwnerTokenClaims`
/// still carries a `Vec<String>` (rather than a single fixed field) so a
/// future phase can widen the granted scopes without a claims-shape
/// migration.
pub const PERMISSION_MEMORIES_READ: &str = "memories.read";

/// Claims embedded in an owner-scoped bearer token:
/// subject · owner_address · audience · issued_at · expires_at ·
/// nonce · permissions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OwnerTokenClaims {
    /// The token's issuer/client identity — always `"console"` in Phase 1
    /// (see [`OWNER_TOKEN_SUBJECT`]). This is who the token was issued
    /// *to*, not who it's scoped *for* — that's `owner_address`.
    pub subject: String,
    /// The WM owner (Sui) address this token authorizes read access for,
    /// in canonical lowercase-hex form (the route handler canonicalizes
    /// before minting — see `routes::owner_token::issue_token`).
    pub owner_address: String,
    /// Fixed to [`OWNER_TOKEN_AUDIENCE`] (`"memwal"`). Checked on verify.
    pub audience: String,
    /// Unix timestamp (seconds) the token was minted at.
    pub issued_at: i64,
    /// Unix timestamp (seconds) after which the token is no longer valid.
    pub expires_at: i64,
    /// Unique per-token identifier (UUID v4), generated fresh at mint time.
    ///
    /// **Design note (deliberately NOT a single-use replay guard):** the
    /// name suggests replay prevention, which is the right instinct for the
    /// *signed-request* scheme this bridges from
    /// (`auth::verify_signature`'s `x-nonce`, single-use-checked against
    /// Redis on the owner-scoped read routes) — there, a nonce stops one
    /// specific signed HTTP request from being captured and replayed.
    ///
    /// But an owner-scoped token is a **bearer** token: it is minted once
    /// and is *meant* to be reused across many `GET
    /// /v1/owners/{owner}/...` calls for its whole TTL window. Treating
    /// `nonce` as single-use (checked against a Redis "seen" set, rejected
    /// on the second request) would defeat that — the token would only
    /// ever authorize exactly one read, which is not what a "short-lived
    /// bearer token scoped to Y" means.
    ///
    /// So `nonce` here is **not** checked against any single-use tracking
    /// set in Phase 1. Its purpose is:
    ///   1. **Forward compatibility for revocation** — a specific
    ///      compromised/misissued token's nonce could be added to a
    ///      future Redis blocklist without invalidating every other token
    ///      for that owner (which revoking by `owner_address` alone would
    ///      do).
    ///   2. **Observability** — logging `nonce` alongside each read lets
    ///      an operator trace which minted token served which request,
    ///      without logging the token itself.
    ///
    /// Spelled out here because "nonce" almost always means single-use, and
    /// a reader who assumes that would file the absence of a Redis check as
    /// a bug rather than the deliberate choice it is.
    pub nonce: String,
    /// Granted scopes. Phase 1 always mints exactly `["memories.read"]`
    /// (see [`PERMISSION_MEMORIES_READ`]); modeled as a `Vec<String>` so
    /// additional scopes can be added later without a claims migration.
    pub permissions: Vec<String>,
}

/// Rejection type for owner-token verification failures (bad signature,
/// expired, malformed, wrong audience) and for the [`OwnerToken`]
/// extractor. Deliberately carries no detail in its `IntoResponse` output:
/// mirrors this crate's existing convention for auth failures (see
/// `auth::verify_signature`'s bare `StatusCode::UNAUTHORIZED` rejections)
/// of collapsing every failure mode to a bare 401 so a caller cannot
/// distinguish "expired" from "wrong secret" from "malformed" by response
/// content.
#[derive(Debug)]
pub struct OwnerTokenError;

impl axum::response::IntoResponse for OwnerTokenError {
    fn into_response(self) -> axum::response::Response {
        axum::http::StatusCode::UNAUTHORIZED.into_response()
    }
}

/// Serialize + HMAC-sign claims into the wire token format:
/// `"{base64url(json claims)}.{base64url(hmac-sha256 signature)}"`.
/// Factored out of [`mint_token`] so tests can construct a token from
/// hand-built claims (e.g. a claims payload with a tampered audience) that
/// [`mint_token`]'s fixed-shape signature can't express.
fn encode_and_sign(secret: &[u8], claims: &OwnerTokenClaims) -> String {
    let payload = serde_json::to_vec(claims).expect("owner token claims serialize");
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key size");
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{signature}")
}

/// Mint a fresh owner-scoped bearer token. `owner` is stored verbatim into
/// `owner_address` — callers must canonicalize (lowercase / validate) the
/// address themselves first, exactly as `security_delete_auth::verify`
/// canonicalizes before calling its `mint_token`. `permissions` is always
/// exactly `["memories.read"]` in Phase 1.
pub fn mint_token(secret: &[u8], owner: &str, ttl_secs: u64, now_unix: i64) -> String {
    let claims = OwnerTokenClaims {
        subject: OWNER_TOKEN_SUBJECT.to_string(),
        owner_address: owner.to_owned(),
        audience: OWNER_TOKEN_AUDIENCE.to_string(),
        issued_at: now_unix,
        expires_at: now_unix.saturating_add(ttl_secs as i64),
        nonce: Uuid::new_v4().to_string(),
        permissions: vec![PERMISSION_MEMORIES_READ.to_string()],
    };
    encode_and_sign(secret, &claims)
}

/// Verify an owner-scoped bearer token's signature, expiry, and audience,
/// returning its claims on success. Mirrors
/// `security_delete_auth::verify_token`'s exact HMAC verification shape
/// (split on `.`, reject a second `.` in the signature half, base64-decode,
/// `verify_slice`, then decode + validate the payload).
pub fn verify_token(
    secret: &[u8],
    token: &str,
    now_unix: i64,
) -> Result<OwnerTokenClaims, OwnerTokenError> {
    let (payload, signature) = token.split_once('.').ok_or(OwnerTokenError)?;
    if signature.contains('.') {
        return Err(OwnerTokenError);
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| OwnerTokenError)?;
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| OwnerTokenError)?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&signature_bytes)
        .map_err(|_| OwnerTokenError)?;
    let claims: OwnerTokenClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| OwnerTokenError)?,
    )
    .map_err(|_| OwnerTokenError)?;
    if claims.expires_at <= now_unix {
        return Err(OwnerTokenError);
    }
    if claims.audience != OWNER_TOKEN_AUDIENCE {
        return Err(OwnerTokenError);
    }
    Ok(claims)
}

/// Verified claims for an owner-scoped bearer token, extracted from the
/// `Authorization: Bearer <token>` header. Mirrors `SdOwner` in
/// `security_delete_auth.rs`: a thin newtype `FromRequestParts` extractor
/// that reads the header, verifies against the configured secret + current
/// time, and yields the parsed claims (or the 401-style [`OwnerTokenError`]
/// rejection) directly — no separate middleware layer needed since axum
/// runs per-handler extractors before the handler body.
pub struct OwnerToken(pub OwnerTokenClaims);

impl<S> FromRequestParts<S> for OwnerToken
where
    S: Send + Sync,
    Arc<AppState>: FromRef<S>,
{
    type Rejection = OwnerTokenError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = Arc::<AppState>::from_ref(state);
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(OwnerTokenError)?;
        // An empty configured secret means owner-token issuance was never
        // configured for this deployment (`OWNER_TOKEN_SECRET` unset — see
        // `Config::owner_token_secret`). HMAC-SHA256 accepts an empty key
        // like any other, so without this guard a caller who *knows* the
        // deployment is unconfigured could forge a valid signature using
        // the well-known empty key. Fail closed instead of trusting an
        // empty secret to behave like "no valid token can ever exist".
        if state.config.owner_token_secret.is_empty() {
            return Err(OwnerTokenError);
        }
        verify_token(
            state.config.owner_token_secret.as_bytes(),
            token,
            chrono::Utc::now().timestamp(),
        )
        .map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_token_roundtrip() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        let claims = verify_token(b"test-secret", &token, 1_000_100).unwrap();
        assert_eq!(claims.owner_address, "0xabc");
        assert_eq!(claims.subject, OWNER_TOKEN_SUBJECT);
        assert_eq!(claims.audience, OWNER_TOKEN_AUDIENCE);
        assert_eq!(
            claims.permissions,
            vec![PERMISSION_MEMORIES_READ.to_string()]
        );
        assert_eq!(claims.issued_at, 1_000_000);
        assert_eq!(claims.expires_at, 1_000_900);
        assert!(Uuid::parse_str(&claims.nonce).is_ok());
    }

    #[test]
    fn owner_token_expired_rejected() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        assert!(verify_token(b"test-secret", &token, 1_000_901).is_err());
    }

    #[test]
    fn owner_token_expires_at_boundary_is_exclusive() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        // Exactly at expiry is rejected (`<=` in verify_token) ...
        assert!(verify_token(b"test-secret", &token, 1_000_900).is_err());
        // ... one second before is still accepted.
        assert!(verify_token(b"test-secret", &token, 1_000_899).is_ok());
    }

    #[test]
    fn owner_token_wrong_secret_rejected() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        assert!(verify_token(b"other-secret", &token, 1_000_000).is_err());
    }

    #[test]
    fn owner_token_tampered_rejected() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        assert!(verify_token(b"test-secret", &(token + "x"), 1_000_000).is_err());
    }

    #[test]
    fn owner_token_malformed_rejected() {
        assert!(verify_token(b"test-secret", "not-a-token", 1_000_000).is_err());
        assert!(verify_token(b"test-secret", "a.b.c", 1_000_000).is_err());
        assert!(verify_token(b"test-secret", "", 1_000_000).is_err());
    }

    #[test]
    fn owner_token_wrong_audience_rejected() {
        // Hand-build claims with a tampered audience, signed with the
        // otherwise-correct secret, to prove `verify_token` checks
        // `audience` independently of the HMAC signature check.
        let claims = OwnerTokenClaims {
            subject: OWNER_TOKEN_SUBJECT.to_string(),
            owner_address: "0xabc".to_string(),
            audience: "not-memwal".to_string(),
            issued_at: 1_000_000,
            expires_at: 1_000_900,
            nonce: Uuid::new_v4().to_string(),
            permissions: vec![PERMISSION_MEMORIES_READ.to_string()],
        };
        let token = encode_and_sign(b"test-secret", &claims);
        assert!(verify_token(b"test-secret", &token, 1_000_000).is_err());
    }

    #[test]
    fn owner_token_owner_address_roundtrips_exactly() {
        let owner = "0x0000000000000000000000000000000000000000000000000000000000000abc";
        let token = mint_token(b"test-secret", owner, 900, 1_000_000);
        let claims = verify_token(b"test-secret", &token, 1_000_000).unwrap();
        assert_eq!(claims.owner_address, owner);
    }

    #[test]
    fn owner_token_each_mint_gets_a_unique_nonce() {
        let token1 = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        let token2 = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        let claims1 = verify_token(b"test-secret", &token1, 1_000_000).unwrap();
        let claims2 = verify_token(b"test-secret", &token2, 1_000_000).unwrap();
        assert_ne!(claims1.nonce, claims2.nonce);
    }

    #[test]
    fn owner_token_permissions_are_memories_read_only() {
        let token = mint_token(b"test-secret", "0xabc", 900, 1_000_000);
        let claims = verify_token(b"test-secret", &token, 1_000_000).unwrap();
        assert_eq!(claims.permissions.len(), 1);
        assert_eq!(claims.permissions[0], "memories.read");
    }
}
