use serde::{Deserialize, Serialize};

use crate::db::VectorDb;

// ============================================================
// App State (shared across routes + middleware)
// ============================================================

/// Shared application state passed to all routes and middleware
pub struct AppState {
    pub db: VectorDb,
    pub config: Config,
    pub http_client: reqwest::Client,
    pub walrus_client: walrus_rs::WalrusClient,
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
    pub sui_private_key: Option<String>,
    pub package_id: String,
    pub registry_id: String,
}

impl Config {
    pub fn from_env() -> Self {
        let network = std::env::var("SUI_NETWORK")
            .unwrap_or_else(|_| "testnet".to_string());
        let default_rpc = match network.as_str() {
            "mainnet" => "https://fullnode.mainnet.sui.io:443",
            "devnet" => "https://fullnode.devnet.sui.io:443",
            _ => "https://fullnode.testnet.sui.io:443",
        };

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3001".to_string())
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
                .unwrap_or_else(|_| "https://publisher.walrus-testnet.walrus.space".to_string()),
            walrus_aggregator_url: std::env::var("WALRUS_AGGREGATOR_URL")
                .unwrap_or_else(|_| "https://aggregator.walrus-testnet.walrus.space".to_string()),
            sui_private_key: std::env::var("SERVER_SUI_PRIVATE_KEY").ok(),
            package_id: std::env::var("MEMWAL_PACKAGE_ID")
                .expect("MEMWAL_PACKAGE_ID must be set"),
            registry_id: std::env::var("MEMWAL_REGISTRY_ID")
                .expect("MEMWAL_REGISTRY_ID must be set"),
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
}

#[derive(Debug, Serialize)]
pub struct RememberResponse {
    pub id: String,
    pub blob_id: String,
    pub owner: String,
}

/// POST /api/recall
/// Phase 2: Server does search → download → decrypt → return plaintext
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct RecallRequest {
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    10
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

/// POST /api/embed
#[derive(Debug, Deserialize)]
pub struct EmbedRequest {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct EmbedResponse {
    pub vector: Vec<f32>,
}

/// POST /api/analyze
/// Extract facts from conversation text using LLM, then remember each fact
/// Owner is derived from delegate key via onchain verification (auth middleware)
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    /// Conversation text to analyze for memorable facts
    pub text: String,
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

/// POST /api/ask
/// Recall memories + LLM chat — full AI-with-memory demo
#[derive(Debug, Deserialize)]
pub struct AskRequest {
    /// User's question
    pub question: String,
    /// Max memories to inject (default: 5)
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct AskResponse {
    pub answer: String,
    pub memories_used: usize,
    pub memories: Vec<RecallResult>,
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
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::BadRequest(msg) => write!(f, "Bad Request: {}", msg),
            AppError::Unauthorized(msg) => write!(f, "Unauthorized: {}", msg),
            AppError::Internal(msg) => write!(f, "Internal Error: {}", msg),
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
        };

        let body = serde_json::json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}
