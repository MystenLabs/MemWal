/// Per-wallet Apalis job queue.
///
/// Every operation that requires a Sui wallet signature is modelled as a
/// `WalletJob` and routed to the queue that is **pinned to that wallet index**.
/// This guarantees that:
///   - upload → metadata+transfer always use the SAME key (no wrong-signer retries)
///   - each wallet queue processes jobs serially (no coin-object lock conflicts)
///   - jobs survive server restarts (persisted in Postgres via Apalis)
///
/// Retry policy: up to MAX_ATTEMPTS attempts with exponential back-off.
/// Failed jobs are visible in the `apalis_jobs` table (status = 'Dead').
use std::collections::HashMap;
use std::sync::Arc;

use apalis::prelude::*;
use apalis_sql::postgres::PostgresStorage;
use base64::Engine as _;
use futures::stream::{self, StreamExt as _};

use serde::{Deserialize, Serialize};

use crate::types::{AppState, BULK_UPLOAD_CONCURRENCY};

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
    /// Set on-chain metadata attributes + transfer a blob that was ALREADY
    /// uploaded (used by remember_manual and analyze routes which upload
    /// synchronously and only need the background metadata+transfer step).
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

fn default_epochs() -> u32 { 50 }

/// A wallet-pinned job. `wallet_index` determines which per-wallet worker
/// picks up and executes this job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletJob {
    /// Index into `config.sui_private_keys` — both for routing (queue name)
    /// and for signing within the worker. Set once at enqueue time and never
    /// changed, so upload and transfer always use the identical key.
    pub wallet_index: usize,
    pub operation: WalletOperation,
}

/// Convenience type alias
pub type WalletJobStorage = PostgresStorage<WalletJob>;

// ============================================================
// Legacy MetaTransferJob — kept for backward-compat with existing
// DB rows. New code should enqueue WalletJob::SetMetadataAndTransfer.
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
    Http { status: u16, body: String },
}

impl std::fmt::Display for MetaTransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MetaTransferError::SidecarError(msg) => write!(f, "sidecar call failed: {}", msg),
            MetaTransferError::Http { status, body } => {
                write!(f, "http error ({}): {}", status, body)
            }
        }
    }
}

impl std::error::Error for MetaTransferError {}

// ============================================================
// Sidecar request/response types
// ============================================================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetMetadataRequest<'a> {
    blob_object_id: &'a str,
    owner: &'a str,
    namespace: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<&'a str>,
    key_index: usize,
}

// ============================================================
// Job handler
// ============================================================

/// Apalis calls this function for each `MetaTransferJob`.
///
/// It POSTs to the sidecar `POST /walrus/set-metadata` endpoint which
/// builds and executes a Sui transaction that:
///   1. Sets `memwal_namespace`, `memwal_owner`, `memwal_package_id`,
///      and `memwal_agent_id` on-chain attributes on the Blob object.
///   2. Transfers the Blob object to the user's wallet.
///
/// Returns `Err(MetaTransferError)` to trigger the Tower retry policy.
pub async fn execute_meta_transfer(
    job: MetaTransferJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), MetaTransferError> {
    // Data<T> implements Deref<Target=T>, so &*ctx gives &Arc<AppState>
    let state: &AppState = &**ctx;
    let url = format!("{}/walrus/set-metadata", state.config.sidecar_url);

    // Use the key_index stored in the job — this is the same key that
    // registered/certified the blob, so the signer address will match
    // the blob's current owner. No round-robin selection here.
    let key_index = job.key_index;

    tracing::info!(
        "[meta-transfer] blob={} owner={} ns={} key={}",
        job.blob_object_id,
        &job.owner[..10.min(job.owner.len())],
        job.namespace,
        key_index,
    );

    let mut req = state.http_client.post(&url).json(&SetMetadataRequest {
        blob_object_id: &job.blob_object_id,
        owner: &job.owner,
        namespace: &job.namespace,
        package_id: job.package_id.as_deref(),
        agent_id: job.agent_id.as_deref(),
        key_index,
    });

    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        req = req.header("authorization", format!("Bearer {}", secret));
    }

    let resp = req.send().await.map_err(|e| {
        MetaTransferError::SidecarError(format!("request failed: {}", e))
    })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!(
            "[meta-transfer] sidecar returned {}: {}",
            status,
            &body[..200.min(body.len())]
        );
        return Err(MetaTransferError::Http { status, body });
    }

    tracing::info!(
        "[meta-transfer] ok: blob={} transferred to owner",
        job.blob_object_id
    );
    Ok(())
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

/// Type alias for the Apalis Postgres storage used throughout the codebase.
pub type JobStorage = PostgresStorage<MetaTransferJob>;

// ============================================================
// execute_wallet_job — dispatcher for WalletJob
// ============================================================

/// Apalis worker handler for WalletJob.
///
/// The worker is pinned to a specific `wallet_index` via `Data<(Arc<AppState>, usize)>`.
/// Every operation inside uses that fixed index — never round-robin.
pub async fn execute_wallet_job(
    job: WalletJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), WalletJobError> {
    let state: &AppState = &**ctx;
    // The wallet_index stored in the job is authoritative.
    // The worker queue name is just for routing; actual signing uses job.wallet_index.
    let wallet_index = job.wallet_index;

    match job.operation {
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
            ).await
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
            ).await
        }
    }
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
    let url = format!("{}/walrus/set-metadata", state.config.sidecar_url);

    tracing::info!(
        "[wallet-job:set-meta] blob={} owner={} ns={} key={}",
        blob_object_id,
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
    );

    // Retry transient network failures (sidecar overload / connection drop /
    // Enoki sponsor flake). Each attempt re-builds the request because reqwest
    // RequestBuilder is not Clone-able once a body is attached.
    const MAX_ATTEMPTS: u32 = 4;
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;

        let mut req = state.http_client.post(&url).json(&SetMetadataRequest {
            blob_object_id: &blob_object_id,
            owner: &owner,
            namespace: &namespace,
            package_id: package_id.as_deref(),
            agent_id: agent_id.as_deref(),
            key_index: wallet_index,
        });

        if let Some(secret) = state.config.sidecar_secret.as_deref() {
            req = req.header("authorization", format!("Bearer {}", secret));
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!(
                    "[wallet-job:set-meta] ok: blob={} transferred to owner (attempt {})",
                    blob_object_id, attempt
                );
                return Ok(());
            }
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                let snippet = &body[..200.min(body.len())];
                // Retry on 5xx and 408/429; fail fast on other 4xx (bad input).
                let retriable = status >= 500 || status == 408 || status == 429;
                tracing::warn!(
                    "[wallet-job:set-meta] sidecar returned {} (attempt {}/{}, retriable={}): {}",
                    status, attempt, MAX_ATTEMPTS, retriable, snippet
                );
                if !retriable || attempt >= MAX_ATTEMPTS {
                    return Err(WalletJobError::Internal(format!(
                        "set-metadata failed ({}): {}",
                        status, snippet
                    )));
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[wallet-job:set-meta] network error (attempt {}/{}): {}",
                    attempt, MAX_ATTEMPTS, e
                );
                if attempt >= MAX_ATTEMPTS {
                    return Err(WalletJobError::Internal(format!(
                        "set-metadata request failed after {} attempts: {}",
                        MAX_ATTEMPTS, e
                    )));
                }
            }
        }

        // Exponential backoff: 500ms, 1s, 2s
        let backoff_ms = 500u64 * (1u64 << (attempt - 1));
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        tracing::info!(
            "[wallet-job:set-meta] retry {} after {}ms",
            attempt + 1,
            backoff_ms,
        );
    }
}

// ────────────────────────────────────────────────────────────
// WalletOperation::UploadAndTransfer
// ────────────────────────────────────────────────────────────

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

    // Helper: mark failed and return Err
    let fail = |msg: String| -> WalletJobError {
        tracing::error!("[wallet-job:upload] {}", msg);
        WalletJobError::Internal(msg)
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

    // ── Insert vector ──────────────────────────────────────────
    let blob_size = encrypted.len() as i64;
    let vector_id = uuid::Uuid::new_v4().to_string();
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

    // ── Set metadata + transfer via sidecar (SAME wallet_index!) ─
    // Mark `uploaded` first so polling clients see progress; only flip to
    // `done` after the on-chain transfer to user wallet succeeds. If transfer
    // permanently fails we set `failed` with a diagnostic so the user knows
    // the blob is indexed but not under their ownership yet.
    if let Some(ref jid) = remember_job_id {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, updated_at = NOW() WHERE id = $2",
        )
        .bind(&blob_id)
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    let mut transfer_status: Result<(), String> = Ok(());
    if !upload.object_id.as_deref().unwrap_or("").is_empty() {
        let blob_object_id = upload.object_id.clone().unwrap_or_default();
        if let Err(e) = execute_set_metadata_and_transfer(
            state,
            wallet_index,
            blob_object_id,
            owner.clone(),
            namespace.clone(),
            Some(package_id.clone()),
            agent_public_key.clone(),
        ).await {
            tracing::warn!(
                "[wallet-job:upload] set-metadata failed (transfer pending): {} blob_id={}",
                e, blob_id
            );
            transfer_status = Err(format!("metadata+transfer failed: {}", e));
        }
    }

    // ── Mark final status ──────────────────────────────────────
    if let Some(ref jid) = remember_job_id {
        match &transfer_status {
            Ok(()) => {
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'done', blob_id = $1, updated_at = NOW() WHERE id = $2",
                )
                .bind(&blob_id)
                .bind(jid)
                .execute(state.db.pool())
                .await;
            }
            Err(err_msg) => {
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                )
                .bind(err_msg)
                .bind(jid)
                .execute(state.db.pool())
                .await;
            }
        }
    }

    tracing::info!(
        "[wallet-job:upload] done blob_id={} owner={} ns={} key={} transfer_ok={}",
        blob_id,
        &owner[..10.min(owner.len())],
        namespace,
        wallet_index,
        transfer_status.is_ok(),
    );
    // We deliberately do NOT propagate transfer failure as Err — that would
    // trigger Apalis retry of the entire upload (wasting Walrus storage).
    // The status is recorded in remember_jobs for the client.
    Ok(())
}

// ============================================================
// WalletJobError
// ============================================================

#[derive(Debug)]
pub enum WalletJobError {
    Internal(String),
}

impl std::fmt::Display for WalletJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WalletJobError::Internal(msg) => write!(f, "wallet job error: {}", msg),
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
/// The Apalis worker executes embed → encrypt → upload → insert_vector → MetaTransferJob.
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
    /// Delegate public key (agent_id for MetaTransferJob).
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
///   5. push(MetaTransferJob)
///   6. Mark job `done` with blob_id
///
/// On any error: mark job `failed` with error_msg, then return Err to
/// prevent Apalis from re-enqueueing (we handle status ourselves).
pub async fn execute_remember(
    job: RememberJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), RememberJobError> {
    let state: &AppState = &**ctx;

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

    // ── Step 4: insert_vector ────────────────────────────────────
    let blob_size = encrypted.len() as i64;
    let vector_id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = state
        .db
        .insert_vector(&vector_id, &job.owner, &job.namespace, &blob_id, &job.vector, blob_size)
        .await
    {
        fail!(format!("insert_vector failed: {}", e));
    }

    // ── Step 5: enqueue MetaTransferJob (with correct key_index) ─────────
    if !upload.object_id.as_deref().unwrap_or("").is_empty() {
        let mut meta_storage = state.job_storage.clone();
        if let Err(e) = meta_storage.push(MetaTransferJob {
            blob_object_id: upload.object_id.clone().unwrap_or_default(),
            owner: job.owner.clone(),
            namespace: job.namespace.clone(),
            package_id: Some(job.package_id.clone()),
            agent_id: job.agent_public_key.clone(),
            // Pass the SAME key_index used for upload — the blob is owned
            // by this key's address, so set-metadata must also sign with it.
            key_index,
        }).await {
            // Non-fatal — blob is already indexed; log and continue.
            tracing::warn!("[remember-job] failed to enqueue meta-transfer: {} job_id={}", e, job.job_id);
        }
    }

    // ── Step 6: mark uploaded ────────────────────────────────────
    // Note: legacy `RememberJob` enqueues a separate `MetaTransferJob` for the
    // transfer step, so we cannot mark `done` here — the transfer hasn't
    // happened yet. The (legacy) `MetaTransferJob` worker does NOT update this
    // row (it predates the status table); for callers using this legacy path,
    // a successful upload visible to the client is `status=uploaded` with
    // a non-null `blob_id`. New code should use `WalletJob::UploadAndTransfer`
    // which atomically transitions to `done` after transfer.
    let _ = sqlx::query(
        "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, updated_at = NOW() WHERE id = $2",
    )
    .bind(&blob_id)
    .bind(&job.job_id)
    .execute(state.db.pool())
    .await;

    tracing::info!(
        "[remember-job] uploaded job_id={} blob_id={} owner={} ns={} (transfer enqueued separately)",
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
// Batches N memories into:
//   - N×2 Sui txs (register + certify per blob, unavoidable)
//   - K Sui txs for set-metadata+transfer, where K = number of wallet slots used
//     (one PTB per wallet-slot via /walrus/set-metadata-batch on sidecar)
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
    /// Wallet pool index assigned at enqueue time (round-robin).
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
// Sidecar request types for POST /walrus/set-metadata-batch
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetMetadataBatchEntry<'a> {
    blob_object_id: &'a str,
    namespace: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetMetadataBatchRequest<'a> {
    blobs: Vec<SetMetadataBatchEntry<'a>>,
    owner: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<&'a str>,
    key_index: usize,
}

// ─────────────────────────────────────────────────────────────
// execute_bulk_remember — Apalis handler
// ─────────────────────────────────────────────────────────────

/// Apalis worker handler for BulkRememberJob (ENG-1408).
///
/// Steps:
///   1. Mark all items `running`
///   2. Upload N blobs to Walrus concurrently (bounded by BULK_UPLOAD_CONCURRENCY)
///      + insert_vector for each successful upload
///   3. Mark each item `done` with blob_id immediately after upload success
///   4. Group blobs with objectId by wallet_index
///   5. For each group → POST /walrus/set-metadata-batch (1 PTB per wallet slot)
///      Falls back to per-blob /walrus/set-metadata if batch endpoint unavailable.
pub async fn execute_bulk_remember(
    job: BulkRememberJob,
    ctx: Data<Arc<AppState>>,
) -> Result<(), BulkRememberError> {
    let state: &AppState = &**ctx;

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

    // ── Step 1: mark all items running ────────────────────────────────────
    for item in &job.items {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'running', updated_at = NOW() WHERE id = $1",
        )
        .bind(&item.job_id)
        .execute(state.db.pool())
        .await;
    }

    // ── Step 2: upload N blobs + insert_vector concurrently ───────────────
    struct UploadOk {
        job_id: String,
        #[allow(dead_code)]
        blob_id: String,
        object_id: Option<String>,
        wallet_index: usize,
        namespace: String,
    }

    let db = &state.db;
    let http = &state.http_client;
    let sidecar_url = state.config.sidecar_url.clone();
    let sidecar_secret = state.config.sidecar_secret.clone();
    let owner = job.owner.clone();
    let package_id = job.package_id.clone();
    let agent = job.agent_public_key.clone();
    let epochs = job.epochs as u64;

    let upload_results: Vec<Result<UploadOk, ()>> = stream::iter(job.items.into_iter())
        .map(|item| {
            let sidecar_url = sidecar_url.clone();
            let sidecar_secret = sidecar_secret.clone();
            let owner = owner.clone();
            let package_id = package_id.clone();
            let agent = agent.clone();
            async move {
                let encrypted = match base64::engine::general_purpose::STANDARD.decode(&item.encrypted_b64) {
                    Ok(b) => b,
                    Err(e) => {
                        let msg = format!("base64 decode failed: {}", e);
                        tracing::error!("[bulk-remember] job_id={} {}", item.job_id, msg);
                        let _ = sqlx::query(
                            "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                        )
                        .bind(&msg).bind(&item.job_id).execute(db.pool()).await;
                        return Err(());
                    }
                };

                let upload = match crate::walrus::upload_blob(
                    http,
                    &sidecar_url,
                    sidecar_secret.as_deref(),
                    &encrypted,
                    epochs,
                    &owner,
                    item.wallet_index,
                    &item.namespace,
                    &package_id,
                    agent.as_deref(),
                ).await {
                    Ok(u) => u,
                    Err(e) => {
                        let msg = format!("walrus upload failed: {}", e);
                        tracing::error!("[bulk-remember] job_id={} {}", item.job_id, msg);
                        let _ = sqlx::query(
                            "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                        )
                        .bind(&msg).bind(&item.job_id).execute(db.pool()).await;
                        return Err(());
                    }
                };
                let blob_id = upload.blob_id.clone();

                let blob_size = encrypted.len() as i64;
                let vector_id = uuid::Uuid::new_v4().to_string();
                if let Err(e) = db.insert_vector(&vector_id, &owner, &item.namespace, &blob_id, &item.vector, blob_size).await {
                    let msg = format!("insert_vector failed: {}", e);
                    tracing::error!("[bulk-remember] job_id={} {}", item.job_id, msg);
                    let _ = sqlx::query(
                        "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
                    )
                    .bind(&msg).bind(&item.job_id).execute(db.pool()).await;
                    return Err(());
                }

                // Mark uploaded — vector indexed. `done` will be set only after
                // metadata+transfer succeeds in Step 4 (or `failed` on permanent error).
                let _ = sqlx::query(
                    "UPDATE remember_jobs SET status = 'uploaded', blob_id = $1, updated_at = NOW() WHERE id = $2",
                )
                .bind(&blob_id).bind(&item.job_id).execute(db.pool()).await;

                Ok(UploadOk {
                    job_id: item.job_id.clone(),
                    blob_id,
                    object_id: upload.object_id,
                    wallet_index: item.wallet_index,
                    namespace: item.namespace.clone(),
                })
            }
        })
        .buffer_unordered(BULK_UPLOAD_CONCURRENCY)
        .collect()
        .await;

    // ── Step 3: group successful blobs by wallet_index ────────────────────
    // Each entry: (object_id, namespace, job_id) so we can mark status after transfer.
    let mut groups: HashMap<usize, Vec<(String, String, String)>> = HashMap::new();
    // Jobs that uploaded but had no object_id (shouldn't happen, but if so we
    // can't transfer — mark them `done` pragmatically since vector is indexed).
    let mut no_object_ids: Vec<String> = Vec::new();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;

    for r in upload_results {
        match r {
            Ok(ok) => {
                success_count += 1;
                match ok.object_id {
                    Some(obj_id) if !obj_id.is_empty() => {
                        groups.entry(ok.wallet_index).or_default().push((obj_id, ok.namespace, ok.job_id));
                    }
                    _ => {
                        // No object id — vector is indexed but we can't transfer.
                        // Treat as done since the blob is already on Walrus.
                        no_object_ids.push(ok.job_id);
                    }
                }
            }
            Err(()) => fail_count += 1,
        }
    }

    // Mark the no-object-id jobs as done (vector indexed, transfer skipped).
    for jid in &no_object_ids {
        let _ = sqlx::query(
            "UPDATE remember_jobs SET status = 'done', updated_at = NOW() WHERE id = $1",
        )
        .bind(jid)
        .execute(state.db.pool())
        .await;
    }

    tracing::info!(
        "[bulk-remember] uploads done: ok={} fail={} wallet_groups={}",
        success_count, fail_count, groups.len(),
    );

    // ── Step 4: batch set-metadata + transfer per wallet group ────────────
    //
    // For each wallet slot we try ONE batched PTB; if that fails we fall back
    // to per-blob set-metadata calls. Only after a blob's transfer definitively
    // succeeds do we mark its remember_jobs row `done`. Permanent failures
    // transition the row from `uploaded → failed` with a diagnostic error.
    let mark_done = |jid: &str| {
        let pool = state.db.pool().clone();
        let jid = jid.to_string();
        async move {
            let _ = sqlx::query(
                "UPDATE remember_jobs SET status = 'done', updated_at = NOW() WHERE id = $1",
            )
            .bind(&jid)
            .execute(&pool)
            .await;
        }
    };
    let mark_transfer_failed = |jid: &str, err: &str| {
        let pool = state.db.pool().clone();
        let jid = jid.to_string();
        let err = err.to_string();
        async move {
            let _ = sqlx::query(
                "UPDATE remember_jobs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2",
            )
            .bind(&err)
            .bind(&jid)
            .execute(&pool)
            .await;
        }
    };

    for (wallet_index, blobs) in &groups {
        if blobs.is_empty() { continue; }

        let url = format!("{}/walrus/set-metadata-batch", state.config.sidecar_url);
        let blob_entries: Vec<SetMetadataBatchEntry<'_>> = blobs
            .iter()
            .map(|(obj_id, ns, _jid)| SetMetadataBatchEntry {
                blob_object_id: obj_id.as_str(),
                namespace: ns.as_str(),
            })
            .collect();

        let mut req = state.http_client.post(&url).json(&SetMetadataBatchRequest {
            blobs: blob_entries,
            owner: &job.owner,
            package_id: Some(job.package_id.as_str()),
            agent_id: job.agent_public_key.as_deref(),
            key_index: *wallet_index,
        });
        if let Some(secret) = state.config.sidecar_secret.as_deref() {
            req = req.header("authorization", format!("Bearer {}", secret));
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!(
                    "[bulk-remember] set-metadata-batch ok: {} blobs wallet={}",
                    blobs.len(), wallet_index,
                );
                for (_obj, _ns, jid) in blobs {
                    mark_done(jid).await;
                }
            }
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                tracing::warn!(
                    "[bulk-remember] set-metadata-batch ({}) failed: {} wallet={} — falling back per-blob",
                    status, &body[..200.min(body.len())], wallet_index,
                );
                for (obj_id, ns, jid) in blobs {
                    match execute_set_metadata_and_transfer(
                        state, *wallet_index, obj_id.clone(), job.owner.clone(),
                        ns.clone(), Some(job.package_id.clone()), job.agent_public_key.clone(),
                    ).await {
                        Ok(()) => mark_done(jid).await,
                        Err(e) => {
                            tracing::warn!("[bulk-remember] fallback set-metadata failed blob={}: {}", obj_id, e);
                            mark_transfer_failed(
                                jid,
                                &format!("metadata+transfer permanently failed: {}", e),
                            ).await;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "[bulk-remember] set-metadata-batch network error: {} wallet={} — falling back per-blob",
                    e, wallet_index,
                );
                for (obj_id, ns, jid) in blobs {
                    match execute_set_metadata_and_transfer(
                        state, *wallet_index, obj_id.clone(), job.owner.clone(),
                        ns.clone(), Some(job.package_id.clone()), job.agent_public_key.clone(),
                    ).await {
                        Ok(()) => mark_done(jid).await,
                        Err(e) => {
                            tracing::warn!("[bulk-remember] fallback set-metadata failed blob={}: {}", obj_id, e);
                            mark_transfer_failed(
                                jid,
                                &format!("metadata+transfer permanently failed: {}", e),
                            ).await;
                        }
                    }
                }
            }
        }
    }

    tracing::info!(
        "[bulk-remember] complete: owner={} total={} ok={} fail={}",
        &job.owner[..10.min(job.owner.len())],
        items_total, success_count, fail_count,
    );

    Ok(())
}
