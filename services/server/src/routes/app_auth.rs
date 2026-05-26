//! Hosted OAuth-style app auth for third-party web apps.
//!
//! `/connect/app` is rendered by the Vite app. These API endpoints own all
//! security-sensitive short-lived Redis state: registered client validation,
//! redirect construction, server-held delegate references, and one-time code
//! exchange.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::{
    extract::State,
    http::{header, HeaderMap},
    Json,
};
use base64::{engine::general_purpose, Engine as _};
use blake2::{
    digest::{Update, VariableOutput},
    Blake2bVar,
};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::SigningKey;
use rand::{rngs::OsRng, RngCore};
use redis::AsyncCommands;
use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::storage::sui::verify_delegate_key_onchain;
use crate::types::{AppAuthClientConfig, AppError, AppState};

const APP_AUTH_SESSION_TTL_SECS: u64 = 15 * 60;
const APP_AUTH_CODE_TTL_SECS: u64 = 5 * 60;
const APP_AUTH_INTENT: &str = "sdk_delegate";
const DEFAULT_LABEL: &str = "Walrus Memory App";

#[derive(Debug, Deserialize)]
pub struct AppAuthStartRequest {
    pub client_id: String,
    pub redirect_uri: String,
    pub state: String,
    pub label: Option<String>,
    pub intent: String,
    pub fallback_uri: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AppAuthStartResponse {
    pub session_id: String,
    pub client: AppAuthClientPublic,
    pub redirect_host: String,
    pub label: String,
    pub expires_at: DateTime<Utc>,
    pub delegate: AppAuthStartDelegate,
}

#[derive(Debug, Serialize)]
pub struct AppAuthClientPublic {
    pub client_id: String,
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct AppAuthStartDelegate {
    pub public_key: String,
    pub sui_address: String,
}

#[derive(Debug, Deserialize)]
pub struct AppAuthCompleteRequest {
    pub session_id: String,
    pub account_id: String,
    pub owner_address: String,
    pub provider: String,
    pub tx_digest: String,
}

#[derive(Debug, Serialize)]
pub struct AppAuthRedirectResponse {
    pub redirect_url: String,
}

#[derive(Debug, Deserialize)]
pub struct AppAuthCancelRequest {
    pub session_id: String,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppAuthTokenRequest {
    pub grant_type: String,
    pub code: String,
    pub redirect_uri: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub struct AppAuthTokenResponse {
    pub account_id: String,
    pub owner_address: String,
    pub provider: String,
    pub delegate: AppAuthTokenDelegate,
}

#[derive(Debug, Serialize)]
pub struct AppAuthTokenDelegate {
    pub status: String,
    #[serde(rename = "ref")]
    pub delegate_ref: String,
    pub public_key: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppAuthSessionStore {
    id: String,
    client_id: String,
    redirect_uri: String,
    fallback_uri: Option<String>,
    state: String,
    label: String,
    delegate_ref: String,
    delegate_public_key: String,
    status: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppAuthCodeStore {
    client_id: String,
    redirect_uri: String,
    state: String,
    account_id: String,
    owner_address: String,
    provider: String,
    delegate_ref: String,
    delegate_public_key: String,
    delegate_label: String,
    expires_at: DateTime<Utc>,
}

#[allow(dead_code)]
#[derive(Clone, Serialize, Deserialize)]
struct AppAuthDelegateStore {
    id: String,
    client_id: String,
    account_id: Option<String>,
    owner_address: Option<String>,
    provider: Option<String>,
    delegate_public_key: String,
    delegate_address: String,
    encrypted_delegate_private_key: String,
    label: String,
    status: String,
    tx_digest: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

pub async fn app_auth_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppAuthStartRequest>,
) -> Result<Json<AppAuthStartResponse>, AppError> {
    if req.intent != APP_AUTH_INTENT {
        return Err(AppError::BadRequest("unsupported intent".into()));
    }
    if req.state.trim().is_empty() {
        return Err(AppError::BadRequest("state is required".into()));
    }

    let client = find_client(&state.config.app_auth_clients, &req.client_id)
        .ok_or_else(|| AppError::BadRequest("unknown app client".into()))?;
    let redirect_uri = validated_allowed_url(
        &req.redirect_uri,
        &client.allowed_redirect_uris,
        state.config.app_auth_enable_dev_localhost_wildcards,
    )
    .ok_or_else(|| AppError::BadRequest("redirect_uri is not registered for this client".into()))?;
    let fallback_uri = select_fallback_uri(
        client,
        req.fallback_uri.as_deref(),
        state.config.app_auth_enable_dev_localhost_wildcards,
    );
    if req.fallback_uri.is_some() && fallback_uri.is_none() {
        return Err(AppError::BadRequest(
            "fallback_uri is not registered for this client".into(),
        ));
    }

    let label = sanitize_label(
        req.label
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&client.display_name),
    );
    let (private_key_hex, public_key, delegate_address) = generate_delegate_key();
    let encrypted_delegate_private_key = encrypt_delegate_private_key(&state, &private_key_hex)?;
    let delegate_ref = random_token("appdel_");
    let session_id = random_token("appses_");
    let now = Utc::now();
    let expires_at = now + Duration::seconds(APP_AUTH_SESSION_TTL_SECS as i64);

    let delegate = AppAuthDelegateStore {
        id: delegate_ref.clone(),
        client_id: client.client_id.clone(),
        account_id: None,
        owner_address: None,
        provider: None,
        delegate_public_key: public_key.clone(),
        delegate_address: delegate_address.clone(),
        encrypted_delegate_private_key,
        label: label.clone(),
        status: "pending".to_string(),
        tx_digest: None,
        created_at: now,
        updated_at: now,
    };
    let session = AppAuthSessionStore {
        id: session_id.clone(),
        client_id: client.client_id.clone(),
        redirect_uri: redirect_uri.clone(),
        fallback_uri: fallback_uri.clone(),
        state: req.state.clone(),
        label: label.clone(),
        delegate_ref: delegate_ref.clone(),
        delegate_public_key: public_key.clone(),
        status: "pending".to_string(),
        expires_at,
    };

    set_redis_json(
        state.as_ref(),
        &app_auth_delegate_key(&delegate_ref),
        &delegate,
        None,
    )
    .await?;
    set_redis_json(
        state.as_ref(),
        &app_auth_session_key(&session_id),
        &session,
        Some(APP_AUTH_SESSION_TTL_SECS),
    )
    .await?;

    Ok(Json(AppAuthStartResponse {
        session_id,
        client: AppAuthClientPublic {
            client_id: client.client_id.clone(),
            display_name: client.display_name.clone(),
        },
        redirect_host: url_host_label(&redirect_uri),
        label,
        expires_at,
        delegate: AppAuthStartDelegate {
            public_key,
            sui_address: delegate_address,
        },
    }))
}

pub async fn app_auth_complete(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppAuthCompleteRequest>,
) -> Result<Json<AppAuthRedirectResponse>, AppError> {
    let provider = normalize_provider(&req.provider)?;
    let tx_digest = sanitize_short_token(&req.tx_digest, "tx_digest")?;
    let account_id = sanitize_sui_object_id(&req.account_id, "account_id")?;
    let owner_address = sanitize_sui_object_id(&req.owner_address, "owner_address")?;
    let session = load_session(&state, &req.session_id).await?;
    ensure_session_pending(&session)?;

    let public_key_bytes = hex::decode(&session.delegate_public_key)
        .map_err(|_| AppError::Internal("stored delegate public key is invalid".into()))?;
    let verified_owner = verify_delegate_key_onchain(
        &state.http_client,
        &state.config.sui_rpc_url,
        &account_id,
        &public_key_bytes,
    )
    .await
    .map_err(|e| AppError::BadRequest(format!("delegate key is not registered on-chain: {}", e)))?;

    if !verified_owner.eq_ignore_ascii_case(&owner_address) {
        return Err(AppError::BadRequest(
            "verified owner does not match connected account".into(),
        ));
    }

    let code = random_token("mwa_");
    let code_hash = hash_secret(&code);
    let session = take_session(state.as_ref(), &req.session_id).await?;
    ensure_session_pending(&session)?;

    let code_expires_at = Utc::now() + Duration::seconds(APP_AUTH_CODE_TTL_SECS as i64);
    let code_payload = AppAuthCodeStore {
        client_id: session.client_id.clone(),
        redirect_uri: session.redirect_uri.clone(),
        state: session.state.clone(),
        account_id: account_id.clone(),
        owner_address: verified_owner.clone(),
        provider: provider.clone(),
        delegate_ref: session.delegate_ref.clone(),
        delegate_public_key: session.delegate_public_key.clone(),
        delegate_label: session.label.clone(),
        expires_at: code_expires_at,
    };

    let mut delegate = load_delegate(state.as_ref(), &session.delegate_ref).await?;
    delegate.account_id = Some(account_id);
    delegate.owner_address = Some(verified_owner);
    delegate.provider = Some(provider);
    delegate.status = "active".to_string();
    delegate.tx_digest = Some(tx_digest);
    delegate.updated_at = Utc::now();

    set_redis_json(
        state.as_ref(),
        &app_auth_delegate_key(&session.delegate_ref),
        &delegate,
        None,
    )
    .await?;
    set_redis_json(
        state.as_ref(),
        &app_auth_code_key(&session.client_id, &code_hash),
        &code_payload,
        Some(APP_AUTH_CODE_TTL_SECS),
    )
    .await?;

    Ok(Json(AppAuthRedirectResponse {
        redirect_url: build_success_redirect(&session.redirect_uri, &code, &session.state),
    }))
}

pub async fn app_auth_cancel(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppAuthCancelRequest>,
) -> Result<Json<AppAuthRedirectResponse>, AppError> {
    let session = take_session(state.as_ref(), &req.session_id).await?;
    ensure_session_pending(&session)?;
    let error = req
        .error
        .as_deref()
        .map(|value| sanitize_error_code(value))
        .unwrap_or_else(|| "access_denied".to_string());
    let target = session
        .fallback_uri
        .as_deref()
        .unwrap_or(session.redirect_uri.as_str());
    Ok(Json(AppAuthRedirectResponse {
        redirect_url: build_error_redirect(target, &error, &session.state),
    }))
}

pub async fn app_auth_token(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppAuthTokenRequest>,
) -> Result<Json<AppAuthTokenResponse>, AppError> {
    if req.grant_type != "authorization_code" {
        return Err(AppError::BadRequest("unsupported grant_type".into()));
    }

    let (client_id, client_secret) = parse_basic_client_auth(&headers)?;
    let client = find_client(&state.config.app_auth_clients, &client_id)
        .ok_or_else(|| AppError::Unauthorized("invalid client credentials".into()))?;
    let secret_hash = hash_secret(&client_secret);
    if !constant_time_eq(
        secret_hash.as_bytes(),
        client.client_secret_sha256.as_bytes(),
    ) {
        return Err(AppError::Unauthorized("invalid client credentials".into()));
    }

    let code_hash = hash_secret(&req.code);
    let row = take_code(state.as_ref(), &client_id, &code_hash).await?;
    if row.client_id != client_id {
        return Err(AppError::Unauthorized(
            "client_id does not match authorization code".into(),
        ));
    }
    if let Some(reason) = code_binding_error(&row, &req.redirect_uri, &req.state, Utc::now()) {
        return Err(AppError::Unauthorized(reason.into()));
    }

    Ok(Json(AppAuthTokenResponse {
        account_id: row.account_id,
        owner_address: row.owner_address,
        provider: row.provider,
        delegate: AppAuthTokenDelegate {
            status: "active".to_string(),
            delegate_ref: row.delegate_ref,
            public_key: row.delegate_public_key,
            label: row.delegate_label,
        },
    }))
}

fn find_client<'a>(
    clients: &'a [AppAuthClientConfig],
    client_id: &str,
) -> Option<&'a AppAuthClientConfig> {
    clients.iter().find(|client| client.client_id == client_id)
}

fn select_fallback_uri(
    client: &AppAuthClientConfig,
    requested_fallback_uri: Option<&str>,
    allow_dev_localhost_wildcards: bool,
) -> Option<String> {
    if let Some(requested) = requested_fallback_uri {
        return validated_allowed_url(
            requested,
            &client.allowed_fallback_uris,
            allow_dev_localhost_wildcards,
        );
    }
    client.fallback_uri.as_deref().and_then(|fallback| {
        validated_allowed_url(
            fallback,
            &client.allowed_fallback_uris,
            allow_dev_localhost_wildcards,
        )
    })
}

fn validated_allowed_url(
    candidate: &str,
    allowlist: &[String],
    allow_dev_localhost_wildcards: bool,
) -> Option<String> {
    let candidate = validated_redirect_url(candidate)?;
    let candidate_normalized = candidate.as_str();
    let allowed = allowlist.iter().any(|allowed| {
        validated_redirect_url(allowed)
            .map(|allowed_url| allowed_url.as_str() == candidate_normalized)
            .unwrap_or_else(|| {
                localhost_wildcard_matches(&candidate, allowed, allow_dev_localhost_wildcards)
            })
    });
    allowed.then(|| candidate_normalized.to_string())
}

fn validated_redirect_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let scheme = url.scheme();
    let host = url.host_str()?;
    let is_localhost = is_loopback_host(host);
    if scheme != "https" && !(scheme == "http" && is_localhost) {
        return None;
    }
    Some(url)
}

fn localhost_wildcard_matches(
    candidate: &Url,
    allowed_pattern: &str,
    allow_dev_localhost_wildcards: bool,
) -> bool {
    if !allow_dev_localhost_wildcards {
        return false;
    }
    let Some(rest) = allowed_pattern.strip_prefix("http://") else {
        return false;
    };
    let Some((host_pattern, path_pattern)) = rest.split_once('/') else {
        return false;
    };
    let Some(host) = host_pattern.strip_suffix(":*") else {
        return false;
    };
    if !matches!(host, "localhost" | "127.0.0.1") {
        return false;
    }
    if candidate.scheme() != "http" || candidate.host_str() != Some(host) {
        return false;
    }
    if candidate.port().is_none() || candidate.query().is_some() {
        return false;
    }
    candidate.path() == format!("/{path_pattern}")
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn build_success_redirect(redirect_uri: &str, code: &str, state: &str) -> String {
    let mut url = Url::parse(redirect_uri).expect("stored redirect_uri must be valid");
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", state);
    url.to_string()
}

fn build_error_redirect(target_uri: &str, error: &str, state: &str) -> String {
    let mut url = Url::parse(target_uri).expect("stored fallback/redirect_uri must be valid");
    url.query_pairs_mut()
        .append_pair("error", error)
        .append_pair("state", state);
    url.to_string()
}

fn url_host_label(raw: &str) -> String {
    Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "registered app".to_string())
}

fn sanitize_label(raw: &str) -> String {
    let cleaned = raw
        .chars()
        .filter(|ch| !matches!(ch, '<' | '>' | '&' | '"' | '\'' | '/' | '\\'))
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(64)
        .collect::<String>();
    if cleaned.is_empty() {
        DEFAULT_LABEL.to_string()
    } else {
        cleaned
    }
}

fn sanitize_error_code(raw: &str) -> String {
    let cleaned = raw
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '_')
        .take(48)
        .collect::<String>();
    if cleaned.is_empty() {
        "server_error".to_string()
    } else {
        cleaned
    }
}

fn sanitize_short_token(raw: &str, field: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 160 {
        return Err(AppError::BadRequest(format!("{} is invalid", field)));
    }
    Ok(trimmed.to_string())
}

fn sanitize_sui_object_id(raw: &str, field: &str) -> Result<String, AppError> {
    let value = raw.trim();
    if value.starts_with("0x")
        && value.len() == 66
        && value[2..].chars().all(|ch| ch.is_ascii_hexdigit())
    {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(AppError::BadRequest(format!("{} is invalid", field)))
    }
}

fn normalize_provider(raw: &str) -> Result<String, AppError> {
    match raw {
        "wallet" | "google" => Ok(raw.to_string()),
        _ => Err(AppError::BadRequest("unsupported auth provider".into())),
    }
}

fn random_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!(
        "{}{}",
        prefix,
        general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn hash_secret(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn generate_delegate_key() -> (String, String, String) {
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    let signing_key = SigningKey::from_bytes(&secret);
    let public_key = signing_key.verifying_key().to_bytes();
    let private_key_hex = hex::encode(secret);
    let public_key_hex = hex::encode(public_key);
    let delegate_address = delegate_public_key_to_sui_address(&public_key);
    (private_key_hex, public_key_hex, delegate_address)
}

fn delegate_public_key_to_sui_address(public_key: &[u8; 32]) -> String {
    let mut hasher = Blake2bVar::new(32).expect("BLAKE2b-256 length is valid");
    hasher.update(&[0x00]);
    hasher.update(public_key);
    let mut digest = [0u8; 32];
    hasher
        .finalize_variable(&mut digest)
        .expect("BLAKE2b output length matches digest buffer");
    format!("0x{}", hex::encode(digest))
}

fn encrypt_delegate_private_key(
    state: &AppState,
    private_key_hex: &str,
) -> Result<String, AppError> {
    let secret = state
        .config
        .app_auth_delegate_secret
        .as_ref()
        .ok_or_else(|| {
            AppError::Internal(
                "APP_AUTH_DELEGATE_ENCRYPTION_KEY or SIDECAR_AUTH_TOKEN is required for app auth"
                    .into(),
            )
        })?;
    let cipher = Aes256Gcm::new_from_slice(secret.as_slice())
        .map_err(|_| AppError::Internal("app auth delegate encryption key is invalid".into()))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), private_key_hex.as_bytes())
        .map_err(|_| AppError::Internal("failed to encrypt app delegate private key".into()))?;
    Ok(format!(
        "v1.{}.{}",
        general_purpose::URL_SAFE_NO_PAD.encode(nonce_bytes),
        general_purpose::URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

fn app_auth_session_key(session_id: &str) -> String {
    format!("app_auth:session:{session_id}")
}

fn app_auth_code_key(client_id: &str, code_hash: &str) -> String {
    format!("app_auth:code:{client_id}:{code_hash}")
}

fn app_auth_delegate_key(delegate_ref: &str) -> String {
    format!("app_auth:delegate:{delegate_ref}")
}

async fn set_redis_json<T: Serialize>(
    state: &AppState,
    key: &str,
    value: &T,
    ttl_secs: Option<u64>,
) -> Result<(), AppError> {
    let payload = serde_json::to_string(value)
        .map_err(|e| AppError::Internal(format!("Failed to encode app auth state: {}", e)))?;
    let mut redis = state.redis.clone();
    if let Some(ttl_secs) = ttl_secs {
        redis
            .set_ex::<_, _, ()>(key, payload, ttl_secs)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to store app auth state: {}", e)))?;
    } else {
        redis
            .set::<_, _, ()>(key, payload)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to store app auth state: {}", e)))?;
    }
    Ok(())
}

async fn get_redis_json<T: DeserializeOwned>(
    state: &AppState,
    key: &str,
) -> Result<Option<T>, AppError> {
    let mut redis = state.redis.clone();
    let payload: Option<String> = redis
        .get(key)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to load app auth state: {}", e)))?;
    payload
        .map(|payload| {
            serde_json::from_str(&payload)
                .map_err(|e| AppError::Internal(format!("Failed to decode app auth state: {}", e)))
        })
        .transpose()
}

async fn take_redis_json<T: DeserializeOwned>(
    state: &AppState,
    key: &str,
) -> Result<Option<T>, AppError> {
    let mut redis = state.redis.clone();
    let payload: Option<String> = redis::cmd("GETDEL")
        .arg(key)
        .query_async(&mut redis)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to consume app auth state: {}", e)))?;
    payload
        .map(|payload| {
            serde_json::from_str(&payload)
                .map_err(|e| AppError::Internal(format!("Failed to decode app auth state: {}", e)))
        })
        .transpose()
}

async fn load_session(state: &AppState, session_id: &str) -> Result<AppAuthSessionStore, AppError> {
    get_redis_json(state, &app_auth_session_key(session_id))
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown app auth session".into()))
}

async fn take_session(state: &AppState, session_id: &str) -> Result<AppAuthSessionStore, AppError> {
    take_redis_json(state, &app_auth_session_key(session_id))
        .await?
        .ok_or_else(|| AppError::BadRequest("unknown or already used app auth session".into()))
}

async fn load_delegate(
    state: &AppState,
    delegate_ref: &str,
) -> Result<AppAuthDelegateStore, AppError> {
    get_redis_json(state, &app_auth_delegate_key(delegate_ref))
        .await?
        .ok_or_else(|| AppError::Internal("app auth delegate ref is missing".into()))
}

async fn take_code(
    state: &AppState,
    client_id: &str,
    code_hash: &str,
) -> Result<AppAuthCodeStore, AppError> {
    take_redis_json(state, &app_auth_code_key(client_id, code_hash))
        .await?
        .ok_or_else(|| {
            AppError::Unauthorized("authorization code expired, already used, or invalid".into())
        })
}

fn ensure_session_pending(session: &AppAuthSessionStore) -> Result<(), AppError> {
    if session.status != "pending" {
        return Err(AppError::BadRequest(
            "app auth session is not pending".into(),
        ));
    }
    if session.expires_at <= Utc::now() {
        return Err(AppError::BadRequest("app auth session expired".into()));
    }
    Ok(())
}

fn code_binding_error(
    row: &AppAuthCodeStore,
    redirect_uri: &str,
    state: &str,
    now: DateTime<Utc>,
) -> Option<&'static str> {
    if row.expires_at <= now {
        return Some("authorization code expired");
    }
    if row.redirect_uri != redirect_uri {
        return Some("redirect_uri does not match authorization code");
    }
    if row.state != state {
        return Some("state does not match authorization code");
    }
    None
}

fn parse_basic_client_auth(headers: &HeaderMap) -> Result<(String, String), AppError> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("missing client authentication".into()))?;
    let encoded = auth
        .strip_prefix("Basic ")
        .ok_or_else(|| AppError::Unauthorized("client authentication must use Basic".into()))?;
    let decoded = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::Unauthorized("client authentication is invalid".into()))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| AppError::Unauthorized("client authentication is invalid".into()))?;
    let (client_id, secret) = decoded
        .split_once(':')
        .ok_or_else(|| AppError::Unauthorized("client authentication is invalid".into()))?;
    if client_id.is_empty() || secret.is_empty() {
        return Err(AppError::Unauthorized(
            "client authentication is invalid".into(),
        ));
    }
    Ok((client_id.to_string(), secret.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_client() -> AppAuthClientConfig {
        AppAuthClientConfig {
            client_id: "demo_dapp".into(),
            client_secret_sha256: hash_secret("demo_dapp_secret"),
            display_name: "Demo Dapp".into(),
            allowed_redirect_uris: vec![
                "https://demo-app.com/api/memwal/callback".into(),
                "http://localhost:5173/api/memwal/callback".into(),
            ],
            fallback_uri: Some("https://demo-app.com/memwal/error".into()),
            allowed_fallback_uris: vec!["https://demo-app.com/memwal/error".into()],
        }
    }

    #[test]
    fn validates_exact_allowlisted_redirect() {
        let client = demo_client();
        assert_eq!(
            validated_allowed_url(
                "https://demo-app.com/api/memwal/callback",
                &client.allowed_redirect_uris,
                false
            )
            .as_deref(),
            Some("https://demo-app.com/api/memwal/callback")
        );
        assert_eq!(
            validated_allowed_url(
                "https://demo-app.com/api/memwal/callback/extra",
                &client.allowed_redirect_uris,
                false
            ),
            None
        );
    }

    #[test]
    fn validates_deployed_app_redirect_and_fallback_exactly() {
        let client = AppAuthClientConfig {
            client_id: "deployed_demo".into(),
            client_secret_sha256: hash_secret("deployed_demo_secret"),
            display_name: "Deployed Demo".into(),
            allowed_redirect_uris: vec![
                "https://deployed-demo.example.com/api/memwal/callback".into()
            ],
            fallback_uri: Some("https://deployed-demo.example.com/memwal/error".into()),
            allowed_fallback_uris: vec!["https://deployed-demo.example.com/memwal/error".into()],
        };

        assert_eq!(
            validated_allowed_url(
                "https://deployed-demo.example.com/api/memwal/callback",
                &client.allowed_redirect_uris,
                false
            )
            .as_deref(),
            Some("https://deployed-demo.example.com/api/memwal/callback")
        );
        assert_eq!(
            validated_allowed_url(
                "https://deployed-demo.example.com/api/memwal/callback/",
                &client.allowed_redirect_uris,
                false
            ),
            None
        );
        assert_eq!(
            select_fallback_uri(
                &client,
                Some("https://deployed-demo.example.com/memwal/error"),
                false
            )
            .as_deref(),
            Some("https://deployed-demo.example.com/memwal/error")
        );
        assert_eq!(
            select_fallback_uri(
                &client,
                Some("https://deployed-demo.example.com/other"),
                false
            ),
            None
        );
    }

    #[test]
    fn rejects_http_for_deployed_apps_even_when_allowlisted() {
        let allowlist = vec!["http://deployed-demo.example.com/api/memwal/callback".to_string()];

        assert_eq!(
            validated_allowed_url(
                "http://deployed-demo.example.com/api/memwal/callback",
                &allowlist,
                false
            ),
            None
        );
        assert_eq!(
            validated_allowed_url(
                "http://deployed-demo.example.com/api/memwal/callback",
                &allowlist,
                true
            ),
            None
        );
    }

    #[test]
    fn rejects_open_redirect_inputs() {
        let client = demo_client();
        for candidate in [
            "javascript:alert(1)",
            "https://demo-app.com.evil.test/api/memwal/callback",
            "https://demo-app.com/api/memwal/callback#token",
            "https://attacker@demo-app.com/api/memwal/callback",
            "http://demo-app.com/api/memwal/callback",
        ] {
            assert_eq!(
                validated_allowed_url(candidate, &client.allowed_redirect_uris, false),
                None,
                "{candidate} must be rejected"
            );
        }
    }

    #[test]
    fn allows_localhost_http_for_dev_only_when_registered() {
        let client = demo_client();
        assert_eq!(
            validated_allowed_url(
                "http://localhost:5173/api/memwal/callback",
                &client.allowed_redirect_uris,
                false
            )
            .as_deref(),
            Some("http://localhost:5173/api/memwal/callback")
        );
    }

    #[test]
    fn localhost_wildcard_accepts_any_port_when_enabled() {
        let allowlist = vec![
            "http://localhost:*/api/memwal/callback".to_string(),
            "http://127.0.0.1:*/api/memwal/callback".to_string(),
        ];
        assert_eq!(
            validated_allowed_url(
                "http://localhost:3000/api/memwal/callback",
                &allowlist,
                true
            )
            .as_deref(),
            Some("http://localhost:3000/api/memwal/callback")
        );
        assert_eq!(
            validated_allowed_url(
                "http://localhost:5174/api/memwal/callback",
                &allowlist,
                true
            )
            .as_deref(),
            Some("http://localhost:5174/api/memwal/callback")
        );
        assert_eq!(
            validated_allowed_url(
                "http://127.0.0.1:8080/api/memwal/callback",
                &allowlist,
                true
            )
            .as_deref(),
            Some("http://127.0.0.1:8080/api/memwal/callback")
        );
    }

    #[test]
    fn localhost_wildcard_rejects_unsafe_values() {
        let allowlist = vec!["http://localhost:*/api/memwal/callback".to_string()];
        for candidate in [
            "http://localhost:3000/wrong",
            "http://localhost.evil.test:3000/api/memwal/callback",
            "https://localhost:3000/api/memwal/callback",
            "http://attacker@localhost:3000/api/memwal/callback",
            "http://localhost:3000/api/memwal/callback#frag",
            "http://localhost/api/memwal/callback",
            "http://localhost:3000/api/memwal/callback?x=1",
        ] {
            assert_eq!(
                validated_allowed_url(candidate, &allowlist, true),
                None,
                "{candidate} must be rejected"
            );
        }
    }

    #[test]
    fn localhost_wildcard_is_ignored_when_disabled() {
        let allowlist = vec!["http://localhost:*/api/memwal/callback".to_string()];
        assert_eq!(
            validated_allowed_url(
                "http://localhost:3000/api/memwal/callback",
                &allowlist,
                false
            ),
            None
        );
    }

    #[test]
    fn localhost_wildcard_pattern_must_be_loopback_http_port() {
        let candidate = "http://localhost:3000/api/memwal/callback";
        for pattern in [
            "https://localhost:*/api/memwal/callback",
            "http://evil.test:*/api/memwal/callback",
            "http://localhost/api/memwal/callback",
            "http://localhost:*/different",
        ] {
            assert_eq!(
                validated_allowed_url(candidate, &[pattern.to_string()], true),
                None,
                "{pattern} must not allow localhost wildcard redirect"
            );
        }
    }

    #[test]
    fn fallback_uri_must_be_allowlisted() {
        let client = demo_client();
        assert_eq!(
            select_fallback_uri(&client, Some("https://demo-app.com/memwal/error"), false)
                .as_deref(),
            Some("https://demo-app.com/memwal/error")
        );
        assert_eq!(
            select_fallback_uri(&client, Some("https://evil.test/callback"), false),
            None
        );
    }

    #[test]
    fn fallback_uri_accepts_localhost_wildcard_when_enabled() {
        let client = AppAuthClientConfig {
            client_id: "dev_localhost".into(),
            client_secret_sha256: hash_secret("dev_localhost_secret"),
            display_name: "Local Dev App".into(),
            allowed_redirect_uris: vec![],
            fallback_uri: None,
            allowed_fallback_uris: vec!["http://localhost:*/memwal/error".into()],
        };
        assert_eq!(
            select_fallback_uri(&client, Some("http://localhost:5174/memwal/error"), true)
                .as_deref(),
            Some("http://localhost:5174/memwal/error")
        );
        assert_eq!(
            select_fallback_uri(&client, Some("http://localhost:5174/other"), true),
            None
        );
    }

    #[test]
    fn success_redirect_contains_only_code_and_state() {
        let redirect = build_success_redirect(
            "https://demo-app.com/api/memwal/callback",
            "mwa_test",
            "random_state",
        );
        let url = Url::parse(&redirect).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params.get("code").map(|v| v.as_ref()), Some("mwa_test"));
        assert_eq!(
            params.get("state").map(|v| v.as_ref()),
            Some("random_state")
        );
        assert!(!params.contains_key("account_id"));
        assert!(!params.contains_key("delegate_key"));
        assert!(!params.contains_key("token"));
        assert!(!params.contains_key("bearer"));
    }

    #[test]
    fn error_redirect_preserves_state_without_credentials() {
        let redirect = build_error_redirect(
            "https://demo-app.com/memwal/error",
            "access_denied",
            "random_state",
        );
        let url = Url::parse(&redirect).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(
            params.get("error").map(|v| v.as_ref()),
            Some("access_denied")
        );
        assert_eq!(
            params.get("state").map(|v| v.as_ref()),
            Some("random_state")
        );
        assert!(!params.contains_key("delegate_key"));
        assert!(!params.contains_key("token"));
    }

    #[test]
    fn code_binding_rejects_expired_and_mismatched_inputs() {
        let now = Utc::now();
        let mut row = AppAuthCodeStore {
            client_id: "demo_dapp".into(),
            redirect_uri: "https://demo-app.com/api/memwal/callback".into(),
            state: "random_state".into(),
            account_id: "0x".to_string() + &"1".repeat(64),
            owner_address: "0x".to_string() + &"2".repeat(64),
            provider: "wallet".into(),
            delegate_ref: "appdel_1".into(),
            delegate_public_key: "a".repeat(64),
            delegate_label: "Demo".into(),
            expires_at: now + Duration::minutes(5),
        };
        assert_eq!(
            code_binding_error(
                &row,
                "https://demo-app.com/api/memwal/callback",
                "random_state",
                now
            ),
            None
        );
        assert_eq!(
            code_binding_error(&row, "https://demo-app.com/other", "random_state", now),
            Some("redirect_uri does not match authorization code")
        );
        assert_eq!(
            code_binding_error(
                &row,
                "https://demo-app.com/api/memwal/callback",
                "wrong",
                now
            ),
            Some("state does not match authorization code")
        );
        row.expires_at = now - Duration::seconds(1);
        assert_eq!(
            code_binding_error(
                &row,
                "https://demo-app.com/api/memwal/callback",
                "random_state",
                now
            ),
            Some("authorization code expired")
        );
    }

    #[test]
    fn client_secret_hash_matches_demo_secret() {
        assert!(constant_time_eq(
            hash_secret("demo_dapp_secret").as_bytes(),
            demo_client().client_secret_sha256.as_bytes()
        ));
        assert!(!constant_time_eq(
            hash_secret("wrong").as_bytes(),
            demo_client().client_secret_sha256.as_bytes()
        ));
    }
}
