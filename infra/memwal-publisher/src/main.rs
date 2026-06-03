use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

const DEFAULT_MAINNET_WALRUS_PACKAGE_ID: &str =
    "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
const DEFAULT_TESTNET_WALRUS_PACKAGE_ID: &str =
    "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "memwal_publisher=info".to_string()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let state = AppState {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(config.http_timeout_secs))
            .build()?,
        replay_cache: Arc::new(Mutex::new(HashMap::new())),
        config: Arc::clone(&config),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/api", get(proxy_api))
        .route("/v1/blobs", put(store_blob))
        .with_state(state);

    info!(
        "starting MemWal publisher on {}, upstream={}",
        config.bind_address, config.upstream_publisher_url
    );
    let listener = tokio::net::TcpListener::bind(config.bind_address.clone()).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    config: Arc<Config>,
    replay_cache: Arc<Mutex<HashMap<String, i64>>>,
}

#[derive(Debug)]
struct Config {
    bind_address: String,
    upstream_publisher_url: String,
    upstream_bearer_token: Option<String>,
    jwt_secret: Vec<u8>,
    sui_cli: String,
    sui_wallet_config: String,
    walrus_package_id: String,
    http_timeout_secs: u64,
    command_timeout_secs: u64,
    metadata_retry_delays_ms: Vec<u64>,
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let network = std::env::var("NETWORK")
            .or_else(|_| std::env::var("SUI_NETWORK"))
            .unwrap_or_else(|_| "mainnet".to_string());
        let default_package_id = if network == "testnet" {
            DEFAULT_TESTNET_WALRUS_PACKAGE_ID
        } else {
            DEFAULT_MAINNET_WALRUS_PACKAGE_ID
        };
        let jwt_secret = std::env::var("MEMWAL_PUBLISHER_JWT_SECRET")
            .or_else(|_| std::env::var("JWT_DECODE_SECRET"))
            .or_else(|_| std::env::var("WALRUS_PUBLISHER_JWT_SECRET"))
            .map_err(|_| {
                anyhow::anyhow!(
                    "MEMWAL_PUBLISHER_JWT_SECRET/JWT_DECODE_SECRET/WALRUS_PUBLISHER_JWT_SECRET is required"
                )
            })?;

        Ok(Self {
            bind_address: env_or("MEMWAL_PUBLISHER_BIND_ADDRESS", "0.0.0.0:31416"),
            upstream_publisher_url: env_or(
                "MEMWAL_PUBLISHER_UPSTREAM_URL",
                "http://127.0.0.1:31415",
            ),
            upstream_bearer_token: std::env::var("MEMWAL_PUBLISHER_UPSTREAM_BEARER_TOKEN").ok(),
            jwt_secret: secret_bytes(&jwt_secret)?,
            sui_cli: env_or("SUI_CLI", "sui"),
            sui_wallet_config: env_or("SUI_WALLET_CONFIG", "/config/wallet-config.yml"),
            walrus_package_id: env_or("WALRUS_PACKAGE_ID", default_package_id),
            http_timeout_secs: parse_env_u64("MEMWAL_PUBLISHER_HTTP_TIMEOUT_SECS", 180),
            command_timeout_secs: parse_env_u64("MEMWAL_PUBLISHER_COMMAND_TIMEOUT_SECS", 120),
            metadata_retry_delays_ms: parse_retry_delays_ms(),
        })
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn proxy_api(State(state): State<AppState>) -> Result<Response, ApiError> {
    let url = format!(
        "{}/v1/api",
        state.config.upstream_publisher_url.trim_end_matches('/')
    );
    let body = state
        .client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("upstream api request failed: {e}")))?
        .text()
        .await
        .map_err(|e| ApiError::internal(format!("upstream api body failed: {e}")))?;
    Ok((StatusCode::OK, body).into_response())
}

#[derive(Debug, Deserialize)]
struct StoreQuery {
    epochs: Option<u64>,
    deletable: Option<bool>,
    permanent: Option<bool>,
    #[serde(default, alias = "send-object-to")]
    send_object_to: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PublisherClaims {
    exp: i64,
    jti: String,
    epochs: Option<u32>,
    max_epochs: Option<u32>,
    size: Option<u64>,
    max_size: Option<u64>,
    send_object_to: Option<String>,
    memwal_namespace: Option<String>,
    memwal_owner: Option<String>,
    memwal_package_id: Option<String>,
    memwal_agent_id: Option<String>,
    job_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublisherStoreResponse {
    newly_created: Option<PublisherNewlyCreated>,
    already_certified: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublisherNewlyCreated {
    blob_object: PublisherBlobObject,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublisherBlobObject {
    id: String,
    blob_id: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

async fn store_blob(
    State(state): State<AppState>,
    Query(query): Query<StoreQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let claims = verify_bearer_jwt(&state, &headers).await?;
    let epochs = query.epochs.unwrap_or(1);
    validate_claims(&claims, &query, body.len() as u64, epochs)?;

    let owner = query
        .send_object_to
        .as_deref()
        .or(claims.send_object_to.as_deref())
        .or(claims.memwal_owner.as_deref())
        .ok_or_else(|| ApiError::bad_request("send_object_to is required"))?;
    validate_sui_address(owner, "send_object_to")?;

    let namespace = claims.memwal_namespace.as_deref().unwrap_or("default");
    let package_id = claims.memwal_package_id.as_deref();
    let agent_id = claims.memwal_agent_id.as_deref();

    let upstream = upload_to_upstream(&state, &query, body).await?;
    if upstream.already_certified.is_some() {
        return Err(ApiError::conflict(
            "upstream returned alreadyCertified; MemWal metadata requires a newly-created Blob object",
        ));
    }
    let newly_created = upstream
        .newly_created
        .ok_or_else(|| ApiError::internal("upstream response missing newlyCreated"))?;
    let object_id = newly_created.blob_object.id.clone();
    let blob_id = newly_created.blob_object.blob_id.clone();

    let metadata_digest = metadata_transfer_with_retry(
        &state.config,
        &object_id,
        owner,
        namespace,
        package_id,
        agent_id,
    )
    .await?;

    info!(
        "memwal publish ok blob_id={} object_id={} owner={} ns={} job_id={:?}",
        blob_id, object_id, owner, namespace, claims.job_id
    );

    Ok(Json(serde_json::json!({
        "newlyCreated": newly_created,
        "memwal": {
            "metadataStatus": "ok",
            "transferStatus": "ok",
            "metadataTransferDigest": metadata_digest,
            "namespace": namespace,
            "owner": owner,
            "jobId": claims.job_id,
        }
    })))
}

async fn verify_bearer_jwt(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<PublisherClaims, ApiError> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("authorization bearer token is required"))?;

    let mut validation = Validation::new(Algorithm::HS256);
    validation.required_spec_claims = HashSet::from(["exp".to_string()]);
    let decoded = decode::<PublisherClaims>(
        token,
        &DecodingKey::from_secret(&state.config.jwt_secret),
        &validation,
    )
    .map_err(|e| ApiError::unauthorized(format!("invalid publisher JWT: {e}")))?;

    if decoded.claims.jti.trim().is_empty() {
        return Err(ApiError::unauthorized("publisher JWT missing jti"));
    }
    check_replay(&state.replay_cache, &decoded.claims).await?;
    Ok(decoded.claims)
}

async fn check_replay(
    replay_cache: &Arc<Mutex<HashMap<String, i64>>>,
    claims: &PublisherClaims,
) -> Result<(), ApiError> {
    let now = now_secs();
    let mut cache = replay_cache.lock().await;
    cache.retain(|_, exp| *exp > now);
    if cache.contains_key(&claims.jti) {
        return Err(ApiError::unauthorized("publisher JWT jti was already used"));
    }
    cache.insert(claims.jti.clone(), claims.exp);
    Ok(())
}

fn validate_claims(
    claims: &PublisherClaims,
    query: &StoreQuery,
    size: u64,
    epochs: u64,
) -> Result<(), ApiError> {
    if let Some(expected) = claims.size {
        if expected != size {
            return Err(ApiError::bad_request(format!(
                "JWT size mismatch: claim={expected}, actual={size}"
            )));
        }
    }
    if let Some(max_size) = claims.max_size {
        if size > max_size {
            return Err(ApiError::bad_request(format!(
                "request body exceeds JWT max_size: {size}>{max_size}"
            )));
        }
    }
    if let Some(expected) = claims.epochs {
        if u64::from(expected) != epochs {
            return Err(ApiError::bad_request(format!(
                "JWT epochs mismatch: claim={expected}, query={epochs}"
            )));
        }
    }
    if let Some(max_epochs) = claims.max_epochs {
        if epochs > u64::from(max_epochs) {
            return Err(ApiError::bad_request(format!(
                "query epochs exceeds JWT max_epochs: {epochs}>{max_epochs}"
            )));
        }
    }
    if let Some(owner_claim) = claims.send_object_to.as_deref() {
        if query.send_object_to.as_deref() != Some(owner_claim) {
            return Err(ApiError::bad_request("JWT send_object_to mismatch"));
        }
    }
    if let Some(owner_claim) = claims.memwal_owner.as_deref() {
        if query.send_object_to.as_deref() != Some(owner_claim) {
            return Err(ApiError::bad_request("JWT memwal_owner mismatch"));
        }
    }
    Ok(())
}

async fn upload_to_upstream(
    state: &AppState,
    query: &StoreQuery,
    body: Bytes,
) -> Result<PublisherStoreResponse, ApiError> {
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1/blobs",
        state.config.upstream_publisher_url.trim_end_matches('/')
    ))
    .map_err(|e| ApiError::internal(format!("invalid upstream URL: {e}")))?;
    {
        let mut pairs = url.query_pairs_mut();
        if let Some(epochs) = query.epochs {
            pairs.append_pair("epochs", &epochs.to_string());
        }
        if query.deletable.unwrap_or(true) {
            pairs.append_pair("deletable", "true");
        } else if query.permanent.unwrap_or(false) {
            pairs.append_pair("permanent", "true");
        }
    }

    let mut req = state
        .client
        .put(url)
        .header("content-type", "application/octet-stream")
        .body(body);
    if let Some(token) = state.config.upstream_bearer_token.as_deref() {
        req = req.bearer_auth(token);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("upstream store failed: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| ApiError::internal(format!("upstream response body failed: {e}")))?;
    if !status.is_success() {
        return Err(ApiError::upstream(status, text));
    }
    serde_json::from_str(&text).map_err(|e| {
        ApiError::internal(format!(
            "failed to parse upstream response: {e}; body={text}"
        ))
    })
}

async fn metadata_transfer_with_retry(
    config: &Config,
    object_id: &str,
    owner: &str,
    namespace: &str,
    package_id: Option<&str>,
    agent_id: Option<&str>,
) -> Result<String, ApiError> {
    let mut last_error = None;
    for attempt in 0..=config.metadata_retry_delays_ms.len() {
        match run_metadata_transfer_ptb(config, object_id, owner, namespace, package_id, agent_id)
            .await
        {
            Ok(digest) => return Ok(digest),
            Err(err) => {
                warn!(
                    "metadata_transfer attempt={} failed object_id={} owner={} error={}",
                    attempt + 1,
                    object_id,
                    owner,
                    err
                );
                last_error = Some(err);
            }
        }
        if let Some(delay_ms) = config.metadata_retry_delays_ms.get(attempt) {
            tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
        }
    }
    Err(ApiError::internal(format!(
        "metadata+transfer failed: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )))
}

async fn run_metadata_transfer_ptb(
    config: &Config,
    object_id: &str,
    owner: &str,
    namespace: &str,
    package_id: Option<&str>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    validate_object_id(object_id, "object_id").map_err(|e| e.message)?;
    validate_sui_address(owner, "owner").map_err(|e| e.message)?;
    if let Some(package_id) = package_id {
        validate_object_id(package_id, "package_id").map_err(|e| e.message)?;
    }

    let mut cmd = Command::new(&config.sui_cli);
    cmd.arg("client")
        .arg("--client.config")
        .arg(&config.sui_wallet_config)
        .arg("ptb")
        .arg("--assign")
        .arg("blob")
        .arg(format!("@{object_id}"));

    append_metadata_move_call(&mut cmd, config, "memwal_namespace", namespace);
    append_metadata_move_call(&mut cmd, config, "memwal_owner", owner);
    if let Some(package_id) = package_id {
        append_metadata_move_call(&mut cmd, config, "memwal_package_id", package_id);
    }
    if let Some(agent_id) = agent_id.filter(|value| !value.trim().is_empty()) {
        append_metadata_move_call(&mut cmd, config, "memwal_agent_id", agent_id);
    }

    cmd.arg("--transfer-objects")
        .arg("[blob]")
        .arg(format!("@{owner}"))
        .arg("--json");

    let output = tokio::time::timeout(
        Duration::from_secs(config.command_timeout_secs),
        cmd.output(),
    )
    .await
    .map_err(|_| "metadata transfer command timed out".to_string())?
    .map_err(|e| format!("failed to spawn sui ptb: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "sui ptb failed status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    parse_digest(&output.stdout).ok_or_else(|| {
        format!(
            "sui ptb output missing digest: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

fn append_metadata_move_call(cmd: &mut Command, config: &Config, key: &str, value: &str) {
    cmd.arg("--move-call")
        .arg(format!(
            "{}::blob::insert_or_update_metadata_pair",
            config.walrus_package_id
        ))
        .arg("blob")
        .arg(json_string_arg(key))
        .arg(json_string_arg(value));
}

fn parse_digest(stdout: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    value
        .pointer("/effects/transactionDigest")
        .or_else(|| value.pointer("/digest"))
        .or_else(|| value.pointer("/transactionDigest"))
        .and_then(|digest| digest.as_str())
        .map(str::to_string)
}

fn json_string_arg(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}

fn secret_bytes(secret: &str) -> anyhow::Result<Vec<u8>> {
    let trimmed = secret.trim();
    if let Some(hex_secret) = trimmed.strip_prefix("0x") {
        return Ok(hex::decode(hex_secret)?);
    }
    Ok(trimmed.as_bytes().to_vec())
}

fn validate_sui_address(value: &str, field: &str) -> Result<(), ApiError> {
    if value.len() == 66
        && value.starts_with("0x")
        && value[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!("invalid {field} address")))
    }
}

fn validate_object_id(value: &str, field: &str) -> Result<(), ApiError> {
    if value.starts_with("0x")
        && value.len() <= 66
        && value.len() > 2
        && value[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!("invalid {field}")))
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn parse_env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn parse_retry_delays_ms() -> Vec<u64> {
    std::env::var("MEMWAL_PUBLISHER_METADATA_RETRY_DELAYS_MS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .filter_map(|part| part.trim().parse::<u64>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec![1_000, 2_000, 5_000])
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn upstream(status: StatusCode, message: String) -> Self {
        Self { status, message }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.status == StatusCode::INTERNAL_SERVER_ERROR {
            error!("{}", self.message);
        }
        (
            self.status,
            Json(serde_json::json!({
                "error": self.message,
            })),
        )
            .into_response()
    }
}
