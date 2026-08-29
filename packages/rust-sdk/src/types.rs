//! Request options and response types mirroring the TypeScript / Python SDKs.
//!
//! Wire JSON field names are `snake_case` for all `/api/*` bodies; the
//! `/version` metadata uses `camelCase` (handled via `serde(rename_all)`).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Known relayer environments, used by [`crate::WalrusMemoryBuilder::env`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Env {
    /// `https://relayer.memory.walrus.xyz`
    Prod,
    /// `https://relayer-staging.memory.walrus.xyz`
    Staging,
    /// `https://relayer.dev.memwal.ai` (legacy dev domain, pre-WALM-86 rebrand)
    Dev,
    /// `http://127.0.0.1:8000`
    Local,
}

impl Env {
    /// The relayer base URL for this environment.
    pub fn server_url(self) -> &'static str {
        match self {
            Env::Prod => "https://relayer.memory.walrus.xyz",
            Env::Staging => "https://relayer-staging.memory.walrus.xyz",
            Env::Dev => "https://relayer.dev.memwal.ai",
            Env::Local => "http://127.0.0.1:8000",
        }
    }
}

/// Polling configuration for `*_and_wait` / `wait_for_*` helpers.
#[derive(Debug, Clone, Copy)]
pub struct WaitOptions {
    /// Base delay between status polls (jittered exponential backoff is applied).
    pub poll_interval_ms: u64,
    /// Give up after this many milliseconds.
    pub timeout_ms: u64,
}

impl Default for WaitOptions {
    fn default() -> Self {
        Self {
            poll_interval_ms: 1500,
            timeout_ms: 60_000,
        }
    }
}

impl WaitOptions {
    /// Default poll cadence with a longer timeout (used for bulk/analyze waits).
    pub fn bulk() -> Self {
        Self {
            poll_interval_ms: 1500,
            timeout_ms: 120_000,
        }
    }
}

/// Optional hybrid-ranking weights for `recall` / `recall_manual` / `ask`.
///
/// Omitting the whole object yields plain cosine-distance ordering.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScoringWeights {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recency_half_life_days: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<f64>,
}

/// Parameters for [`crate::WalrusMemory::recall`].
#[derive(Debug, Clone)]
pub struct RecallParams {
    /// Natural-language query (required).
    pub query: String,
    /// Max results (default 10, server-capped to 100).
    pub limit: Option<u32>,
    /// Namespace override (defaults to the client namespace).
    pub namespace: Option<String>,
    /// Client-side filter: drop results whose `distance >= max_distance`.
    pub max_distance: Option<f64>,
    /// Optional hybrid-ranking weights.
    pub scoring_weights: Option<ScoringWeights>,
}

impl RecallParams {
    /// Start from just a query string.
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            limit: None,
            namespace: None,
            max_distance: None,
            scoring_weights: None,
        }
    }
    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }
    pub fn max_distance(mut self, d: f64) -> Self {
        self.max_distance = Some(d);
        self
    }
    pub fn scoring_weights(mut self, w: ScoringWeights) -> Self {
        self.scoring_weights = Some(w);
        self
    }
}

impl<S: Into<String>> From<S> for RecallParams {
    fn from(query: S) -> Self {
        RecallParams::new(query)
    }
}

/// Options for [`crate::WalrusMemory::analyze`].
#[derive(Debug, Clone, Default)]
pub struct AnalyzeOptions {
    /// Namespace override (defaults to the client namespace).
    pub namespace: Option<String>,
    /// Valid-time anchor for relative dates inside the text (serialized RFC-3339 UTC).
    pub occurred_at: Option<DateTime<Utc>>,
}

impl AnalyzeOptions {
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }
    pub fn occurred_at(mut self, ts: DateTime<Utc>) -> Self {
        self.occurred_at = Some(ts);
        self
    }
}

/// One item for [`crate::WalrusMemory::remember_bulk`].
#[derive(Debug, Clone)]
pub struct RememberBulkItem {
    pub text: String,
    pub namespace: Option<String>,
}

impl RememberBulkItem {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            namespace: None,
        }
    }
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }
}

/// Options for [`crate::WalrusMemory::recall_manual`].
#[derive(Debug, Clone)]
pub struct RecallManualOptions {
    /// Pre-computed query embedding vector.
    pub vector: Vec<f32>,
    pub limit: Option<u32>,
    pub namespace: Option<String>,
    pub scoring_weights: Option<ScoringWeights>,
}

impl RecallManualOptions {
    pub fn new(vector: Vec<f32>) -> Self {
        Self {
            vector,
            limit: None,
            namespace: None,
            scoring_weights: None,
        }
    }
    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }
    pub fn scoring_weights(mut self, w: ScoringWeights) -> Self {
        self.scoring_weights = Some(w);
        self
    }
}

/// Options for [`crate::WalrusMemory::remember_manual`]: caller has already
/// embedded + SEAL-encrypted + uploaded the memory to Walrus themselves, and
/// only needs the relayer to index the resulting blob.
#[derive(Debug, Clone)]
pub struct RememberManualOptions {
    /// The Walrus blob id where the SEAL-encrypted memory was already stored.
    pub blob_id: String,
    /// Pre-computed embedding vector for the memory.
    pub vector: Vec<f32>,
    pub namespace: Option<String>,
}

impl RememberManualOptions {
    pub fn new(blob_id: impl Into<String>, vector: Vec<f32>) -> Self {
        Self {
            blob_id: blob_id.into(),
            vector,
            namespace: None,
        }
    }
    pub fn namespace(mut self, ns: impl Into<String>) -> Self {
        self.namespace = Some(ns.into());
        self
    }
}

// ── Response types (snake_case wire) ──────────────────────────────────────

/// Returned by `remember` / `remember_bulk` accept calls.
#[derive(Debug, Clone, Deserialize)]
pub struct RememberAccepted {
    pub job_id: String,
    pub status: String,
}

/// Raw `GET /api/remember/{job_id}` status body.
#[derive(Debug, Clone, Deserialize)]
pub struct RememberJobStatus {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub blob_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Completed remember result (synthesized once a job reaches `done`).
#[derive(Debug, Clone, Deserialize)]
pub struct RememberResult {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub job_id: Option<String>,
    pub blob_id: String,
    pub owner: String,
    pub namespace: String,
}

/// One recalled memory.
#[derive(Debug, Clone, Deserialize)]
pub struct RecallMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
    #[serde(default)]
    pub score: Option<f64>,
}

/// Result of [`crate::WalrusMemory::recall`].
#[derive(Debug, Clone, Deserialize)]
pub struct RecallResult {
    pub results: Vec<RecallMemory>,
    pub total: u64,
    #[serde(default)]
    pub dropped_count: Option<u64>,
}

/// Result of [`crate::WalrusMemory::embed`].
#[derive(Debug, Clone, Deserialize)]
pub struct EmbedResult {
    pub vector: Vec<f32>,
}

/// One fact extracted by `analyze`.
#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzedFact {
    pub text: String,
    pub id: String,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub blob_id: Option<String>,
}

/// Result of [`crate::WalrusMemory::analyze`].
#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzeResult {
    pub job_ids: Vec<String>,
    pub facts: Vec<AnalyzedFact>,
    pub fact_count: u64,
    pub status: String,
    pub owner: String,
}

/// One memory used to answer an `ask` query.
#[derive(Debug, Clone, Deserialize)]
pub struct AskMemory {
    pub blob_id: String,
    pub text: String,
    pub distance: f64,
    #[serde(default)]
    pub score: Option<f64>,
}

/// Result of [`crate::WalrusMemory::ask`].
#[derive(Debug, Clone, Deserialize)]
pub struct AskResult {
    pub answer: String,
    pub memories_used: u64,
    pub memories: Vec<AskMemory>,
}

/// Result of [`crate::WalrusMemory::restore`].
#[derive(Debug, Clone, Deserialize)]
pub struct RestoreResult {
    pub restored: u64,
    pub skipped: u64,
    pub total: u64,
    pub namespace: String,
    pub owner: String,
}

/// Result of [`crate::WalrusMemory::health`]. Captures the common fields plus any
/// additional relayer metadata in `extra`.
#[derive(Debug, Clone, Deserialize)]
pub struct HealthResult {
    pub status: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mode: Option<String>,
    /// Any remaining fields (relayerVersion, apiVersion, featureFlags, …).
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Minimum supported SDK versions advertised by the relayer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinSupportedSdk {
    pub typescript: String,
    pub python: String,
    pub mcp: String,
}

/// One deprecation notice from `GET /version`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeprecationNotice {
    pub surface: String,
    pub deprecated_since: String,
    pub removal_api_version: String,
    pub guidance: String,
}

/// Build metadata from `GET /version`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub build_timestamp: Option<String>,
}

/// `GET /version` relayer compatibility metadata.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub relayer_version: String,
    pub api_version: String,
    pub min_supported_sdk: MinSupportedSdk,
    #[serde(default)]
    pub feature_flags: HashMap<String, bool>,
    #[serde(default)]
    pub deprecations: Vec<DeprecationNotice>,
    #[serde(default)]
    pub build: BuildInfo,
}

// ── Bulk ──────────────────────────────────────────────────────────────────

/// Returned by `remember_bulk`.
#[derive(Debug, Clone, Deserialize)]
pub struct RememberBulkAccepted {
    pub job_ids: Vec<String>,
    pub total: u64,
    pub status: String,
}

/// One item of a bulk status response.
#[derive(Debug, Clone, Deserialize)]
pub struct RememberBulkStatusItem {
    pub job_id: String,
    pub status: String,
    #[serde(default)]
    pub blob_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Raw `POST /api/remember/bulk/status` response.
#[derive(Debug, Clone, Deserialize)]
pub struct RememberBulkStatusResult {
    pub results: Vec<RememberBulkStatusItem>,
}

/// One resolved bulk item after waiting.
#[derive(Debug, Clone)]
pub struct RememberBulkItemResult {
    pub id: String,
    pub blob_id: Option<String>,
    /// `done` | `failed` | `timeout`
    pub status: String,
    pub namespace: String,
    pub error: Option<String>,
}

/// Resolved bulk result after waiting for all jobs.
#[derive(Debug, Clone)]
pub struct RememberBulkResult {
    pub results: Vec<RememberBulkItemResult>,
    pub total: u64,
    pub succeeded: u64,
    pub failed: u64,
}

/// Result of [`crate::WalrusMemory::analyze_and_wait`]: extracted facts plus the
/// resolved status of every per-fact remember job.
#[derive(Debug, Clone)]
pub struct AnalyzeWaitResult {
    pub facts: Vec<AnalyzedFact>,
    pub owner: String,
    pub results: Vec<RememberBulkItemResult>,
    pub total: u64,
    pub succeeded: u64,
    pub failed: u64,
}

/// One hit from `recall_manual` (no decrypted text).
#[derive(Debug, Clone, Deserialize)]
pub struct RecallManualHit {
    pub blob_id: String,
    pub distance: f64,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub importance: Option<f32>,
}

/// Result of [`crate::WalrusMemory::recall_manual`].
#[derive(Debug, Clone, Deserialize)]
pub struct RecallManualResult {
    pub results: Vec<RecallManualHit>,
    pub total: u64,
}

/// Result of [`crate::WalrusMemory::remember_manual`].
#[derive(Debug, Clone, Deserialize)]
pub struct RememberManualResult {
    pub blob_id: String,
    pub owner: String,
    pub namespace: String,
}
