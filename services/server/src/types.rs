use std::sync::atomic::{AtomicUsize, Ordering};
use serde::{Deserialize, Serialize};

use crate::db::VectorDb;
use crate::rate_limit::RateLimitConfig;

// ============================================================
// App State (shared across routes + middleware)
// ============================================================

/// Shared application state passed to all routes and middleware
pub struct AppState {
    pub db: VectorDb,
    pub config: Config,
    pub http_client: reqwest::Client,
    pub walrus_client: walrus_rs::WalrusClient,
    /// Round-robin pool of Sui private keys for parallel Walrus uploads
    pub key_pool: KeyPool,
    /// Redis multiplexed connection for rate limiting
    pub redis: redis::aio::MultiplexedConnection,
}

// ============================================================
// Key Pool (round-robin selection for parallel uploads)
// ============================================================

/// A thread-safe round-robin pool of Sui private keys.
/// Each call to `next()` returns the next key in the pool,
/// allowing concurrent uploads to use different signer addresses.
pub struct KeyPool {
    keys: Vec<String>,
    counter: AtomicUsize,
}

impl KeyPool {
    pub fn new(keys: Vec<String>) -> Self {
        Self {
            keys,
            counter: AtomicUsize::new(0),
        }
    }

    /// Returns the next key in round-robin order, or `None` if the pool is empty.
    pub fn next(&self) -> Option<&str> {
        if self.keys.is_empty() {
            return None;
        }
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % self.keys.len();
        Some(&self.keys[idx])
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

// ============================================================
// Config
// ============================================================

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub sui_rpc_url: String,
    pub memwal_account_id: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_api_base: String,
    pub walrus_publisher_url: String,
    pub walrus_aggregator_url: String,
    /// Primary key (used for SEAL decrypt / recall). Unchanged.
    pub sui_private_key: Option<String>,
    /// Pool of keys for parallel Walrus uploads (parsed from SERVER_SUI_PRIVATE_KEYS,
    /// falls back to SERVER_SUI_PRIVATE_KEY as a single-element list).
    pub sui_private_keys: Vec<String>,
    pub package_id: String,
    pub registry_id: String,
    /// URL of the SEAL/Walrus TS sidecar HTTP server
    pub sidecar_url: String,
    /// Rate limiting configuration
    pub rate_limit: RateLimitConfig,
}

impl Config {
    pub fn from_env() -> Self {
        let network = std::env::var("SUI_NETWORK")
            .unwrap_or_else(|_| "mainnet".to_string());
        let default_rpc = match network.as_str() {
            "testnet" => "https://fullnode.testnet.sui.io:443",
            "devnet" => "https://fullnode.devnet.sui.io:443",
            _ => "https://fullnode.mainnet.sui.io:443",
        };

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8000".to_string())
                .parse()
                .expect("PORT must be a number"),
            database_url: std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set (e.g. postgresql://memwal:memwal_secret@localhost:5432/memwal)"),
            sui_rpc_url: std::env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| default_rpc.to_string()),
            memwal_account_id: std::env::var("MEMWAL_ACCOUNT_ID").ok(),
            openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
            openai_api_base: std::env::var("OPENAI_API_BASE")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            walrus_publisher_url: std::env::var("WALRUS_PUBLISHER_URL")
                .unwrap_or_else(|_| "https://publisher.walrus-mainnet.walrus.space".to_string()),
            walrus_aggregator_url: std::env::var("WALRUS_AGGREGATOR_URL")
                .unwrap_or_else(|_| "https://aggregator.walrus-mainnet.walrus.space".to_string()),
            sui_private_key: std::env::var("SERVER_SUI_PRIVATE_KEY").ok(),
            sui_private_keys: {
                // SERVER_SUI_PRIVATE_KEYS takes priority (comma-separated list).
                // Falls back to SERVER_SUI_PRIVATE_KEY as a single-element list.
                let multi = std::env::var("SERVER_SUI_PRIVATE_KEYS").ok().map(|s| {
                    s.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect::<Vec<_>>()
                });
                let single = std::env::var("SERVER_SUI_PRIVATE_KEY").ok().map(|k| vec![k]);
                multi.or(single).unwrap_or_default()
            },
            package_id: std::env::var("MEMWAL_PACKAGE_ID")
                .expect("MEMWAL_PACKAGE_ID must be set"),
            registry_id: std::env::var("MEMWAL_REGISTRY_ID")
                .expect("MEMWAL_REGISTRY_ID must be set"),
            sidecar_url: std::env::var("SIDECAR_URL")
                .unwrap_or_else(|_| "http://localhost:9000".to_string()),
            rate_limit: RateLimitConfig::from_env(),
        }
    }
}

// ============================================================
// API Types
// ============================================================

/// POST /api/remember
/// Phase 2: Server handles everything — encrypt, upload Walrus, embed, store
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct RememberRequest {
    pub text: String,
    /// Namespace for memory isolation (default: "default")
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberResponse {
    pub id: String,
    pub blob_id: String,
    pub owner: String,
    pub namespace: String,
}

/// POST /api/recall
/// Phase 2: Server does search → download → decrypt → return plaintext
/// Owner is derived from delegate key via onchain verification (auth middleware)
fn default_limit() -> usize {
    10
}

fn default_namespace() -> String {
    "default".to_string()
}

#[derive(Debug, Deserialize)]
pub struct RecallRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RecallResponse {
    pub results: Vec<RecallResult>,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct RecallResult {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub blob_id: String,
    pub distance: f64,
}



/// POST /api/analyze
/// Extract facts from conversation text using LLM, then remember each fact
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    /// Conversation text to analyze for memorable facts
    pub text: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct AnalyzedFact {
    pub text: String,
    pub id: String,
    pub blob_id: String,
}

#[derive(Debug, Serialize)]
pub struct AnalyzeResponse {
    pub facts: Vec<AnalyzedFact>,
    pub total: usize,
    pub owner: String,
}

/// POST /api/remember/manual
/// Client sends SEAL-encrypted data (base64) + pre-computed embedding vector.
/// Server uploads to Walrus via sidecar, then stores the vector ↔ blobId mapping.
#[derive(Debug, Deserialize)]
pub struct RememberManualRequest {
    pub encrypted_data: String,  // base64-encoded SEAL-encrypted bytes
    pub vector: Vec<f32>,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberManualResponse {
    pub id: String,
    pub blob_id: String,
    pub owner: String,
    pub namespace: String,
}

/// POST /api/recall/manual
/// User provides pre-computed query vector.
/// Server returns matching blobIds + distances (no download/decrypt).
#[derive(Debug, Deserialize)]
pub struct RecallManualRequest {
    pub vector: Vec<f32>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RecallManualResponse {
    pub results: Vec<SearchHit>,
    pub total: usize,
}

/// POST /api/ask
/// Recall memories + LLM chat — full AI-with-memory demo
#[derive(Debug, Deserialize)]
pub struct AskRequest {
    /// User's question
    pub question: String,
    /// Max memories to inject (default: 5)
    pub limit: Option<usize>,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct AskResponse {
    pub answer: String,
    pub memories_used: usize,
    pub memories: Vec<RecallResult>,
}

/// POST /api/restore
/// Restore a namespace: download blobs from Walrus, decrypt, re-embed, re-index
fn default_restore_limit() -> usize {
    50
}

#[derive(Debug, Deserialize)]
pub struct RestoreRequest {
    pub namespace: String,
    /// Max blobs to restore (default: 50)
    #[serde(default = "default_restore_limit")]
    pub limit: usize,
}

#[derive(Debug, Serialize)]
pub struct RestoreResponse {
    pub restored: usize,
    pub skipped: usize,
    pub total: usize,
    pub namespace: String,
    pub owner: String,
}

/// Health check
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

// ============================================================
// Auth Types
// ============================================================

/// Headers required for authenticated requests
#[derive(Debug, Clone)]
pub struct AuthInfo {
    #[allow(dead_code)]
    pub public_key: String,
    /// Owner address from the onchain MemWalAccount (set after onchain verification)
    pub owner: String,
    /// MemWalAccount object ID (set after onchain verification)
    pub account_id: String,
    /// Delegate private key (hex) — used for SEAL decrypt SessionKey
    pub delegate_key: Option<String>,
}

// ============================================================
// Error
// ============================================================

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    #[allow(dead_code)]
    Unauthorized(String),
    Internal(String),
    /// Walrus blob not found (expired or deleted) — triggers cleanup
    BlobNotFound(String),
    /// Rate limit exceeded (HTTP 429)
    #[allow(dead_code)]
    RateLimited(String),
    /// Storage quota exceeded (HTTP 402)
    QuotaExceeded(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::BadRequest(msg) => write!(f, "Bad Request: {}", msg),
            AppError::Unauthorized(msg) => write!(f, "Unauthorized: {}", msg),
            AppError::Internal(msg) => write!(f, "Internal Error: {}", msg),
            AppError::BlobNotFound(msg) => write!(f, "Blob Not Found: {}", msg),
            AppError::RateLimited(msg) => write!(f, "Rate Limited: {}", msg),
            AppError::QuotaExceeded(msg) => write!(f, "Quota Exceeded: {}", msg),
        }
    }
}

impl axum::response::IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            AppError::BadRequest(msg) => (axum::http::StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (axum::http::StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Internal(msg) => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                msg.clone(),
            ),
            AppError::BlobNotFound(msg) => (axum::http::StatusCode::NOT_FOUND, msg.clone()),
            AppError::RateLimited(msg) => (axum::http::StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::QuotaExceeded(msg) => (axum::http::StatusCode::PAYMENT_REQUIRED, msg.clone()),
        };

        let body = serde_json::json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}

// ============================================================
// Sidecar Types (shared by seal.rs + walrus.rs)
// ============================================================

/// Error response from the TS sidecar HTTP server
#[derive(Debug, Deserialize)]
pub struct SidecarError {
    pub error: String,
}
