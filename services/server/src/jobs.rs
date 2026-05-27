/// Wallet signing job queue.
///
/// Every operation that requires a Sui wallet signature is modelled as a
/// `WalletJob` jobs are signed by the configured server wallet pool.
/// This guarantees that:
///   - upload → metadata+transfer use the same key for a given job
///   - signing operations can run concurrently across the configured wallets
///   - jobs survive server restarts (persisted in Postgres via Apalis)
///
/// Retry policy: up to MAX_ATTEMPTS attempts with exponential back-off.
/// Failed jobs are visible in the `apalis_jobs` table.
use std::io;
use std::sync::Arc;

use apalis::prelude::*;
use apalis_sql::postgres::PostgresStorage;
use base64::Engine as _;
use redis::AsyncCommands;

use serde::{Deserialize, Serialize};

use crate::alerts::{
    SIDECAR_WALRUS_DEP_VERSION, WalrusPackageUpgradeDetectedAlert, WalrusUploadExhaustedAlert,
};
use crate::storage::walrus::{SetMetadataBatchEntry, UploadBlobError};
use crate::types::{configured_walrus_storage_epochs, AppState, BLOB_CACHE_KEY_PREFIX};

// ============================================================
// WalletJob — unified job type for all wallet-signing operations
// ============================================================

/// All operations that require a Sui private key to sign a transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WalletOperation {
    /// Upload SEAL-encrypted blob to Walrus, index vector, set on-chain
    /// metadata, then transfer the Blob object to the user's wallet.
    ///
    /// This collapses the old RememberJob + MetaTransferJob into one unit
    /// that always executes with the same wallet key.
    UploadAndTransfer {
        /// SEAL-encrypted ciphertext (base64). Pre-computed in route handler.
        encrypted_b64: String,
        /// Pre-computed embedding vector (1536-dim).
        vector: Vec<f32>,
        /// MEM-54: per-fact importance set at extraction time. Persisted
        /// on `vector_entries.importance` after Walrus upload completes.
        /// `#[serde(default = "default_importance")]` so legacy job rows
        /// enqueued before MEM-54 land at the neutral "standard" bucket
        /// rather than failing deserialisation.
        #[serde(default = "default_importance")]
        importance: f32,
        /// Walrus Memory owner address.
        owner: String,
        /// Namespace for isolation.
        namespace: String,
        /// Walrus Memory package ID.
        package_id: String,
        /// Delegate public key (used as agent_id on-chain).
        agent_public_key: Option<String>,
        /// `remember_jobs` row ID to update with status/blob_id.
        remember_job_id: Option<String>,
        /// Storage epochs for Walrus upload.
        #[serde(default = "default_epochs")]
        epochs: u32,
    },
    /// Legacy metadata+transfer operation for rows created before `/walrus/upload`
    /// started doing metadata+transfer atomically.
    SetMetadataAndTransfer {
        /// Sui object ID of the certified Walrus Blob.
        blob_object_id: String,
        /// Sui address of the Walrus Memory user.
        owner: String,
        /// Walrus Memory namespace.
        namespace: String,
        /// Walrus Memory package ID.
        package_id: Option<String>,
        /// Agent / delegate public key.
        agent_id: Option<String>,
        /// `remember_jobs` row ID to complete after transfer. Present for
        /// partial upload recovery jobs; absent for legacy transfer-only rows.
        #[serde(default)]
        remember_job_id: Option<String>,
        /// Walrus blob ID to index after transfer succeeds.
        #[serde(default)]
        blob_id: Option<String>,
        /// Pre-computed embedding vector to index after transfer succeeds.
        #[serde(default)]
        vector: Option<Vec<f32>>,
        /// Encrypted blob size to record with the vector row.
        #[serde(default)]
        blob_size_bytes: Option<i64>,
        /// MEM-54: per-fact importance score, indexed alongside the vector
        /// when this recovery job finalises the upload. Defaulted to
        /// `IMPORTANCE_STANDARD` so legacy / pre-MEM-54 rows degrade to the
        /// neutral bucket rather than failing deserialisation.
        #[serde(default = "default_importance")]
        importance: f32,
    },
    /// Finish a partially recovered upload after metadata+transfer has already
    /// succeeded. This keeps DB/vector retries from repeating an on-chain
    /// transfer for an object that may now be owned by the user.
    FinalizeUploadedBlob {
        owner: String,
        namespace: String,
        #[serde(default)]
        remember_job_id: Option<String>,
        blob_id: String,
        vector: Vec<f32>,
        blob_size_bytes: i64,
        /// MEM-54: same as on `UploadAndTransfer` — persisted on the
        /// `vector_entries.importance` column. Defaulted to
        /// `IMPORTANCE_STANDARD` for backwards compatibility with in-flight
        /// recovery jobs enqueued before this field existed.
        #[serde(default = "default_importance")]
        importance: f32,
    },
}

fn default_epochs() -> u32 {
    let network = std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".to_string());
    configured_walrus_storage_epochs(&network)
}

/// MEM-54: serde default for `WalletOperation::UploadAndTransfer.importance`
/// so legacy job rows enqueued before this field existed degrade to the
/// neutral "standard" bucket on dequeue.
fn default_importance() -> f32 {
    crate::services::extractor::IMPORTANCE_STANDARD
}

pub(crate) async fn warm_blob_cache_after_upload(
    state: &AppState,
    blob_id: &str,
    ciphertext: &[u8],
) {
    let ttl_secs = state.blob_cache_ttl.as_secs();
    if ttl_secs == 0 || state.blob_cache_max_bytes == 0 {
        return;
    }

    if ciphertext.len() > state.blob_cache_max_bytes {
        tracing::info!(
            "blob cache warm skipped for {}: {} bytes exceeds max {}",
            blob_id,
            ciphertext.len(),
            state.blob_cache_max_bytes
        );
        return;
    }

    let cache_key = format!("{}{}", BLOB_CACHE_KEY_PREFIX, blob_id);
    let mut redis = state.redis.clone();
    let result: redis::RedisResult<()> =
        redis.set_ex(cache_key, ciphertext.to_vec(), ttl_secs).await;
    if let Err(e) = result {
        tracing::warn!("blob cache warm failed for {}: {}", blob_id, e);
    }
}

async fn update_remember_job_after_wallet_error(
    state: &AppState,
    remember_job_id: Option<&str>,
    error: &WalletJobError,
    msg: &str,
) {
    let Some(jid) = remember_job_id else {
        return;
    };

    let status = if error.is_permanent() {
        "failed"
    } else {
        "running"
    };

    let _ = sqlx::query(
        "UPDATE remember_jobs SET status = $1, error_msg = $2, updated_at = NOW() WHERE id = $3",
    )
    .bind(status)
    .bind(msg)
    .bind(jid)
    .execute(state.db.pool())
    .await;
}

async fn mark_remember_job_failed(
    pool: &sqlx::PgPool,
    remember_job_id: Option<&str>,
    msg: &str,
) -> Result<(), sqlx::Error> {
    let Some(jid) = remember_job_id else {
        return Ok(());
    };

    let result = sqlx::query(
        "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(msg)
    .bind(jid)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    Ok(())
}

fn remember_job_persist_failure_message(msg: &str, persist_err: &sqlx::Error) -> String {
    format!(
        "{}; failed to persist remember_jobs failed status: {}",
        msg, persist_err
    )
}

async fn classify_wallet_remember_handoff_failure(
    pool: &sqlx::PgPool,
    remember_job_id: Option<&str>,
    msg: String,
) -> WalletJobError {
    // Recovery handoff failures happen after an external side effect already
    // succeeded: a Walrus upload and sometimes an on-chain transfer. Once the
    // polling row is durably terminal, abort retries so clients see `failed`
    // instead of polling `uploaded` / `running` forever. If that terminal
    // state cannot be persisted, keep the wallet handler retryable so the row
    // is not orphaned.
    match mark_remember_job_failed(pool, remember_job_id, &msg).await {
        Ok(()) => WalletJobError::Permanent(msg),
        Err(persist_err) => {
            WalletJobError::Transient(remember_job_persist_failure_message(&msg, &persist_err))
        }
    }
}

async fn handle_legacy_remember_handoff_failure(
    pool: &sqlx::PgPool,
    remember_job_id: &str,
    msg: String,
) -> Result<(), RememberJobError> {
    match mark_remember_job_failed(pool, Some(remember_job_id), &msg).await {
        Ok(()) => Ok(()),
        Err(persist_err) => Err(RememberJobError::Internal(
            remember_job_persist_failure_message(&msg, &persist_err),
        )),
    }
}

/// A wallet job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletJob {
    /// Index into `config.sui_private_keys` used by the sidecar for signing.
    /// For `UploadAndTransfer`, this is the enqueue-time assignment used for
    /// logging only; the worker selects a fresh round-robin wallet at execution
    /// time so retries can move to another wallet.
    pub wallet_index: usize,
    pub operation: WalletOperation,
}

/// Convenience type alias
pub type WalletJobStorage = PostgresStorage<WalletJob>;

// ============================================================
// Legacy MetaTransferJob — kept for backward-compat with existing DB rows.
// ============================================================

/// Payload stored as JSON in the `apalis_jobs` Postgres table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaTransferJob {
    /// Sui object ID of the certified Walrus Blob (0x...).
    pub blob_object_id: String,
    /// Sui address of the Walrus Memory user who should own the blob.
    pub owner: String,
    /// Walrus Memory namespace (e.g. "default").
    pub namespace: String,
    /// Walrus Memory package ID (optional — stored as on-chain attribute).
    pub package_id: Option<String>,
    /// Agent ID (optional — stored as on-chain attribute).
    pub agent_id: Option<String>,
    /// Index of the pool key that registered/certified this blob.
    /// The set-metadata + transfer transaction MUST be signed by the same key
    /// (the blob is currently owned by that key's address).
    pub key_index: usize,
}

// ============================================================
// Error type
// ============================================================

#[derive(Debug)]
pub enum MetaTransferError {
    SidecarError(String),
}

impl std::fmt::Display for MetaTransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MetaTransferError::SidecarError(msg) => write!(f, "sidecar call failed: {}", msg),
        }
    }
}

impl std::error::Error for MetaTransferError {}

// ============================================================
// Job handler
// ============================================================

/// Apalis calls this function for each `MetaTransferJob`.
///
/// Legacy handler for rows created before upload and transfer were collapsed.
pub async fn execute_meta_transfer(
    job: MetaTransferJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), MetaTransferError> {
    // Data<T> implements Deref<Target=T>, so &*ctx gives &Arc<AppState>
    let state: &AppState = &ctx;
    // Use the key_index stored in the job — this is the same key that
    // registered/certified the blob, so the signer address will match
    // the blob's current owner. No round-robin selection here.
    let key_index = job.key_index;

    execute_set_metadata_and_transfer(
        state,
        key_index,
        job.blob_object_id,
        job.owner,
        job.namespace,
        job.package_id,
        job.agent_id,
    )
    .await
    .map_err(|e| MetaTransferError::SidecarError(e.to_string()))
}

// ============================================================
// Retry constants
// ============================================================

/// Maximum number of attempts (1 initial + N-1 retries).
#[allow(dead_code)]
pub const MAX_ATTEMPTS: u32 = 5;

/// Exponential back-off: attempt 1→2s, 2→4s, 3→8s, 4→16s, 5→32s.
#[allow(dead_code)]
pub fn backoff_duration(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2u64.pow(attempt))
}

pub(crate) fn wallet_job_request(
    job: WalletJob,
) -> Request<WalletJob, apalis_sql::context::SqlContext> {
    let mut context = apalis_sql::context::SqlContext::new();
    context.set_max_attempts(MAX_ATTEMPTS as i32);
    Request::new_with_ctx(job, context)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct WalletJobAttemptInfo {
    current: usize,
    max: usize,
}

impl WalletJobAttemptInfo {
    fn exhausted_by(&self, error: &WalletJobError) -> bool {
        !error.is_permanent() && self.current >= self.max
    }
}

impl FromRequest<Request<WalletJob, apalis_sql::context::SqlContext>> for WalletJobAttemptInfo {
    fn from_request(
        req: &Request<WalletJob, apalis_sql::context::SqlContext>,
    ) -> Result<Self, Error> {
        let mut max =
            usize::try_from(req.parts.context.max_attempts()).unwrap_or(MAX_ATTEMPTS as usize);
        if max == 0 {
            max = MAX_ATTEMPTS as usize;
        }
        Ok(Self {
            current: req.parts.attempt.current(),
            max,
        })
    }
}

// ============================================================
// execute_wallet_job — dispatcher for WalletJob
// ============================================================

/// Apalis worker handler for WalletJob.
///
/// Multiple concurrent invocations of this handler share the `wallet_jobs`
/// queue. Upload jobs select a fresh wallet index at execution time; legacy
/// metadata-transfer jobs keep their pinned wallet because the blob object is
/// owned by the wallet that registered/certified it.
pub(crate) async fn execute_wallet_job(
    job: WalletJob,
    ctx: Data<Arc<AppState>>,
    attempt_info: WalletJobAttemptInfo,
) -> Result<(), Error> {
    let state: &AppState = &ctx;
    let enqueued_wallet_index = job.wallet_index;

    let result = match job.operation {
        WalletOperation::UploadAndTransfer {
            encrypted_b64,
            vector,
            importance,
            owner,
            namespace,
            package_id,
            agent_public_key,
            remember_job_id,
            epochs,
        } => {
            let wallet_index = match state.key_pool.next_index() {
                Some(index) => index,
                None => {
                    return Err(WalletJobError::Permanent(
                        "No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)"
                            .into(),
                    )
                    .into_apalis_error());
                }
            };
            if wallet_index != enqueued_wallet_index {
                tracing::info!(
                    "[wallet-job:upload] reassigned wallet at execution: enqueued={} executing={}",
                    enqueued_wallet_index,
                    wallet_index,
                );
            }
            execute_upload_and_transfer(
                state,
                wallet_index,
                encrypted_b64,
                vector,
                importance,
                owner,
                namespace,
                package_id,
                agent_public_key,
                remember_job_id,
                epochs,
                attempt_info,
            )
            .await
        }
        WalletOperation::SetMetadataAndTransfer {
            blob_object_id,
            owner,
            namespace,
            package_id,
            agent_id,
            remember_job_id,
            blob_id,
            vector,
            blob_size_bytes,
            importance,
        } => {
            let result = execute_set_metadata_and_transfer(
                state,
                enqueued_wallet_index,
                blob_object_id,
                owner.clone(),
                namespace.clone(),
                package_id.clone(),
                agent_id.clone(),
            )
            .await;

            match result {
                Ok(()) => match (blob_id, vector, blob_size_bytes) {
                    (Some(blob_id), Some(vector), Some(blob_size_bytes)) => {
                        if let Err(err) = insert_vector_and_mark_remember_done(
                            state,
                            remember_job_id.as_deref(),
                            &owner,
                            &namespace,
                            &blob_id,
                            &vector,
                            blob_size_bytes,
                            importance,
                            enqueued_wallet_index,
                        )
                        .await
                        {
                            let finalize_remember_job_id = remember_job_id.clone();
                            if let Err(enqueue_err) = enqueue_finalize_uploaded_blob(
                                state,
                                enqueued_wallet_index,
                                owner,
                                namespace,
                                remember_job_id,
                                blob_id,
                                vector,
                                blob_size_bytes,
                                importance,
                            )
                            .await
                            {
                                let classified = classify_wallet_remember_handoff_failure(
                                    state.db.pool(),
                                    finalize_remember_job_id.as_deref(),
                                    enqueue_err.to_string(),
                                )
                                .await;
                                tracing::error!(
                                    "[wallet-job:set-metadata] job_id={} {}",
                                    finalize_remember_job_id.as_deref().unwrap_or("-"),
                                    classified,
                                );
                                return Err(classified.into_apalis_error());
                            }
                            tracing::warn!(
                                    "[wallet-job:set-metadata] finalization failed after transfer; enqueued index-only retry: {}",
                                    err
                                );
                        }
                        Ok(())
                    }
                    (None, None, None) => Ok(()),
                    _ => Err(WalletJobError::Permanent(
                        "metadata transfer recovery job missing finalization fields".into(),
                    )),
                },
                Err(err) => {
                    let msg = err.to_string();
                    update_remember_job_after_wallet_error(
                        state,
                        remember_job_id.as_deref(),
                        &err,
                        &msg,
                    )
                    .await;
                    tracing::error!(
                        "[wallet-job:set-metadata] job_id={} {} classification={} retryable={}",
                        remember_job_id.as_deref().unwrap_or("-"),
                        msg,
                        err.kind(),
                        !err.is_permanent()
                    );
                    Err(err)
                }
            }
        }
        WalletOperation::FinalizeUploadedBlob {
            owner,
            namespace,
            remember_job_id,
            blob_id,
            vector,
            blob_size_bytes,
            importance,
        } => {
            insert_vector_and_mark_remember_done(
                state,
                remember_job_id.as_deref(),
                &owner,
                &namespace,
                &blob_id,
                &vector,
                blob_size_bytes,
                importance,
                enqueued_wallet_index,
            )
            .await
        }
    };

    result.map_err(|err| {
        if let WalletJobError::Permanent(ref msg) = err {
            tracing::warn!(
                target: "wallet_job.permanent",
                "permanent failure for wallet_index={} (will mark Dead): {}",
                enqueued_wallet_index,
                msg
            );
        }
        err.into_apalis_error()
    })
}

// ────────────────────────────────────────────────────────────
// WalletOperation::SetMetadataAndTransfer
// ────────────────────────────────────────────────────────────

async fn execute_set_metadata_and_transfer(
    state: &AppState,
    wallet_index: usize,
    blob_object_id: String,
    owner: String,
    namespace: String,
    package_id: Option<String>,
    agent_id: Option<String>,
) -> Result<(), WalletJobError> {
    crate::storage::walrus::set_metadata_batch(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        wallet_index,
        &owner,
        package_id.as_deref().unwrap_or(&state.config.package_id),
        agent_id.as_deref(),
        vec![SetMetadataBatchEntry {
            blob_object_id,
            namespace,
        }],
    )
    .await
    .map(|_| ())
    .map_err(|e| {
        let msg = e.to_string();
        let classified = WalletJobError::classify_sidecar_error(&msg);
        if classified.is_permanent() {
            tracing::error!(
                "[wallet-job:set-metadata] permanent failure (will mark Dead): {}",
                msg
            );
        }
        classified
    })
}

async fn insert_vector_and_mark_remember_done(
    state: &AppState,
    remember_job_id: Option<&str>,
    owner: &str,
    namespace: &str,
    blob_id: &str,
    vector: &[f32],
    blob_size_bytes: i64,
    importance: f32,
    wallet_index: usize,
) -> Result<(), WalletJobError> {
    let vector_id = remember_job_id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    if let Err(e) = state
        .db
        .insert_vector(
            &vector_id,
            owner,
            namespace,
            blob_id,
            vector,
            blob_size_bytes,
            importance,
        )
        .await
    {
        let msg = format!("insert_vector failed: {}", e);
        let classified = WalletJobError::classify_sidecar_error(&msg);
        update_remember_job_after_wallet_error(state, remember_job_id, &classified, &msg).await;
        tracing::error!(
            "[wallet-job:upload] job_id={} {} classification={} retryable={}",
            remember_job_id.unwrap_or("-"),
            msg,
            classified.kind(),
            !classified.is_permanent()
        );
        return Err(classified);
    }

    if let Some(jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'done', blob_id = $1, error_msg = NULL, updated_at = NOW() WHERE id = $2",
        )
        .bind(blob_id)
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    tracing::info!(
        "[wallet-job:upload] done job_id={} blob_id={} owner={} ns={} key={}",
        remember_job_id.unwrap_or("-"),
        blob_id,
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
    );
    Ok(())
}

async fn enqueue_finalize_uploaded_blob(
    state: &AppState,
    wallet_index: usize,
    owner: String,
    namespace: String,
    remember_job_id: Option<String>,
    blob_id: String,
    vector: Vec<f32>,
    blob_size_bytes: i64,
    importance: f32,
) -> Result<(), WalletJobError> {
    let mut storage = state.wallet_storage.clone();
    storage
        .push_request(wallet_job_request(WalletJob {
            wallet_index,
            operation: WalletOperation::FinalizeUploadedBlob {
                owner,
                namespace,
                remember_job_id,
                blob_id,
                vector,
                blob_size_bytes,
                importance,
            },
        }))
        .await
        .map_err(|e| {
            WalletJobError::Transient(format!(
                "failed to enqueue uploaded-blob finalization job: {}",
                e
            ))
        })
        .map(|_| ())
}

// ────────────────────────────────────────────────────────────
// WalletOperation::UploadAndTransfer
// ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn execute_upload_and_transfer(
    state: &AppState,
    wallet_index: usize,
    encrypted_b64: String,
    vector: Vec<f32>,
    importance: f32,
    owner: String,
    namespace: String,
    package_id: String,
    agent_public_key: Option<String>,
    remember_job_id: Option<String>,
    epochs: u32,
    attempt_info: WalletJobAttemptInfo,
) -> Result<(), WalletJobError> {
    // ── Mark running ───────────────────────────────────────────
    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'running', error_msg = NULL, updated_at = NOW() WHERE id = $1",
        )
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    // ── Decode encrypted bytes ─────────────────────────────────
    let encrypted = match base64::engine::general_purpose::STANDARD.decode(&encrypted_b64) {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("base64 decode failed: {}", e);
            let classified = WalletJobError::Permanent(msg.clone());
            update_remember_job_after_wallet_error(
                state,
                remember_job_id.as_deref(),
                &classified,
                &msg,
            )
            .await;
            tracing::error!(
                "[wallet-job:upload] job_id={} {}",
                remember_job_id.as_deref().unwrap_or("-"),
                msg
            );
            return Err(classified);
        }
    };

    tracing::info!(
        "[wallet-job:upload] job_id={} owner={} ns={} key={} bytes={}",
        remember_job_id.as_deref().unwrap_or("-"),
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
        encrypted.len(),
    );

    // ── Upload to Walrus via sidecar (using pinned wallet_index) ─
    let upload_result = crate::storage::walrus::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        &encrypted,
        epochs as u64,
        &owner,
        wallet_index,
        &namespace,
        &package_id,
        agent_public_key.as_deref(),
    )
    .await;

    let upload = match upload_result {
        Ok(u) => u,
        Err(UploadBlobError::MetadataTransferFailed {
            blob_id,
            object_id,
            message,
        }) => {
            tracing::warn!(
                "[wallet-job:upload] job_id={} upload succeeded but metadata/transfer failed: {}",
                remember_job_id.as_deref().unwrap_or("-"),
                message,
            );

            warm_blob_cache_after_upload(state, &blob_id, &encrypted).await;

            if let Some(ref jid) = remember_job_id {
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, error_msg = NULL, updated_at = NOW() WHERE id = $2",
                )
                .bind(&blob_id)
                .bind(jid)
                .execute(state.db.pool())
                .await;
            }

            let job_id_for_log = remember_job_id.as_deref().unwrap_or("-").to_string();
            let recovery_remember_job_id = remember_job_id.clone();
            let mut storage = state.wallet_storage.clone();
            if let Err(e) = storage
                .push_request(wallet_job_request(WalletJob {
                    wallet_index,
                    operation: WalletOperation::SetMetadataAndTransfer {
                        blob_object_id: object_id,
                        owner,
                        namespace,
                        package_id: Some(package_id),
                        agent_id: agent_public_key,
                        remember_job_id,
                        blob_id: Some(blob_id.clone()),
                        vector: Some(vector),
                        blob_size_bytes: Some(encrypted.len() as i64),
                        importance,
                    },
                }))
                .await
            {
                let classified = classify_wallet_remember_handoff_failure(
                    state.db.pool(),
                    recovery_remember_job_id.as_deref(),
                    format!("failed to enqueue metadata/transfer recovery job: {}", e),
                )
                .await;
                tracing::error!(
                    "[wallet-job:upload] job_id={} {}",
                    job_id_for_log,
                    classified,
                );
                return Err(classified);
            }

            tracing::info!(
                "[wallet-job:upload] job_id={} enqueued metadata/transfer recovery for blob_id={} key={}",
                job_id_for_log,
                blob_id,
                wallet_index,
            );
            return Ok(());
        }
        Err(UploadBlobError::App(e)) => {
            let msg = format!("walrus upload failed: {}", e);
            let classified = WalletJobError::classify_sidecar_error(&msg);
            maybe_alert_walrus_package_upgrade_detected(
                state,
                remember_job_id.as_deref(),
                Some(&owner),
                Some(&namespace),
                &msg,
            )
            .await;
            maybe_alert_walrus_upload_exhausted(
                state,
                &classified,
                attempt_info,
                remember_job_id.as_deref(),
                &owner,
                &namespace,
                wallet_index,
                &msg,
            )
            .await;
            update_remember_job_after_wallet_error(
                state,
                remember_job_id.as_deref(),
                &classified,
                &msg,
            )
            .await;
            tracing::error!(
                "[wallet-job:upload] job_id={} {} classification={} retryable={}",
                remember_job_id.as_deref().unwrap_or("-"),
                msg,
                classified.kind(),
                !classified.is_permanent()
            );
            return Err(classified);
        }
    };
    let blob_id = upload.blob_id.clone();

    warm_blob_cache_after_upload(state, &blob_id, &encrypted).await;

    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, error_msg = NULL, updated_at = NOW() WHERE id = $2",
        )
        .bind(&blob_id)
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    // The sidecar's `/walrus/upload` endpoint already performs metadata+transfer
    // atomically. A successful upload response means the blob is ready to index.
    insert_vector_and_mark_remember_done(
        state,
        remember_job_id.as_deref(),
        &owner,
        &namespace,
        &blob_id,
        &vector,
        encrypted.len() as i64,
        importance,
        wallet_index,
    )
    .await
}

/// Mirrors the TS sidecar's `isWalrusPackageVersionMismatch` detector. We
/// recheck the pattern on the Rust side so we can fire a one-shot informational
/// Slack alert when the sidecar surfaces an EWrongVersion MoveAbort, without
/// having to plumb a structured signal back from the subprocess.
///
/// Anchor: requires the literal `MoveAbort` token alongside either the
/// `::system::inner_mut` function-path fragment (cross-transport stable, since
/// the package component is always a numeric address) OR the symbolic
/// `EWrongVersion` (only present on gRPC/GraphQL clients). See
/// `services/server/scripts/walrus-error-detection.ts` for the same pattern.
fn is_walrus_package_version_mismatch(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    if !lower.contains("moveabort") && !lower.contains("move abort") {
        return false;
    }
    lower.contains("::system::inner_mut") || lower.contains("ewrongversion")
}

async fn maybe_alert_walrus_package_upgrade_detected(
    state: &AppState,
    remember_job_id: Option<&str>,
    owner: Option<&str>,
    namespace: Option<&str>,
    msg: &str,
) {
    if !is_walrus_package_version_mismatch(msg) {
        return;
    }

    let alert = WalrusPackageUpgradeDetectedAlert {
        remember_job_id: remember_job_id.map(str::to_owned),
        owner: owner.map(str::to_owned),
        namespace: namespace.map(str::to_owned),
        sui_network: state.config.sui_network.clone(),
        sidecar_walrus_dep_version: SIDECAR_WALRUS_DEP_VERSION.to_string(),
        on_chain_version_before: None,
        on_chain_version_after: None,
        action_taken: "Sidecar refreshed cached @mysten/walrus client; Apalis will retry against the new package metadata.".to_string(),
        error: msg.to_string(),
    };

    if let Err(err) = state
        .alerts
        .notify_walrus_package_upgrade_detected(alert)
        .await
    {
        tracing::warn!(
            "[wallet-job:upload] failed to send Slack alert for Walrus package upgrade detected: {}",
            err
        );
    }
}

async fn maybe_alert_walrus_upload_exhausted(
    state: &AppState,
    error: &WalletJobError,
    attempt_info: WalletJobAttemptInfo,
    remember_job_id: Option<&str>,
    owner: &str,
    namespace: &str,
    wallet_index: usize,
    msg: &str,
) {
    if !attempt_info.exhausted_by(error) {
        return;
    }

    let alert = WalrusUploadExhaustedAlert {
        remember_job_id: remember_job_id.map(str::to_owned),
        owner: owner.to_string(),
        namespace: namespace.to_string(),
        attempt: attempt_info.current,
        max_attempts: attempt_info.max,
        wallet_index,
        configured_wallets: state.key_pool.len(),
        sui_network: state.config.sui_network.clone(),
        error: msg.to_string(),
    };

    if let Err(err) = state.alerts.notify_walrus_upload_exhausted(alert).await {
        tracing::warn!(
            "[wallet-job:upload] failed to send Slack alert for exhausted Walrus upload retries: {}",
            err
        );
    }
}

// ============================================================
// WalletJobError
// ============================================================

/// Failure classification for `WalletJob` handlers.
///
/// Apalis re-queues with exponential backoff on `Transient`. `Permanent`
/// errors are returned as-is so the job is marked Dead immediately and we
/// don't burn retry budget on inputs that can never succeed.
///
/// Mapping rules (enforced at the point of error origination):
/// - `MoveAbort(_)` → `Permanent` (deterministic Move-level failure), except
///   `balance::split` stale-state failures that can recover after sidecar refresh
/// - `ObjectLockedAtVersion(_)` → `Transient` (retry can rebuild with a fresh
///   wallet assignment)
/// - `InsufficientGas` / `ObjectNotFound` /
///   `ObjectVersionUnavailableForConsumption` → `Transient` (refill wallet,
///   refresh local state, retry)
/// - Network 429 / 5xx / timeout → `Transient`
#[derive(Debug)]
pub enum WalletJobError {
    /// Transient failure — Apalis should retry with backoff.
    Transient(String),
    /// Permanent failure — Apalis should mark Dead immediately (no retry).
    Permanent(String),
}

impl WalletJobError {
    pub fn kind(&self) -> &'static str {
        match self {
            WalletJobError::Transient(_) => "transient",
            WalletJobError::Permanent(_) => "permanent",
        }
    }

    /// True if the error is `Permanent` — caller should NOT retry.
    pub fn is_permanent(&self) -> bool {
        matches!(self, WalletJobError::Permanent(_))
    }

    /// Heuristic classification from the sidecar's error string. The sidecar
    /// surfaces Sui execution errors verbatim (Move abort codes, lock errors).
    /// Until the sidecar emits structured error codes, we match on substrings.
    pub fn classify_sidecar_error(msg: &str) -> Self {
        let lower = msg.to_ascii_lowercase();
        if (lower.contains("moveabort") || lower.contains("move abort"))
            && lower.contains("balance")
            && lower.contains("split")
        {
            return WalletJobError::Transient(msg.to_string());
        }
        // Walrus on-chain package upgrade — the cached @mysten/walrus client
        // carries stale package metadata until refreshed. The sidecar already
        // recreates the client on this error; classifying Transient lets
        // Apalis retry against the refreshed client instead of Dead-marking
        // a job that the next attempt will succeed on.
        if (lower.contains("moveabort") || lower.contains("move abort"))
            && (lower.contains("::system::inner_mut") || lower.contains("ewrongversion"))
        {
            return WalletJobError::Transient(msg.to_string());
        }
        if lower.contains("moveabort") || lower.contains("move abort") {
            return WalletJobError::Permanent(msg.to_string());
        }
        if lower.contains("objectlocked")
            || lower.contains("object_locked")
            || lower.contains("object is locked")
            || lower.contains("locked at version")
            || lower.contains("sponsor failed")
            || lower.contains("enoki api error")
            || lower.contains("sponsored transaction has expired")
        {
            return WalletJobError::Transient(msg.to_string());
        }
        WalletJobError::Transient(msg.to_string())
    }

    pub fn into_apalis_error(self) -> Error {
        let error = io::Error::other(self.to_string());
        match self {
            WalletJobError::Transient(_) => Error::Failed(Arc::new(Box::new(error))),
            WalletJobError::Permanent(_) => Error::Abort(Arc::new(Box::new(error))),
        }
    }
}

impl std::fmt::Display for WalletJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalletJobError::Transient(msg) => write!(f, "wallet job error (transient): {}", msg),
            WalletJobError::Permanent(msg) => write!(f, "wallet job error (permanent): {}", msg),
        }
    }
}

impl std::error::Error for WalletJobError {}

// ============================================================
// RememberJob — full async pipeline (ENG-1406 v3)
// ============================================================

/// Payload for the full async remember pipeline stored in `apalis_jobs`.
///
/// The route handler enqueues this job and returns HTTP 202 immediately.
/// The Apalis worker executes embed → encrypt → upload → insert_vector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RememberJob {
    /// Stable job ID returned to the client in the 202 response.
    pub job_id: String,
    /// SEAL-encrypted ciphertext (base64). Plaintext is NOT stored here.
    /// Embed + SEAL encrypt happen in the route handler before enqueuing.
    pub encrypted_b64: String,
    /// Pre-computed embedding vector (generated in route handler alongside encrypt).
    pub vector: Vec<f32>,
    /// Walrus Memory owner address (from auth middleware).
    pub owner: String,
    /// Namespace for isolation.
    pub namespace: String,
    /// Walrus Memory package ID (needed by metadata tx).
    pub package_id: String,
    /// Delegate public key (agent_id for upload metadata).
    pub agent_public_key: Option<String>,
}

/// Type alias for the RememberJob Apalis storage.
pub type RememberJobStorage = PostgresStorage<RememberJob>;

/// Error type for the RememberJob handler.
#[derive(Debug)]
pub enum RememberJobError {
    Internal(String),
}

impl std::fmt::Display for RememberJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RememberJobError::Internal(msg) => write!(f, "remember job error: {}", msg),
        }
    }
}

impl std::error::Error for RememberJobError {}

/// Apalis handler for the full remember pipeline.
///
/// Steps:
///   1. Mark job `running` in `remember_jobs`
///   2. embed() + seal_encrypt() concurrently
///   3. walrus upload_blob()
///   4. insert_vector()
///   5. Mark job `done` with blob_id
///
/// On any error: mark job `failed` with error_msg, then return Err to
/// prevent Apalis from re-enqueueing (we handle status ourselves).
pub async fn execute_remember(
    job: RememberJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), RememberJobError> {
    let state: &AppState = &ctx;

    // ── Step 1: mark running ──────────────────────────────────────
    let _ = sqlx::query(
        "UPDATE remember_jobs SET status = 'running', error_msg = NULL, updated_at = NOW() WHERE id = $1",
    )
    .bind(&job.job_id)
    .execute(state.db.pool())
    .await;

    // Helper: mark failed and return Err
    macro_rules! fail {
        ($msg:expr) => {{
            let msg = $msg.to_string();
            tracing::error!("[remember-job] {} job_id={}", msg, job.job_id);
            let _ = sqlx::query(
                "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
            )
            .bind(&msg)
            .bind(&job.job_id)
            .execute(state.db.pool())
            .await;
            return Err(RememberJobError::Internal(msg));
        }};
    }

    // ── Step 2: decode ciphertext (already SEAL-encrypted in route handler) ──
    let encrypted = match base64::engine::general_purpose::STANDARD.decode(&job.encrypted_b64) {
        Ok(b) => b,
        Err(e) => fail!(format!("base64 decode failed: {}", e)),
    };
    // vector is also pre-computed in route handler — no network call needed here.

    let key_index = match state.key_pool.next_index() {
        Some(idx) => idx,
        None => fail!("No Sui keys configured in pool"),
    };

    // ── Step 3: walrus upload (the slow part ~2-3s) ───────────────
    let upload_result = crate::storage::walrus::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        &encrypted,
        state.config.walrus_storage_epochs as u64,
        &job.owner,
        key_index,
        &job.namespace,
        &job.package_id,
        job.agent_public_key.as_deref(),
    )
    .await;

    let upload = match upload_result {
        Ok(u) => u,
        Err(UploadBlobError::MetadataTransferFailed {
            blob_id,
            object_id,
            message,
        }) => {
            tracing::warn!(
                "[remember-job] job_id={} upload succeeded but metadata/transfer failed: {}",
                job.job_id,
                message,
            );
            warm_blob_cache_after_upload(state, &blob_id, &encrypted).await;

            let _ = sqlx::query(
                "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, error_msg = NULL, updated_at = NOW() WHERE id = $2",
            )
            .bind(&blob_id)
            .bind(&job.job_id)
            .execute(state.db.pool())
            .await;

            let mut storage = state.wallet_storage.clone();
            if let Err(e) = storage
                .push_request(wallet_job_request(WalletJob {
                    wallet_index: key_index,
                    operation: WalletOperation::SetMetadataAndTransfer {
                        blob_object_id: object_id,
                        owner: job.owner.clone(),
                        namespace: job.namespace.clone(),
                        package_id: Some(job.package_id.clone()),
                        agent_id: job.agent_public_key.clone(),
                        remember_job_id: Some(job.job_id.clone()),
                        blob_id: Some(blob_id.clone()),
                        vector: Some(job.vector.clone()),
                        blob_size_bytes: Some(encrypted.len() as i64),
                        // MEM-54: legacy RememberJob payload predates the
                        // importance field. Drain the queue at the neutral
                        // "standard" bucket; new requests go through
                        // WalletOperation::UploadAndTransfer which carries
                        // importance through end-to-end.
                        importance: crate::services::extractor::IMPORTANCE_STANDARD,
                    },
                }))
                .await
            {
                let msg = format!("failed to enqueue metadata/transfer recovery job: {}", e);
                tracing::error!("[remember-job] {} job_id={}", msg, job.job_id);
                return handle_legacy_remember_handoff_failure(state.db.pool(), &job.job_id, msg)
                    .await;
            }

            tracing::info!(
                "[remember-job] job_id={} enqueued metadata/transfer recovery for blob_id={} key={}",
                job.job_id,
                blob_id,
                key_index,
            );
            return Ok(());
        }
        Err(UploadBlobError::App(e)) => {
            let msg = format!("walrus upload failed: {}", e);
            // EWrongVersion is transient: the sidecar's catch path refreshes
            // the cached @mysten/walrus client before bubbling this error up,
            // so the next Apalis attempt sees fresh package metadata. We must
            // not write `status='failed'` here — that would make the row read
            // as terminal even though the upload is about to succeed on retry.
            if is_walrus_package_version_mismatch(&msg) {
                maybe_alert_walrus_package_upgrade_detected(
                    state,
                    Some(&job.job_id),
                    Some(&job.owner),
                    Some(&job.namespace),
                    &msg,
                )
                .await;
                tracing::warn!(
                    "[remember-job] walrus package upgrade detected, returning Err for Apalis retry job_id={} msg={}",
                    job.job_id,
                    msg
                );
                return Err(RememberJobError::Internal(msg));
            }
            fail!(msg);
        }
    };
    let blob_id = upload.blob_id.clone();

    warm_blob_cache_after_upload(state, &blob_id, &encrypted).await;

    // ── Step 4: insert_vector ────────────────────────────────────
    let blob_size = encrypted.len() as i64;
    let vector_id = job.job_id.clone();
    if let Err(e) = state
        .db
        .insert_vector(
            &vector_id,
            &job.owner,
            &job.namespace,
            &blob_id,
            &job.vector,
            blob_size,
            // MEM-54: legacy RememberJob payload predates the importance
            // field. Drains the queue at the neutral "standard" bucket;
            // new requests go through WalletOperation::UploadAndTransfer
            // which carries importance through end-to-end.
            crate::services::extractor::IMPORTANCE_STANDARD,
        )
        .await
    {
        fail!(format!("insert_vector failed: {}", e));
    }

    // ── Step 5: mark done ────────────────────────────────────────
    let _ = sqlx::query(
        "UPDATE remember_jobs SET status = 'done', blob_id = $1, error_msg = NULL, updated_at = NOW() WHERE id = $2",
    )
    .bind(&blob_id)
    .bind(&job.job_id)
    .execute(state.db.pool())
    .await;

    tracing::info!(
        "[remember-job] done job_id={} blob_id={} owner={} ns={}",
        job.job_id,
        blob_id,
        &job.owner[..10.min(job.owner.len())],
        job.namespace
    );
    Ok(())
}

// ============================================================
// BulkRememberJob — ENG-1408
//
// Fans a preprocessed bulk request out into per-item wallet jobs.
// ============================================================

/// One pre-processed item (embed + encrypt already done in route handler).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkRememberItem {
    /// remember_jobs row ID to update with status/blob_id.
    pub job_id: String,
    /// SEAL-encrypted ciphertext (base64). Pre-computed in route handler.
    pub encrypted_b64: String,
    /// Pre-computed embedding vector (1536-dim).
    pub vector: Vec<f32>,
    pub namespace: String,
    /// Wallet index assigned at enqueue time.
    pub wallet_index: usize,
    /// MEM-54: per-item importance score (defaults to "standard" 0.5 when
    /// the bulk-remember route doesn't run extraction — e.g. SDK passes
    /// pre-formed memories). `#[serde(default)]` so legacy bulk job rows
    /// drain cleanly at the neutral default.
    #[serde(default = "default_importance")]
    pub importance: f32,
}

/// Batch job payload — one BulkRememberJob per POST /api/remember/bulk call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkRememberJob {
    pub owner: String,
    pub package_id: String,
    pub agent_public_key: Option<String>,
    pub items: Vec<BulkRememberItem>,
    #[serde(default = "default_epochs")]
    pub epochs: u32,
}

/// Type alias for the BulkRememberJob Apalis storage.
pub type BulkRememberJobStorage = PostgresStorage<BulkRememberJob>;

// ─────────────────────────────────────────────────────────────
// BulkRememberError
// ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum BulkRememberError {
    #[allow(dead_code)]
    Internal(String),
}

impl std::fmt::Display for BulkRememberError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BulkRememberError::Internal(msg) => write!(f, "bulk-remember job error: {}", msg),
        }
    }
}

impl std::error::Error for BulkRememberError {}

// ─────────────────────────────────────────────────────────────
// execute_bulk_remember — Apalis handler
// ─────────────────────────────────────────────────────────────

/// Apalis worker handler for BulkRememberJob (ENG-1408).
///
/// The bulk worker intentionally does not perform wallet work itself. It fans
/// out already-prepared items into the shared WalletJob queue so single-item
/// and bulk requests share the same retry/error-classification path.
pub async fn execute_bulk_remember(
    job: BulkRememberJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), BulkRememberError> {
    let state: Arc<AppState> = Arc::clone(&ctx);

    if job.items.is_empty() {
        return Ok(());
    }

    let items_total = job.items.len();

    tracing::info!(
        "[bulk-remember] start: {} items owner={} epochs={}",
        items_total,
        &job.owner[..10.min(job.owner.len())],
        job.epochs,
    );

    let mut storage = state.wallet_storage.clone();
    let mut enqueued_count = 0usize;
    for item in job.items {
        let job_id = item.job_id.clone();
        let namespace = item.namespace.clone();
        let wallet_index = item.wallet_index;
        storage
            .push_request(wallet_job_request(WalletJob {
                wallet_index,
                operation: WalletOperation::UploadAndTransfer {
                    encrypted_b64: item.encrypted_b64,
                    vector: item.vector,
                    importance: item.importance,
                    owner: job.owner.clone(),
                    namespace,
                    package_id: job.package_id.clone(),
                    agent_public_key: job.agent_public_key.clone(),
                    remember_job_id: Some(job_id.clone()),
                    epochs: job.epochs,
                },
            }))
            .await
            .map_err(|e| {
                BulkRememberError::Internal(format!(
                    "failed to enqueue wallet job for {}: {}",
                    job_id, e
                ))
            })?;
        enqueued_count += 1;
    }

    tracing::info!(
        "[bulk-remember] fanout complete: owner={} total={} enqueued={}",
        &job.owner[..10.min(job.owner.len())],
        items_total,
        enqueued_count,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;
    use std::time::Duration;

    use sqlx::postgres::PgPoolOptions;

    use super::{
        classify_wallet_remember_handoff_failure, is_walrus_package_version_mismatch,
        mark_remember_job_failed, wallet_job_request, WalletJob, WalletJobAttemptInfo,
        WalletJobError, WalletOperation, MAX_ATTEMPTS,
    };

    static DB_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    fn test_database_url() -> String {
        std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://memwal:memwal_secret@localhost:5432/memwal".into())
    }

    async fn test_pool() -> sqlx::PgPool {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&test_database_url())
            .await
            .unwrap();

        let _guard = DB_SETUP_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        sqlx::raw_sql(include_str!("../migrations/005_remember_jobs.sql"))
            .execute(&pool)
            .await
            .unwrap();

        pool
    }

    #[test]
    fn classify_object_lock_as_transient() {
        let cases = [
            "ObjectLockedAtVersion { object_id: 0xabc, version: 42 }",
            "object is locked at version 17",
            "ObjectLocked: 0x1234",
        ];
        for msg in cases {
            assert!(
                !WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected transient for: {}",
                msg
            );
        }
    }

    #[test]
    fn classify_move_abort_as_permanent() {
        for msg in [
            "MoveAbort(MoveLocation { module: ... }, 1)",
            "Move abort at code 7",
        ] {
            assert!(
                WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected permanent for: {}",
                msg
            );
        }
    }

    #[test]
    fn classify_balance_split_move_abort_as_transient() {
        for msg in [
            "walrus upload failed: Enoki API error (400): {\"errors\":[{\"code\":\"dry_run_failed\",\"message\":\"Dry run failed: MoveAbort(MoveLocation { module: 0x2::balance, function_name: Some(\\\"split\\\") }, 2)\"}]}",
            "move abort during balance split",
        ] {
            assert!(
                !WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected transient for: {}",
                msg
            );
        }
    }

    #[test]
    fn classify_walrus_version_mismatch_as_transient() {
        // The sidecar refreshes the cached @mysten/walrus client on EWrongVersion;
        // Apalis must retry against the refreshed client instead of marking Dead.
        for msg in [
            // JSON-RPC production format (common): only "abort code: 1", no symbolic name
            "walrus upload failed: MoveAbort in 1st command, abort code: 1, in '0xc1b6::system::inner_mut' (instruction 0)",
            // gRPC/GraphQL: symbolic EWrongVersion
            "walrus upload failed: MoveAbort in 1st command, 'EWrongVersion': 1, in '0xc1b6::system::inner_mut' (line 42)",
            // Defensive: lowercase + only symbolic name
            "moveabort ewrongversion",
        ] {
            assert!(
                !WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected transient for: {}",
                msg
            );
        }
    }

    #[test]
    fn classify_non_walrus_moveabort_stays_permanent() {
        // The walrus-specific carve-out must NOT widen — other modules' MoveAborts
        // still classify Permanent (the existing contract for non-retryable errors).
        for msg in [
            // generic move abort with no walrus-specific anchors
            "MoveAbort in 1st command, abort code: 5, in '0x2::coin::join' (instruction 0)",
            "MoveAbort(MoveLocation { module: 0x3::foo }, 1)",
        ] {
            assert!(
                WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected permanent for: {}",
                msg
            );
        }
    }

    #[test]
    fn walrus_version_mismatch_detector_pattern() {
        // Mirrors the sidecar's isWalrusPackageVersionMismatch; keep both in sync.
        assert!(is_walrus_package_version_mismatch(
            "MoveAbort in 1st command, abort code: 1, in '0xc1b6::system::inner_mut'"
        ));
        assert!(is_walrus_package_version_mismatch(
            "MoveAbort 'EWrongVersion': 1"
        ));
        // Lowercase / case-insensitive matching
        assert!(is_walrus_package_version_mismatch(
            "moveabort ewrongversion"
        ));
        // Anchors required — bare tokens alone don't match
        assert!(!is_walrus_package_version_mismatch("EWrongVersion"));
        assert!(!is_walrus_package_version_mismatch(
            "::system::inner_mut without context"
        ));
        // Balance-split MoveAbort (the existing handler's domain) does not match
        assert!(!is_walrus_package_version_mismatch(
            "MoveAbort(MoveLocation { module: 0x2::balance, function_name: Some(\"split\") }, 2)"
        ));
        assert!(!is_walrus_package_version_mismatch(""));
    }

    #[test]
    fn classify_network_errors_as_transient() {
        for msg in [
            "sidecar timeout",
            "503 service unavailable",
            "ECONNRESET",
            "insufficient gas",
            "Enoki API error (400): {\"errors\":[{\"code\":\"expired\",\"message\":\"Sponsored transaction has expired\"}]}",
        ] {
            assert!(
                !WalletJobError::classify_sidecar_error(msg).is_permanent(),
                "expected transient for: {}",
                msg
            );
        }
    }

    #[test]
    fn display_includes_classification_tag() {
        let perm = WalletJobError::Permanent("locked".to_string());
        let trans = WalletJobError::Transient("network".to_string());
        assert!(perm.to_string().contains("permanent"));
        assert!(trans.to_string().contains("transient"));
    }

    #[test]
    fn permanent_errors_abort_apalis_retries() {
        let error = WalletJobError::Permanent("move abort".to_string()).into_apalis_error();
        assert!(matches!(error, apalis::prelude::Error::Abort(_)));
    }

    #[test]
    fn transient_errors_remain_retryable() {
        let error = WalletJobError::Transient("timeout".to_string()).into_apalis_error();
        assert!(matches!(error, apalis::prelude::Error::Failed(_)));
    }

    #[test]
    fn alert_gate_only_opens_on_final_transient_attempt() {
        let transient = WalletJobError::Transient("timeout".to_string());
        assert!(!WalletJobAttemptInfo { current: 4, max: 5 }.exhausted_by(&transient));
        assert!(WalletJobAttemptInfo { current: 5, max: 5 }.exhausted_by(&transient));
    }

    #[test]
    fn alert_gate_stays_closed_for_permanent_errors() {
        let permanent = WalletJobError::Permanent("move abort".to_string());
        assert!(!WalletJobAttemptInfo { current: 5, max: 5 }.exhausted_by(&permanent));
    }

    #[test]
    fn wallet_job_request_sets_explicit_max_attempts() {
        let req = wallet_job_request(WalletJob {
            wallet_index: 0,
            operation: WalletOperation::FinalizeUploadedBlob {
                owner: "0xowner".to_string(),
                namespace: "default".to_string(),
                remember_job_id: None,
                blob_id: "blob".to_string(),
                vector: vec![],
                blob_size_bytes: 0,
                importance: crate::services::extractor::IMPORTANCE_STANDARD,
            },
        });

        assert_eq!(req.parts.context.max_attempts(), MAX_ATTEMPTS as i32);
    }

    #[tokio::test]
    async fn recovery_enqueue_failure_marks_remember_job_failed() {
        let pool = test_pool().await;
        let job_id = format!("remember-job-{}", uuid::Uuid::new_v4());
        let msg = "failed to enqueue metadata/transfer recovery job: synthetic queue down";

        sqlx::query(
            "INSERT INTO remember_jobs (id, owner, namespace, status) VALUES ($1, $2, $3, 'uploaded')",
        )
        .bind(&job_id)
        .bind("0xtest-owner")
        .bind("test-ns")
        .execute(&pool)
        .await
        .unwrap();

        let classified =
            classify_wallet_remember_handoff_failure(&pool, Some(&job_id), msg.to_string()).await;

        match classified {
            WalletJobError::Permanent(ref got) => assert_eq!(got, msg),
            other => panic!("expected permanent handoff error, got {other}"),
        }

        let row: (String, Option<String>) =
            sqlx::query_as("SELECT status, error_msg FROM remember_jobs WHERE id = $1")
                .bind(&job_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(row.0, "failed");
        assert_eq!(row.1.as_deref(), Some(msg));

        let _ = sqlx::query("DELETE FROM remember_jobs WHERE id = $1")
            .bind(&job_id)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn terminal_recovery_handoff_failure_overrides_transient_looking_queue_error() {
        let pool = test_pool().await;
        let job_id = format!("remember-job-{}", uuid::Uuid::new_v4());
        let msg = "failed to enqueue metadata/transfer recovery job: 503 service unavailable";

        sqlx::query(
            "INSERT INTO remember_jobs (id, owner, namespace, status) VALUES ($1, $2, $3, 'uploaded')",
        )
        .bind(&job_id)
        .bind("0xtest-owner")
        .bind("test-ns")
        .execute(&pool)
        .await
        .unwrap();

        let classified =
            classify_wallet_remember_handoff_failure(&pool, Some(&job_id), msg.to_string()).await;

        match classified {
            WalletJobError::Permanent(ref got) => assert_eq!(got, msg),
            other => panic!("expected permanent handoff error, got {other}"),
        }

        let row: (String, Option<String>) =
            sqlx::query_as("SELECT status, error_msg FROM remember_jobs WHERE id = $1")
                .bind(&job_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(row.0, "failed");
        assert_eq!(row.1.as_deref(), Some(msg));

        let _ = sqlx::query("DELETE FROM remember_jobs WHERE id = $1")
            .bind(&job_id)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn failed_status_persistence_keeps_wallet_handoff_retryable() {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&test_database_url())
            .await
            .unwrap();
        pool.close().await;

        let msg = "failed to enqueue uploaded-blob finalization job: synthetic queue down";
        let classified =
            classify_wallet_remember_handoff_failure(&pool, Some("job-closed-pool"), msg.into())
                .await;

        match classified {
            WalletJobError::Transient(got) => {
                assert!(got.contains(msg));
                assert!(got.contains("failed to persist remember_jobs failed status"));
            }
            other => panic!("expected transient handoff error, got {other}"),
        }
    }

    #[tokio::test]
    async fn mark_remember_job_failed_returns_real_update_error() {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&test_database_url())
            .await
            .unwrap();
        pool.close().await;

        let err = mark_remember_job_failed(&pool, Some("job-closed-pool"), "synthetic")
            .await
            .expect_err("closed pool should fail");

        assert!(err.to_string().contains("closed"));
    }

    #[tokio::test]
    async fn missing_remember_job_keeps_handoff_retryable() {
        let pool = test_pool().await;
        let job_id = format!("missing-remember-job-{}", uuid::Uuid::new_v4());
        let msg = "failed to enqueue metadata/transfer recovery job: synthetic queue down";

        let classified =
            classify_wallet_remember_handoff_failure(&pool, Some(&job_id), msg.to_string()).await;

        match classified {
            WalletJobError::Transient(got) => {
                assert!(got.contains(msg));
                assert!(got.contains("failed to persist remember_jobs failed status"));
                assert!(got.contains("no rows returned"));
            }
            other => panic!("expected transient handoff error, got {other}"),
        }
    }
}
