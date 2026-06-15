//! Production `MemoryEngine`: Walrus upload + SEAL decrypt + Postgres index.
//!
//! Holds the *one* copy of the storage choreography that is currently
//! inlined across `routes.rs` (`recall`, `ask`, `remember_manual`) and
//! `jobs.rs` (the `RememberJob` / `BulkRememberJob` workers):
//!
//! - **store_blob**: pick a Sui key (round-robin pool) → `walrus::upload_blob`
//!   the prepared ciphertext → `db.insert_vector`.
//! - **fetch_one**: Redis blob-cache lookup → on miss, `walrus::download_blob`
//!   + cache write-back → `seal::seal_decrypt` → UTF-8. Reactive cleanup of
//!   the index row (scoped to `owner`) on Walrus 404 / permanent decrypt
//!   failure. Returns `Ok(None)` for "gone", not an error.
//! - **fetch_batch**: per-id cache lookup, then `seal::seal_decrypt_batch`
//!   the cache-cold blobs in chunks of 25; same cleanup-on-404 semantics;
//!   returns `(hydrated, dropped_count)` so callers can tell "no matches"
//!   from "matches we couldn't return".
//!
//! The SEAL credential is derived from `&AuthInfo` here (prefer the
//! exported SessionKey, fall back to the legacy delegate key, then to
//! the server fallback key) — the same resolution `routes.rs` does
//! today via `seal::SealCredential::from_auth_or_fallback`.

use async_trait::async_trait;
use redis::AsyncCommands;
use std::sync::Arc;
use std::time::Duration;

use crate::storage::db::VectorDb;
use crate::storage::envelope;
use crate::storage::seal::{self, DecryptOutcome, SealCredential};
use crate::storage::sui;
use crate::storage::walrus;
use crate::types::{AppError, AuthInfo, Config, KeyPool, SearchHit};

use super::{FetchTimings, HydratedMemory, MemoryEngine, MemoryRef};

/// Redis key prefix for the Walrus blob ciphertext cache.
const BLOB_CACHE_KEY_PREFIX: &str = "memwal:blob:v1:";
/// SEAL decrypt-batch chunk size (matches the inlined `recall` value).
const SEAL_DECRYPT_BATCH_SIZE: usize = 25;

#[derive(Clone, PartialEq, Eq)]
struct DecryptStack {
    package_id: String,
    namespace_id: Option<String>,
    registry_id: Option<String>,
    key_version: Option<u32>,
}

/// Production engine — uploads prepared ciphertext to Walrus, indexes
/// the row in Postgres, serves reads through the Redis blob cache.
///
/// Deps are held via `Arc<>` / cheap `Clone` so the engine shares
/// ownership with `AppState` rather than duplicating connections.
pub struct WalrusSealEngine {
    db: Arc<VectorDb>,
    http_client: reqwest::Client,
    key_pool: Arc<KeyPool>,
    config: Arc<Config>,
    redis: redis::aio::MultiplexedConnection,
    /// Blob ciphertext cache TTL. Zero disables write-back.
    blob_cache_ttl: Duration,
    /// Max ciphertext size kept in the Redis cache. Reads ignore
    /// entries larger than this (they get evicted via TTL eventually);
    /// writes skip blobs larger than this. Zero disables the cache
    /// entirely (read and write).
    blob_cache_max_bytes: usize,
}

impl WalrusSealEngine {
    pub fn new(
        db: Arc<VectorDb>,
        http_client: reqwest::Client,
        key_pool: Arc<KeyPool>,
        config: Arc<Config>,
        redis: redis::aio::MultiplexedConnection,
        blob_cache_ttl: Duration,
        blob_cache_max_bytes: usize,
    ) -> Self {
        Self {
            db,
            http_client,
            key_pool,
            config,
            redis,
            blob_cache_ttl,
            blob_cache_max_bytes,
        }
    }

    /// Resolve the SEAL credential the way `routes.rs` does: exported
    /// SessionKey > legacy delegate key > server fallback private key.
    fn credential(&self, auth: &AuthInfo) -> Result<SealCredential, AppError> {
        SealCredential::from_auth_or_fallback(auth, self.config.sui_private_key.as_deref())
            .ok_or_else(|| {
                AppError::Internal(
                    "SEAL credential required (x-seal-session, x-delegate-key, or SERVER_SUI_PRIVATE_KEY)"
                        .into(),
                )
            })
    }

    fn decrypt_stack_for_hit(&self, hit: &SearchHit) -> DecryptStack {
        let is_p2 = hit.protocol == "p2" || hit.namespace_object_id.is_some();
        let package_id = hit.package_id.clone().unwrap_or_else(|| {
            if is_p2 {
                self.config
                    .p2_package_id
                    .clone()
                    .unwrap_or_else(|| self.config.package_id.clone())
            } else {
                self.config.package_id.clone()
            }
        });
        let namespace_id = if is_p2 {
            hit.namespace_object_id
                .clone()
                .or_else(|| self.config.p2_namespace_id.clone())
                .or_else(|| self.config.namespace_id.clone())
        } else {
            None
        };
        let registry_id = namespace_id.as_ref().and_then(|_| {
            self.config
                .p2_registry_id
                .clone()
                .or_else(|| Some(self.config.registry_id.clone()))
        });
        let key_version = if is_p2 {
            hit.key_version
                .and_then(|v| u32::try_from(v).ok())
                .or(Some(self.config.key_version))
        } else {
            None
        };

        DecryptStack {
            package_id,
            namespace_id,
            registry_id,
            key_version,
        }
    }

    async fn decrypt_wrapped_dek(
        &self,
        credential: &SealCredential,
        account_id: &str,
        stack: &DecryptStack,
    ) -> Result<[u8; envelope::DEK_LEN], AppError> {
        let namespace_id = stack.namespace_id.as_deref().ok_or_else(|| {
            AppError::Internal("P2 decrypt stack missing namespace_id".into())
        })?;
        let registry_id = stack
            .registry_id
            .as_deref()
            .ok_or_else(|| AppError::Internal("P2 decrypt stack missing registry_id".into()))?;
        let key_version = stack
            .key_version
            .ok_or_else(|| AppError::Internal("P2 decrypt stack missing key_version".into()))?;

        let wrapped = sui::fetch_namespace_wrapped_dek(
            &self.http_client,
            &self.config.sui_rpc_url,
            namespace_id,
            key_version,
        )
        .await
        .map_err(|e| AppError::Internal(format!("fetch wrapped DEK failed: {}", e)))?
        .ok_or_else(|| {
            AppError::Internal(format!(
                "wrapped DEK not found for namespace={} key_version={}",
                namespace_id, key_version
            ))
        })?;

        let dek = seal::seal_decrypt_namespace(
            &self.http_client,
            &self.config.sidecar_url,
            self.config.sidecar_secret.as_deref(),
            &wrapped,
            credential,
            &stack.package_id,
            account_id,
            namespace_id,
            registry_id,
        )
        .await?;
        let dek: [u8; envelope::DEK_LEN] = dek.try_into().map_err(|actual: Vec<u8>| {
            AppError::Internal(format!(
                "wrapped DEK decrypted to {} bytes, expected {}",
                actual.len(),
                envelope::DEK_LEN
            ))
        })?;
        Ok(dek)
    }

    async fn decrypt_p2_envelope(
        &self,
        ciphertext: &[u8],
        credential: &SealCredential,
        account_id: &str,
        stack: &DecryptStack,
    ) -> Result<Vec<u8>, AppError> {
        let header = envelope::parse_header(ciphertext)
            .map_err(|e| AppError::Internal(format!("P2 envelope parse failed: {}", e)))?;
        let namespace_id = envelope::format_object_id(&header.namespace_id);
        let stack_namespace = stack.namespace_id.as_deref().ok_or_else(|| {
            AppError::Internal("P2 decrypt stack missing namespace_id".into())
        })?;
        if namespace_id != stack_namespace {
            return Err(AppError::Internal(format!(
                "P2 envelope namespace mismatch: header={} stack={}",
                namespace_id, stack_namespace
            )));
        }
        if Some(header.key_version) != stack.key_version {
            return Err(AppError::Internal(format!(
                "P2 envelope key_version mismatch: header={} stack={:?}",
                header.key_version, stack.key_version
            )));
        }

        let dek = self
            .decrypt_wrapped_dek(credential, account_id, stack)
            .await?;
        envelope::open_envelope(&dek, ciphertext)
            .map_err(|e| AppError::Internal(format!("P2 envelope decrypt failed: {}", e)))
    }

    /// Reactively delete an expired blob's index row. Best-effort —
    /// errors logged, not propagated. Scoped to `owner` so a
    /// blob discovered via one user's recall can't delete another's row.
    async fn cleanup_expired_blob(&self, blob_id: &str, owner: &str) {
        match self.db.delete_by_blob_id(blob_id, owner).await {
            Ok(rows) => {
                if rows > 0 {
                    tracing::info!(
                        "reactive cleanup: deleted {} vector entries for expired blob_id={} owner={}",
                        rows, blob_id, owner
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    "reactive cleanup failed for blob_id={} owner={}: {}",
                    blob_id,
                    owner,
                    e
                );
            }
        }
    }

    /// Try the Redis blob cache. Returns `Some(ciphertext)` on hit;
    /// `None` on miss, oversized entry (cap), or any cache error
    /// (cache is best-effort). Disabled entirely when
    /// `blob_cache_max_bytes` is zero.
    async fn cache_get(&self, blob_id: &str) -> Option<Vec<u8>> {
        if self.blob_cache_max_bytes == 0 {
            return None;
        }
        let mut redis = self.redis.clone();
        let cache_key = format!("{}{}", BLOB_CACHE_KEY_PREFIX, blob_id);
        match redis.get::<_, Option<Vec<u8>>>(&cache_key).await {
            Ok(Some(ciphertext)) => {
                match read_decision(ciphertext.len(), self.blob_cache_max_bytes) {
                    CacheReadDecision::Serve => Some(ciphertext),
                    CacheReadDecision::IgnoreOversize => {
                        // ignore entries larger than the configured cap.
                        // The entry will be evicted by TTL eventually; we don't
                        // delete it here to keep `cache_get` read-only.
                        tracing::info!(
                            "blob cache ignored for {}: {} bytes exceeds max {}",
                            blob_id,
                            ciphertext.len(),
                            self.blob_cache_max_bytes
                        );
                        None
                    }
                }
            }
            Ok(None) => None,
            Err(e) => {
                tracing::warn!("blob cache get failed for {}: {}", blob_id, e);
                None
            }
        }
    }

    /// Write a freshly-downloaded ciphertext into the Redis cache.
    /// No-op when `blob_cache_ttl` is zero, `blob_cache_max_bytes` is
    /// zero, or the ciphertext exceeds the size cap. Best-effort.
    async fn cache_put(&self, blob_id: &str, ciphertext: &[u8]) {
        let ttl_secs = self.blob_cache_ttl.as_secs();
        match write_decision(ciphertext.len(), self.blob_cache_max_bytes, ttl_secs) {
            CacheWriteDecision::Skip => return,
            CacheWriteDecision::SkipOversize => {
                // skip blobs above the size cap to bound Redis memory.
                tracing::info!(
                    "blob cache skip for {}: {} bytes exceeds max {}",
                    blob_id,
                    ciphertext.len(),
                    self.blob_cache_max_bytes
                );
                return;
            }
            CacheWriteDecision::Write => {}
        }
        let mut redis = self.redis.clone();
        let cache_key = format!("{}{}", BLOB_CACHE_KEY_PREFIX, blob_id);
        let result: redis::RedisResult<()> = redis
            .set_ex(&cache_key, ciphertext.to_vec(), ttl_secs)
            .await;
        if let Err(e) = result {
            tracing::warn!("blob cache set failed for {}: {}", blob_id, e);
        }
    }

    /// Fetch a blob's ciphertext: cache → Walrus (+ cache write-back).
    /// Returns `Some((ciphertext, was_cached))` — `was_cached` is `true` on
    /// a Redis hit, `false` on a cold fetch from Walrus. Returns `None` if
    /// the blob is gone (Walrus 404 → reactive cleanup) or any other
    /// download error.
    async fn fetch_ciphertext(&self, blob_id: &str, owner: &str) -> Option<(Vec<u8>, bool)> {
        if let Some(ciphertext) = self.cache_get(blob_id).await {
            return Some((ciphertext, true));
        }
        match walrus::download_blob_from_aggregators(
            &self.http_client,
            &self.config.walrus_aggregator_urls,
            blob_id,
            self.config.walrus_skip_consistency_check,
            Duration::from_millis(self.config.walrus_aggregator_race_after_ms),
        )
        .await
        {
            Ok(ciphertext) => {
                self.cache_put(blob_id, &ciphertext).await;
                Some((ciphertext, false))
            }
            Err(AppError::BlobNotFound(msg)) => {
                tracing::warn!("Blob expired, cleaning up: {}", msg);
                self.cleanup_expired_blob(blob_id, owner).await;
                None
            }
            Err(e) => {
                tracing::warn!("Failed to download blob {}: {}", blob_id, e);
                None
            }
        }
    }
}

#[async_trait]
impl MemoryEngine for WalrusSealEngine {
    #[tracing::instrument(
        name = "engine.walrus_seal.store_blob",
        skip_all,
        fields(owner = %owner, namespace = %namespace, bytes = bytes.len())
    )]
    async fn store_blob(
        &self,
        owner: &str,
        namespace: &str,
        bytes: &[u8],
        vector: &[f32],
        importance: f32,
        agent_public_key: Option<&str>,
    ) -> Result<MemoryRef, AppError> {
        // Pick the next Sui key slot (round-robin) so concurrent stores
        // don't serialise on one signer.
        let key_index = self.key_pool.next_index().ok_or_else(|| {
            AppError::Internal(
                "No Sui keys configured (set SERVER_SUI_PRIVATE_KEYS or SERVER_SUI_PRIVATE_KEY)"
                    .into(),
            )
        })?;

        // Upload the prepared ciphertext to Walrus via the relay sidecar
        // (pool key pays gas). `defer_transfer = false` — the blob is
        // transferred to `owner` immediately, same as the inlined
        // `remember_manual` path.
        let upload = walrus::upload_blob(
            &self.http_client,
            &self.config.sidecar_url,
            self.config.sidecar_secret.as_deref(),
            bytes,
            self.config.walrus_storage_epochs as u64,
            owner,
            key_index,
            namespace,
            &self.config.package_id,
            agent_public_key,
            None,
        )
        .await?;
        let blob_id = upload.blob_id;
        tracing::info!("engine.store_blob: walrus upload ok blob_id={}", blob_id);

        // warm the Redis blob cache with the just-uploaded ciphertext
        // so the first recall of this blob hits the cache instead of round-
        // tripping Walrus. Best-effort — skipped when the cache is disabled
        // or the blob exceeds `blob_cache_max_bytes`.
        self.cache_put(&blob_id, bytes).await;

        // Index the row. Quota accounting uses the ciphertext byte length.
        let id = uuid::Uuid::new_v4().to_string();
        let blob_size = bytes.len() as i64;
        self.db
            .insert_vector(
                &id, owner, namespace, &blob_id, vector, blob_size, importance,
            )
            .await?;

        Ok(MemoryRef { id, blob_id })
    }

    /// F3 (structure-review): eagerly resolve a SEAL credential so
    /// `/api/ask` can fail fast on credential misconfiguration before
    /// running recall. Returns the same error `fetch_one` / `fetch_batch`
    /// would surface when they try to decrypt — keeps behaviour
    /// equivalent to dev's pre-refactor `/api/ask`, where the credential
    /// check happened up front regardless of how many hits recall
    /// produced.
    fn require_read_credentials(&self, auth: &AuthInfo) -> Result<(), AppError> {
        self.credential(auth).map(|_| ())
    }

    #[tracing::instrument(
        name = "engine.walrus_seal.fetch_one",
        skip_all,
        fields(blob_id = %blob_id)
    )]
    async fn fetch_one(
        &self,
        owner: &str,
        blob_id: &str,
        distance: f64,
        auth: &AuthInfo,
    ) -> Result<Option<HydratedMemory>, AppError> {
        let credential = self.credential(auth)?;

        // Step 1: cache → Walrus. (fetch_one doesn't aggregate cache stats —
        // a single blob's hit/miss isn't worth a log line; the span carries it.)
        let ciphertext = match self.fetch_ciphertext(blob_id, owner).await {
            Some((c, _was_cached)) => c,
            None => return Ok(None),
        };

        // Step 2: decrypt. P2 blobs are WMEM envelopes; legacy blobs are raw
        // SEAL encrypted objects.
        let plaintext_bytes = match envelope::parse_header(&ciphertext) {
            Ok(header) => {
                let stack = DecryptStack {
                    package_id: self
                        .config
                        .p2_package_id
                        .clone()
                        .unwrap_or_else(|| self.config.package_id.clone()),
                    namespace_id: Some(envelope::format_object_id(&header.namespace_id)),
                    registry_id: self
                        .config
                        .p2_registry_id
                        .clone()
                        .or_else(|| Some(self.config.registry_id.clone())),
                    key_version: Some(header.key_version),
                };
                match self
                    .decrypt_p2_envelope(&ciphertext, &credential, &auth.account_id, &stack)
                    .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("P2 envelope decrypt failed for {}: {}", blob_id, e);
                        return Ok(None);
                    }
                }
            }
            Err(envelope::EnvelopeError::BadMagic) => {
                match seal::seal_decrypt_configured(
                    &self.http_client,
                    &self.config.sidecar_url,
                    self.config.sidecar_secret.as_deref(),
                    &ciphertext,
                    &credential,
                    &self.config.package_id,
                    &auth.account_id,
                    self.config.namespace_id.as_deref(),
                    Some(self.config.registry_id.as_str()),
                )
                .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        // `seal_decrypt` (single) doesn't classify permanence
                        // the way `seal_decrypt_batch` does; mirror the inlined
                        // `ask` behaviour — log, drop, no cleanup on a single failure.
                        tracing::warn!("SEAL decrypt failed for {}: {}", blob_id, e);
                        return Ok(None);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("P2 envelope header invalid for {}: {}", blob_id, e);
                return Ok(None);
            }
        };

        // Step 3: UTF-8.
        let text = match String::from_utf8(plaintext_bytes) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(
                    "Invalid UTF-8 in decrypted data for blob {}: {}",
                    blob_id,
                    e
                );
                return Ok(None);
            }
        };

        Ok(Some(HydratedMemory {
            blob_id: blob_id.to_string(),
            text,
            distance,
            // Engine doesn't fetch created_at / importance; the recall
            // handler zips them on from the SearchHit.
            // See HydratedMemory docs.
            created_at: None,
            importance: None,
        }))
    }

    #[tracing::instrument(
        name = "engine.walrus_seal.fetch_batch",
        skip_all,
        fields(hits = hits.len())
    )]
    async fn fetch_batch(
        &self,
        owner: &str,
        hits: &[SearchHit],
        auth: &AuthInfo,
    ) -> Result<(Vec<HydratedMemory>, usize, FetchTimings), AppError> {
        if hits.is_empty() {
            return Ok((vec![], 0, FetchTimings::default()));
        }
        let credential = self.credential(auth)?;

        // Step 1: fetch all ciphertexts concurrently (cache → Walrus,
        // with cache write-back on cold hits). Blobs that 404 / error
        // drop out here (and get reactive cleanup inside `fetch_ciphertext`).
        struct Fetched {
            hit: SearchHit,
            ciphertext: Vec<u8>,
            was_cached: bool,
        }
        let walrus_start = std::time::Instant::now();
        let fetch_tasks = hits.iter().cloned().map(|hit| async move {
            self.fetch_ciphertext(&hit.blob_id, owner)
                .await
                .map(|(ciphertext, was_cached)| Fetched {
                    hit,
                    ciphertext,
                    was_cached,
                })
        });
        let fetched: Vec<Fetched> = futures::future::join_all(fetch_tasks)
            .await
            .into_iter()
            .flatten()
            .collect();
        let walrus_ms = walrus_start.elapsed().as_millis();
        let cache_hits = fetched.iter().filter(|f| f.was_cached).count();
        let cache_misses = fetched.len() - cache_hits;
        let download_drops = hits.len() - fetched.len();
        tracing::info!(
            "engine.fetch_batch: {} hits -> {} fetched ({} cached, {} cold), {} dropped (download)",
            hits.len(),
            fetched.len(),
            cache_hits,
            cache_misses,
            download_drops
        );

        // Step 2: batch-decrypt the ciphertexts in chunks.
        let seal_start = std::time::Instant::now();
        let mut decrypted: Vec<DecryptOutcome> = (0..fetched.len())
            .map(|_| DecryptOutcome::Missing)
            .collect();

        struct DecryptGroup {
            stack: DecryptStack,
            indices: Vec<usize>,
        }

        let mut groups: Vec<DecryptGroup> = Vec::new();
        for (idx, fetched_item) in fetched.iter().enumerate() {
            let stack = self.decrypt_stack_for_hit(&fetched_item.hit);
            if let Some(group) = groups.iter_mut().find(|group| group.stack == stack) {
                group.indices.push(idx);
            } else {
                groups.push(DecryptGroup {
                    stack,
                    indices: vec![idx],
                });
            }
        }

        for group in groups {
            for chunk in group.indices.chunks(SEAL_DECRYPT_BATCH_SIZE) {
                let batch_input: Vec<(String, Vec<u8>)> = chunk
                    .iter()
                    .map(|idx| {
                        let fetched_item = &fetched[*idx];
                        (
                            fetched_item.hit.blob_id.clone(),
                            fetched_item.ciphertext.clone(),
                        )
                    })
                    .collect();
                if group.stack.namespace_id.is_some() {
                    match self
                        .decrypt_wrapped_dek(&credential, &auth.account_id, &group.stack)
                        .await
                    {
                        Ok(dek) => {
                            for idx in chunk.iter().copied() {
                                let fetched_item = &fetched[idx];
                                decrypted[idx] =
                                    match envelope::open_envelope(&dek, &fetched_item.ciphertext) {
                                        Ok(plaintext) => DecryptOutcome::Ok(plaintext),
                                        Err(e) => DecryptOutcome::Failed {
                                            error: format!("P2 envelope decrypt failed: {}", e),
                                            permanent: true,
                                        },
                                    };
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "engine.fetch_batch: P2 wrapped DEK decrypt failed for {} blobs package={} namespace={:?} key_version={:?}: {}",
                                chunk.len(),
                                group.stack.package_id,
                                group.stack.namespace_id,
                                group.stack.key_version,
                                e
                            );
                            for idx in chunk.iter().copied() {
                                decrypted[idx] = DecryptOutcome::Failed {
                                    error: e.to_string(),
                                    permanent: false,
                                };
                            }
                        }
                    }
                } else {
                    match seal::seal_decrypt_batch_configured(
                        &self.http_client,
                        &self.config.sidecar_url,
                        self.config.sidecar_secret.as_deref(),
                        &batch_input,
                        &credential,
                        &group.stack.package_id,
                        &auth.account_id,
                        group.stack.namespace_id.as_deref(),
                        group.stack.registry_id.as_deref(),
                    )
                    .await
                    {
                        Ok(outcomes) => {
                            for (idx, outcome) in chunk.iter().copied().zip(outcomes) {
                                decrypted[idx] = outcome;
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "engine.fetch_batch: seal_decrypt_batch failed for {} blobs package={} namespace={:?}: {}",
                                chunk.len(),
                                group.stack.package_id,
                                group.stack.namespace_id,
                                e
                            );
                        }
                    }
                }
            }
        }
        let seal_ms = seal_start.elapsed().as_millis();

        // Step 3: assemble results; permanent decrypt failures trigger cleanup.
        let mut results = Vec::new();
        let mut decrypt_drops = 0usize;
        for (f, outcome) in fetched.iter().zip(decrypted) {
            match outcome {
                DecryptOutcome::Ok(plaintext) => match String::from_utf8(plaintext) {
                    Ok(text) => results.push(HydratedMemory {
                        blob_id: f.hit.blob_id.clone(),
                        text,
                        distance: f.hit.distance,
                        // Engine doesn't fetch created_at / importance;
                        // recall handler zips them on. See HydratedMemory.
                        created_at: None,
                        importance: None,
                    }),
                    Err(e) => {
                        tracing::warn!(
                            "Invalid UTF-8 in decrypted data for blob {}: {}",
                            f.hit.blob_id,
                            e
                        );
                        decrypt_drops += 1;
                    }
                },
                DecryptOutcome::Failed { error, permanent } => {
                    if permanent {
                        tracing::warn!(
                            "SEAL decrypt permanently failed for blob {}, cleaning up: {}",
                            f.hit.blob_id,
                            error
                        );
                        self.cleanup_expired_blob(&f.hit.blob_id, owner).await;
                    } else {
                        tracing::warn!(
                            "SEAL decrypt transient failure for blob {}: {}",
                            f.hit.blob_id,
                            error
                        );
                    }
                    decrypt_drops += 1;
                }
                DecryptOutcome::Missing => decrypt_drops += 1,
            }
        }

        tracing::info!(
            "engine.fetch_batch: decrypted {} of {} fetched ({} dropped: {} download, {} decrypt) walrus={}ms seal={}ms",
            results.len(),
            fetched.len(),
            download_drops + decrypt_drops,
            download_drops,
            decrypt_drops,
            walrus_ms,
            seal_ms,
        );

        Ok((
            results,
            download_drops + decrypt_drops,
            FetchTimings { walrus_ms, seal_ms },
        ))
    }
}

// ============================================================
// Pure cache-policy helpers (size cap, TTL)
// ============================================================

/// What `cache_get` should do with a Redis hit, given the configured
/// size cap. Extracted so the policy is unit-testable without a Redis
/// fixture — the IO-bound branches (Redis error, miss) stay in
/// `cache_get` itself.
#[derive(Debug, PartialEq, Eq)]
enum CacheReadDecision {
    /// Entry is within the cap — serve it.
    Serve,
    /// Entry exceeds the cap — ignore (policy: don't delete,
    /// let TTL evict).
    IgnoreOversize,
}

fn read_decision(ciphertext_len: usize, max_bytes: usize) -> CacheReadDecision {
    if ciphertext_len <= max_bytes {
        CacheReadDecision::Serve
    } else {
        CacheReadDecision::IgnoreOversize
    }
}

/// What `cache_put` should do with a freshly-downloaded ciphertext,
/// given the configured TTL + size cap.
#[derive(Debug, PartialEq, Eq)]
enum CacheWriteDecision {
    /// Either TTL or max-bytes is zero — cache is disabled, no write.
    Skip,
    /// Ciphertext exceeds the size cap — skip the write.
    SkipOversize,
    /// Within policy — go ahead and write with the configured TTL.
    Write,
}

fn write_decision(ciphertext_len: usize, max_bytes: usize, ttl_secs: u64) -> CacheWriteDecision {
    if ttl_secs == 0 || max_bytes == 0 {
        CacheWriteDecision::Skip
    } else if ciphertext_len > max_bytes {
        CacheWriteDecision::SkipOversize
    } else {
        CacheWriteDecision::Write
    }
}

#[cfg(test)]
mod tests {
    use super::{read_decision, write_decision, CacheReadDecision, CacheWriteDecision};

    // ── read-side cap ──────────────────────────────────────────────

    #[test]
    fn read_decision_serves_entries_at_or_below_cap() {
        assert_eq!(
            read_decision(100, 512),
            CacheReadDecision::Serve,
            "100 bytes under 512 cap should be served"
        );
        assert_eq!(
            read_decision(512, 512),
            CacheReadDecision::Serve,
            "exactly at cap should be served (boundary)"
        );
        assert_eq!(
            read_decision(0, 512),
            CacheReadDecision::Serve,
            "empty entry under cap should be served"
        );
    }

    #[test]
    fn read_decision_ignores_oversize_entries() {
        assert_eq!(
            read_decision(513, 512),
            CacheReadDecision::IgnoreOversize,
            "one byte over cap should be ignored"
        );
        assert_eq!(
            read_decision(usize::MAX, 512),
            CacheReadDecision::IgnoreOversize,
            "wildly oversized entry should be ignored without crashing"
        );
    }

    // ── write-side cap + TTL ──────────────────────────────

    #[test]
    fn write_decision_skips_when_ttl_zero() {
        // TTL=0 disables write-back entirely.
        assert_eq!(
            write_decision(100, 512, 0),
            CacheWriteDecision::Skip,
            "TTL=0 should disable cache writes"
        );
    }

    #[test]
    fn write_decision_skips_when_max_bytes_zero() {
        // max=0 disables cache writes.
        assert_eq!(
            write_decision(100, 0, 600),
            CacheWriteDecision::Skip,
            "max_bytes=0 should disable cache writes"
        );
    }

    #[test]
    fn write_decision_skips_when_both_disabled() {
        assert_eq!(
            write_decision(100, 0, 0),
            CacheWriteDecision::Skip,
            "both TTL and max disabled should skip"
        );
    }

    #[test]
    fn write_decision_writes_within_cap() {
        assert_eq!(
            write_decision(100, 512, 600),
            CacheWriteDecision::Write,
            "in-cap ciphertext should be written"
        );
        assert_eq!(
            write_decision(512, 512, 600),
            CacheWriteDecision::Write,
            "exactly at cap should be written (boundary)"
        );
    }

    #[test]
    fn write_decision_skips_oversize() {
        assert_eq!(
            write_decision(513, 512, 600),
            CacheWriteDecision::SkipOversize,
            "one byte over cap should be skipped"
        );
        assert_eq!(
            write_decision(1024 * 1024, 512, 600),
            CacheWriteDecision::SkipOversize,
            "1 MiB ciphertext under 512 B cap should be skipped"
        );
    }

    #[test]
    fn write_decision_disabled_beats_oversize() {
        // If the cache is disabled, the oversize check never fires —
        // Skip is the right answer even when the entry would also be
        // oversize. Documents the precedence in `cache_put`.
        assert_eq!(
            write_decision(1024 * 1024, 0, 600),
            CacheWriteDecision::Skip,
            "max=0 should skip via Skip, not SkipOversize"
        );
    }
}
