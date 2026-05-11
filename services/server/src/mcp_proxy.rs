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
//! Trust model: only the relayer can reach the sidecar (loopback). Forwarding
//! the user's `Authorization` header into the sidecar is safe; the sidecar's
//! own shared-secret auth middleware does not run on `/mcp/*` (mounted before
//! it in `sidecar-server.ts`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};

use crate::types::AppState;

/// Header names that we forward verbatim from the inbound client request to
/// the sidecar. Anything else is dropped — we never proxy cookies, host, or
/// any infra header that would confuse the sidecar.
const FORWARD_HEADER_PREFIXES: &[&str] = &["x-memwal-"];
const FORWARD_HEADER_EXACT: &[&str] = &[
    "authorization",
    "content-type",
    "accept",
    // MCP 2025-06 streamable HTTP transport headers — the SDK on both
    // sides reads these to route requests to the right session.
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];

fn should_forward(name: &HeaderName) -> bool {
    let s = name.as_str().to_ascii_lowercase();
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

/// `GET /api/mcp/sse` — open the SSE stream to the sidecar and stream the
/// response body back to the client without buffering. The sidecar emits an
/// `event: endpoint` line carrying `/api/mcp/messages?sessionId=…`; the
/// client posts subsequent JSON-RPC envelopes to that URL.
pub async fn sse_proxy(
    State(state): State<Arc<AppState>>,
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
    let req = state
        .http_client
        .get(&url)
        .timeout(std::time::Duration::from_secs(86_400))
        .headers(build_forwarded_headers(&headers));

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
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let session_id = match params.get("sessionId") {
        Some(s) if !s.is_empty() => s.clone(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing sessionId query parameter",
            )
                .into_response();
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

    let upstream = state
        .http_client
        .post(&url)
        .headers(build_forwarded_headers(&headers))
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
///     claude mcp add --transport http memwal https://relayer.memwal.ai/api/mcp
///
/// We proxy verbatim to the sidecar's `/mcp` endpoint (whose SDK
/// `StreamableHTTPServerTransport` does all the protocol heavy-lifting).
/// `mcp-session-id` round-trips between client and sidecar; the
/// authorization scheme stays Bearer-on-every-request (same ed25519 seed
/// scheme as the stdio bridge — no OAuth dance required).
pub async fn streamable_proxy(
    State(state): State<Arc<AppState>>,
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
    req = req.headers(build_forwarded_headers(&headers));

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
