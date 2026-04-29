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
    /// Redis multiplexed connection for rate limiting
    pub redis: redis::aio::MultiplexedConnection,
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
    /// Server's Sui private key for SEAL decrypt operations.
    pub sui_private_key: Option<String>,
    pub package_id: String,
    pub registry_id: String,
    /// URL of the SEAL/Walrus TS sidecar HTTP server
    pub sidecar_url: String,
    /// Shared secret for authenticating sidecar requests
    pub sidecar_secret: String,
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
            package_id: std::env::var("MEMWAL_PACKAGE_ID")
                .expect("MEMWAL_PACKAGE_ID must be set"),
            registry_id: std::env::var("MEMWAL_REGISTRY_ID")
                .expect("MEMWAL_REGISTRY_ID must be set"),
            sidecar_url: std::env::var("SIDECAR_URL")
                .unwrap_or_else(|_| "http://localhost:9000".to_string()),
            sidecar_secret: std::env::var("SIDECAR_SECRET")
                .unwrap_or_default(),
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

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchHit {
    pub blob_id: String,
    pub distance: f64,
}



/// POST /api/remember/batch
/// Batch version of /api/remember — processes multiple texts in a single transaction
#[derive(Debug, Deserialize)]
pub struct RememberBatchRequest {
    pub items: Vec<RememberBatchItem>,
}

#[derive(Debug, Deserialize)]
pub struct RememberBatchItem {
    pub text: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct RememberBatchResponse {
    pub results: Vec<RememberResponse>,
    pub total: usize,
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
            AppError::Internal(msg) => {
                tracing::error!("internal error: {}", msg);
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error".to_string(),
                )
            }
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
