//! MCP reverse-proxy to the Node sidecar.
//!
//! The MCP server (Model Context Protocol) lives in the sidecar at
//! `<sidecar_url>/mcp/*` because the official `@modelcontextprotocol/sdk` is
//! TypeScript. This module exposes two public axum routes that forward
//! external client traffic to the sidecar:
//!
//!   GET  /api/mcp/sse        SSE stream open + endpoint event
//!   POST /api/mcp/messages   JSON-RPC envelopes from the client
//!
//! These routes intentionally bypass the relayer's Ed25519 signed-request
//! auth + per-key rate limiting because:
//!
//!   * MCP clients (Claude Code, Codex, etc.) cannot ship a per-request
//!     timestamp+nonce+signature — they send a single `Authorization: Bearer`
//!     at SSE open and reuse the session for the lifetime of the connection.
//!   * The sidecar's MCP layer does its own auth — parses the Bearer as the
//!     Ed25519 delegate key and the `X-MemWal-Account-Id` header — and the
//!     SDK signs every downstream relayer API call from inside the MCP tools.
//!
//! Trust model: the sidecar's blanket shared-secret middleware does not run on
//! `/mcp/*` (mounted before it in `scripts/sidecar/app.ts`), because
//! `Authorization` already carries the end user's delegate key. Instead this
//! module presents the same secret in `x-memwal-internal-sidecar-token`, and
//! the sidecar refuses to honour any `x-memwal-internal-*` header without it —
//! so reaching the sidecar directly is not enough to forge one (GH #685).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};

use crate::{client_ip::canonical_client_ip, types::AppState};

/// Header names that we forward verbatim from the inbound client request to
/// the sidecar. Anything else is dropped — we never proxy cookies, host, or
/// any infra header that would confuse the sidecar.
///
/// Internal headers (starting with `x-memwal-internal-`) are strictly reserved
/// for trusted relayer-to-sidecar communication and must NEVER be forwarded
/// from untrusted client requests.
const FORWARD_HEADER_PREFIXES: &[&str] = &["x-memwal-"];
const INTERNAL_HEADER_PREFIXES: &[&str] = &["x-memwal-internal-"];
const FORWARD_HEADER_EXACT: &[&str] = &[
    "authorization",
    "content-type",
    "accept",
    "x-request-id",
    "x-correlation-id",
    // MCP 2025-06 streamable HTTP transport headers — the SDK on both
    // sides reads these to route requests to the right session.
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];

fn should_forward(name: &HeaderName) -> bool {
    let s = name.as_str().to_ascii_lowercase();
    if INTERNAL_HEADER_PREFIXES.iter().any(|p| s.starts_with(p)) {
        return false;
    }
    FORWARD_HEADER_EXACT.iter().any(|h| *h == s)
        || FORWARD_HEADER_PREFIXES.iter().any(|p| s.starts_with(p))
}

fn build_forwarded_headers(inbound: &HeaderMap) -> reqwest::header::HeaderMap {
    let mut out = reqwest::header::HeaderMap::new();
    for (name, value) in inbound.iter() {
        if should_forward(name) {
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
                reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
            ) {
                out.insert(n, v);
            }
        }
    }
    out
}

/// Forward exactly one canonical, validated client IP to the loopback
/// sidecar. Never pass the inbound XFF chain through: its left side may be
/// attacker-controlled and the sidecar must not reinterpret proxy trust.
fn set_forwarded_client_ip(
    headers: &mut reqwest::header::HeaderMap,
    inbound: &HeaderMap,
    peer: SocketAddr,
    trusted_proxy_hops: usize,
) {
    let client_ip = canonical_client_ip(inbound, peer, trusted_proxy_hops);
    if let Ok(v) = reqwest::header::HeaderValue::from_str(&client_ip.to_string()) {
        out_set(headers, "x-forwarded-for", v);
    }
}

fn out_set(
    headers: &mut reqwest::header::HeaderMap,
    name: &'static str,
    value: reqwest::header::HeaderValue,
) {
    if let Ok(n) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) {
        headers.insert(n, value);
    }
}

// ---------------------------------------------------------------------
// MCP OAuth bearer resolution (Claude custom connectors). Runs before the
// sidecar ever sees the request: classifies the inbound bearer, and when
// it's an OAuth access token, translates it into the legacy
// `Authorization: Bearer <delegate-key-hex>` + `X-MemWal-Account-Id` shape
// the sidecar's `resolveAuth()` already accepts — so the sidecar itself
// needs zero changes. See `oauth.rs` for the crypto/DB side.
// ---------------------------------------------------------------------

enum McpAuthOutcome {
    /// The bearer is the legacy 64-hex delegate key — forward exactly as
    /// today, byte for byte (OAuth tokens are never valid here).
    Passthrough,
    Oauth(Box<crate::oauth::ResolvedOAuthIdentity>),
    /// OAuth is enabled and the bearer is missing/malformed/expired/
    /// revoked — respond with the RFC 9728 challenge ourselves instead of
    /// forwarding to the sidecar (which wouldn't know how to build the
    /// `resource_metadata` pointer anyway).
    Unauthorized(Option<crate::oauth::OAuthBearerError>),
}

fn is_legacy_delegate_bearer(token: &str) -> bool {
    let hex_part = token.strip_prefix("0x").unwrap_or(token);
    hex_part.len() == 64 && hex_part.chars().all(|c| c.is_ascii_hexdigit())
}

async fn classify_and_resolve(state: &AppState, headers: &HeaderMap) -> McpAuthOutcome {
    if state.config.mcp_oauth.is_none() {
        return McpAuthOutcome::Passthrough;
    }
    let Some(auth_value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return McpAuthOutcome::Unauthorized(None);
    };
    let Some(token) = auth_value
        .strip_prefix("Bearer ")
        .or_else(|| auth_value.strip_prefix("bearer "))
        .map(str::trim)
    else {
        return McpAuthOutcome::Unauthorized(None);
    };

    if is_legacy_delegate_bearer(token) {
        return McpAuthOutcome::Passthrough;
    }

    match crate::oauth::resolve_oauth_bearer(state, token).await {
        Ok(identity) => McpAuthOutcome::Oauth(Box::new(identity)),
        Err(crate::oauth::OAuthBearerError::NotOAuthToken) => McpAuthOutcome::Unauthorized(None),
        Err(err) => {
            tracing::debug!("mcp_proxy oauth bearer rejected: {:?}", err);
            McpAuthOutcome::Unauthorized(Some(err))
        }
    }
}

/// Internal headers the relayer states on every forwarded `/mcp/*` request.
///
/// Both values are written with `insert` (overwrite, never append), so a
/// client-supplied `x-memwal-internal-*` copied through by
/// `build_forwarded_headers` is always replaced and can never survive. GH #665
/// additionally drops that prefix on the way in; this function does not depend
/// on it.
///
/// - **sidecar token** proves to the sidecar that the request really came from
///   the relayer. `/mcp/*` is mounted before the sidecar's shared-secret
///   middleware because `authorization` already carries the end user's
///   delegate key, so the secret rides in its own header instead.
/// - **oauth scope** is stated explicitly on BOTH auth paths — the resolved
///   grant for OAuth callers, and full read+write for legacy delegate-key
///   callers. The sidecar registers no tools when it is absent, so silence
///   means "no access" rather than "unrestricted" (GH #685).
///
/// For the OAuth path this MUST overwrite `authorization` and
/// `x-memwal-account-id`: `build_forwarded_headers` copies any client-supplied
/// `x-memwal-*` header verbatim (that's how the legacy explicit-header flow
/// works), so a caller presenting a valid OAuth token alongside a forged
/// `X-MemWal-Account-Id` must have the forged value discarded, not merged.
///
/// Returns `Err` rather than skipping a header it cannot build: a partially
/// applied set would hand the sidecar an authenticated request with no scope,
/// and the whole point of #685 is that such a request must fail, not proceed.
fn apply_internal_headers(
    forwarded: &mut reqwest::header::HeaderMap,
    sidecar_secret: Option<&str>,
    identity: Option<&crate::oauth::ResolvedOAuthIdentity>,
) -> Result<(), StatusCode> {
    fn internal_error(what: &str) -> StatusCode {
        tracing::error!("mcp_proxy: cannot build internal header {what}");
        StatusCode::INTERNAL_SERVER_ERROR
    }

    let Some(secret) = sidecar_secret else {
        return Err(internal_error(
            "x-memwal-internal-sidecar-token (SIDECAR_AUTH_TOKEN unset)",
        ));
    };
    let token = reqwest::header::HeaderValue::from_str(secret)
        .map_err(|_| internal_error("x-memwal-internal-sidecar-token"))?;

    let scope = match identity {
        Some(identity) => identity.scope.clone(),
        // Legacy delegate-key callers have no OAuth grant, so the relayer says
        // outright that they hold every tool scope.
        None => format!("{} {}", crate::oauth::SCOPE_READ, crate::oauth::SCOPE_WRITE),
    };
    let scope = reqwest::header::HeaderValue::from_str(&scope)
        .map_err(|_| internal_error("x-memwal-internal-oauth-scope"))?;

    if let Some(identity) = identity {
        let auth = reqwest::header::HeaderValue::from_str(&format!(
            "Bearer {}",
            identity.delegate_private_key.as_str()
        ))
        .map_err(|_| internal_error("authorization"))?;
        let account = reqwest::header::HeaderValue::from_str(&identity.account_id)
            .map_err(|_| internal_error("x-memwal-account-id"))?;
        forwarded.insert(reqwest::header::AUTHORIZATION, auth);
        forwarded.insert(
            reqwest::header::HeaderName::from_static("x-memwal-account-id"),
            account,
        );
    }

    forwarded.insert(
        reqwest::header::HeaderName::from_static("x-memwal-internal-sidecar-token"),
        token,
    );
    forwarded.insert(
        reqwest::header::HeaderName::from_static("x-memwal-internal-oauth-scope"),
        scope,
    );
    Ok(())
}

/// RFC 9728 401 challenge. `state.config.mcp_oauth` must be `Some` — only
/// called from `classify_and_resolve`'s `Unauthorized` arm, which only
/// returns that when OAuth is enabled.
fn oauth_unauthorized_response(
    state: &AppState,
    err: Option<&crate::oauth::OAuthBearerError>,
) -> Response {
    let Some(cfg) = state.config.mcp_oauth.as_ref() else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    let mut challenge = format!(
        "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"",
        cfg.issuer
    );
    if let Some(err) = err {
        challenge.push_str(&format!(", error=\"{}\"", err.error_code()));
    }
    let mut resp = (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    if let Ok(v) = HeaderValue::from_str(&challenge) {
        resp.headers_mut()
            .insert(axum::http::header::WWW_AUTHENTICATE, v);
    }
    resp
}

/// `GET /api/mcp/sse` — open the SSE stream to the sidecar and stream the
/// response body back to the client without buffering. The sidecar emits an
/// `event: endpoint` line carrying `/api/mcp/messages?sessionId=…`; the
/// client posts subsequent JSON-RPC envelopes to that URL.
pub async fn sse_proxy(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let url = format!("{}/mcp/sse", state.config.sidecar_url);
    // SSE streams are long-lived (idle between tool calls + 27-35s walrus
    // writes leave the body silent). The shared `http_client` carries a 30s
    // request timeout intended for finite LLM/Walrus calls; if we let it
    // apply here reqwest kills the streaming response at 30s and the bridge
    // sees `terminated`. Override with a 24h ceiling so the stream stays
    // open until the client itself closes it. `read_timeout` keeps a
    // per-chunk watchdog (heartbeats fire every 3s, so 60s is plenty).
    let mut forwarded = build_forwarded_headers(&headers);
    set_forwarded_client_ip(
        &mut forwarded,
        &headers,
        peer,
        state.config.trusted_proxy_hops,
    );
    let identity = match classify_and_resolve(&state, &headers).await {
        McpAuthOutcome::Passthrough => None,
        McpAuthOutcome::Oauth(identity) => Some(identity),
        McpAuthOutcome::Unauthorized(err) => {
            return oauth_unauthorized_response(&state, err.as_ref())
        }
    };
    if let Err(code) = apply_internal_headers(
        &mut forwarded,
        state.config.sidecar_secret.as_deref(),
        identity.as_deref(),
    ) {
        return (code, "internal error").into_response();
    }
    let req = state
        .http_client
        .get(&url)
        .timeout(std::time::Duration::from_secs(86_400))
        .headers(forwarded);

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            tracing::error!("mcp_proxy.sse upstream connect failed: {}", err);
            return (
                StatusCode::BAD_GATEWAY,
                format!("MCP sidecar unreachable: {}", err),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    // Build response with streaming body. Forward only the headers SSE
    // clients actually depend on; copy custom `www-authenticate` on auth
    // failures so the user agent knows what's wrong.
    let mut resp = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if matches!(
            lname.as_str(),
            "content-type" | "cache-control" | "www-authenticate" | "connection"
        ) {
            if let (Ok(n), Ok(v)) = (
                HeaderName::from_bytes(name.as_str().as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                resp = resp.header(n, v);
            }
        }
    }
    // Belt-and-braces: ensure no intermediary buffers the stream. nginx /
    // Cloudflare honor `X-Accel-Buffering: no`; explicit `no-transform`
    // tells caches not to compress. These are no-ops on loopback but cheap
    // insurance once the relayer sits behind a real proxy.
    resp = resp
        .header("x-accel-buffering", "no")
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive");

    let body = Body::from_stream(upstream.bytes_stream());
    match resp.body(body) {
        Ok(r) => r,
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to build proxied response: {}", err),
        )
            .into_response(),
    }
}

/// `POST /api/mcp/messages?sessionId=<uuid>` — forward the JSON-RPC envelope
/// to the sidecar's matching session.
pub async fn messages_proxy(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let session_id = match params.get("sessionId") {
        Some(s) if !s.is_empty() => s.clone(),
        _ => {
            return (StatusCode::BAD_REQUEST, "Missing sessionId query parameter").into_response();
        }
    };

    // session_id comes from the sidecar (it is a UUID v4, no special chars)
    // so no percent-encoding needed. Sanitize the assumption by rejecting any
    // value that contains characters outside the UUID alphabet.
    if !session_id
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return (StatusCode::BAD_REQUEST, "Invalid sessionId").into_response();
    }
    let url = format!(
        "{}/mcp/messages?sessionId={}",
        state.config.sidecar_url, session_id
    );

    let mut forwarded = build_forwarded_headers(&headers);
    set_forwarded_client_ip(
        &mut forwarded,
        &headers,
        peer,
        state.config.trusted_proxy_hops,
    );
    let identity = match classify_and_resolve(&state, &headers).await {
        McpAuthOutcome::Passthrough => None,
        McpAuthOutcome::Oauth(identity) => Some(identity),
        McpAuthOutcome::Unauthorized(err) => {
            return oauth_unauthorized_response(&state, err.as_ref())
        }
    };
    if let Err(code) = apply_internal_headers(
        &mut forwarded,
        state.config.sidecar_secret.as_deref(),
        identity.as_deref(),
    ) {
        return (code, "internal error").into_response();
    }
    let upstream = state
        .http_client
        .post(&url)
        .headers(forwarded)
        .body(body.to_vec())
        .send()
        .await;

    let upstream = match upstream {
        Ok(r) => r,
        Err(err) => {
            tracing::error!("mcp_proxy.messages upstream connect failed: {}", err);
            return (
                StatusCode::BAD_GATEWAY,
                format!("MCP sidecar unreachable: {}", err),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    match upstream.bytes().await {
        Ok(bytes) => (
            status,
            [(
                axum::http::header::CONTENT_TYPE,
                HeaderValue::from_str(&content_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/json")),
            )],
            bytes,
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            format!("MCP sidecar read failed: {}", err),
        )
            .into_response(),
    }
}

/// `ANY /api/mcp` — Streamable HTTP transport (MCP 2025-06 spec).
///
/// Single endpoint that supersedes the SSE+POST split: one URL handles
/// GET (open server→client SSE), POST (JSON-RPC with optional SSE upgrade),
/// and DELETE (close session). The MailGate / Linear / Figma MCP servers
/// all use this newer transport — clients just configure a single URL:
///
///     claude mcp add --transport http memwal https://relayer.memory.walrus.xyz/api/mcp
///
/// We proxy verbatim to the sidecar's `/mcp` endpoint (whose SDK
/// `StreamableHTTPServerTransport` does all the protocol heavy-lifting).
/// `mcp-session-id` round-trips between client and sidecar; the
/// authorization scheme stays Bearer-on-every-request (same ed25519 seed
/// scheme as the stdio bridge — no OAuth dance required).
pub async fn streamable_proxy(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let url = format!("{}/mcp", state.config.sidecar_url);

    // Build the upstream request matching the inbound method. reqwest
    // doesn't expose a generic builder that takes a Method directly, so
    // we branch — only GET/POST/DELETE are meaningful for the transport.
    let mut req = match method {
        axum::http::Method::GET => state.http_client.get(&url),
        axum::http::Method::POST => state.http_client.post(&url),
        axum::http::Method::DELETE => state.http_client.delete(&url),
        axum::http::Method::OPTIONS => {
            // CORS preflight — answer here without hitting the sidecar.
            return (StatusCode::NO_CONTENT, ()).into_response();
        }
        _ => {
            return (
                StatusCode::METHOD_NOT_ALLOWED,
                "MCP HTTP transport only supports GET, POST, DELETE",
            )
                .into_response();
        }
    };

    // GET/DELETE may carry an empty body; only POST will have JSON-RPC
    // envelopes. Streaming both ways is the simplest correct choice.
    if !body.is_empty() {
        req = req.body(body.to_vec());
    }
    let mut forwarded = build_forwarded_headers(&headers);
    set_forwarded_client_ip(
        &mut forwarded,
        &headers,
        peer,
        state.config.trusted_proxy_hops,
    );
    let identity = match classify_and_resolve(&state, &headers).await {
        McpAuthOutcome::Passthrough => None,
        McpAuthOutcome::Oauth(identity) => Some(identity),
        McpAuthOutcome::Unauthorized(err) => {
            return oauth_unauthorized_response(&state, err.as_ref())
        }
    };
    if let Err(code) = apply_internal_headers(
        &mut forwarded,
        state.config.sidecar_secret.as_deref(),
        identity.as_deref(),
    ) {
        return (code, "internal error").into_response();
    }
    req = req.headers(forwarded);

    // Same 24h request timeout as the SSE proxy — a streamable response
    // can stay open well past the shared `http_client`'s default 30s
    // (tool calls take 25-35s for walrus blob writes). See mcp_proxy.rs
    // commit 8990a88 for the original SSE fix.
    req = req.timeout(std::time::Duration::from_secs(86_400));

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            tracing::error!("mcp_proxy.streamable upstream connect failed: {}", err);
            return (
                StatusCode::BAD_GATEWAY,
                format!("MCP sidecar unreachable: {}", err),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

    // Forward the headers the streamable transport relies on. Critically
    // `mcp-session-id` — the SDK sets it on the response to first POST and
    // expects subsequent requests to carry it back.
    let mut resp = Response::builder().status(status);
    for (name, value) in upstream.headers().iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if matches!(
            lname.as_str(),
            "content-type"
                | "cache-control"
                | "www-authenticate"
                | "connection"
                | "mcp-session-id"
                | "mcp-protocol-version"
        ) {
            if let (Ok(n), Ok(v)) = (
                HeaderName::from_bytes(name.as_str().as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                resp = resp.header(n, v);
            }
        }
    }
    resp = resp
        .header("x-accel-buffering", "no")
        .header("cache-control", "no-cache, no-transform");

    // Stream both ways — the SDK may upgrade a POST response to SSE
    // (`Content-Type: text/event-stream`) for long-running tool calls.
    // `Body::from_stream` handles small JSON bodies and infinite SSE
    // alike without buffering.
    let body = Body::from_stream(upstream.bytes_stream());
    match resp.body(body) {
        Ok(r) => r,
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to build proxied response: {}", err),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderName as AxumHeaderName;

    fn axum_headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                AxumHeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    fn xff(headers: &reqwest::header::HeaderMap) -> Option<String> {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    }

    #[test]
    fn should_forward_allows_authorization_and_mcp_headers() {
        for h in [
            "authorization",
            "content-type",
            "accept",
            "mcp-session-id",
            "mcp-protocol-version",
            "last-event-id",
            "x-memwal-account-id",
            "x-memwal-namespace",
        ] {
            let name = AxumHeaderName::from_bytes(h.as_bytes()).unwrap();
            assert!(should_forward(&name), "should forward {h}");
        }
    }

    #[test]
    fn should_forward_blocks_cookies_and_host_and_arbitrary_headers() {
        for h in ["cookie", "host", "x-real-ip", "user-agent", "referer"] {
            let name = AxumHeaderName::from_bytes(h.as_bytes()).unwrap();
            assert!(!should_forward(&name), "must not forward {h}");
        }
    }

    #[test]
    fn should_forward_blocks_internal_headers() {
        for h in [
            "x-memwal-internal-oauth-scope",
            "x-memwal-internal-auth",
            "x-memwal-internal-test",
            "X-MemWal-Internal-Oauth-Scope",
        ] {
            let name = AxumHeaderName::from_bytes(h.as_bytes()).unwrap();
            assert!(!should_forward(&name), "must not forward internal header {h}");
        }
    }

    #[test]
    fn forwarded_client_ip_sets_peer_when_inbound_missing() {
        let mut out = reqwest::header::HeaderMap::new();
        let inbound = axum_headers(&[]);
        let peer: SocketAddr = "203.0.113.7:54321".parse().unwrap();

        set_forwarded_client_ip(&mut out, &inbound, peer, 0);

        assert_eq!(xff(&out).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn forwarded_client_ip_default_ignores_inbound_chain() {
        let mut out = reqwest::header::HeaderMap::new();
        let inbound = axum_headers(&[("x-forwarded-for", "198.51.100.4, 10.0.0.1")]);
        let peer: SocketAddr = "127.0.0.1:9000".parse().unwrap();

        set_forwarded_client_ip(&mut out, &inbound, peer, 0);

        assert_eq!(xff(&out).as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn forwarded_client_ip_uses_configured_trusted_hop() {
        let mut out = reqwest::header::HeaderMap::new();
        let inbound = axum_headers(&[("x-forwarded-for", "192.0.2.66, 203.0.113.7")]);
        let peer: SocketAddr = "10.0.0.2:1".parse().unwrap();

        set_forwarded_client_ip(&mut out, &inbound, peer, 1);

        assert_eq!(xff(&out).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn forwarded_client_ip_handles_ipv6_peer() {
        let mut out = reqwest::header::HeaderMap::new();
        let inbound = axum_headers(&[]);
        let peer: SocketAddr = "[2001:db8::1]:443".parse().unwrap();

        set_forwarded_client_ip(&mut out, &inbound, peer, 0);

        assert_eq!(xff(&out).as_deref(), Some("2001:db8::1"));
    }

    #[test]
    fn build_forwarded_headers_drops_cookies_keeps_authorization() {
        let inbound = axum_headers(&[
            ("authorization", "Bearer abc"),
            ("cookie", "session=evil"),
            ("x-memwal-account-id", "0xdeadbeef"),
            ("x-memwal-internal-oauth-scope", "memwal:write"),
            ("host", "evil.example"),
        ]);

        let out = build_forwarded_headers(&inbound);

        assert_eq!(
            out.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer abc")
        );
        assert_eq!(
            out.get("x-memwal-account-id").and_then(|v| v.to_str().ok()),
            Some("0xdeadbeef")
        );
        assert!(out.get("cookie").is_none(), "cookie must not be forwarded");
        assert!(out.get("host").is_none(), "host must not be forwarded");
        assert!(
            out.get("x-memwal-internal-oauth-scope").is_none(),
            "inbound internal oauth scope header must be dropped"
        );
    }

    // -- MCP OAuth bearer classification ---------------------------------

    #[test]
    fn legacy_bearer_classification_accepts_64_hex_with_or_without_0x() {
        let hex64 = "a".repeat(64);
        assert!(is_legacy_delegate_bearer(&hex64));
        assert!(is_legacy_delegate_bearer(&format!("0x{hex64}")));
    }

    #[test]
    fn legacy_bearer_classification_rejects_oauth_and_garbage_tokens() {
        assert!(!is_legacy_delegate_bearer("mwo_abcdefgh"));
        assert!(!is_legacy_delegate_bearer("not-hex-at-all"));
        assert!(!is_legacy_delegate_bearer(&"a".repeat(63))); // one short
        assert!(!is_legacy_delegate_bearer(&"a".repeat(65))); // one long
    }

    // -- internal relayer->sidecar headers (GH #685) ----------------------

    fn test_identity(scope: &str) -> crate::oauth::ResolvedOAuthIdentity {
        let key = [3u8; 32];
        let envelope = crate::oauth::encrypt_delegate_private_key(&key, &"b".repeat(64)).unwrap();
        let secret = crate::oauth::decrypt_delegate_private_key(&key, &envelope).unwrap();
        crate::oauth::ResolvedOAuthIdentity {
            account_id: "0xrealaccount".to_string(),
            delegate_private_key: secret,
            grant_id: "mwg_test".to_string(),
            scope: scope.to_string(),
        }
    }

    #[test]
    fn internal_headers_grant_full_scope_to_legacy_passthrough() {
        let mut out = reqwest::header::HeaderMap::new();

        apply_internal_headers(&mut out, Some("shhh"), None).expect("passthrough must succeed");

        assert_eq!(
            out.get("x-memwal-internal-oauth-scope")
                .and_then(|v| v.to_str().ok()),
            Some("memwal:read memwal:write"),
            "legacy callers must be granted read+write explicitly, not by omission"
        );
        assert_eq!(
            out.get("x-memwal-internal-sidecar-token")
                .and_then(|v| v.to_str().ok()),
            Some("shhh")
        );
    }

    #[test]
    fn internal_headers_forward_the_resolved_oauth_scope() {
        let mut out = reqwest::header::HeaderMap::new();
        let identity = test_identity("memwal:read");

        apply_internal_headers(&mut out, Some("shhh"), Some(&identity))
            .expect("oauth must succeed");

        assert_eq!(
            out.get("x-memwal-internal-oauth-scope")
                .and_then(|v| v.to_str().ok()),
            Some("memwal:read"),
            "the sidecar relies on this header being set; nothing else asserts it"
        );
        assert_eq!(
            out.get("x-memwal-internal-sidecar-token")
                .and_then(|v| v.to_str().ok()),
            Some("shhh")
        );
    }

    #[test]
    fn internal_headers_overwrite_client_supplied_values() {
        let mut out = build_forwarded_headers(&axum_headers(&[
            ("x-memwal-internal-oauth-scope", "memwal:write"),
            ("x-memwal-internal-sidecar-token", "guessed"),
        ]));

        apply_internal_headers(&mut out, Some("shhh"), None).unwrap();

        assert_eq!(
            out.get("x-memwal-internal-oauth-scope")
                .and_then(|v| v.to_str().ok()),
            Some("memwal:read memwal:write")
        );
        assert_eq!(
            out.get("x-memwal-internal-sidecar-token")
                .and_then(|v| v.to_str().ok()),
            Some("shhh")
        );
    }

    #[test]
    fn internal_headers_fail_closed_without_a_sidecar_secret() {
        let mut out = reqwest::header::HeaderMap::new();

        assert!(
            apply_internal_headers(&mut out, None, None).is_err(),
            "no shared secret must fail the request, not forward unauthenticated"
        );
        assert!(
            out.get("x-memwal-internal-oauth-scope").is_none(),
            "must not leave partial headers behind on failure"
        );
    }

    #[test]
    fn apply_internal_headers_overwrites_forwarded_authorization_and_account_id() {
        // Simulates the case build_forwarded_headers already copied a
        // client-supplied (potentially forged) x-memwal-account-id — the
        // OAuth resolution must win, not merge.
        let mut forwarded = reqwest::header::HeaderMap::new();
        forwarded.insert(
            reqwest::header::AUTHORIZATION,
            "Bearer mwo_whatever".parse().unwrap(),
        );
        forwarded.insert(
            reqwest::header::HeaderName::from_bytes(b"x-memwal-account-id").unwrap(),
            "0xforged".parse().unwrap(),
        );

        let key = [3u8; 32];
        let envelope = crate::oauth::encrypt_delegate_private_key(&key, &"b".repeat(64)).unwrap();
        let secret = crate::oauth::decrypt_delegate_private_key(&key, &envelope).unwrap();
        let identity = crate::oauth::ResolvedOAuthIdentity {
            account_id: "0xrealaccount".to_string(),
            delegate_private_key: secret,
            grant_id: "mwg_test".to_string(),
            scope: "memwal:read".to_string(),
        };

        apply_internal_headers(&mut forwarded, Some("shhh"), Some(&identity)).unwrap();

        assert_eq!(
            forwarded.get("authorization").and_then(|v| v.to_str().ok()),
            Some(format!("Bearer {}", "b".repeat(64)).as_str())
        );
        assert_eq!(
            forwarded
                .get("x-memwal-account-id")
                .and_then(|v| v.to_str().ok()),
            Some("0xrealaccount")
        );
    }
}
