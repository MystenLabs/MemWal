//! HTTP handlers for MCP OAuth 2.1 (Claude custom connectors).
//!
//! Structurally mirrors the reviewed-but-unmerged WALM-30/ENG-1783
//! `app_auth.rs` (PR #193) — same start/complete/cancel/token shape — but
//! implements RFC 7591 dynamic client registration, RFC 8414/9728
//! discovery, and PKCE instead of that ticket's simpler client_id/secret
//! model. All pure logic (crypto, PKCE, validation, sanitization) lives in
//! `crate::oauth`; this file is HTTP plumbing + the on-chain verification
//! call at `/api/oauth/session/{id}/complete`.
//!
//! Routes are always mounted when configured; OAuth tokens simply won't resolve
//! if clients haven't registered yet.

use axum::extract::{ConnectInfo, FromRequest, Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::{Form, Json};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::oauth::{self, OAuthError};
use crate::storage::db::oauth_rows::{
    OAuthClientRow, OAuthCodeRow, OAuthDelegateRow, OAuthGrantRow, OAuthSessionRow, OAuthTokenRow,
};
use crate::storage::sui::verify_delegate_key_onchain;
use crate::types::AppState;

/// Read the configured `McpOAuthConfig`, or fail with 404 if not configured.
fn require_oauth(state: &AppState) -> Result<&oauth::McpOAuthConfig, OAuthError> {
    state.config.mcp_oauth.as_ref().ok_or_else(|| {
        OAuthError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "MCP OAuth is not configured",
        )
    })
}

// ---------------------------------------------------------------------
// Discovery — RFC 9728 protected-resource metadata, RFC 8414
// authorization-server metadata
// ---------------------------------------------------------------------

pub async fn protected_resource_metadata(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, OAuthError> {
    let cfg = require_oauth(&state)?;
    Ok(Json(serde_json::json!({
        "resource": cfg.resource,
        "authorization_servers": [cfg.issuer],
        "scopes_supported": ["memwal:read", "memwal:write", "offline_access"],
        "bearer_methods_supported": ["header"],
        "resource_name": "Walrus Memory",
    })))
}

pub async fn authorization_server_metadata(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, OAuthError> {
    let cfg = require_oauth(&state)?;
    Ok(Json(serde_json::json!({
        "issuer": cfg.issuer,
        "authorization_endpoint": format!("{}/oauth/authorize", cfg.issuer),
        "token_endpoint": format!("{}/oauth/token", cfg.issuer),
        "registration_endpoint": format!("{}/oauth/register", cfg.issuer),
        "revocation_endpoint": format!("{}/oauth/revoke", cfg.issuer),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "scopes_supported": ["memwal:read", "memwal:write", "offline_access"],
    })))
}

// ---------------------------------------------------------------------
// RFC 7591 — Dynamic Client Registration
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ClientRegistrationRequest {
    #[serde(default)]
    pub client_name: Option<String>,
    pub redirect_uris: Vec<String>,
    #[serde(default)]
    pub grant_types: Option<Vec<String>>,
    #[serde(default)]
    pub response_types: Option<Vec<String>>,
    #[serde(default)]
    pub token_endpoint_auth_method: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ClientRegistrationResponse {
    pub client_id: String,
    pub client_id_issued_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret_expires_at: Option<i64>,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub grant_types: Vec<String>,
    pub response_types: Vec<String>,
    pub token_endpoint_auth_method: String,
    pub scope: String,
}

pub async fn register_client(
    ConnectInfo(connect_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ClientRegistrationRequest>,
) -> Result<(StatusCode, Json<ClientRegistrationResponse>), OAuthError> {
    let cfg = require_oauth(&state)?;

    // Decision D5: Anthropic's documented connector egress is a single
    // shared CIDR — every Claude user's DCR request would otherwise land in
    // one per-IP bucket. Exempt it; throttle everything else per-IP via the
    // existing Redis rate limiter, backed by the global unconsumed-client
    // cap below regardless of source.
    let ip = crate::client_ip::canonical_client_ip(
        &headers,
        connect_addr,
        state.config.trusted_proxy_hops,
    );
    let is_trusted = oauth::ip_is_trusted(ip, &cfg.registration_trusted_cidrs);
    if !is_trusted {
        let mut redis = state.redis.clone();
        let key = format!("mcp_oauth:register_rl:{}", ip);
        let count: i64 = redis::cmd("INCR")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap_or(1);
        if count == 1 {
            let _: Result<(), redis::RedisError> = redis::cmd("EXPIRE")
                .arg(&key)
                .arg(3600)
                .query_async(&mut redis)
                .await;
        }
        if count > cfg.registration_per_hour_per_ip as i64 {
            return Err(OAuthError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "invalid_request",
                "registration rate limit exceeded, try again later",
            ));
        }
    }

    // Global backstop regardless of source IP — bounds the worst case even
    // if the trusted-CIDR check is ever misconfigured.
    if state
        .db
        .count_unconsumed_oauth_clients(std::time::Duration::from_secs(3600))
        .await
        .unwrap_or(0)
        > 5000
    {
        return Err(OAuthError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "invalid_request",
            "registration is temporarily unavailable, try again later",
        ));
    }

    if req.redirect_uris.is_empty() || req.redirect_uris.len() > 10 {
        return Err(OAuthError::invalid_client_metadata(
            "redirect_uris must contain 1-10 URIs",
        ));
    }
    for uri in &req.redirect_uris {
        if !oauth::is_allowed_registration_redirect(uri, &cfg.allowed_registration_redirect_hosts) {
            return Err(OAuthError::invalid_client_metadata(format!(
                "redirect_uri is not on the allowed registration list: {uri}"
            )));
        }
    }

    let client_name =
        oauth::sanitize_client_name(req.client_name.as_deref().unwrap_or("Unnamed client"))
            .map_err(|_| OAuthError::invalid_client_metadata("client_name is invalid"))?;

    let auth_method = req
        .token_endpoint_auth_method
        .clone()
        .unwrap_or_else(|| "none".to_string());
    if !matches!(
        auth_method.as_str(),
        "none" | "client_secret_basic" | "client_secret_post"
    ) {
        return Err(OAuthError::invalid_client_metadata(
            "unsupported token_endpoint_auth_method",
        ));
    }

    let grant_types = req.grant_types.clone().unwrap_or_else(|| {
        vec![
            "authorization_code".to_string(),
            "refresh_token".to_string(),
        ]
    });
    for gt in &grant_types {
        if !matches!(gt.as_str(), "authorization_code" | "refresh_token") {
            return Err(OAuthError::invalid_client_metadata(format!(
                "unsupported grant_type: {gt}"
            )));
        }
    }
    let response_types = req
        .response_types
        .clone()
        .unwrap_or_else(|| vec!["code".to_string()]);
    if response_types != ["code"] {
        return Err(OAuthError::invalid_client_metadata(
            "only response_type=code is supported",
        ));
    }
    let scope = oauth::normalize_scopes(req.scope.as_deref().unwrap_or(oauth::DEFAULT_SCOPES))
        .map_err(OAuthError::invalid_client_metadata)?;

    let client_id = oauth::random_token(oauth::CLIENT_ID_PREFIX);
    let (client_secret, client_secret_sha256) = if auth_method == "none" {
        (None, None)
    } else {
        let secret = oauth::random_token("mws_secret_");
        let hash = oauth::hash_token(&secret);
        (Some(secret), Some(hash))
    };

    let row = OAuthClientRow {
        client_id: client_id.clone(),
        client_secret_sha256,
        client_name: client_name.clone(),
        redirect_uris: req.redirect_uris.clone(),
        grant_types: grant_types.clone(),
        response_types: response_types.clone(),
        token_endpoint_auth_method: auth_method.clone(),
        scope: scope.clone(),
        status: "active".to_string(),
        registered_ip: Some(ip.to_string()),
    };
    state.db.insert_oauth_client(&row).await?;

    Ok((
        StatusCode::CREATED,
        Json(ClientRegistrationResponse {
            client_id,
            client_id_issued_at: Utc::now().timestamp(),
            client_secret,
            client_secret_expires_at: if auth_method == "none" { None } else { Some(0) },
            client_name,
            redirect_uris: req.redirect_uris,
            grant_types,
            response_types,
            token_endpoint_auth_method: auth_method,
            scope,
        }),
    ))
}

// ---------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AuthorizeQuery {
    pub response_type: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    #[serde(default)]
    pub code_challenge_method: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub resource: Option<String>,
}

fn error_page(status: StatusCode, title: &str, detail: &str) -> Response {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem\">\
         <h1>{title}</h1><p>{detail}</p></body></html>"
    );
    (status, Html(body)).into_response()
}

pub async fn authorize(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(query): axum::extract::Query<AuthorizeQuery>,
) -> Response {
    let cfg = match require_oauth(&state) {
        Ok(cfg) => cfg,
        Err(err) => return err.into_response(),
    };

    // Client and redirect_uri must both check out before we're willing to
    // redirect anywhere — an invalid client or redirect target is an error
    // PAGE, never a redirect, so a bad `client_id` can't be used to bounce
    // a victim through our domain to an attacker's URL.
    let client = match state.db.fetch_oauth_client(&query.client_id).await {
        Ok(Some(client)) => client,
        Ok(None) => {
            return error_page(
                StatusCode::BAD_REQUEST,
                "Unknown application",
                "This connector is not registered with Walrus Memory.",
            )
        }
        Err(_) => {
            return error_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong",
                "Please try again.",
            )
        }
    };
    let Some(redirect_uri) = client
        .redirect_uris
        .iter()
        .find(|registered| oauth::redirect_uri_matches(&query.redirect_uri, registered))
        .cloned()
    else {
        return error_page(
            StatusCode::BAD_REQUEST,
            "Redirect not recognized",
            "The redirect_uri does not match what this connector registered.",
        );
    };

    // Every failure below this point is safe to report via redirect, per
    // RFC 6749 §4.1.2.1 — the caller already proved it controls
    // `redirect_uri`.
    let bounce_error = |error: &'static str, description: &str| -> Response {
        let mut target = url::Url::parse(&redirect_uri).expect("validated above");
        target.query_pairs_mut().append_pair("error", error);
        if !description.is_empty() {
            target
                .query_pairs_mut()
                .append_pair("error_description", description);
        }
        if let Some(state) = &query.state {
            target.query_pairs_mut().append_pair("state", state);
        }
        Redirect::to(target.as_str()).into_response()
    };

    if query.response_type != "code" {
        return bounce_error(
            "unsupported_response_type",
            "only response_type=code is supported",
        );
    }
    if query.code_challenge_method.as_deref() != Some("S256") {
        return bounce_error("invalid_request", "code_challenge_method must be S256");
    }
    if query.code_challenge.is_empty() {
        return bounce_error("invalid_request", "code_challenge is required");
    }
    let Some(resource) = query
        .resource
        .as_deref()
        .and_then(oauth::normalize_resource_uri)
    else {
        return bounce_error(
            "invalid_target",
            "resource is required and must be a valid https URL",
        );
    };
    if resource != oauth::normalize_resource_uri(&cfg.resource).unwrap_or_default() {
        return bounce_error("invalid_target", "resource does not match this server");
    }

    // Reuse an already-activated delegate for this account+client pair if
    // the account is known from a prior grant tied to the SAME client, so a
    // reconnect doesn't mint a fresh on-chain delegate key every time. We
    // don't know the account yet at this point (no wallet connected), so
    // this is re-checked in `session_account` once the user picks a
    // wallet — here we always mint a placeholder pending delegate; the
    // consent step may swap it for a reused one.
    let (private_key_hex, public_key_hex, delegate_address) = oauth::generate_delegate_key();
    let encrypted = match oauth::encrypt_delegate_private_key(&cfg.encryption_key, &private_key_hex)
    {
        Ok(env) => env,
        Err(_) => {
            return error_page(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong",
                "Please try again.",
            )
        }
    };
    let delegate_ref = oauth::random_token(oauth::DELEGATE_REF_PREFIX);
    let delegate_row = OAuthDelegateRow {
        delegate_ref: delegate_ref.clone(),
        account_id: None,
        owner_address: None,
        delegate_public_key: public_key_hex,
        delegate_address,
        encrypted_private_key: encrypted,
        label: oauth::sanitize_label(query.state.as_deref().unwrap_or(""), &client.client_name),
        status: "pending".to_string(),
        tx_digest: None,
    };
    if state.db.insert_oauth_delegate(&delegate_row).await.is_err() {
        return error_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong",
            "Please try again.",
        );
    }

    let scope = match oauth::normalize_scopes(query.scope.as_deref().unwrap_or(&client.scope)) {
        Ok(scope) if oauth::scopes_are_subset(&scope, &client.scope) => scope,
        Ok(_) => {
            return bounce_error(
                "invalid_scope",
                "requested scope exceeds the registered client scope",
            )
        }
        Err(_) => return bounce_error("invalid_scope", "requested scope is unsupported"),
    };
    let session_id = oauth::random_token(oauth::SESSION_ID_PREFIX);
    let session_row = OAuthSessionRow {
        session_id: session_id.clone(),
        client_id: client.client_id.clone(),
        redirect_uri: redirect_uri.clone(),
        state: query.state.clone(),
        scope,
        resource: resource.clone(),
        code_challenge: query.code_challenge.clone(),
        code_challenge_method: "S256".to_string(),
        delegate_ref,
        status: "pending".to_string(),
        expires_at: Utc::now() + Duration::seconds(cfg.session_ttl_secs),
    };
    if state.db.insert_oauth_session(&session_row).await.is_err() {
        return error_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong",
            "Please try again.",
        );
    }
    let _ = state
        .db
        .touch_oauth_client_last_used(&client.client_id)
        .await;

    Redirect::to(&format!("{}?session={session_id}", cfg.consent_url)).into_response()
}

// ---------------------------------------------------------------------
// Consent SPA JSON API
// ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SessionViewResponse {
    pub client_name: String,
    pub redirect_host: String,
    pub scopes: Vec<String>,
    pub delegate_public_key: String,
    pub delegate_sui_address: String,
    pub expires_at: chrono::DateTime<Utc>,
}

pub async fn session_view(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<Json<SessionViewResponse>, OAuthError> {
    require_oauth(&state)?;
    let session = state
        .db
        .fetch_oauth_session(&session_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_request("unknown or expired session"))?;
    let client = state
        .db
        .fetch_oauth_client(&session.client_id)
        .await?
        .ok_or_else(|| OAuthError::server_error("session references an unknown client"))?;
    let delegate = state
        .db
        .fetch_oauth_delegate(&session.delegate_ref)
        .await?
        .ok_or_else(|| OAuthError::server_error("session references an unknown delegate"))?;

    let redirect_host = url::Url::parse(&session.redirect_uri)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());

    Ok(Json(SessionViewResponse {
        client_name: client.client_name,
        redirect_host,
        scopes: session
            .scope
            .split_whitespace()
            .map(str::to_string)
            .collect(),
        delegate_public_key: delegate.delegate_public_key,
        delegate_sui_address: delegate.delegate_address,
        expires_at: session.expires_at,
    }))
}

#[derive(Debug, Deserialize)]
pub struct SessionAccountRequest {
    pub account_id: String,
    /// Accepted for API-shape symmetry with `SessionCompleteRequest`;
    /// the reuse-preflight only needs `account_id`. Owner is verified
    /// on-chain in `session_complete`, not here.
    #[allow(dead_code)]
    pub owner_address: String,
}

#[derive(Debug, Serialize)]
pub struct SessionAccountResponse {
    pub needs_onchain_registration: bool,
    pub delegate_public_key: String,
    pub delegate_sui_address: String,
}

pub async fn session_account(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SessionAccountRequest>,
) -> Result<Json<SessionAccountResponse>, OAuthError> {
    require_oauth(&state)?;
    let session = state
        .db
        .fetch_oauth_session(&session_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_request("unknown or expired session"))?;

    // Preflight: does this account already have an active OAuth delegate
    // (from a prior grant, any client)? If so, the consent UI can skip the
    // on-chain `add_delegate_key` tx entirely — this is what keeps a
    // reconnect from burning another slot toward the on-chain 20-key cap.
    if let Some(existing) = state
        .db
        .find_reusable_oauth_delegate(&req.account_id)
        .await?
    {
        return Ok(Json(SessionAccountResponse {
            needs_onchain_registration: false,
            delegate_public_key: existing.delegate_public_key,
            delegate_sui_address: existing.delegate_address,
        }));
    }

    let delegate = state
        .db
        .fetch_oauth_delegate(&session.delegate_ref)
        .await?
        .ok_or_else(|| OAuthError::server_error("session references an unknown delegate"))?;

    Ok(Json(SessionAccountResponse {
        needs_onchain_registration: true,
        delegate_public_key: delegate.delegate_public_key,
        delegate_sui_address: delegate.delegate_address,
    }))
}

#[derive(Debug, Deserialize)]
pub struct SessionCompleteRequest {
    pub account_id: String,
    pub owner_address: String,
    pub owner_signature: String,
    pub tx_digest: String,
}

#[derive(Debug, Serialize)]
pub struct RedirectResponse {
    pub redirect_url: String,
}

fn oauth_owner_proof_message(session_id: &str, account_id: &str, owner_address: &str) -> String {
    format!(
        "Walrus Memory OAuth authorization\nsession:{session_id}\naccount:{account_id}\nowner:{owner_address}"
    )
}

fn sanitize_sui_object_id(raw: &str) -> Result<String, OAuthError> {
    let value = raw.trim();
    if value.starts_with("0x")
        && value.len() == 66
        && value[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(OAuthError::invalid_request(
            "account_id/owner_address is invalid",
        ))
    }
}

pub async fn session_complete(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SessionCompleteRequest>,
) -> Result<Json<RedirectResponse>, OAuthError> {
    require_oauth(&state)?;
    let account_id = sanitize_sui_object_id(&req.account_id)?;
    let owner_address = sanitize_sui_object_id(&req.owner_address)?;
    if req.tx_digest.trim().is_empty() || req.tx_digest.len() > 160 {
        return Err(OAuthError::invalid_request("tx_digest is invalid"));
    }
    if req.owner_signature.trim().is_empty() || req.owner_signature.len() > 4096 {
        return Err(OAuthError::invalid_request("owner_signature is invalid"));
    }

    // Verify a fresh, session-bound wallet signature before consuming the
    // session or consulting reusable delegates. This prevents an attacker
    // with a session ID from naming a victim account that connected before.
    let proof = oauth_owner_proof_message(&session_id, &account_id, &owner_address);
    state
        .security_delete_wallet_verifier
        .verify_personal(&owner_address, proof.as_bytes(), &req.owner_signature)
        .await
        .map_err(|_| OAuthError::invalid_request("wallet ownership proof is invalid"))?;

    // Atomically claim the session so it can only ever be completed once —
    // Postgres analog of the WALM-30 prior art's Redis GETDEL guarantee.
    let session = state
        .db
        .consume_oauth_session(&session_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_request("session already used, expired, or unknown"))?;

    // Both new and reused delegates require fresh on-chain verification.
    // Possession of an authorization session ID is not wallet proof and must
    // never be sufficient to select another account's custodied delegate.
    let (delegate, is_reused) = match state.db.find_reusable_oauth_delegate(&account_id).await? {
        Some(existing) => (existing, true),
        None => (
            state
                .db
                .fetch_oauth_delegate(&session.delegate_ref)
                .await?
                .ok_or_else(|| OAuthError::server_error("session delegate is missing"))?,
            false,
        ),
    };
    let public_key_bytes = hex::decode(&delegate.delegate_public_key)
        .map_err(|_| OAuthError::server_error("stored delegate public key is invalid"))?;
    let verified_owner = verify_delegate_key_onchain(
        &state.http_client,
        &state.config.sui_rpc_url,
        state.sui_grpc_client.as_ref(),
        &account_id,
        &public_key_bytes,
        &state.config.package_id,
    )
    .await
    .map_err(|e| {
        OAuthError::invalid_request(format!("delegate key is not registered on-chain: {e}"))
    })?;
    if !verified_owner.eq_ignore_ascii_case(&owner_address) {
        return Err(OAuthError::invalid_request(
            "verified owner does not match connected account",
        ));
    }
    if !is_reused {
        state
            .db
            .activate_oauth_delegate(
                &delegate.delegate_ref,
                &account_id,
                &verified_owner,
                &req.tx_digest,
            )
            .await?;
    }
    let delegate_ref = delegate.delegate_ref;
    let delegate_public_key = delegate.delegate_public_key;

    let code = oauth::random_token("mwac_");
    let code_row = OAuthCodeRow {
        code_sha256: oauth::hash_token(&code),
        client_id: session.client_id.clone(),
        redirect_uri: session.redirect_uri.clone(),
        scope: session.scope.clone(),
        resource: session.resource.clone(),
        code_challenge: session.code_challenge.clone(),
        code_challenge_method: session.code_challenge_method.clone(),
        delegate_ref,
        account_id,
        owner_address,
        expires_at: Utc::now()
            + Duration::seconds(
                state
                    .config
                    .mcp_oauth
                    .as_ref()
                    .map(|c| c.code_ttl_secs)
                    .unwrap_or(300),
            ),
    };
    state.db.insert_oauth_code(&code_row).await?;
    let _ = delegate_public_key; // reserved for future consent-page echo; not needed in the redirect

    let mut target = url::Url::parse(&session.redirect_uri).expect("validated at authorize time");
    target.query_pairs_mut().append_pair("code", &code);
    if let Some(state_param) = &session.state {
        target.query_pairs_mut().append_pair("state", state_param);
    }
    Ok(Json(RedirectResponse {
        redirect_url: target.to_string(),
    }))
}

#[derive(Debug, Deserialize)]
pub struct SessionCancelRequest {
    #[serde(default)]
    pub error: Option<String>,
}

pub async fn session_cancel(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Json(req): Json<SessionCancelRequest>,
) -> Result<Json<RedirectResponse>, OAuthError> {
    require_oauth(&state)?;
    let session = state
        .db
        .consume_oauth_session(&session_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_request("session already used, expired, or unknown"))?;

    let error = req
        .error
        .as_deref()
        .filter(|e| e.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
        .unwrap_or("access_denied");

    let mut target = url::Url::parse(&session.redirect_uri).expect("validated at authorize time");
    target.query_pairs_mut().append_pair("error", error);
    if let Some(state_param) = &session.state {
        target.query_pairs_mut().append_pair("state", state_param);
    }
    Ok(Json(RedirectResponse {
        redirect_url: target.to_string(),
    }))
}

// ---------------------------------------------------------------------
// POST /oauth/token — accepts BOTH application/x-www-form-urlencoded (the
// spec-required content type) and application/json (Anthropic's docs
// explicitly warn that a JSON-only parser here breaks the flow with a 415,
// implying some client code paths send JSON).
// ---------------------------------------------------------------------

pub struct FormOrJson<T>(pub T);

impl<S, T> FromRequest<S> for FormOrJson<T>
where
    T: serde::de::DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = OAuthError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let is_json = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.starts_with("application/json"))
            .unwrap_or(false);
        if is_json {
            let Json(value) = Json::<T>::from_request(req, state)
                .await
                .map_err(|e| OAuthError::invalid_request(format!("invalid JSON body: {e}")))?;
            Ok(FormOrJson(value))
        } else {
            let Form(value) = Form::<T>::from_request(req, state)
                .await
                .map_err(|e| OAuthError::invalid_request(format!("invalid form body: {e}")))?;
            Ok(FormOrJson(value))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenRequest {
    pub grant_type: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub code_verifier: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub resource: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    pub scope: String,
}

/// Authenticate the client for `/oauth/token`: Basic-auth header wins if
/// present (confidential clients), otherwise `client_id`/`client_secret`
/// from the body (RFC 6749 allows either; Claude's public clients send
/// neither and rely on `token_endpoint_auth_method: "none"`).
fn client_credentials_from_request(
    headers: &HeaderMap,
    body: &TokenRequest,
) -> Option<(String, Option<String>)> {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(encoded) = auth.strip_prefix("Basic ") {
            if let Ok(decoded) =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
            {
                if let Ok(text) = String::from_utf8(decoded) {
                    if let Some((id, secret)) = text.split_once(':') {
                        return Some((id.to_string(), Some(secret.to_string())));
                    }
                }
            }
        }
    }
    body.client_id
        .clone()
        .map(|id| (id, body.client_secret.clone()))
}

async fn authenticate_client(
    state: &AppState,
    headers: &HeaderMap,
    body: &TokenRequest,
) -> Result<OAuthClientRow, OAuthError> {
    let (client_id, secret) = client_credentials_from_request(headers, body)
        .ok_or_else(|| OAuthError::invalid_client("missing client authentication"))?;
    let client = state
        .db
        .fetch_oauth_client(&client_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_client("unknown client"))?;

    match client.token_endpoint_auth_method.as_str() {
        "none" => Ok(client),
        _ => {
            let secret =
                secret.ok_or_else(|| OAuthError::invalid_client("missing client_secret"))?;
            let expected = client
                .client_secret_sha256
                .as_deref()
                .ok_or_else(|| OAuthError::invalid_client("client has no secret configured"))?;
            if oauth::constant_time_eq(oauth::hash_token(&secret).as_bytes(), expected.as_bytes()) {
                Ok(client)
            } else {
                Err(OAuthError::invalid_client("invalid client_secret"))
            }
        }
    }
}

fn mint_token_pair(
    cfg: &oauth::McpOAuthConfig,
    grant_id: &str,
    scope: &str,
) -> (String, OAuthTokenRow, String, OAuthTokenRow) {
    let access_token = oauth::random_token(oauth::ACCESS_TOKEN_PREFIX);
    let access_row = OAuthTokenRow {
        token_sha256: oauth::hash_token(&access_token),
        grant_id: grant_id.to_string(),
        token_type: "access".to_string(),
        expires_at: Utc::now() + Duration::seconds(cfg.access_ttl_secs),
    };
    let refresh_token = oauth::random_token(oauth::REFRESH_TOKEN_PREFIX);
    let refresh_row = OAuthTokenRow {
        token_sha256: oauth::hash_token(&refresh_token),
        grant_id: grant_id.to_string(),
        token_type: "refresh".to_string(),
        expires_at: Utc::now() + Duration::seconds(cfg.refresh_ttl_secs),
    };
    let _ = scope;
    (access_token, access_row, refresh_token, refresh_row)
}

pub async fn token(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    FormOrJson(req): FormOrJson<TokenRequest>,
) -> Result<Json<TokenResponse>, OAuthError> {
    let cfg = require_oauth(&state)?;

    match req.grant_type.as_str() {
        "authorization_code" => {
            let client = authenticate_client(&state, &headers, &req).await?;
            let code = req
                .code
                .as_deref()
                .ok_or_else(|| OAuthError::invalid_request("code is required"))?;
            let redirect_uri = req
                .redirect_uri
                .as_deref()
                .ok_or_else(|| OAuthError::invalid_request("redirect_uri is required"))?;
            let code_verifier = req
                .code_verifier
                .as_deref()
                .ok_or_else(|| OAuthError::invalid_request("code_verifier is required"))?;

            let code_row = state
                .db
                .consume_oauth_code(&client.client_id, &oauth::hash_token(code))
                .await?
                .ok_or_else(|| {
                    OAuthError::invalid_grant(
                        "authorization code is invalid, expired, or already used",
                    )
                })?;

            if code_row.redirect_uri != redirect_uri {
                return Err(OAuthError::invalid_grant(
                    "redirect_uri does not match the authorization request",
                ));
            }
            if !oauth::verify_pkce_s256(code_verifier, &code_row.code_challenge) {
                return Err(OAuthError::invalid_grant(
                    "code_verifier does not match code_challenge",
                ));
            }
            if let Some(requested_resource) = req.resource.as_deref() {
                let normalized = oauth::normalize_resource_uri(requested_resource);
                if normalized.as_deref() != Some(code_row.resource.as_str()) {
                    return Err(OAuthError::invalid_target(
                        "resource does not match the authorization request",
                    ));
                }
            }

            let grant_id = oauth::random_token(oauth::GRANT_ID_PREFIX);
            state
                .db
                .insert_oauth_grant(&OAuthGrantRow {
                    grant_id: grant_id.clone(),
                    client_id: client.client_id.clone(),
                    delegate_ref: code_row.delegate_ref.clone(),
                    account_id: code_row.account_id.clone(),
                    owner_address: code_row.owner_address.clone(),
                    scope: code_row.scope.clone(),
                    resource: code_row.resource.clone(),
                })
                .await?;

            let (access_token, access_row, refresh_token, refresh_row) =
                mint_token_pair(cfg, &grant_id, &code_row.scope);
            state.db.insert_oauth_token(&access_row).await?;
            state.db.insert_oauth_token(&refresh_row).await?;

            Ok(Json(TokenResponse {
                access_token,
                token_type: "Bearer",
                expires_in: cfg.access_ttl_secs,
                refresh_token: Some(refresh_token),
                scope: code_row.scope,
            }))
        }
        "refresh_token" => {
            let client = authenticate_client(&state, &headers, &req).await?;
            let presented = req
                .refresh_token
                .as_deref()
                .ok_or_else(|| OAuthError::invalid_request("refresh_token is required"))?;
            let presented_hash = oauth::hash_token(presented);

            let preview = state
                .db
                .fetch_oauth_token_with_delegate(&presented_hash)
                .await?
                .ok_or_else(|| OAuthError::invalid_grant("refresh_token is invalid"))?;
            if preview.token_type != "refresh" {
                return Err(OAuthError::invalid_grant("token is not a refresh token"));
            }
            if preview.client_id != client.client_id {
                return Err(OAuthError::invalid_grant(
                    "refresh_token belongs to another client",
                ));
            }
            if preview.revoked_at.is_some() || preview.grant_revoked_at.is_some() {
                state.db.revoke_oauth_grant(&preview.grant_id).await?;
                return Err(OAuthError::invalid_grant(
                    "refresh_token was already used or revoked; the connection has been revoked",
                ));
            }
            if preview.expires_at <= Utc::now() {
                return Err(OAuthError::invalid_grant("refresh_token has expired"));
            }

            // Consume and replace the refresh token in one database
            // transaction. Exactly one concurrent presenter can succeed.
            let (access_token, access_row, refresh_token, refresh_row) =
                mint_token_pair(cfg, &preview.grant_id, &preview.scope);
            let row = state
                .db
                .rotate_oauth_refresh_token(
                    &presented_hash,
                    &client.client_id,
                    &access_row,
                    &refresh_row,
                )
                .await?
                .ok_or_else(|| {
                    OAuthError::invalid_grant("refresh_token was concurrently used or revoked")
                })?;

            Ok(Json(TokenResponse {
                access_token,
                token_type: "Bearer",
                expires_in: cfg.access_ttl_secs,
                refresh_token: Some(refresh_token),
                scope: row.scope,
            }))
        }
        other => Err(OAuthError::unsupported_grant_type(format!(
            "unsupported grant_type: {other}"
        ))),
    }
}

// ---------------------------------------------------------------------
// POST /oauth/revoke (RFC 7009)
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RevokeRequest {
    pub token: String,
    #[serde(default)]
    pub token_type_hint: Option<String>,
}

pub async fn revoke(
    State(state): State<Arc<AppState>>,
    FormOrJson(req): FormOrJson<RevokeRequest>,
) -> Result<StatusCode, OAuthError> {
    require_oauth(&state)?;
    let hash = oauth::hash_token(&req.token);
    let _ = req.token_type_hint;

    // RFC 7009 §2.2: revoking a refresh token invalidates its whole grant;
    // revoking an access token invalidates only that token. Always 200
    // regardless of whether the token existed, to avoid leaking token
    // validity to an unauthenticated caller.
    if let Ok(Some(row)) = state.db.fetch_oauth_token_with_delegate(&hash).await {
        if row.token_type == "refresh" {
            let _ = state.db.revoke_oauth_grant(&row.grant_id).await;
        } else {
            let _ = state.db.revoke_oauth_token(&hash).await;
        }
    }
    Ok(StatusCode::OK)
}
