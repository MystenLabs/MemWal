//! Production `MemoryEngine`: SEAL encrypt → Walrus upload → Postgres index.

use async_trait::async_trait;
use std::sync::Arc;

use crate::storage::{db::VectorDb, seal, walrus};
use crate::types::{AppError, AuthInfo, Config, KeyPool};

use super::{HydratedMemory, MemoryEngine, MemoryRecord, MemoryRef};

/// Production engine — holds only the dependencies it actually needs,
/// via `Arc<>` so it can share ownership with `AppState` without
/// circular references.
pub struct WalrusSealEngine {
    db: Arc<VectorDb>,
    http_client: reqwest::Client,
    walrus_client: Arc<walrus_rs::WalrusClient>,
    key_pool: Arc<KeyPool>,
    config: Arc<Config>,
}

impl WalrusSealEngine {
    pub fn new(
        db: Arc<VectorDb>,
        http_client: reqwest::Client,
        walrus_client: Arc<walrus_rs::WalrusClient>,
        key_pool: Arc<KeyPool>,
        config: Arc<Config>,
    ) -> Self {
        Self {
            db,
            http_client,
            walrus_client,
            key_pool,
            config,
        }
    }

    /// Reactively delete an expired blob from the local DB index.
    /// Best-effort — errors logged but not propagated. Called on Walrus
    /// 404s and on permanent SEAL decrypt failures.
    async fn cleanup_expired_blob(&self, blob_id: &str) {
        match self.db.delete_by_blob_id(blob_id).await {
            Ok(rows) => {
                tracing::info!(
                    "reactive cleanup: deleted {} vector entries for expired blob_id={}",
                    rows, blob_id
                );
            }
            Err(e) => {
                tracing::error!(
                    "reactive cleanup failed for blob_id={}: {}",
                    blob_id, e
                );
            }
        }
    }
}

#[async_trait]
impl MemoryEngine for WalrusSealEngine {
    async fn store(
        &self,
        record: MemoryRecord,
        auth: &AuthInfo,
    ) -> Result<MemoryRef, AppError> {
        // Step 1: SEAL-encrypt the plaintext.
        let encrypted = seal::seal_encrypt(
            &self.http_client,
            &self.config.sidecar_url,
            record.text.as_bytes(),
            &record.owner,
            &self.config.package_id,
        )
        .await?;

        // Step 2: Upload encrypted blob to Walrus via sidecar.
        // Each store() call grabs a Sui key from the round-robin pool so
        // concurrent stores don't serialise on a single signer.
        let sui_key = self
            .key_pool
            .next()
            .map(|s| s.to_string())
            .ok_or_else(|| {
                AppError::Internal(
                    "No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)"
                        .into(),
                )
            })?;
        let upload_result = walrus::upload_blob(
            &self.http_client,
            &self.config.sidecar_url,
            &encrypted,
            50,
            &record.owner,
            &sui_key,
            &record.namespace,
            &self.config.package_id,
            Some(&auth.public_key),
        )
        .await?;
        let blob_id = upload_result.blob_id;

        // Step 3: Index the row in Postgres. Quota tracking uses the
        // ciphertext byte length (we charge for what's actually stored).
        let id = uuid::Uuid::new_v4().to_string();
        let blob_size = encrypted.len() as i64;
        self.db
            .insert_vector(
                &id,
                &record.owner,
                &record.namespace,
                &blob_id,
                &record.vector,
                blob_size,
            )
            .await?;

        Ok(MemoryRef { id, blob_id })
    }

    async fn fetch_one(
        &self,
        blob_id: &str,
        distance: f64,
        auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        // Resolve the SEAL decrypt key: prefer the delegate key from the
        // request (so requests from delegated clients work without server-
        // side keys), fall back to the server key for legacy callers.
        let private_key = auth
            .delegate_key
            .as_deref()
            .or(self.config.sui_private_key.as_deref())
            .ok_or_else(|| {
                AppError::Internal(
                    "Delegate key or SERVER_SUI_PRIVATE_KEY required for SEAL decryption".into(),
                )
            })?
            .to_string();

        // Step 1: Download encrypted blob from Walrus.
        let encrypted_data = match walrus::download_blob(&self.walrus_client, blob_id).await {
            Ok(data) => data,
            Err(AppError::BlobNotFound(msg)) => {
                tracing::warn!("Blob expired, cleaning up: {}", msg);
                self.cleanup_expired_blob(blob_id).await;
                return Ok(None);
            }
            Err(e) => {
                tracing::warn!("Failed to download blob {}: {}", blob_id, e);
                return Ok(None);
            }
        };

        // Step 2: SEAL decrypt via sidecar.
        let plaintext_bytes = match seal::seal_decrypt(
            &self.http_client,
            &self.config.sidecar_url,
            &encrypted_data,
            &private_key,
            &self.config.package_id,
            &auth.account_id,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                let err_str = e.to_string();
                let is_permanent = err_str.contains("Not enough shares")
                    || err_str.contains("decrypt failed");
                if is_permanent {
                    tracing::warn!(
                        "SEAL decrypt permanently failed for blob {}, cleaning up: {}",
                        blob_id, e
                    );
                    self.cleanup_expired_blob(blob_id).await;
                } else {
                    tracing::warn!("Failed to SEAL decrypt blob {}: {}", blob_id, e);
                }
                return Ok(None);
            }
        };

        // Step 3: Parse UTF-8.
        let text = match String::from_utf8(plaintext_bytes) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Invalid UTF-8 in decrypted data: {}", e);
                return Ok(None);
            }
        };

        Ok(Some(HydratedMemory {
            blob_id: blob_id.to_string(),
            text,
            distance,
        }))
    }
}
