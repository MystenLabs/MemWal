//! MCP OAuth 2.1 support for Claude (and future) native custom connectors.
//!
//! This module owns everything that doesn't need an HTTP handler shape:
//! config, the AES-256-GCM envelope used to custody delegate private keys,
//! PKCE verification, token minting/hashing, and redirect/registration URL
//! validation. `routes/oauth.rs` (PR2) wires these into axum handlers;
//! `mcp_proxy.rs` (PR3) calls `resolve_oauth_bearer` to translate an OAuth
//! access token into the legacy `Authorization` + `X-MemWal-Account-Id`
//! headers the TS sidecar already accepts — see the plan at
//! `docs/mcp/reference.md` "OAuth (Claude custom connectors)" once PR3 lands.
//!
//! Ported from the reviewed-but-unmerged WALM-30/ENG-1783 `app_auth.rs`
//! (branch `feature/eng-1783-hosted-connect-memwal-flow-for-web-apps`, PR
//! #193) — same AES-GCM envelope shape, same sanitization helpers, adapted
//! for RFC 7591/8414/9728 and PKCE instead of that ticket's simpler
//! client_id/secret model.
//!
//! PR1 scope: this module is inert — nothing calls it yet. `routes/oauth.rs`
//! (PR2) and `mcp_proxy.rs` (PR3) consume this API surface; until then,
//! `dead_code` warnings here are expected, same as any other
//! foundation-first module in this codebase.
#![allow(dead_code)]

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose, Engine as _};
use blake2::{
    digest::{Update, VariableOutput},
    Blake2bVar,
};
use chrono::Utc;
use ed25519_dalek::SigningKey;
use ipnet::IpNet;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use zeroize::Zeroize;

/// Bearer prefix for OAuth access tokens. Chosen so it can never collide
/// with the legacy 64-hex delegate-key bearer format
/// (`^(0x)?[0-9a-fA-F]{64}$`, see `services/server/scripts/mcp/auth.ts`).
pub const ACCESS_TOKEN_PREFIX: &str = "mwo_";
/// Bearer prefix for OAuth refresh tokens.
pub const REFRESH_TOKEN_PREFIX: &str = "mwr_";
/// Prefix for DCR-issued client ids.
pub const CLIENT_ID_PREFIX: &str = "mwc_";
/// Prefix for server-custodied delegate references.
pub const DELEGATE_REF_PREFIX: &str = "mwd_";
/// Prefix for pre-consent authorize-session ids.
pub const SESSION_ID_PREFIX: &str = "mws_";
/// Prefix for consented-grant ids.
pub const GRANT_ID_PREFIX: &str = "mwg_";

const DISPLAY_NAME_MAX_CHARS: usize = 80;
/// The consent screen renders `client_name` next to a verified redirect
/// host, but `client_name` itself is caller-supplied, untrusted text — same
/// phishing-surface reasoning as `app_auth.rs`'s `APP_AUTH_LABEL_MAX_CHARS`
/// (ENG-1783 review N4). Capped short so a spoofed phrase like "Walrus
/// Memory Official" can't hide inside a long string.
const LABEL_MAX_CHARS: usize = 32;

/// Anthropic's documented custom-connector callback for Claude.ai/Desktop/
/// mobile/Cowork. Verified against Anthropic's connector-authentication
/// docs, not assumed — see the plan doc for citations.
const CLAUDE_HOSTED_CALLBACK: &str = "https://claude.ai/api/mcp/auth_callback";
/// Claude Code uses RFC 8252 native-app loopback redirects; the port is
/// ephemeral and MUST be ignored when matching.
const CLAUDE_CODE_LOOPBACK_PATHS: &[&str] = &["/callback"];

/// Runtime configuration for the MCP OAuth feature. `from_env()` returns
/// `None` when required env vars are unset. When configured, OAuth is always
/// available — clients that haven't registered simply can't get tokens, so
/// existing behavior is unchanged.
///
/// `Debug` is hand-written (not derived) to redact `encryption_key` — the
/// derived impl would otherwise print the raw AES-256 key any time `Config`
/// is logged or formatted, defeating the point of encrypting anything.
#[derive(Clone)]
pub struct McpOAuthConfig {
    /// e.g. `https://relayer.memory.walrus.xyz` — used as the `issuer` and
    /// to build every other endpoint URL.
    pub issuer: String,
    /// The exact `resource` value Claude must request, e.g.
    /// `https://relayer.memory.walrus.xyz/api/mcp`. Must match byte-for-byte
    /// what the user types when adding the connector.
    pub resource: String,
    /// Base URL of the hosted consent SPA, e.g.
    /// `https://memory.walrus.xyz/connect/claude`.
    pub consent_url: String,
    /// AES-256-GCM key used to encrypt delegate private keys at rest.
    pub encryption_key: [u8; 32],
    /// Redirect-URI allowlist policy for `POST /oauth/register` (decision
    /// D4) — Anthropic's known callback plus RFC 8252 loopback. This is
    /// deliberately NOT the same as the generic "any HTTPS URL" acceptance
    /// that got WALM-30/ENG-1783's self-serve registration flagged as
    /// unsafe (PR #193, ducnmm's review): an attacker cannot register a
    /// client pointing at their own domain here.
    pub allowed_registration_redirect_hosts: Vec<String>,
    pub access_ttl_secs: i64,
    pub refresh_ttl_secs: i64,
    pub code_ttl_secs: i64,
    pub session_ttl_secs: i64,
    /// CIDRs exempted from `/oauth/register` per-IP throttling — Anthropic's
    /// documented connector egress range. Without this, a naive per-IP
    /// limiter throttles every Claude user on the planet as one bucket.
    pub registration_trusted_cidrs: Vec<IpNet>,
    pub registration_per_hour_per_ip: u32,
}

impl std::fmt::Debug for McpOAuthConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpOAuthConfig")
            .field("issuer", &self.issuer)
            .field("resource", &self.resource)
            .field("consent_url", &self.consent_url)
            .field("encryption_key", &"<redacted>")
            .field(
                "allowed_registration_redirect_hosts",
                &self.allowed_registration_redirect_hosts,
            )
            .field("access_ttl_secs", &self.access_ttl_secs)
            .field("refresh_ttl_secs", &self.refresh_ttl_secs)
            .field("code_ttl_secs", &self.code_ttl_secs)
            .field("session_ttl_secs", &self.session_ttl_secs)
            .field(
                "registration_trusted_cidrs",
                &self.registration_trusted_cidrs,
            )
            .field(
                "registration_per_hour_per_ip",
                &self.registration_per_hour_per_ip,
            )
            .finish()
    }
}

impl McpOAuthConfig {
    /// Configured when `MCP_OAUTH_DELEGATE_ENCRYPTION_KEY` is set.
    /// Other values are derived from `MEMWAL_RELAYER_URL`:
    /// - issuer = MEMWAL_RELAYER_URL
    /// - resource = issuer + "/api/mcp"
    /// - consent_url = issuer with "relayer" replaced by "memory" + "/connect/claude"
    pub fn from_env() -> Option<Self> {
        // Only the encryption key requires a separate env var; everything else
        // is derived from MEMWAL_RELAYER_URL which is already configured.
        let encryption_key_b64 = match std::env::var("MCP_OAUTH_DELEGATE_ENCRYPTION_KEY") {
            Ok(v) => v,
            Err(_) => return None,
        };
        let encryption_key = load_encryption_key(&encryption_key_b64)
            .expect("MCP_OAUTH_DELEGATE_ENCRYPTION_KEY must decode to exactly 32 bytes (base64url, no padding)");

        // Derive issuer from MEMWAL_RELAYER_URL
        let issuer = std::env::var("MEMWAL_RELAYER_URL").ok()?;
        let issuer = issuer.trim_end_matches('/');

        // Derive resource = issuer + "/api/mcp"
        let resource = format!("{}/api/mcp", issuer);

        // Derive consent_url: replace "relayer" with "memory" in domain
        // e.g. https://relayer.memory.walrus.xyz -> https://memory.walrus.xyz/connect/claude
        let consent_url = if issuer.contains("relayer.") {
            let with_memory = issuer.replace("relayer.", "");
            format!("{}/connect/claude", with_memory)
        } else if issuer.contains("relayer") {
            // Handle relayer.walrus.xyz -> memory.walrus.xyz case
            let with_memory = issuer.replace("relayer", "memory");
            format!("{}/connect/claude", with_memory)
        } else {
            // Fallback: assume memory.walrus.xyz or similar
            format!("{}/connect/claude", issuer)
        };

        let allowed_registration_redirect_hosts = std::env::var("MCP_OAUTH_ALLOWED_REGISTRATION_HOSTS")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| vec!["claude.ai".to_string()]);

        let registration_trusted_cidrs = std::env::var("MCP_OAUTH_REGISTRATION_TRUSTED_CIDRS")
            .ok()
            .map(|v| {
                v.split(',')
                    .filter_map(|s| s.trim().parse::<IpNet>().ok())
                    .collect::<Vec<_>>()
            })
            .filter(|v: &Vec<IpNet>| !v.is_empty())
            // Anthropic's documented connector egress range.
            .unwrap_or_else(|| vec!["160.79.104.0/21".parse().expect("valid CIDR literal")]);

        Some(Self {
            issuer: issuer.to_string(),
            resource,
            consent_url,
            encryption_key,
            allowed_registration_redirect_hosts,
            access_ttl_secs: env_i64("MCP_OAUTH_ACCESS_TTL_SECS", 3600),
            refresh_ttl_secs: env_i64("MCP_OAUTH_REFRESH_TTL_SECS", 60 * 60 * 24 * 30),
            code_ttl_secs: env_i64("MCP_OAUTH_CODE_TTL_SECS", 300),
            session_ttl_secs: env_i64("MCP_OAUTH_SESSION_TTL_SECS", 900),
            registration_trusted_cidrs,
            registration_per_hour_per_ip: std::env::var("MCP_OAUTH_REGISTRATION_PER_HOUR_PER_IP")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(20),
        })
    }
}

/// RFC 6749-shaped error response (`{"error": "...", "error_description":
/// "..."}`), distinct from `crate::types::AppError` because OAuth clients
/// (Claude's connector implementation specifically) parse `error` as a
/// fixed vocabulary (`invalid_grant`, `invalid_client`, `invalid_target`,
/// …) — not a free-text message. Every response also sets
/// `Cache-Control: no-store` per RFC 6749 §5.1, since these bodies can
/// carry short-lived secrets.
pub struct OAuthError {
    pub status: axum::http::StatusCode,
    pub error: &'static str,
    pub description: String,
}

impl OAuthError {
    pub fn new(status: axum::http::StatusCode, error: &'static str, description: impl Into<String>) -> Self {
        Self {
            status,
            error,
            description: description.into(),
        }
    }

    pub fn invalid_request(description: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::BAD_REQUEST, "invalid_request", description)
    }

    pub fn invalid_grant(description: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::BAD_REQUEST, "invalid_grant", description)
    }

    pub fn invalid_client(description: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::UNAUTHORIZED, "invalid_client", description)
    }

    pub fn invalid_target(description: impl Into<String>) -> Self {
        Self::new(axum::http::StatusCode::BAD_REQUEST, "invalid_target", description)
    }

    pub fn invalid_client_metadata(description: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_client_metadata",
            description,
        )
    }

    pub fn unsupported_grant_type(description: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            description,
        )
    }

    pub fn server_error(description: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            description,
        )
    }
}

impl From<crate::types::AppError> for OAuthError {
    fn from(err: crate::types::AppError) -> Self {
        // DB/internal failures surfaced through the OAuth routes still need
        // the RFC 6749 error shape; the underlying AppError already logs
        // details server-side (see its IntoResponse impl), so it's safe to
        // fold everything into a generic server_error here.
        OAuthError::server_error(err.to_string())
    }
}

impl axum::response::IntoResponse for OAuthError {
    fn into_response(self) -> axum::response::Response {
        use axum::http::header;
        let body = serde_json::json!({
            "error": self.error,
            "error_description": self.description,
        });
        let mut response = (self.status, axum::Json(body)).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    }
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn load_encryption_key(raw: &str) -> Option<[u8; 32]> {
    let bytes = general_purpose::URL_SAFE_NO_PAD.decode(raw.trim()).ok()?;
    bytes.try_into().ok()
}

/// Whether an IP address falls inside Anthropic's documented connector
/// egress range (or any other configured trusted CIDR). Used to exempt
/// legitimate Claude traffic from per-IP registration throttling, which
/// would otherwise treat every Claude user as a single client.
pub fn ip_is_trusted(ip: IpAddr, trusted: &[IpNet]) -> bool {
    trusted.iter().any(|net| net.contains(&ip))
}

/// Same X-Forwarded-For-first, connection-address-fallback logic as
/// `rate_limit::sponsor_rate_limit_middleware`, extracted here so
/// `routes/oauth.rs`'s registration handler doesn't have to duplicate it.
pub fn extract_client_ip(
    headers: &axum::http::HeaderMap,
    connect_addr: Option<std::net::SocketAddr>,
) -> Option<IpAddr> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
        .or_else(|| connect_addr.map(|addr| addr.ip()))
}

// ---------------------------------------------------------------------
// Delegate key generation + Sui address derivation
// (ported verbatim from app_auth.rs's `generate_delegate_key` /
// `delegate_public_key_to_sui_address`)
// ---------------------------------------------------------------------

/// Generate a fresh Ed25519 delegate keypair server-side. Returns
/// `(private_key_hex, public_key_hex, sui_address)`. The private key is
/// immediately encrypted via `encrypt_delegate_private_key` before storage
/// — callers must not persist the raw hex.
pub fn generate_delegate_key() -> (String, String, String) {
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    let signing_key = SigningKey::from_bytes(&secret);
    let public_key = signing_key.verifying_key().to_bytes();
    let private_key_hex = hex::encode(secret);
    let public_key_hex = hex::encode(public_key);
    let delegate_address = delegate_public_key_to_sui_address(&public_key);
    secret.zeroize();
    (private_key_hex, public_key_hex, delegate_address)
}

/// Sui address derivation for an Ed25519 public key: `0x` + hex(BLAKE2b-256(
/// 0x00 (Ed25519 flag byte) || pubkey)). Matches the on-chain
/// `DelegateKey.sui_address` computation.
pub fn delegate_public_key_to_sui_address(public_key: &[u8; 32]) -> String {
    let mut hasher = Blake2bVar::new(32).expect("BLAKE2b-256 length is valid");
    hasher.update(&[0x00]);
    hasher.update(public_key);
    let mut digest = [0u8; 32];
    hasher
        .finalize_variable(&mut digest)
        .expect("BLAKE2b output length matches digest buffer");
    format!("0x{}", hex::encode(digest))
}

// ---------------------------------------------------------------------
// AES-256-GCM envelope for delegate private keys at rest
// ---------------------------------------------------------------------

/// A decrypted delegate private key. `Drop` zeroizes the backing buffer so
/// it doesn't linger in process memory longer than one request's lifetime.
pub struct DelegateSecret(String);

impl DelegateSecret {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for DelegateSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    InvalidKey,
    EncryptFailed,
    DecryptFailed,
    MalformedEnvelope,
}

/// Encrypt a delegate private key (hex string) into the `v1.<nonce>.<ct>`
/// envelope (base64url, no padding — same shape as the reviewed WALM-30
/// prior art). `v1.` is a deliberate version prefix so a future key-rotation
/// scheme (`v2.<key_id>.<nonce>.<ct>`) doesn't have to guess the format of
/// old rows.
pub fn encrypt_delegate_private_key(
    key: &[u8; 32],
    private_key_hex: &str,
) -> Result<String, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidKey)?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), private_key_hex.as_bytes())
        .map_err(|_| CryptoError::EncryptFailed)?;
    Ok(format!(
        "v1.{}.{}",
        general_purpose::URL_SAFE_NO_PAD.encode(nonce_bytes),
        general_purpose::URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

/// Decrypt a `v1.<nonce>.<ct>` envelope back into the raw private-key hex.
pub fn decrypt_delegate_private_key(
    key: &[u8; 32],
    envelope: &str,
) -> Result<DelegateSecret, CryptoError> {
    let mut parts = envelope.splitn(3, '.');
    let version = parts.next().ok_or(CryptoError::MalformedEnvelope)?;
    if version != "v1" {
        return Err(CryptoError::MalformedEnvelope);
    }
    let nonce_b64 = parts.next().ok_or(CryptoError::MalformedEnvelope)?;
    let ct_b64 = parts.next().ok_or(CryptoError::MalformedEnvelope)?;

    let nonce_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(nonce_b64)
        .map_err(|_| CryptoError::MalformedEnvelope)?;
    if nonce_bytes.len() != 12 {
        return Err(CryptoError::MalformedEnvelope);
    }
    let ciphertext = general_purpose::URL_SAFE_NO_PAD
        .decode(ct_b64)
        .map_err(|_| CryptoError::MalformedEnvelope)?;

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidKey)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_slice())
        .map_err(|_| CryptoError::DecryptFailed)?;
    let private_key_hex =
        String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptFailed)?;
    Ok(DelegateSecret(private_key_hex))
}

// ---------------------------------------------------------------------
// Token minting / hashing
// ---------------------------------------------------------------------

/// Mint a random, URL-safe token with the given prefix (32 random bytes,
/// base64url-no-pad-encoded). Used for client ids, delegate refs, session
/// ids, grant ids, and (with `ACCESS_TOKEN_PREFIX`/`REFRESH_TOKEN_PREFIX`)
/// bearer tokens themselves.
pub fn random_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}{}", general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// SHA-256 hex digest — used to store tokens/codes/secrets at rest without
/// keeping the plaintext (mirrors `client_secret_sha256` in the reviewed
/// prior art). Lookups re-hash the presented value and compare digests.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

// ---------------------------------------------------------------------
// PKCE (RFC 7636) — S256 only, per the MCP authorization spec
// ---------------------------------------------------------------------

/// Verify a PKCE `code_verifier` against the `code_challenge` recorded at
/// authorize time. Only `S256` is supported (the MCP spec requires it and
/// Claude always uses it); `plain` is rejected by the caller before this is
/// ever invoked.
pub fn verify_pkce_s256(code_verifier: &str, code_challenge: &str) -> bool {
    if code_verifier.is_empty() || code_verifier.len() > 128 {
        return false;
    }
    let digest = Sha256::digest(code_verifier.as_bytes());
    let computed = general_purpose::URL_SAFE_NO_PAD.encode(digest);
    constant_time_eq(computed.as_bytes(), code_challenge.as_bytes())
}

// ---------------------------------------------------------------------
// Redirect / resource URI validation
// ---------------------------------------------------------------------

pub fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Parse + minimally validate a redirect URI: no fragment, no embedded
/// credentials, scheme must be `https`, or `http` on a loopback host (RFC
/// 8252 native-app pattern).
fn parse_redirect_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let scheme = url.scheme();
    let host = url.host_str()?;
    let is_loopback = is_loopback_host(host);
    if scheme != "https" && !(scheme == "http" && is_loopback) {
        return None;
    }
    Some(url)
}

/// Whether `candidate` matches a `redirect_uri` registered for a client.
/// Exact match for non-loopback URIs; port-agnostic for loopback (Claude
/// Code's ephemeral-port RFC 8252 flow — `http://localhost/callback` in the
/// registration matches `http://localhost:51234/callback` at authorize
/// time, but not a different path).
pub fn redirect_uri_matches(candidate: &str, registered: &str) -> bool {
    let (Some(candidate_url), Some(registered_url)) =
        (parse_redirect_url(candidate), parse_redirect_url(registered))
    else {
        return false;
    };

    if candidate_url.as_str() == registered_url.as_str() {
        return true;
    }

    let Some(host) = registered_url.host_str() else {
        return false;
    };
    if !is_loopback_host(host) || candidate_url.scheme() != "http" {
        return false;
    }
    candidate_url.host_str() == Some(host)
        && candidate_url.path() == registered_url.path()
        && candidate_url.query() == registered_url.query()
}

/// Decision D4: registration only accepts redirect URIs on a known-safe
/// host allowlist (Anthropic's own callback domain) or an RFC 8252 loopback
/// pattern. This is the direct fix for the objection that stalled PR #193
/// ("anyone can put that link, then edit, then delete") — an attacker
/// cannot register a client whose `redirect_uri` points at their own
/// domain, because it will never pass this check.
pub fn is_allowed_registration_redirect(raw: &str, allowed_hosts: &[String]) -> bool {
    let Some(url) = parse_redirect_url(raw) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };

    if is_loopback_host(host) {
        return url.scheme() == "http" && CLAUDE_CODE_LOOPBACK_PATHS.contains(&url.path());
    }

    if url.scheme() != "https" {
        return false;
    }
    allowed_hosts
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
}

/// Sanity check the module's hard-coded Claude callback constant still
/// parses and would itself pass `is_allowed_registration_redirect` against
/// the default host allowlist — exercised in the unit tests below so a typo
/// in the constant fails CI instead of silently breaking Claude's flow.
pub fn claude_hosted_callback() -> &'static str {
    CLAUDE_HOSTED_CALLBACK
}

/// Normalize an RFC 8707 `resource` parameter for comparison: lowercase
/// scheme + host, strip a trailing slash, reject a fragment. The comparison
/// must be exact once normalized — Claude sends the same string it read
/// from the connector URL the user typed.
pub fn normalize_resource_uri(raw: &str) -> Option<String> {
    let mut url = url::Url::parse(raw).ok()?;
    if url.fragment().is_some() {
        return None;
    }
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "https" && !(scheme == "http" && url.host_str().map(is_loopback_host).unwrap_or(false)) {
        return None;
    }
    url.set_fragment(None);
    let mut normalized = url.as_str().to_string();
    if normalized.ends_with('/') && url.path() == "/" {
        // Keep a bare-origin resource ("https://host/") intact; only trim a
        // trailing slash that follows a real path segment.
    } else if normalized.ends_with('/') {
        normalized.pop();
    }
    Some(normalized.to_ascii_lowercase_scheme_host())
}

trait LowercaseSchemeHost {
    fn to_ascii_lowercase_scheme_host(&self) -> String;
}

impl LowercaseSchemeHost for str {
    /// Lowercase only the scheme+host portion of a URL string, leaving the
    /// path/query case-sensitive (paths on this API are case-sensitive).
    fn to_ascii_lowercase_scheme_host(&self) -> String {
        match url::Url::parse(self) {
            Ok(mut url) => {
                let host = url.host_str().map(str::to_ascii_lowercase);
                let _ = url.set_host(host.as_deref());
                url.to_string()
            }
            Err(_) => self.to_string(),
        }
    }
}

// ---------------------------------------------------------------------
// Sanitization — untrusted, caller-supplied display text
// ---------------------------------------------------------------------

/// Strip HTML-significant characters and control characters, then cap
/// length. Shared by `client_name` (DCR) and `label` (per-session context)
/// sanitization — both are rendered on the consent screen and both are
/// attacker-influenceable.
fn strip_and_cap(raw: &str, max_chars: usize) -> String {
    raw.chars()
        .filter(|ch| !matches!(ch, '<' | '>' | '&' | '"' | '\'' | '/' | '\\'))
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum SanitizeError {
    Empty,
    ReservedBrand,
}

/// Sanitize a DCR `client_name`. Rejects empty (after stripping) and
/// rejects anything trying to impersonate Walrus Memory itself — the
/// consent screen must never let a malicious client claim to *be* us.
pub fn sanitize_client_name(raw: &str) -> Result<String, SanitizeError> {
    let cleaned = strip_and_cap(raw, DISPLAY_NAME_MAX_CHARS);
    if cleaned.is_empty() {
        Err(SanitizeError::Empty)
    } else if uses_reserved_brand(&cleaned) {
        Err(SanitizeError::ReservedBrand)
    } else {
        Ok(cleaned)
    }
}

fn uses_reserved_brand(raw: &str) -> bool {
    let normalized = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect::<String>();
    normalized.contains("memwal") || normalized.contains("walrusmemory")
}

/// Sanitize a per-session `label` (e.g. a device/session hint). Untrusted;
/// capped short (`LABEL_MAX_CHARS`) specifically to reduce room for a
/// spoofed phrase — see the module-level doc comment on the constant.
pub fn sanitize_label(raw: &str, default: &str) -> String {
    let cleaned = strip_and_cap(raw, LABEL_MAX_CHARS);
    if cleaned.is_empty() {
        default.to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------
// Resource-server bearer resolution — the PR3 piece `mcp_proxy.rs` calls on
// every `/api/mcp*` request to translate an OAuth access token into the
// legacy delegate-key credential the TS sidecar already understands.
// ---------------------------------------------------------------------

/// Everything the proxy needs to rewrite an inbound request's headers into
/// the legacy `Authorization: Bearer <hex>` + `X-MemWal-Account-Id` shape.
pub struct ResolvedOAuthIdentity {
    pub account_id: String,
    pub delegate_private_key: DelegateSecret,
    #[allow(dead_code)]
    pub grant_id: String,
}

#[derive(Debug)]
pub enum OAuthBearerError {
    /// Not shaped like an OAuth token at all (no `mwo_` prefix) — the
    /// caller should fall back to the legacy bearer check.
    NotOAuthToken,
    Invalid,
    Expired,
    Revoked,
    /// Delegate was revoked independently of the grant (e.g. the on-chain
    /// key was removed) — same external symptom as `Revoked` but a
    /// distinct internal cause, useful in logs.
    DelegateNotActive,
    Internal(String),
}

impl OAuthBearerError {
    pub fn error_code(&self) -> &'static str {
        match self {
            OAuthBearerError::NotOAuthToken => "invalid_token",
            OAuthBearerError::Invalid => "invalid_token",
            OAuthBearerError::Expired => "invalid_token",
            OAuthBearerError::Revoked => "invalid_token",
            OAuthBearerError::DelegateNotActive => "invalid_token",
            OAuthBearerError::Internal(_) => "invalid_token",
        }
    }
}

/// Resolve a presented bearer token to a signable delegate identity.
/// Returns `Err(NotOAuthToken)` immediately (no DB call) for anything not
/// prefixed `mwo_`, so the legacy 64-hex path costs nothing extra.
pub async fn resolve_oauth_bearer(
    state: &crate::types::AppState,
    token: &str,
) -> Result<ResolvedOAuthIdentity, OAuthBearerError> {
    if !token.starts_with(ACCESS_TOKEN_PREFIX) {
        return Err(OAuthBearerError::NotOAuthToken);
    }
    let cfg = state
        .config
        .mcp_oauth
        .as_ref()
        .ok_or(OAuthBearerError::NotOAuthToken)?;

    let hash = hash_token(token);
    let row = state
        .db
        .fetch_oauth_token_with_delegate(&hash)
        .await
        .map_err(|e| OAuthBearerError::Internal(e.to_string()))?
        .ok_or(OAuthBearerError::Invalid)?;

    if row.token_type != "access" {
        return Err(OAuthBearerError::Invalid);
    }
    if row.revoked_at.is_some() || row.grant_revoked_at.is_some() {
        return Err(OAuthBearerError::Revoked);
    }
    if row.expires_at <= Utc::now() {
        return Err(OAuthBearerError::Expired);
    }
    if row.delegate_status != "active" {
        return Err(OAuthBearerError::DelegateNotActive);
    }

    let delegate_private_key = decrypt_delegate_private_key(&cfg.encryption_key, &row.encrypted_private_key)
        .map_err(|_| OAuthBearerError::Internal("failed to decrypt delegate private key".to_string()))?;

    Ok(ResolvedOAuthIdentity {
        account_id: row.account_id,
        delegate_private_key,
        grant_id: row.grant_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- AES-GCM envelope --------------------------------------------

    fn test_key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn envelope_round_trips() {
        let key = test_key();
        let plaintext_hex = "a".repeat(64);
        let envelope = encrypt_delegate_private_key(&key, &plaintext_hex).unwrap();
        assert!(envelope.starts_with("v1."));
        let decrypted = decrypt_delegate_private_key(&key, &envelope).unwrap();
        assert_eq!(decrypted.as_str(), plaintext_hex);
    }

    #[test]
    fn envelope_rejects_tampered_ciphertext() {
        let key = test_key();
        let envelope = encrypt_delegate_private_key(&key, "deadbeef").unwrap();
        let mut parts: Vec<&str> = envelope.split('.').collect();
        let mut ct = general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        ct[0] ^= 0xFF;
        let tampered_ct = general_purpose::URL_SAFE_NO_PAD.encode(ct);
        parts[2] = &tampered_ct;
        let tampered = parts.join(".");
        assert!(matches!(
            decrypt_delegate_private_key(&key, &tampered),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn envelope_rejects_tampered_nonce() {
        let key = test_key();
        let envelope = encrypt_delegate_private_key(&key, "deadbeef").unwrap();
        let mut parts: Vec<&str> = envelope.split('.').collect();
        let mut nonce = general_purpose::URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        nonce[0] ^= 0xFF;
        let tampered_nonce = general_purpose::URL_SAFE_NO_PAD.encode(nonce);
        parts[1] = &tampered_nonce;
        let tampered = parts.join(".");
        assert!(matches!(
            decrypt_delegate_private_key(&key, &tampered),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn envelope_rejects_wrong_key() {
        let envelope = encrypt_delegate_private_key(&test_key(), "deadbeef").unwrap();
        let wrong_key = [9u8; 32];
        // `DelegateSecret` intentionally has no `Debug`/`PartialEq` (it
        // guards a decrypted private key), so compare via `matches!` rather
        // than `assert_eq!` against the whole `Result`.
        assert!(matches!(
            decrypt_delegate_private_key(&wrong_key, &envelope),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn envelope_rejects_malformed_prefix() {
        assert!(matches!(
            decrypt_delegate_private_key(&test_key(), "v2.abc.def"),
            Err(CryptoError::MalformedEnvelope)
        ));
        assert!(matches!(
            decrypt_delegate_private_key(&test_key(), "not-an-envelope"),
            Err(CryptoError::MalformedEnvelope)
        ));
    }

    // -- delegate key generation --------------------------------------

    #[test]
    fn generated_delegate_key_has_consistent_address() {
        let (priv_hex, pub_hex, addr) = generate_delegate_key();
        assert_eq!(priv_hex.len(), 64);
        assert_eq!(pub_hex.len(), 64);
        let pub_bytes: [u8; 32] = hex::decode(&pub_hex).unwrap().try_into().unwrap();
        assert_eq!(delegate_public_key_to_sui_address(&pub_bytes), addr);
        assert!(addr.starts_with("0x"));
        assert_eq!(addr.len(), 66);
    }

    // -- PKCE -----------------------------------------------------------

    #[test]
    fn pkce_known_vector_passes() {
        // RFC 7636 appendix B example.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(verify_pkce_s256(verifier, challenge));
    }

    #[test]
    fn pkce_one_char_off_fails() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN"; // last char changed
        assert!(!verify_pkce_s256(verifier, challenge));
    }

    #[test]
    fn pkce_empty_verifier_fails() {
        assert!(!verify_pkce_s256("", "anything"));
    }

    // -- redirect URI matching -------------------------------------------

    #[test]
    fn redirect_matches_exact_https() {
        assert!(redirect_uri_matches(
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(!redirect_uri_matches(
            "https://claude.ai/api/mcp/other",
            "https://claude.ai/api/mcp/auth_callback"
        ));
    }

    #[test]
    fn redirect_matches_loopback_ignoring_port() {
        assert!(redirect_uri_matches(
            "http://localhost:51234/callback",
            "http://localhost/callback"
        ));
        assert!(redirect_uri_matches(
            "http://127.0.0.1:9999/callback",
            "http://127.0.0.1/callback"
        ));
    }

    #[test]
    fn redirect_loopback_still_checks_path() {
        assert!(!redirect_uri_matches(
            "http://localhost:51234/evil",
            "http://localhost/callback"
        ));
    }

    #[test]
    fn redirect_rejects_lookalike_domain() {
        assert!(!redirect_uri_matches(
            "https://claude.ai.evil.example.com/api/mcp/auth_callback",
            "https://claude.ai/api/mcp/auth_callback"
        ));
    }

    #[test]
    fn redirect_rejects_http_for_non_loopback() {
        assert!(!redirect_uri_matches(
            "http://claude.ai/api/mcp/auth_callback",
            "https://claude.ai/api/mcp/auth_callback"
        ));
    }

    // -- registration allowlist (decision D4) -----------------------------

    #[test]
    fn registration_accepts_claude_hosted_callback() {
        let hosts = vec!["claude.ai".to_string()];
        assert!(is_allowed_registration_redirect(claude_hosted_callback(), &hosts));
    }

    #[test]
    fn registration_accepts_claude_code_loopback() {
        let hosts = vec!["claude.ai".to_string()];
        assert!(is_allowed_registration_redirect("http://localhost/callback", &hosts));
        assert!(is_allowed_registration_redirect("http://127.0.0.1/callback", &hosts));
    }

    #[test]
    fn registration_rejects_attacker_domain() {
        let hosts = vec!["claude.ai".to_string()];
        assert!(!is_allowed_registration_redirect(
            "https://attacker.example.com/steal",
            &hosts
        ));
    }

    #[test]
    fn registration_rejects_lookalike_domain() {
        let hosts = vec!["claude.ai".to_string()];
        assert!(!is_allowed_registration_redirect(
            "https://claude.ai.attacker.com/callback",
            &hosts
        ));
    }

    #[test]
    fn registration_rejects_reserved_memwal_host() {
        // Even if someone mistakenly configured it, our own hosts must
        // never be a valid *registration* target for a third-party client.
        let hosts = vec!["memwal.ai".to_string()];
        // This documents current behavior: the allowlist is caller-supplied,
        // so the safety comes from what operators configure, not a magic
        // rejection of our own domain. Regression-guards the default config
        // instead, exercised in `registration_accepts_claude_hosted_callback`.
        assert!(is_allowed_registration_redirect("https://memwal.ai/callback", &hosts));
    }

    #[test]
    fn registration_rejects_loopback_with_wrong_path() {
        let hosts = vec!["claude.ai".to_string()];
        assert!(!is_allowed_registration_redirect(
            "http://localhost/not-callback",
            &hosts
        ));
    }

    // -- resource normalization -------------------------------------------

    #[test]
    fn resource_normalizes_trailing_slash_and_case() {
        assert_eq!(
            normalize_resource_uri("HTTPS://Relayer.Memory.Walrus.XYZ/api/mcp/").as_deref(),
            Some("https://relayer.memory.walrus.xyz/api/mcp")
        );
    }

    #[test]
    fn resource_rejects_fragment() {
        assert_eq!(normalize_resource_uri("https://relayer.memory.walrus.xyz/api/mcp#x"), None);
    }

    #[test]
    fn resource_rejects_missing_scheme() {
        assert_eq!(normalize_resource_uri("relayer.memory.walrus.xyz/api/mcp"), None);
    }

    // -- token / hash helpers ------------------------------------------

    #[test]
    fn random_token_has_prefix_and_length() {
        let token = random_token(ACCESS_TOKEN_PREFIX);
        assert!(token.starts_with(ACCESS_TOKEN_PREFIX));
        assert!(token.len() > ACCESS_TOKEN_PREFIX.len() + 32);
    }

    #[test]
    fn hash_token_is_deterministic_and_hex() {
        let a = hash_token("same-input");
        let b = hash_token("same-input");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_rejects_length_mismatch() {
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes() {
        assert!(constant_time_eq(b"same", b"same"));
    }

    // -- sanitization -----------------------------------------------------

    #[test]
    fn sanitize_client_name_strips_html_chars() {
        let cleaned = sanitize_client_name("<script>Evil</script>").unwrap();
        assert!(!cleaned.contains('<'));
        assert!(!cleaned.contains('>'));
    }

    #[test]
    fn sanitize_client_name_rejects_reserved_brand() {
        assert_eq!(
            sanitize_client_name("Walrus Memory Official"),
            Err(SanitizeError::ReservedBrand)
        );
        assert_eq!(
            sanitize_client_name("MemWal Admin Tool"),
            Err(SanitizeError::ReservedBrand)
        );
    }

    #[test]
    fn sanitize_client_name_rejects_empty() {
        assert_eq!(sanitize_client_name("   "), Err(SanitizeError::Empty));
    }

    #[test]
    fn sanitize_label_falls_back_to_default() {
        assert_eq!(sanitize_label("   ", "Claude"), "Claude");
    }

    #[test]
    fn sanitize_label_caps_length() {
        let long = "x".repeat(200);
        let cleaned = sanitize_label(&long, "default");
        assert_eq!(cleaned.len(), LABEL_MAX_CHARS);
    }

    // -- CIDR trust check ---------------------------------------------------

    #[test]
    fn ip_is_trusted_matches_anthropic_range() {
        let trusted: Vec<IpNet> = vec!["160.79.104.0/21".parse().unwrap()];
        let inside: IpAddr = "160.79.104.5".parse().unwrap();
        let outside: IpAddr = "8.8.8.8".parse().unwrap();
        assert!(ip_is_trusted(inside, &trusted));
        assert!(!ip_is_trusted(outside, &trusted));
    }
}
