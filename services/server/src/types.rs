use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::engine::MemoryEngine;
use crate::jobs::{BulkRememberJobStorage, RememberJobStorage, WalletJobStorage};
use crate::rate_limit::RateLimitConfig;
use crate::services::{Embedder, Extractor, Ranker};
use crate::storage::db::VectorDb;
use std::sync::atomic::{AtomicUsize, Ordering};

/// ENG-1408: Max items in a single POST /api/remember/bulk request.
pub const MAX_BULK_ITEMS: usize = 20;

/// ENG-1408: Bounded concurrency for concurrent embed+encrypt in bulk route handler.
pub const BULK_EMBED_CONCURRENCY: usize = 5;

/// Redis key prefix for Walrus ciphertext cache entries.
pub const BLOB_CACHE_KEY_PREFIX: &str = "memwal:blob:v1:";

/// Default max age for Redis-cached Walrus ciphertext before revalidating via Walrus.
pub const DEFAULT_BLOB_CACHE_TTL_SECS: u64 = 14 * 24 * 60 * 60;

/// Default maximum ciphertext size stored in Redis.
pub const DEFAULT_BLOB_CACHE_MAX_BYTES: usize = 512 * 1024;

/// Default max age for Redis-cached recall query embeddings.
pub const DEFAULT_EMBEDDING_CACHE_TTL_SECS: u64 = 10 * 60;

/// Sidecar caps Walrus storage purchases to avoid accidental large spends.
pub const MAX_WALRUS_STORAGE_EPOCHS: u32 = 5;

pub(crate) fn default_walrus_storage_epochs_for_network(network: &str) -> u32 {
    match network {
        "mainnet" => 3,
        _ => MAX_WALRUS_STORAGE_EPOCHS,
    }
}

pub(crate) fn configured_walrus_storage_epochs(network: &str) -> u32 {
    let default = default_walrus_storage_epochs_for_network(network);
    match std::env::var("WALRUS_STORAGE_EPOCHS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
    {
        Some(epochs) if epochs > 0 => epochs.min(MAX_WALRUS_STORAGE_EPOCHS),
        _ => default,
    }
}

/// Delay before racing a cold Walrus read against the next configured aggregator.
pub const DEFAULT_WALRUS_AGGREGATOR_RACE_AFTER_MS: u64 = 150;

// ============================================================
// App State (shared across routes + middleware)
// ============================================================

/// Shared application state passed to all routes and middleware
pub struct AppState {
    /// `Arc` so the `MemoryEngine` impl can share the same handle rather
    /// than duplicating the pool.
    pub db: Arc<VectorDb>,
    /// `Arc` so the engine + handlers share one immutable config.
    pub config: Arc<Config>,
    pub http_client: reqwest::Client,
    /// Round-robin pool of Sui private keys for parallel Walrus uploads.
    /// `Arc` so the engine's `store_blob` can draw from the same pool.
    pub key_pool: Arc<KeyPool>,
    /// Persistence abstraction — `WalrusSealEngine` in production,
    /// `PlaintextEngine` in benchmark mode. Selected once at startup
    /// from `Config::benchmark_mode`. Handlers / job workers are mode-blind.
    pub engine: Arc<dyn MemoryEngine>,
    /// Embedding service — `OpenAiEmbedder` (text-embedding-3-small, with
    /// a deterministic mock fallback when no API key). Used by `analyze`,
    /// `remember` (per fact / summary), and `recall` (the query embedding).
    pub embedder: Arc<dyn Embedder>,
    /// LLM fact-extraction service — `LlmExtractor` (gpt-4o-mini). Used by
    /// `analyze`.
    pub extractor: Arc<dyn Extractor>,
    /// Recall re-ranker — `CompositeRanker` blends semantic similarity
    /// with optional recency decay. Used by `/api/recall` and `/api/ask`
    /// when the request body sets `scoring_weights`; default weights
    /// preserve the pgvector cosine order exactly.
    pub ranker: Arc<dyn Ranker>,
    /// Redis multiplexed connection for rate limiting
    pub redis: redis::aio::MultiplexedConnection,
    /// In-memory token bucket fallback for when Redis is unavailable
    pub fallback_rate_limit: tokio::sync::Mutex<crate::rate_limit::InMemoryFallback>,
    /// Apalis storage for RememberJob — legacy full async pipeline.
    /// Kept so the legacy worker can drain any rows enqueued before the
    /// migration to WalletJob::UploadAndTransfer; new requests do NOT use this.
    #[allow(dead_code)]
    pub remember_job_storage: RememberJobStorage,
    /// Single Apalis storage for WalletJob. Routing dimension was previously a
    /// Vec<WalletJobStorage> keyed by wallet_index; that existed to side-step
    /// Sui coin-object equivocation locks. Per Will Bradley (Mysten, 2026-05-12
    /// Slack callout): Sui no longer permanently locks coin objects on
    /// equivocation, so one wallet + concurrent workers + retry handler is
    /// sufficient. See `plans/simplify-walrus-wallet-queues/reports/` for context.
    pub wallet_storage: WalletJobStorage,
    /// ENG-1408: Apalis storage for BulkRememberJob.
    pub bulk_job_storage: BulkRememberJobStorage,
    /// ENG-1405: Redis TTL for Walrus blob ciphertext cache entries.
    /// Expiry forces Walrus revalidation so BlobNotFound still triggers cleanup.
    /// (Also cloned into `WalrusSealEngine` at construction so the engine
    /// shares the same TTL when serving recall.)
    pub blob_cache_ttl: std::time::Duration,
    /// MEM-37: Maximum SEAL ciphertext bytes to cache in Redis.
    /// Zero disables blob ciphertext reads and writes in Redis.
    /// (Also cloned into `WalrusSealEngine` for size-capped cache writes.)
    pub blob_cache_max_bytes: usize,
    /// ENG-1405: Redis TTL for recall query embedding cache entries.
    pub embedding_cache_ttl: std::time::Duration,
}

// ============================================================
// Key Pool — round-robin wallet selection
// ============================================================

/// Wallet key holder for distributing Walrus uploads across configured server
/// keys. Apalis retries call `next_index()` again at execution time, so a
/// transient sponsor/RPC failure can move to the next wallet in the pool.
pub struct KeyPool {
    keys: Vec<String>,
    cursor: AtomicUsize,
}

impl KeyPool {
    pub fn new(keys: Vec<String>) -> Self {
        Self {
            keys,
            cursor: AtomicUsize::new(0),
        }
    }

    /// Returns the next configured key in round-robin order.
    #[allow(dead_code)]
    pub fn next(&self) -> Option<&str> {
        let idx = self.next_index()?;
        self.keys.get(idx).map(|s| s.as_str())
    }

    /// Returns the next key index in round-robin order, or `None` if no keys
    /// are configured.
    pub fn next_index(&self) -> Option<usize> {
        let len = self.keys.len();
        if len == 0 {
            None
        } else {
            Some(self.cursor.fetch_add(1, Ordering::Relaxed) % len)
        }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.keys.len()
    }
}

// ============================================================
// Config
// ============================================================

#[derive(Clone)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl std::fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppAuthClientConfig {
    pub client_id: String,
    pub client_secret_sha256: String,
    pub display_name: String,
    pub allowed_redirect_uris: Vec<String>,
    pub fallback_uri: Option<String>,
    #[serde(default)]
    pub allowed_fallback_uris: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub sui_rpc_url: String,
    /// ENG-1697: network name (mainnet/testnet/devnet). Surfaced via
    /// `GET /config` so the SDK can select the matching Sui fullnode
    /// without the user having to configure it.
    pub sui_network: String,
    pub memwal_account_id: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_api_base: String,
    pub walrus_publisher_url: String,
    pub walrus_aggregator_url: String,
    /// Number of Walrus storage epochs requested for new uploads.
    pub walrus_storage_epochs: u32,
    /// Ordered aggregator candidates used for cold Walrus reads. The primary
    /// `walrus_aggregator_url` is always first; `WALRUS_AGGREGATOR_URLS`
    /// appends additional low-latency/proxy endpoints for tail-race reads.
    pub walrus_aggregator_urls: Vec<String>,
    /// Opt-in Walrus read optimization for blobs written by this relayer.
    /// When true, cold reads append `skip_consistency_check=true`.
    pub walrus_skip_consistency_check: bool,
    /// Delay before launching the next aggregator candidate on a cold read.
    /// Zero launches all configured candidates immediately.
    pub walrus_aggregator_race_after_ms: u64,
    /// Primary key (used for SEAL decrypt / recall). Unchanged.
    pub sui_private_key: Option<String>,
    /// Pool of keys for parallel Walrus uploads (parsed from SERVER_SUI_PRIVATE_KEYS,
    /// falls back to SERVER_SUI_PRIVATE_KEY as a single-element list).
    pub sui_private_keys: Vec<String>,
    pub package_id: String,
    pub registry_id: String,
    /// URL of the SEAL/Walrus TS sidecar HTTP server
    pub sidecar_url: String,
    /// Shared secret for authenticating Rust→sidecar calls (X-Sidecar-Secret header)
    pub sidecar_secret: Option<String>,
    /// Rate limiting configuration
    pub rate_limit: RateLimitConfig,
    /// Sponsor-specific rate limiting and concurrency config
    pub sponsor_rate_limit: SponsorRateLimitConfig,
    /// Allowed CORS origins (comma-separated, e.g. "http://localhost:3000,https://memwal.ai")
    pub allowed_origins: String,
    /// ENG-1747: when true, select `PlaintextEngine` instead of
    /// `WalrusSealEngine` — memories are stored as plaintext in Postgres,
    /// bypassing SEAL + Walrus. **Not for production.** Off by default;
    /// set `BENCHMARK_MODE=true` to enable. Surfaced via `GET /health`.
    pub benchmark_mode: bool,
    /// Registered confidential third-party clients for hosted web app auth.
    /// V1 is env-backed only: APP_AUTH_CLIENTS_JSON.
    pub app_auth_clients: Vec<AppAuthClientConfig>,
    /// Dev/test only: allow configured localhost callback paths on any port.
    pub app_auth_enable_dev_localhost_wildcards: bool,
    /// AES key material derived from APP_AUTH_DELEGATE_ENCRYPTION_KEY or
    /// SIDECAR_AUTH_TOKEN. Redacted in Debug.
    pub app_auth_delegate_secret: Option<SecretBytes>,
}

impl Config {
    pub fn from_env() -> Self {
        let network = std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
        let default_rpc = match network.as_str() {
            "testnet" => "https://fullnode.testnet.sui.io:443",
            "devnet" => "https://fullnode.devnet.sui.io:443",
            _ => "https://fullnode.mainnet.sui.io:443",
        };
        let walrus_publisher_url = std::env::var("WALRUS_PUBLISHER_URL")
            .unwrap_or_else(|_| "https://publisher.walrus-mainnet.walrus.space".to_string());
        let walrus_aggregator_url = std::env::var("WALRUS_AGGREGATOR_URL")
            .unwrap_or_else(|_| "https://aggregator.walrus-mainnet.walrus.space".to_string());
        let walrus_aggregator_urls = parse_walrus_aggregator_urls(
            &walrus_aggregator_url,
            std::env::var("WALRUS_AGGREGATOR_URLS").ok().as_deref(),
        );

        let app_auth_enable_dev_localhost_wildcards =
            app_auth_dev_localhost_wildcards_enabled(&network);

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8000".to_string())
                .parse()
                .expect("PORT must be a number"),
            database_url: std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set (e.g. postgresql://memwal:memwal_secret@localhost:5432/memwal)"),
            sui_rpc_url: std::env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| default_rpc.to_string()),
            sui_network: network.clone(),
            memwal_account_id: std::env::var("MEMWAL_ACCOUNT_ID").ok(),
            openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
            openai_api_base: std::env::var("OPENAI_API_BASE")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            walrus_publisher_url,
            walrus_aggregator_url,
            walrus_storage_epochs: configured_walrus_storage_epochs(&network),
            walrus_aggregator_urls,
            walrus_skip_consistency_check: env_bool("WALRUS_SKIP_CONSISTENCY_CHECK"),
            walrus_aggregator_race_after_ms: std::env::var("WALRUS_AGGREGATOR_RACE_AFTER_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(DEFAULT_WALRUS_AGGREGATOR_RACE_AFTER_MS),
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
            sidecar_secret: std::env::var("SIDECAR_AUTH_TOKEN").ok(),
            rate_limit: RateLimitConfig::from_env(),
            sponsor_rate_limit: SponsorRateLimitConfig::from_env(),
            allowed_origins: std::env::var("ALLOWED_ORIGINS")
                .unwrap_or_default(),
            benchmark_mode: std::env::var("BENCHMARK_MODE")
                .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
                .unwrap_or(false),
            app_auth_clients: parse_app_auth_clients(app_auth_enable_dev_localhost_wildcards),
            app_auth_enable_dev_localhost_wildcards,
            app_auth_delegate_secret: derive_app_auth_delegate_secret(),
        }
    }
}

fn parse_app_auth_clients(include_dev_localhost_client: bool) -> Vec<AppAuthClientConfig> {
    let mut clients = match std::env::var("APP_AUTH_CLIENTS_JSON") {
        Ok(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw)
            .expect("APP_AUTH_CLIENTS_JSON must be a JSON array of app auth clients"),
        _ => vec![AppAuthClientConfig {
            client_id: "demo_dapp".to_string(),
            // sha256("demo_dapp_secret") — test/dev only. Override in production.
            client_secret_sha256:
                "5619a8cdf18ecc129cf7301e0272f0bb4d04144ec1e72e2882de620436a5c577".to_string(),
            display_name: "Demo Dapp".to_string(),
            allowed_redirect_uris: vec!["https://demo-app.com/api/memwal/callback".to_string()],
            fallback_uri: Some("https://demo-app.com/memwal/error".to_string()),
            allowed_fallback_uris: vec!["https://demo-app.com/memwal/error".to_string()],
        }],
    };

    if include_dev_localhost_client
        && !clients
            .iter()
            .any(|client| client.client_id == "dev_localhost")
    {
        clients.push(AppAuthClientConfig {
            client_id: "dev_localhost".to_string(),
            // sha256("dev_localhost_secret") — local/dev only.
            client_secret_sha256:
                "a8af739963bcf3b6b2267229bbaba4106dc13812e7ace14c03b4cdb70acc0667".to_string(),
            display_name: "Local Dev App".to_string(),
            allowed_redirect_uris: vec![
                "http://localhost:*/api/memwal/callback".to_string(),
                "http://127.0.0.1:*/api/memwal/callback".to_string(),
            ],
            fallback_uri: None,
            allowed_fallback_uris: vec![
                "http://localhost:*/memwal/error".to_string(),
                "http://127.0.0.1:*/memwal/error".to_string(),
            ],
        });
    }

    clients
}

fn app_auth_dev_localhost_wildcards_enabled(network: &str) -> bool {
    app_auth_dev_localhost_wildcards_enabled_from_value(
        network,
        env_bool("APP_AUTH_ENABLE_DEV_LOCALHOST_WILDCARDS"),
    )
}

fn app_auth_dev_localhost_wildcards_enabled_from_value(network: &str, enabled: bool) -> bool {
    network != "mainnet" && enabled
}

fn derive_app_auth_delegate_secret() -> Option<SecretBytes> {
    let source = std::env::var("APP_AUTH_DELEGATE_ENCRYPTION_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("SIDECAR_AUTH_TOKEN")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })?;
    Some(SecretBytes(Sha256::digest(source.as_bytes()).to_vec()))
}

fn env_bool(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn parse_walrus_aggregator_urls(primary: &str, extra_csv: Option<&str>) -> Vec<String> {
    let mut urls = Vec::new();
    let mut push_unique = |raw: &str| {
        let value = raw.trim();
        if !value.is_empty() && !urls.iter().any(|existing| existing == value) {
            urls.push(value.to_string());
        }
    };

    push_unique(primary);
    if let Some(extra_csv) = extra_csv {
        for value in extra_csv.split(',') {
            push_unique(value);
        }
    }

    urls
}

// ============================================================
// Sponsor Rate Limit Config
// ============================================================

#[derive(Debug, Clone)]
pub struct SponsorRateLimitConfig {
    /// Max sponsor requests per minute per IP (default: 10)
    pub per_minute: i64,
    /// Max sponsor requests per hour per IP (default: 30)
    pub per_hour: i64,
}

impl Default for SponsorRateLimitConfig {
    fn default() -> Self {
        Self {
            per_minute: 10,
            per_hour: 30,
        }
    }
}

impl SponsorRateLimitConfig {
    pub fn from_env() -> Self {
        let mut c = Self::default();
        if let Ok(v) = std::env::var("SPONSOR_RATE_LIMIT_PER_MINUTE") {
            if let Ok(n) = v.parse() {
                c.per_minute = n;
            }
        }
        if let Ok(v) = std::env::var("SPONSOR_RATE_LIMIT_PER_HOUR") {
            if let Ok(n) = v.parse() {
                c.per_hour = n;
            }
        }
        c
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

// ============================================================
// Bulk Remember types (ENG-1408)
// ============================================================

/// One item in a POST /api/remember/bulk request.
#[derive(Debug, Deserialize)]
pub struct RememberBulkItem {
    pub text: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

/// POST /api/remember/bulk request body.
#[derive(Debug, Deserialize)]
pub struct RememberBulkRequest {
    /// 1–MAX_BULK_ITEMS items to remember in one batched operation.
    pub items: Vec<RememberBulkItem>,
}

/// POST /api/remember/bulk — 202 Accepted response.
/// `job_ids[i]` corresponds to `items[i]`; poll each via GET /api/remember/:job_id.
#[derive(Debug, Serialize)]
pub struct RememberBulkAcceptedResponse {
    pub job_ids: Vec<String>,
    pub total: usize,
    pub status: String, // "running" on accepted background work
}

/// POST /api/remember/bulk/status request body.
#[derive(Debug, Deserialize)]
pub struct RememberBulkStatusRequest {
    /// 1–MAX_BULK_ITEMS job IDs from a prior POST /api/remember/bulk call.
    pub job_ids: Vec<String>,
}

/// One item in a POST /api/remember/bulk/status response.
#[derive(Debug, Serialize, Clone)]
pub struct RememberBulkStatusItem {
    pub job_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// POST /api/remember/bulk/status response.
#[derive(Debug, Serialize)]
pub struct RememberBulkStatusResponse {
    pub results: Vec<RememberBulkStatusItem>,
}

/// POST /api/remember (async, ENG-1406 v3)
/// Returns 202 Accepted immediately with a job_id for polling.
#[derive(Debug, Serialize)]
pub struct RememberAcceptedResponse {
    pub job_id: String,
    pub status: String, // "running" on accepted background work
}

/// GET /api/remember/:job_id — job status polling response
#[derive(Debug, Serialize)]
pub struct RememberJobStatusResponse {
    pub job_id: String,
    pub status: String, // "pending" | "running" | "uploaded" | "done" | "failed"
    /// Owner address of the memory (from auth at enqueue time).
    pub owner: String,
    /// Namespace the memory was stored under.
    pub namespace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// POST /api/remember (legacy sync response, kept for remember_manual)
#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct RememberResponse {
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
    /// Optional composite-scoring weights. Omitted → response order is
    /// byte-identical to a pgvector cosine-distance sort. See
    /// [`ScoringWeights`].
    #[serde(default)]
    pub scoring_weights: Option<ScoringWeights>,
}

#[derive(Debug, Serialize)]
pub struct RecallResponse {
    pub results: Vec<RecallResult>,
    pub total: usize,
    /// LOW-7: Count of matches whose blob download / SEAL decrypt / UTF-8 decode
    /// failed and were silently omitted from `results`. Zero on the happy path.
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    pub dropped_count: usize,
}

fn is_zero_usize(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Serialize)]
pub struct RecallResult {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
    /// Composite score used for ranking. Present only when the ranker
    /// actually ran (i.e. when `scoring_weights` was supplied with
    /// `recency > 0` so the ranker didn't short-circuit). `None` when
    /// the response is in default pgvector-cosine order — in that case
    /// the score is just `1.0 - distance` and we don't bother surfacing
    /// a derived field. `#[serde(skip_serializing_if)]` keeps the wire
    /// shape byte-identical to today for default-weights requests.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub blob_id: String,
    pub distance: f64,
    /// Insertion timestamp from `vector_entries.created_at`. Used by the
    /// composite ranker for recency scoring; threaded through unchanged
    /// in the engine `fetch_*` calls. Always present (column is NOT NULL
    /// in migration 001).
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// MEM-54: per-fact importance score from `vector_entries.importance`
    /// (column added by migration 009). Set at extraction time by the
    /// LLM-emitted vital/standard/trivial bucket (mapped to 0.9/0.5/0.2
    /// via `services::extractor::importance_for_bucket`). Consumed by
    /// `CompositeRanker` at recall time when `scoring_weights.importance`
    /// is non-zero. NOT NULL with default 0.5 so legacy rows degrade
    /// gracefully to the "standard" bucket.
    pub importance: f32,
}

/// Composite-scoring weights for `/api/recall` and `/api/ask`. Optional on
/// the wire — when omitted, the response order is byte-identical to a
/// pure pgvector cosine-distance sort (today's behaviour).
///
/// The score formula is:
///
/// ```text
/// score = semantic    * (1.0 - distance)
///       + recency     * 2^(-age_days / recency_half_life_days)
///       + importance  * vector_entries.importance   (already in [0,1])
/// ```
///
/// Sorted descending (higher score = better). `default()` returns
/// `semantic=1.0, recency=0.0, importance=0.0` so deserialising an empty
/// body yields the "today" ordering exactly.
#[derive(Debug, Clone, Deserialize)]
pub struct ScoringWeights {
    /// Weight applied to `1.0 - cosine_distance`. Default 1.0.
    #[serde(default = "default_semantic_weight")]
    pub semantic: f64,
    /// Weight applied to `2^(-age_days / half_life)`. Default 0.0.
    /// When all non-semantic weights are effectively zero, the ranker
    /// short-circuits and preserves the input order (which is already
    /// cosine-sorted by pgvector).
    #[serde(default)]
    pub recency: f64,
    /// Half-life for the recency decay term, in days. Default 30.
    /// A memory aged exactly `half_life` days has recency score 0.5;
    /// twice that, 0.25; etc.
    #[serde(default = "default_recency_half_life_days")]
    pub recency_half_life_days: f64,
    /// MEM-54: weight applied to the per-fact importance score from
    /// `vector_entries.importance` (set by the extractor's vital /
    /// standard / trivial bucket → 0.9 / 0.5 / 0.2). Default 0.0 so the
    /// existing default-weights path is byte-identical to the pre-MEM-54
    /// behaviour. Opt in by passing a positive value via
    /// `scoring_weights.importance` in the request body.
    #[serde(default)]
    pub importance: f64,
}

fn default_semantic_weight() -> f64 {
    1.0
}

fn default_recency_half_life_days() -> f64 {
    30.0
}

impl Default for ScoringWeights {
    fn default() -> Self {
        Self {
            semantic: 1.0,
            recency: 0.0,
            recency_half_life_days: 30.0,
            importance: 0.0,
        }
    }
}

impl ScoringWeights {
    /// Minimum allowed half-life. Anything smaller (incl. subnormals like
    /// `f64::MIN_POSITIVE`) makes the `exp(-age * ln2 / half_life)` term
    /// collapse to `0.0` for any non-zero `age`, silently turning the
    /// recency signal into a constant. ~86 milliseconds is well below any
    /// real-world recall use case and still survives float arithmetic.
    const MIN_HALF_LIFE_DAYS: f64 = 1e-6;

    /// True when the ranker actually computes scores (rather than
    /// short-circuiting to the input order). Mirrors the
    /// `recency / importance < f64::EPSILON` predicate inside
    /// `CompositeRanker` so handler-side gating (validation logs, tracing
    /// breadcrumbs) stays in lockstep with what the ranker actually does.
    /// Keep this in sync with [`crate::services::ranker::CompositeRanker::rank`].
    ///
    /// MEM-54: a non-zero `importance` weight is enough on its own to
    /// activate the ranker — the importance signal alone can reorder hits
    /// even when recency is off.
    pub fn is_ranker_active(&self) -> bool {
        self.recency.abs() >= f64::EPSILON || self.importance.abs() >= f64::EPSILON
    }

    /// Return an error if the weights are outside reasonable bounds. The
    /// `CompositeRanker` already has internal guards (NaN sorts as Equal,
    /// non-positive half-life zeros out the recency term) so we wouldn't
    /// crash — but it's friendlier to return a 400 up-front than to
    /// silently degrade to the default ordering.
    ///
    /// Constraints:
    /// - no NaN or infinite weights
    /// - signal weights (`semantic`, `recency`) must be in `[0.0, 100.0]`
    ///   — negative weights would invert the signal (older = better, less
    ///   semantic match = better), which is almost certainly a bug, not a
    ///   feature. The 100.0 ceiling is generous; a real client doesn't
    ///   need values that large.
    /// - `recency_half_life_days` must be at least `MIN_HALF_LIFE_DAYS`
    ///   (≈86 ms) when `recency > 0`. A zero / negative / subnormal
    ///   half-life with non-zero recency silently degrades the recency
    ///   term to zero — surface it as a 400 so the client notices.
    pub fn validate(&self) -> Result<(), AppError> {
        for (name, value) in [
            ("semantic", self.semantic),
            ("recency", self.recency),
            ("recency_half_life_days", self.recency_half_life_days),
            ("importance", self.importance),
        ] {
            if !value.is_finite() {
                return Err(AppError::BadRequest(format!(
                    "scoring_weights.{} must be a finite number (got {})",
                    name, value
                )));
            }
        }
        for (name, value) in [
            ("semantic", self.semantic),
            ("recency", self.recency),
            ("importance", self.importance),
        ] {
            if !(0.0..=100.0).contains(&value) {
                return Err(AppError::BadRequest(format!(
                    "scoring_weights.{} must be in [0.0, 100.0] (got {})",
                    name, value
                )));
            }
        }
        if self.recency > 0.0 && self.recency_half_life_days < Self::MIN_HALF_LIFE_DAYS {
            return Err(AppError::BadRequest(format!(
                "scoring_weights.recency_half_life_days must be >= {} when \
                 recency > 0 (got {})",
                Self::MIN_HALF_LIFE_DAYS,
                self.recency_half_life_days
            )));
        }
        Ok(())
    }
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

/// POST /api/analyze (async, returns 202 immediately)
/// Returns job_ids for each extracted fact; poll via GET /api/remember/:job_id
#[derive(Debug, Serialize)]
pub struct AnalyzeAcceptedResponse {
    /// One job_id per extracted fact — poll GET /api/remember/:job_id for each
    pub job_ids: Vec<String>,
    /// Extracted facts accepted for background storage. `id` equals `job_id`.
    pub facts: Vec<AnalyzeAcceptedFact>,
    /// Number of facts extracted from the text
    pub fact_count: usize,
    /// "pending" on accepted analyze jobs
    pub status: String,
    pub owner: String,
}

#[derive(Debug, Serialize)]
pub struct AnalyzeAcceptedFact {
    pub text: String,
    pub id: String,
    pub job_id: String,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct AnalyzedFact {
    pub text: String,
    pub id: String,
    pub blob_id: String,
}

#[allow(dead_code)]
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
    pub encrypted_data: String, // base64-encoded SEAL-encrypted bytes
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
    /// Optional composite-scoring weights. Omitted → results are ordered by
    /// raw pgvector cosine distance, byte-identical to the pre-ranker
    /// behaviour. When set, the manual path applies the **same**
    /// `CompositeRanker` as `/api/recall` and `/api/ask` so all three return
    /// the same ordering for the same query + weights (ENG-1785). The ranker
    /// scores the `SearchHit` fields directly (`distance` / `created_at` /
    /// `importance`) — no Walrus fetch or SEAL decrypt — preserving manual
    /// recall's "server returns blob ids + distances, client hydrates" contract.
    #[serde(default)]
    pub scoring_weights: Option<ScoringWeights>,
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
    /// Optional composite-scoring weights applied to the retrieved
    /// memories before they're injected into the LLM prompt. Omitted →
    /// pgvector cosine order. See [`ScoringWeights`].
    #[serde(default)]
    pub scoring_weights: Option<ScoringWeights>,
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
    10
}

#[derive(Debug, Deserialize)]
pub struct RestoreRequest {
    pub namespace: String,
    /// Max blobs to restore (default: 10)
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

/// POST /api/forget — delete the vector index rows for a namespace
/// (hard DELETE on vector_entries; Walrus blobs persist). Used by the
/// benchmark harness for inter-run cleanup. Mode-blind, owner-scoped.
#[derive(Debug, Deserialize)]
pub struct ForgetRequest {
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct ForgetResponse {
    pub deleted: u64,
    pub namespace: String,
    pub owner: String,
}

/// POST /api/stats — count + stored bytes for a namespace.
/// Used by the benchmark harness for verification. Mode-blind.
#[derive(Debug, Deserialize)]
pub struct StatsRequest {
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub memory_count: i64,
    pub storage_bytes: i64,
    pub namespace: String,
    pub owner: String,
}

/// Health check
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    #[serde(flatten)]
    pub compatibility: crate::compatibility::VersionResponse,
    /// "production" or "benchmark" — lets benchmark harness runs verify
    /// at startup that they're hitting a benchmark-mode server before
    /// ingesting plaintext memories. Mirrors `Config::benchmark_mode`.
    pub mode: String,
    /// MEM-56: the prompt version constants the running binary is using.
    /// The benchmark harness reads this at run start and pins the
    /// versions into the result-artifact JSON so a future "score jumped"
    /// delta is attributable to the prompt change rather than guessed
    /// at from git history. Both fields are always populated — there is
    /// no "version unknown" state for a running server.
    pub prompt_versions: PromptVersions,
}

/// MEM-56: prompt version constants surfaced on `/health`. See the
/// `*_PROMPT_VERSION` consts in `services::extractor` and `routes::admin`.
#[derive(Debug, Serialize)]
pub struct PromptVersions {
    /// `FACT_EXTRACTION_PROMPT_VERSION` from `services::extractor` — the
    /// extractor system prompt used by `/api/analyze` and the
    /// summarise-long-text path in `/api/remember`.
    pub extract: String,
    /// `ASK_SYSTEM_PROMPT_VERSION` from `routes::admin` — the LLM
    /// system prompt that wraps recalled memories on `/api/ask`.
    pub ask: String,
}

/// GET /config response (ENG-1697).
///
/// Public deployment parameters the SDK needs to build a SEAL SessionKey
/// client-side. All fields are non-secret (on-chain / public RPC URL).
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    #[serde(rename = "packageId")]
    pub package_id: String,
    pub network: String,
    #[serde(rename = "suiRpcUrl")]
    pub sui_rpc_url: String,
    /// Mirror of `RateLimitConfig::bench_bypass_enabled`. Lets benchmark
    /// scripts pre-flight the server config before running.
    #[serde(rename = "rateLimitDisabled")]
    pub rate_limit_disabled: bool,
}

// ============================================================
// Sponsor Types
// ============================================================

/// POST /sponsor — validated request body forwarded to sidecar
#[derive(Debug, Deserialize)]
pub struct SponsorRequest {
    pub sender: String,
    #[serde(rename = "transactionBlockKindBytes")]
    pub transaction_block_kind_bytes: String,
}

/// POST /sponsor/execute — validated request body forwarded to sidecar.
/// `sender` is optional — when present it is validated and counted against
/// the per-sender rate limit bucket (same axis as POST /sponsor).
#[derive(Debug, Deserialize)]
pub struct SponsorExecuteRequest {
    pub digest: String,
    pub signature: String,
    /// Sui address of the transaction sender (0x + 64 hex). Optional but
    /// recommended — enables per-sender rate limiting on this endpoint too.
    pub sender: Option<String>,
}

// ============================================================
// Auth Types
// ============================================================

/// Headers required for authenticated requests
#[derive(Clone)]
pub struct AuthInfo {
    #[allow(dead_code)]
    pub public_key: String,
    /// Owner address from the onchain MemWalAccount (set after onchain verification)
    pub owner: String,
    /// MemWalAccount object ID (set after onchain verification)
    pub account_id: String,
    /// Delegate private key (hex) — legacy path for SEAL decrypt. Optional;
    /// modern SDKs send `seal_session` instead. Retained during the
    /// transition so older clients keep working.
    pub delegate_key: Option<String>,
    /// Exported SEAL SessionKey (base64-encoded JSON) — replaces the raw
    /// delegate private key on the wire. When present it is preferred over
    /// `delegate_key`. TTL-bounded, package-scoped, signed by the delegate
    /// key on the client; the server never handles private-key material.
    pub seal_session: Option<String>,
}

// LOW-5 / ENG-1697: Manual Debug redacts both credential fields so accidental
// `{:?}` formatting never leaks delegate private key material or session
// tokens into logs.
impl std::fmt::Debug for AuthInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthInfo")
            .field("public_key", &self.public_key)
            .field("owner", &self.owner)
            .field("account_id", &self.account_id)
            .field(
                "delegate_key",
                &self.delegate_key.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "seal_session",
                &self.seal_session.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
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
        crate::observability::record_app_error(self.kind());
        let (status, message) = match &self {
            AppError::BadRequest(msg) => (axum::http::StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (axum::http::StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Internal(msg) => {
                // SEC: Never leak internal error details to the client.
                // Log the full message server-side with a request ID so
                // operators can correlate, then return a generic message.
                let trace_id = crate::observability::current_request_id()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                tracing::error!(
                    request_id = %trace_id,
                    "Internal server error: {}",
                    msg,
                );
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Internal server error (traceId: {})", trace_id),
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

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::BadRequest(_) => "bad_request",
            AppError::Unauthorized(_) => "unauthorized",
            AppError::Internal(_) => "internal",
            AppError::BlobNotFound(_) => "blob_not_found",
            AppError::RateLimited(_) => "rate_limited",
            AppError::QuotaExceeded(_) => "quota_exceeded",
        }
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

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ── LOW-5: AuthInfo Debug redacts delegate_key ───────────────────────

    #[test]
    fn blob_cache_defaults_match_mem_37_policy() {
        assert_eq!(BLOB_CACHE_KEY_PREFIX, "memwal:blob:v1:");
        assert_eq!(DEFAULT_BLOB_CACHE_TTL_SECS, 14 * 24 * 60 * 60);
        assert_eq!(DEFAULT_BLOB_CACHE_MAX_BYTES, 512 * 1024);
        assert_eq!(DEFAULT_WALRUS_AGGREGATOR_RACE_AFTER_MS, 150);
    }

    #[test]
    fn parse_walrus_aggregator_urls_keeps_primary_first_and_dedupes() {
        let urls = parse_walrus_aggregator_urls(
            "https://primary.example",
            Some(" https://secondary.example,https://primary.example,,https://third.example "),
        );

        assert_eq!(
            urls,
            vec![
                "https://primary.example".to_string(),
                "https://secondary.example".to_string(),
                "https://third.example".to_string(),
            ]
        );
    }

    #[test]
    fn auth_info_debug_redacts_delegate_key() {
        let auth = AuthInfo {
            public_key: "aabbccdd".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            delegate_key: Some("supersecretprivatekeyinhex1234567890abcdef".to_string()),
            seal_session: None,
        };

        let debug_str = format!("{:?}", auth);

        // Must contain the redacted marker
        assert!(
            debug_str.contains("<redacted>"),
            "delegate_key must be redacted in Debug output, got: {}",
            debug_str
        );
        // Must NOT contain the actual key
        assert!(
            !debug_str.contains("supersecretprivatekeyinhex"),
            "actual delegate key leaked in Debug output: {}",
            debug_str
        );
        // Public fields are still visible
        assert!(debug_str.contains("aabbccdd"));
        assert!(debug_str.contains("0xowner"));
        assert!(debug_str.contains("0xaccount"));
    }

    #[test]
    fn auth_info_debug_shows_none_when_no_delegate_key() {
        let auth = AuthInfo {
            public_key: "aabb".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            delegate_key: None,
            seal_session: None,
        };

        let debug_str = format!("{:?}", auth);

        // None variant should render as None
        assert!(
            debug_str.contains("None"),
            "expected None in debug: {}",
            debug_str
        );
        assert!(!debug_str.contains("<redacted>"));
    }

    // ENG-1697: seal_session must also be redacted in Debug output. While
    // less catastrophic than the raw private key (bounded TTL, bounded
    // scope), it is still an authorization token and must not surface in
    // structured logs.
    #[test]
    fn auth_info_debug_redacts_seal_session() {
        let auth = AuthInfo {
            public_key: "aabbccdd".to_string(),
            owner: "0xowner".to_string(),
            account_id: "0xaccount".to_string(),
            delegate_key: None,
            seal_session: Some("eyJhZGRyZXNzIjoiMHhhYmMiLCJwYWNrYWdlSWQiOiIweGRlZiJ9".to_string()),
        };

        let debug_str = format!("{:?}", auth);
        assert!(debug_str.contains("<redacted>"));
        assert!(!debug_str.contains("eyJhZGRyZXNzIjo"));
    }

    // ── AppError: status code mapping ───────────────────────────────────

    #[test]
    fn app_error_bad_request_status() {
        let err = AppError::BadRequest("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn app_error_unauthorized_status() {
        let err = AppError::Unauthorized("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn app_error_internal_status() {
        let err = AppError::Internal("secret db connection string".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn app_error_internal_redacts_message() {
        let err = AppError::Internal("secret db connection string".into());
        let resp = axum::response::IntoResponse::into_response(err);
        let body_bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let body_str = String::from_utf8(body_bytes.to_vec()).unwrap();
        // Must NOT contain the internal message
        assert!(
            !body_str.contains("secret db connection string"),
            "internal error details leaked to client: {}",
            body_str,
        );
        // Must contain a traceId for correlation
        assert!(
            body_str.contains("traceId"),
            "response should contain traceId: {}",
            body_str,
        );
    }

    #[test]
    fn app_error_blob_not_found_status() {
        let err = AppError::BlobNotFound("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn app_error_rate_limited_status() {
        let err = AppError::RateLimited("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    #[test]
    fn app_error_quota_exceeded_status() {
        let err = AppError::QuotaExceeded("test".into());
        let resp = axum::response::IntoResponse::into_response(err);
        assert_eq!(resp.status(), axum::http::StatusCode::PAYMENT_REQUIRED);
    }

    // ── KeyPool: round-robin selection ─────────────────────────────────

    #[test]
    fn key_pool_returns_keys_round_robin() {
        let pool = KeyPool::new(vec!["key_a".into(), "key_b".into(), "key_c".into()]);

        assert_eq!(pool.next(), Some("key_a"));
        assert_eq!(pool.next(), Some("key_b"));
        assert_eq!(pool.next(), Some("key_c"));
        assert_eq!(pool.next(), Some("key_a"));
    }

    #[test]
    fn key_pool_empty_returns_none() {
        let pool = KeyPool::new(vec![]);
        assert_eq!(pool.next(), None);
        assert_eq!(pool.next_index(), None);
        assert!(pool.is_empty());
    }

    #[test]
    fn key_pool_single_key() {
        let pool = KeyPool::new(vec!["only_key".into()]);
        assert_eq!(pool.next(), Some("only_key"));
        assert_eq!(pool.next(), Some("only_key"));
        assert!(!pool.is_empty());
    }

    #[test]
    fn key_pool_next_index_round_robin() {
        let pool = KeyPool::new(vec!["a".into(), "b".into()]);
        assert_eq!(pool.next_index(), Some(0));
        assert_eq!(pool.next_index(), Some(1));
        assert_eq!(pool.next_index(), Some(0));
    }

    // ── SponsorRateLimitConfig defaults ─────────────────────────────────

    #[test]
    fn sponsor_rate_limit_default_values() {
        let config = SponsorRateLimitConfig::default();
        assert_eq!(config.per_minute, 10);
        assert_eq!(config.per_hour, 30);
    }

    #[test]
    fn app_auth_dev_localhost_wildcards_are_never_enabled_on_mainnet() {
        assert!(!app_auth_dev_localhost_wildcards_enabled_from_value(
            "mainnet", true
        ));
        assert!(app_auth_dev_localhost_wildcards_enabled_from_value(
            "testnet", true
        ));
        assert!(!app_auth_dev_localhost_wildcards_enabled_from_value(
            "testnet", false
        ));
    }

    #[test]
    fn walrus_storage_epochs_default_by_network() {
        assert_eq!(default_walrus_storage_epochs_for_network("mainnet"), 3);
        assert_eq!(
            default_walrus_storage_epochs_for_network("testnet"),
            MAX_WALRUS_STORAGE_EPOCHS
        );
    }

    // ── AppError Display implementations ────────────────────────────────

    #[test]
    fn app_error_display_all_variants() {
        assert!(AppError::BadRequest("x".into())
            .to_string()
            .contains("Bad Request"));
        assert!(AppError::Unauthorized("x".into())
            .to_string()
            .contains("Unauthorized"));
        assert!(AppError::Internal("x".into())
            .to_string()
            .contains("Internal"));
        assert!(AppError::BlobNotFound("x".into())
            .to_string()
            .contains("Blob Not Found"));
        assert!(AppError::RateLimited("x".into())
            .to_string()
            .contains("Rate Limited"));
        assert!(AppError::QuotaExceeded("x".into())
            .to_string()
            .contains("Quota Exceeded"));
    }

    // ── ScoringWeights::validate() — full bounds matrix ──────────────────

    /// Build weights from explicit fields so tests don't depend on
    /// `Default::default()` if someone changes the defaults later.
    fn w(semantic: f64, recency: f64, half_life: f64) -> ScoringWeights {
        ScoringWeights {
            semantic,
            recency,
            recency_half_life_days: half_life,
            importance: 0.0,
        }
    }

    fn assert_bad_request_mentions(w: &ScoringWeights, needle: &str) {
        match w.validate() {
            Err(AppError::BadRequest(msg)) => assert!(
                msg.contains(needle),
                "expected error mentioning {:?}, got: {}",
                needle,
                msg
            ),
            other => panic!(
                "expected BadRequest containing {:?}, got: {:?}",
                needle, other
            ),
        }
    }

    #[test]
    fn validate_default_is_ok() {
        ScoringWeights::default().validate().unwrap();
    }

    #[test]
    fn validate_rejects_nan_on_each_field() {
        assert_bad_request_mentions(&w(f64::NAN, 0.0, 30.0), "semantic");
        assert_bad_request_mentions(&w(1.0, f64::NAN, 30.0), "recency");
        assert_bad_request_mentions(&w(1.0, 0.0, f64::NAN), "recency_half_life_days");
    }

    #[test]
    fn validate_rejects_infinity_on_each_field() {
        for v in [f64::INFINITY, f64::NEG_INFINITY] {
            assert_bad_request_mentions(&w(v, 0.0, 30.0), "semantic");
            assert_bad_request_mentions(&w(1.0, v, 30.0), "recency");
            assert_bad_request_mentions(&w(1.0, 0.0, v), "recency_half_life_days");
        }
    }

    #[test]
    fn validate_rejects_negative_weights() {
        assert_bad_request_mentions(&w(-0.0001, 0.0, 30.0), "semantic");
        assert_bad_request_mentions(&w(1.0, -1.0, 30.0), "recency");
    }

    #[test]
    fn validate_rejects_weights_above_100() {
        assert_bad_request_mentions(&w(100.0001, 0.0, 30.0), "semantic");
        assert_bad_request_mentions(&w(1.0, 200.0, 30.0), "recency");
    }

    #[test]
    fn validate_accepts_exact_boundaries() {
        // 0.0 and 100.0 are inclusive; half-life only matters when recency > 0.
        w(0.0, 0.0, 30.0).validate().unwrap();
        w(100.0, 100.0, 30.0).validate().unwrap();
    }

    #[test]
    fn validate_rejects_zero_half_life_when_recency_positive() {
        assert_bad_request_mentions(&w(1.0, 0.5, 0.0), "recency_half_life_days");
    }

    #[test]
    fn validate_rejects_negative_half_life_when_recency_positive() {
        assert_bad_request_mentions(&w(1.0, 0.5, -1.0), "recency_half_life_days");
    }

    #[test]
    fn validate_rejects_subnormal_half_life_when_recency_positive() {
        // Subnormal would silently collapse `exp(-age * ln(2) / half_life)`
        // to 0 for any non-zero age — surface as 400 instead of degrading
        // the recency signal to a constant.
        assert_bad_request_mentions(&w(1.0, 0.5, f64::MIN_POSITIVE), "recency_half_life_days");
        // Just below the floor — still rejected.
        assert_bad_request_mentions(
            &w(1.0, 0.5, ScoringWeights::MIN_HALF_LIFE_DAYS / 2.0),
            "recency_half_life_days",
        );
    }

    #[test]
    fn validate_allows_negative_half_life_when_recency_zero() {
        // Carve-out: half-life is only constrained when recency > 0, so a
        // client that sets recency=0 can leave half-life at whatever
        // (the ranker short-circuits anyway). Pinning this keeps the
        // no-op default path from getting a spurious 400 if a stale SDK
        // forwards a placeholder half-life.
        w(1.0, 0.0, -1.0).validate().unwrap();
        w(1.0, 0.0, 0.0).validate().unwrap();
    }

    #[test]
    fn validate_accepts_half_life_at_floor() {
        // The minimum is inclusive: exactly MIN_HALF_LIFE_DAYS is allowed.
        w(1.0, 0.5, ScoringWeights::MIN_HALF_LIFE_DAYS)
            .validate()
            .unwrap();
    }

    // ── ScoringWeights::is_ranker_active() — opt-in predicate ────────────

    #[test]
    fn is_ranker_active_false_for_default() {
        assert!(!ScoringWeights::default().is_ranker_active());
    }

    #[test]
    fn is_ranker_active_true_for_non_zero_recency() {
        assert!(w(1.0, 0.2, 30.0).is_ranker_active());
        assert!(w(1.0, 0.0001, 30.0).is_ranker_active());
    }

    #[test]
    fn is_ranker_active_false_for_subepsilon_recency() {
        // Below EPSILON ≈ 2.22e-16 is treated as zero — the ranker would
        // short-circuit, so the handler considers itself inactive too.
        assert!(!w(1.0, f64::EPSILON / 2.0, 30.0).is_ranker_active());
    }

    // ── Refactor-safety: default short-circuits, wire contract pinned ────

    #[test]
    fn default_recency_is_zero_so_short_circuit_engages() {
        // If you change `ScoringWeights::default().recency` away from 0.0,
        // you change the wire contract on every existing client (the new
        // `score` field would suddenly appear on every default-weighted
        // recall response). Failing this test = ack the change.
        assert_eq!(ScoringWeights::default().recency, 0.0);
        assert!(!ScoringWeights::default().is_ranker_active());
    }

    // ── MEM-56: HealthResponse.prompt_versions wire shape ────────────────

    #[test]
    fn health_response_serializes_prompt_versions_block() {
        // The benchmark harness reads exactly these field names — pin the
        // wire shape so a rename can't silently break the run-artifact
        // pipeline.
        let resp = HealthResponse {
            status: "ok".to_string(),
            version: "0.1.0".to_string(),
            compatibility: crate::compatibility::version_response(),
            mode: "benchmark".to_string(),
            prompt_versions: PromptVersions {
                extract: "extract.v1".to_string(),
                ask: "ask.v1".to_string(),
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["prompt_versions"]["extract"], "extract.v1");
        assert_eq!(json["prompt_versions"]["ask"], "ask.v1");
        assert_eq!(
            json["apiVersion"],
            crate::compatibility::RELAYER_API_VERSION
        );
        assert_eq!(json["relayerVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            json["minSupportedSdk"]["typescript"],
            crate::compatibility::MIN_TYPESCRIPT_SDK_VERSION
        );
    }
}
