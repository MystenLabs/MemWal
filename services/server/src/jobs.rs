/// Wallet signing job queue.
///
/// Every operation that requires a Sui wallet signature is modelled as a
/// `WalletJob` jobs are signed by the configured server wallet.
/// This guarantees that:
///   - upload → metadata+transfer use the same key for a given job
///   - signing operations can run concurrently on the same wallet
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

use crate::types::{AppState, BLOB_CACHE_KEY_PREFIX};
use crate::walrus::SetMetadataBatchEntry;

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
        /// MemWal owner address.
        owner: String,
        /// Namespace for isolation.
        namespace: String,
        /// MemWal package ID.
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
        /// Sui address of the MemWal user.
        owner: String,
        /// MemWal namespace.
        namespace: String,
        /// MemWal package ID.
        package_id: Option<String>,
        /// Agent / delegate public key.
        agent_id: Option<String>,
    },
}

fn default_epochs() -> u32 {
    50
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

/// A wallet job. `wallet_index` is retained for legacy/audit payloads; new
/// jobs use `0` and all routing goes through the single shared wallet queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletJob {
    /// Index into `config.sui_private_keys` used by the sidecar for signing.
    /// New jobs use 0 after the single-wallet simplification.
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
    /// Sui address of the MemWal user who should own the blob.
    pub owner: String,
    /// MemWal namespace (e.g. "default").
    pub namespace: String,
    /// MemWal package ID (optional — stored as on-chain attribute).
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
// Retry policy (Tower middleware)
// ============================================================

/// Maximum number of attempts (1 initial + N-1 retries).
#[allow(dead_code)]
pub const MAX_ATTEMPTS: u32 = 3;

/// Exponential back-off: attempt 1→2s, 2→4s, 3→8s.
#[allow(dead_code)]
pub fn backoff_duration(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2u64.pow(attempt))
}

// ============================================================
// execute_wallet_job — dispatcher for WalletJob
// ============================================================

/// Apalis worker handler for WalletJob.
///
/// Multiple concurrent invocations of this handler share the single signing
/// wallet (Apalis `WALLET_JOB_CONCURRENCY` controls fan-out, default 8). The
/// `wallet_index` field in the job payload is retained for audit only —
/// routing dimension was removed per MEM-35.
pub async fn execute_wallet_job(job: WalletJob, ctx: Data<Arc<AppState>>) -> Result<(), Error> {
    let state: &AppState = &ctx;
    let wallet_index = job.wallet_index;

    let result = match job.operation {
        WalletOperation::UploadAndTransfer {
            encrypted_b64,
            vector,
            owner,
            namespace,
            package_id,
            agent_public_key,
            remember_job_id,
            epochs,
        } => {
            execute_upload_and_transfer(
                state,
                wallet_index,
                encrypted_b64,
                vector,
                owner,
                namespace,
                package_id,
                agent_public_key,
                remember_job_id,
                epochs,
            )
            .await
        }
        WalletOperation::SetMetadataAndTransfer {
            blob_object_id,
            owner,
            namespace,
            package_id,
            agent_id,
        } => {
            execute_set_metadata_and_transfer(
                state,
                wallet_index,
                blob_object_id,
                owner,
                namespace,
                package_id,
                agent_id,
            )
            .await
        }
    };

    result.map_err(|err| {
        if let WalletJobError::Permanent(ref msg) = err {
            tracing::warn!(
                target: "wallet_job.permanent",
                "permanent failure for wallet_index={} (will mark Dead): {}",
                wallet_index,
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
    crate::walrus::set_metadata_batch(
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

// ────────────────────────────────────────────────────────────
// WalletOperation::UploadAndTransfer
// ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn execute_upload_and_transfer(
    state: &AppState,
    wallet_index: usize,
    encrypted_b64: String,
    vector: Vec<f32>,
    owner: String,
    namespace: String,
    package_id: String,
    agent_public_key: Option<String>,
    remember_job_id: Option<String>,
    epochs: u32,
) -> Result<(), WalletJobError> {
    // ── Mark running ───────────────────────────────────────────
    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'running', updated_at = NOW() WHERE id = $1",
        )
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    // Helper: mark failed and return Err. Classifies sidecar errors so Apalis
    // retries transient wallet/RPC conflicts and aborts deterministic failures.
    let fail = |msg: String| -> WalletJobError {
        tracing::error!("[wallet-job:upload] {}", msg);
        WalletJobError::classify_sidecar_error(&msg)
    };

    // ── Decode encrypted bytes ─────────────────────────────────
    let encrypted = match base64::engine::general_purpose::STANDARD.decode(&encrypted_b64) {
        Ok(b) => b,
        Err(e) => {
            let msg = format!("base64 decode failed: {}", e);
            if let Some(ref jid) = remember_job_id {
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                )
                .bind(&msg)
                .bind(jid)
                .execute(state.db.pool())
                .await;
            }
            return Err(fail(msg));
        }
    };

    tracing::info!(
        "[wallet-job:upload] owner={} ns={} key={} bytes={}",
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
        encrypted.len(),
    );

    // ── Upload to Walrus via sidecar (using pinned wallet_index) ─
    let upload_result = crate::walrus::upload_blob(
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
        Err(e) => {
            let msg = format!("walrus upload failed: {}", e);
            if let Some(ref jid) = remember_job_id {
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                )
                .bind(&msg)
                .bind(jid)
                .execute(state.db.pool())
                .await;
            }
            return Err(fail(msg));
        }
    };
    let blob_id = upload.blob_id.clone();

    warm_blob_cache_after_upload(state, &blob_id, &encrypted).await;

    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(&blob_id)
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    // ── Insert vector after upload ─────────────────────────────────
    //
    // The sidecar's `/walrus/upload` endpoint already performs metadata+transfer
    // atomically. A successful upload response means the blob is ready to index.
    let blob_size = encrypted.len() as i64;
    let vector_id = remember_job_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Err(e) = state
        .db
        .insert_vector(&vector_id, &owner, &namespace, &blob_id, &vector, blob_size)
        .await
    {
        let msg = format!("insert_vector failed: {}", e);
        if let Some(ref jid) = remember_job_id {
            let _ = sqlx::query(
                "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
            )
            .bind(&msg)
            .bind(jid)
            .execute(state.db.pool())
            .await;
        }
        return Err(fail(msg));
    }

    // ── Mark final status ──────────────────────────────────────
    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'done', blob_id = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(&blob_id)
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    tracing::info!(
        "[wallet-job:upload] done blob_id={} owner={} ns={} key={}",
        blob_id,
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
    );
    Ok(())
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
/// - `MoveAbort(_)` → `Permanent` (deterministic Move-level failure)
/// - `ObjectLockedAtVersion(_)` → `Transient` (the single-wallet model relies
///   on retrying any remaining concurrency/race failures)
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
    /// True if the error is `Permanent` — caller should NOT retry.
    pub fn is_permanent(&self) -> bool {
        matches!(self, WalletJobError::Permanent(_))
    }

    /// Heuristic classification from the sidecar's error string. The sidecar
    /// surfaces Sui execution errors verbatim (Move abort codes, lock errors).
    /// Until the sidecar emits structured error codes, we match on substrings.
    pub fn classify_sidecar_error(msg: &str) -> Self {
        let lower = msg.to_ascii_lowercase();
        if lower.contains("objectlocked")
            || lower.contains("object_locked")
            || lower.contains("object is locked")
            || lower.contains("locked at version")
        {
            return WalletJobError::Transient(msg.to_string());
        }
        if lower.contains("moveabort") || lower.contains("move abort") {
            return WalletJobError::Permanent(msg.to_string());
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
    /// MemWal owner address (from auth middleware).
    pub owner: String,
    /// Namespace for isolation.
    pub namespace: String,
    /// MemWal package ID (needed by metadata tx).
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
        "UPDATE remember_jobs SET status = 'running', updated_at = NOW() WHERE id = $1",
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
    let upload_result = crate::walrus::upload_blob(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        &encrypted,
        50,
        &job.owner,
        key_index,
        &job.namespace,
        &job.package_id,
        job.agent_public_key.as_deref(),
    )
    .await;

    let upload = match upload_result {
        Ok(u) => u,
        Err(e) => fail!(format!("walrus upload failed: {}", e)),
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
        )
        .await
    {
        fail!(format!("insert_vector failed: {}", e));
    }

    // ── Step 5: mark done ────────────────────────────────────────
    let _ = sqlx::query(
        "UPDATE remember_jobs SET status = 'done', blob_id = $1, updated_at = NOW() WHERE id = $2",
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
    /// Wallet index assigned at enqueue time. New jobs use 0.
    pub wallet_index: usize,
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
            .push(WalletJob {
                wallet_index,
                operation: WalletOperation::UploadAndTransfer {
                    encrypted_b64: item.encrypted_b64,
                    vector: item.vector,
                    owner: job.owner.clone(),
                    namespace,
                    package_id: job.package_id.clone(),
                    agent_public_key: job.agent_public_key.clone(),
                    remember_job_id: Some(job_id.clone()),
                    epochs: job.epochs,
                },
            })
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
    use super::WalletJobError;

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
    fn classify_network_errors_as_transient() {
        for msg in [
            "sidecar timeout",
            "503 service unavailable",
            "ECONNRESET",
            "insufficient gas",
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
}
