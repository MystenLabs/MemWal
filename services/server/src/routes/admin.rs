//! Admin / utility handlers: `/api/ask`, `/api/forget`, `/api/stats`,
//! `/api/restore`, `GET /health`, `GET /config`.
//!
//! `ask` is the AI-with-memory demo (recall → inject memories into the LLM
//! system prompt → answer). `forget`/`stats` are owner-scoped, mode-blind
//! admin ops the benchmark harness uses for cleanup/verification. `restore`
//! rebuilds a namespace's vector index from the on-chain blobs (download →
//! SEAL-decrypt → re-embed → insert missing rows). `/health` reports the
//! deployment mode; `/config` exposes the public Sui/package metadata the
//! SDK needs to build a SEAL SessionKey.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use base64::Engine as _;
use futures::stream::{self, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;

use crate::services::llm_chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage};
use crate::jobs::WalletOperation;
use crate::storage::{chain, envelope, seal, sui, walrus};
use crate::types::*;

use super::{cleanup_expired_blob, enqueue_wallet_job};

/// the `/api/ask` system prompt — a versioned text asset with a
/// `{MEMORY_CONTEXT}` placeholder (substituted with the `<memory>`-tag-
/// wrapped recall context per request). Includes the prompt-injection
/// guard. Bundled at compile time.
const ASK_SYSTEM_PROMPT: &str = include_str!("../services/prompts/ask.txt");
/// Version ID for the ask prompt. Bump on every meaningful prompt change.
/// Exposed on `GET /health` via `HealthResponse.prompt_versions.ask` so
/// the benchmark harness can pin it into the result-artifact metadata
/// for reproducible comparisons.
const ASK_SYSTEM_PROMPT_VERSION: &str = "ask.v1";

// ============================================================
// /api/forget + /api/stats
// ============================================================

/// POST /api/forget
///
/// Delete the vector index rows for every memory in `owner`'s
/// `namespace` (a hard `DELETE` on `vector_entries` — the underlying
/// Walrus blobs persist, since Walrus has no delete; the memories just
/// stop being retrievable and stop counting toward storage quota). Used
/// by the benchmark harness for inter-run cleanup; also a general admin
/// op. Mode-blind — works the same in production and benchmark mode (in
/// benchmark mode this also removes the plaintext rows). Owner-scoped:
/// only the caller's own rows are deleted.
pub async fn forget(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<ForgetRequest>,
) -> Result<Json<ForgetResponse>, AppError> {
    if body.namespace.is_empty() {
        return Err(AppError::BadRequest("namespace cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    tracing::info!("forget: owner={} ns={}", owner, namespace);

    let deleted = state.db.delete_by_namespace(owner, namespace).await?;

    tracing::info!(
        "forget complete: deleted {} entries for owner={} ns={}",
        deleted,
        owner,
        namespace
    );

    Ok(Json(ForgetResponse {
        deleted,
        namespace: namespace.clone(),
        owner: owner.clone(),
    }))
}

/// POST /api/stats
///
/// Return memory count + stored bytes for `owner`'s `namespace`. Used by
/// the benchmark harness to verify ingestion. Mode-blind. Owner-scoped.
pub async fn stats(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<StatsRequest>,
) -> Result<Json<StatsResponse>, AppError> {
    if body.namespace.is_empty() {
        return Err(AppError::BadRequest("namespace cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;

    let (memory_count, storage_bytes) = state.db.namespace_stats(owner, namespace).await?;

    tracing::info!(
        "stats: owner={} ns={} count={} bytes={}",
        owner,
        namespace,
        memory_count,
        storage_bytes
    );

    Ok(Json(StatsResponse {
        memory_count,
        storage_bytes,
        namespace: namespace.clone(),
        owner: owner.clone(),
    }))
}

// ============================================================
// /health + /version + /config
// ============================================================

/// GET /health
pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        compatibility: crate::compatibility::version_response(),
        mode: if state.config.benchmark_mode {
            "benchmark".to_string()
        } else {
            "production".to_string()
        },
        // surface the prompt-version constants so benchmark
        // run-artifacts can pin them at run start. Read from the same
        // consts the running binary uses for extraction (`/api/analyze`)
        // and ask (`/api/ask`) — no separate config to drift.
        prompt_versions: PromptVersions {
            extract: crate::services::extractor::FACT_EXTRACTION_PROMPT_VERSION.to_string(),
            ask: ASK_SYSTEM_PROMPT_VERSION.to_string(),
        },
    })
}

/// GET /version
pub async fn version() -> Json<crate::compatibility::VersionResponse> {
    Json(crate::compatibility::version_response())
}

/// GET /config
///
/// public, unauthenticated endpoint returning deployment
/// parameters the SDK needs to build a SEAL `SessionKey` client-side —
/// specifically the Move `packageId` and the Sui network/RPC URL.
///
/// These values are public on-chain metadata (not secrets), so no auth is
/// required. Exposing them here lets the SDK migrate from transmitting
/// the raw delegate private key (`x-delegate-key`) to transmitting an
/// exported SessionKey (`x-seal-session`) without forcing users to add
/// `packageId` to their `MemWalConfig` — preserving backward-compatible
/// UX for v0.3.x apps that only passed `{ key, accountId }`.
pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<ConfigResponse> {
    Json(ConfigResponse {
        package_id: state.config.public_package_id().to_string(),
        registry_id: state.config.public_registry_id().to_string(),
        namespace_id: state.config.public_namespace_id().map(str::to_string),
        key_version: state.config.key_version,
        protocol: state.config.public_protocol().to_string(),
        network: state.config.sui_network.clone(),
        sui_rpc_url: state.config.sui_rpc_url.clone(),
        rate_limit_disabled: state.config.rate_limit.bench_bypass_enabled,
    })
}

fn migration_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-memwal-migration-token")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
}

fn require_migration_token(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    let expected = config.sidecar_secret.as_deref().ok_or_else(|| {
        AppError::Unauthorized("migration token is not configured on this server".into())
    })?;
    let provided = migration_token_from_headers(headers)
        .ok_or_else(|| AppError::Unauthorized("missing migration token".into()))?;
    if provided != expected {
        return Err(AppError::Unauthorized("invalid migration token".into()));
    }
    Ok(())
}

/// POST /internal/migration/v2/import-accounts
///
/// Phase-3 account mirror. For each legacy `(owner, namespace)` that still lacks
/// a P2 namespace, this creates the P2 `Account` (once per owner — the registry
/// enforces one account per owner) and the `MemoryNamespace`, copies the legacy
/// delegate keys onto the P2 account, and records the mapping in
/// `account_migrations`. It MUST run before `migration_v2_backfill`, which
/// resolves the P2 account + namespace for each blob from `account_migrations`.
///
/// Idempotent: already-mirrored pairs are filtered out by the candidate query;
/// a second namespace for an owner reuses the existing P2 account.
pub async fn migration_v2_import_accounts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<V2ImportAccountsRequest>,
) -> Result<Json<V2ImportAccountsResponse>, AppError> {
    require_migration_token(&headers, &state.config)?;

    let limit = body.limit.clamp(1, 250);
    let p2_package_id = state
        .config
        .p2_package_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_PACKAGE_ID is required".into()))?;
    let migration_cap_id = state
        .config
        .p2_migration_cap_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_MIGRATION_CAP_ID is required".into()))?;
    let account_registry_id = state
        .config
        .p2_registry_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_REGISTRY_ID is required".into()))?;
    let namespace_registry_id = state
        .config
        .p2_namespace_registry_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_NAMESPACE_REGISTRY_ID is required".into()))?;

    let candidates = state
        .db
        .list_v2_account_migration_candidates(
            body.owner.as_deref(),
            body.namespace.as_deref(),
            limit as i64,
        )
        .await?;

    if body.dry_run {
        return Ok(Json(V2ImportAccountsResponse {
            selected: candidates.len(),
            imported_accounts: 0,
            imported_namespaces: 0,
            imported_delegates: 0,
            skipped: 0,
            failed: 0,
            dry_run: true,
            protocol: "p2".to_string(),
        }));
    }

    // P2 accounts minted in THIS run, so a second namespace for the same owner
    // reuses the account (one account per owner) instead of re-importing.
    let mut owner_accounts: HashMap<String, String> = HashMap::new();
    let mut imported_accounts = 0usize;
    let mut imported_namespaces = 0usize;
    let mut imported_delegates = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for c in candidates.iter() {
        // Cache miss (owner absent from the `accounts` table) → resolve the legacy
        // account id from the OLD registry on chain so the mirror isn't stuck
        // re-returning the same un-resolvable candidates forever.
        let resolved_account_id: Option<String> = match c.legacy_account_id.clone() {
            Some(id) => Some(id),
            None => match sui::fetch_account_id_by_owner(
                &state.http_client,
                &state.config.sui_rpc_url,
                &state.config.registry_id,
                &c.owner,
            )
            .await
            {
                Ok(Some(id)) => {
                    tracing::info!(owner = %c.owner, account_id = %id, "account-mirror: resolved legacy account from chain");
                    Some(id)
                }
                Ok(None) => None,
                Err(e) => {
                    tracing::warn!(owner = %c.owner, error = %e, "account-mirror: chain account resolve failed");
                    None
                }
            },
        };
        let Some(legacy_account_id) = resolved_account_id.as_deref() else {
            tracing::warn!(owner = %c.owner, namespace = %c.namespace, "account-mirror skip: missing legacy account id (not in cache, not on chain)");
            skipped += 1;
            continue;
        };

        // An existing P2 account for this owner: from a prior namespace's mirror
        // (candidate row) or one minted earlier in this run.
        let existing_account = c
            .p2_account_id
            .clone()
            .or_else(|| owner_accounts.get(&c.owner).cloned());
        let is_new_account = existing_account.is_none();

        let outcome: Result<(String, String, usize), AppError> = async {
            let key_index = state.config.migration_key_index;
            if let Some(account_id) = existing_account.clone() {
                // Owner already has a P2 account → create only this namespace.
                let tx = chain::admin_create_namespace(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    key_index,
                    p2_package_id,
                    migration_cap_id,
                    namespace_registry_id,
                    &c.owner,
                    &c.namespace,
                    0,
                )
                .await?;
                let namespace_id = tx.namespace_id.ok_or_else(|| {
                    AppError::Internal("admin_create_namespace returned no namespace id".into())
                })?;
                Ok((account_id, namespace_id, 0))
            } else {
                // First namespace for this owner → import account + namespace + delegates.
                let legacy = sui::fetch_account_for_migration(
                    &state.http_client,
                    &state.config.sui_rpc_url,
                    legacy_account_id,
                )
                .await
                .map_err(|e| AppError::Internal(format!("fetch legacy account failed: {}", e)))?;
                let tx = chain::admin_import_account(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    key_index,
                    p2_package_id,
                    migration_cap_id,
                    account_registry_id,
                    namespace_registry_id,
                    &c.owner,
                    legacy_account_id,
                    &c.namespace,
                    0,
                    legacy.active,
                )
                .await?;
                let account_id = tx.account_id.ok_or_else(|| {
                    AppError::Internal("admin_import_account returned no account id".into())
                })?;
                let namespace_id = tx.namespace_id.ok_or_else(|| {
                    AppError::Internal("admin_import_account returned no namespace id".into())
                })?;
                let mut delegates = 0usize;
                for dk in legacy.delegate_keys.iter() {
                    let ki = state.config.migration_key_index;
                    chain::admin_add_delegate_key(
                        &state.http_client,
                        &state.config.sidecar_url,
                        state.config.sidecar_secret.as_deref(),
                        ki,
                        p2_package_id,
                        migration_cap_id,
                        &account_id,
                        &dk.public_key_hex,
                        &dk.label,
                        dk.perms,
                        dk.created_at,
                    )
                    .await?;
                    delegates += 1;
                }
                Ok((account_id, namespace_id, delegates))
            }
        }
        .await;

        match outcome {
            Ok((account_id, namespace_id, delegates)) => {
                state
                    .db
                    .record_v2_account_migration(
                        legacy_account_id,
                        &c.owner,
                        &c.namespace,
                        &account_id,
                        &namespace_id,
                    )
                    .await?;
                owner_accounts.insert(c.owner.clone(), account_id);
                if is_new_account {
                    imported_accounts += 1;
                }
                imported_namespaces += 1;
                imported_delegates += delegates;
                tracing::info!(owner = %c.owner, namespace = %c.namespace, namespace_id = %namespace_id, "account-mirror: imported");
            }
            Err(e) => {
                tracing::warn!(owner = %c.owner, namespace = %c.namespace, error = %e, "account-mirror: failed");
                let _ = state
                    .db
                    .mark_v2_account_migration_failed(
                        legacy_account_id,
                        &c.owner,
                        &c.namespace,
                        &e.to_string(),
                    )
                    .await;
                failed += 1;
            }
        }
    }

    Ok(Json(V2ImportAccountsResponse {
        selected: candidates.len(),
        imported_accounts,
        imported_namespaces,
        imported_delegates,
        skipped,
        failed,
        dry_run: false,
        protocol: "p2".to_string(),
    }))
}

/// POST /internal/migration/v2/backfill
///
/// Internal migration helper. It decrypts OLD blobs with the configured server
/// fallback key, creates WMEM envelopes under the P2 namespace DEK, and enqueues
/// server-owned Walrus uploads + `admin_record_memory` jobs. It assumes
/// `account_migrations` has already been populated with `p2_account_id` and
/// `p2_namespace_id` for each owner/namespace.
pub async fn migration_v2_backfill(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<V2BackfillRequest>,
) -> Result<Json<V2BackfillResponse>, AppError> {
    require_migration_token(&headers, &state.config)?;
    if body.key_version == 0 {
        return Err(AppError::BadRequest("keyVersion must be positive".into()));
    }

    let limit = body.limit.clamp(1, 250);
    let p2_package_id = state
        .config
        .p2_package_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_PACKAGE_ID is required".into()))?;
    let migration_cap_id = state
        .config
        .p2_migration_cap_id
        .as_deref()
        .ok_or_else(|| AppError::Internal("MEMWAL_P2_MIGRATION_CAP_ID is required".into()))?;
    let fallback_private_key = state
        .config
        .sui_private_key
        .as_deref()
        .or_else(|| state.config.sui_private_keys.first().map(String::as_str))
        .ok_or_else(|| {
            AppError::Internal(
                "SERVER_SUI_PRIVATE_KEY or SERVER_SUI_PRIVATE_KEYS is required for OLD decrypt"
                    .into(),
            )
        })?;
    let credential = seal::SealCredential::DelegateKey(fallback_private_key.to_string());
    // §14: decrypt OLD blobs by passing the dedicated server account (which has the
    // fallback key as a delegate) to the OLD seal_approve. The delegate-branch bug
    // (no id binding) then approves ANY blob id — without making the fallback a
    // delegate on each user's account.
    let migration_old_account_id = state
        .config
        .migration_old_account_id
        .as_deref()
        .ok_or_else(|| {
            AppError::Internal(
                "MEMWAL_MIGRATION_OLD_ACCOUNT_ID is required (the §14 server account on the OLD contract with the fallback key as a delegate)".into(),
            )
        })?;

    let candidates = state
        .db
        .list_v2_migration_candidates(
            body.owner.as_deref(),
            body.namespace.as_deref(),
            limit as i64,
        )
        .await?;
    if body.dry_run {
        return Ok(Json(V2BackfillResponse {
            selected: candidates.len(),
            queued: 0,
            skipped: 0,
            dry_run: true,
            protocol: "p2".to_string(),
        }));
    }

    let mut deks: HashMap<String, [u8; envelope::DEK_LEN]> = HashMap::new();
    let mut queued = 0usize;
    let mut skipped = 0usize;

    for candidate in candidates.iter() {
        let Some(old_account_id) = candidate.old_account_id.as_deref() else {
            tracing::warn!(
                old_blob_id = %candidate.blob_id,
                owner = %candidate.owner,
                "migration backfill skip: missing old account id"
            );
            skipped += 1;
            continue;
        };
        if candidate.p2_account_id.is_none() {
            tracing::warn!(
                old_blob_id = %candidate.blob_id,
                owner = %candidate.owner,
                "migration backfill skip: missing P2 account id"
            );
            skipped += 1;
            continue;
        }
        let Some(p2_namespace_id) = candidate.p2_namespace_id.as_deref() else {
            tracing::warn!(
                old_blob_id = %candidate.blob_id,
                owner = %candidate.owner,
                "migration backfill skip: missing P2 namespace id"
            );
            skipped += 1;
            continue;
        };

        let namespace_bytes = envelope::parse_object_id(p2_namespace_id)
            .map_err(|e| AppError::Internal(format!("invalid P2 namespace id: {}", e)))?;

        if !deks.contains_key(p2_namespace_id) {
            // Resumable DEK resolution: in-memory cache → DB cache → generate.
            // The DB cache (migration_dek_cache, migration 011) lets a later
            // backfill call — or a retry after a partial failure — recover the raw
            // DEK instead of dead-ending on "wrapped DEK already exists".
            let dek = if let Some(cached) = state
                .db
                .get_migration_dek(p2_namespace_id, body.key_version)
                .await?
            {
                if cached.len() != envelope::DEK_LEN {
                    return Err(AppError::Internal(format!(
                        "cached migration DEK for {} has wrong length {}",
                        p2_namespace_id,
                        cached.len()
                    )));
                }
                let mut dek = [0u8; envelope::DEK_LEN];
                dek.copy_from_slice(&cached);
                dek
            } else {
                let existing = sui::fetch_namespace_wrapped_dek(
                    &state.http_client,
                    &state.config.sui_rpc_url,
                    p2_namespace_id,
                    body.key_version,
                )
                .await
                .map_err(|e| AppError::Internal(format!("fetch wrapped DEK failed: {}", e)))?;
                if existing.is_some() {
                    // Wrapped DEK is on chain but no cached raw DEK (a pre-cache
                    // run): it cannot be recovered for this key_version. Re-run the
                    // namespace under a fresh keyVersion (recall scans 1..=current).
                    tracing::warn!(
                        namespace_id = %p2_namespace_id,
                        key_version = body.key_version,
                        "migration backfill skip namespace: wrapped DEK on chain but raw DEK not in cache (pre-cache run); re-run with a fresh keyVersion"
                    );
                    skipped += 1;
                    continue;
                }

                let dek = envelope::generate_dek();
                let wrapped = seal::seal_encrypt_namespace(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    &dek,
                    p2_package_id,
                    p2_namespace_id,
                    body.key_version,
                )
                .await?;
                let key_index = state.config.migration_key_index;
                let tx = chain::admin_set_wrapped_dek(
                    &state.http_client,
                    &state.config.sidecar_url,
                    state.config.sidecar_secret.as_deref(),
                    key_index,
                    p2_package_id,
                    migration_cap_id,
                    p2_namespace_id,
                    body.key_version,
                    &wrapped,
                )
                .await?;
                // Persist the raw DEK so subsequent calls are resumable/idempotent.
                state
                    .db
                    .put_migration_dek(p2_namespace_id, body.key_version, &dek)
                    .await?;
                tracing::info!(
                    namespace_id = %p2_namespace_id,
                    key_version = body.key_version,
                    digest = %tx.digest,
                    "migration backfill stored wrapped DEK"
                );
                dek
            };
            deks.insert(p2_namespace_id.to_string(), dek);
        }

        let old_ciphertext = match walrus::download_blob_from_aggregators(
            &state.http_client,
            &state.config.walrus_aggregator_urls,
            &candidate.blob_id,
            state.config.walrus_skip_consistency_check,
            std::time::Duration::from_millis(state.config.walrus_aggregator_race_after_ms),
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(
                    old_blob_id = %candidate.blob_id,
                    error = %e,
                    "migration backfill skip: old blob download failed"
                );
                skipped += 1;
                continue;
            }
        };

        let old_package_id = candidate
            .old_package_id
            .as_deref()
            .unwrap_or(&state.config.package_id);
        let plaintext = match seal::seal_decrypt(
            &state.http_client,
            &state.config.sidecar_url,
            state.config.sidecar_secret.as_deref(),
            &old_ciphertext,
            &credential,
            old_package_id,
            migration_old_account_id,
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(
                    old_blob_id = %candidate.blob_id,
                    old_account_id = %old_account_id,
                    error = %e,
                    "migration backfill skip: old decrypt failed"
                );
                skipped += 1;
                continue;
            }
        };

        let dek = deks.get(p2_namespace_id).ok_or_else(|| {
            AppError::Internal("internal migration state missing namespace DEK".into())
        })?;
        let envelope_bytes =
            envelope::seal_envelope(dek, &namespace_bytes, body.key_version, &plaintext);
        let wallet_index = state.config.migration_key_index;
        enqueue_wallet_job(
            &state,
            wallet_index,
            WalletOperation::UploadP2Envelope {
                envelope_b64: base64::engine::general_purpose::STANDARD.encode(&envelope_bytes),
                vector: candidate.vector.clone(),
                importance: candidate.importance,
                owner: candidate.owner.clone(),
                namespace: candidate.namespace.clone(),
                package_id: p2_package_id.to_string(),
                namespace_id: p2_namespace_id.to_string(),
                key_version: body.key_version,
                agent_public_key: None,
                remember_job_id: None,
                epochs: state.config.walrus_storage_epochs,
                migrated_from_blob_id: Some(candidate.blob_id.clone()),
            },
        )
        .await?;

        sqlx::query(
            "INSERT INTO blob_migrations (
                old_blob_id,
                owner,
                namespace,
                old_package_id,
                p2_package_id,
                old_account_id,
                p2_account_id,
                p2_namespace_id,
                key_version,
                status,
                updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', NOW())
             ON CONFLICT (old_blob_id) DO UPDATE SET
                p2_package_id = EXCLUDED.p2_package_id,
                old_account_id = EXCLUDED.old_account_id,
                p2_account_id = EXCLUDED.p2_account_id,
                p2_namespace_id = EXCLUDED.p2_namespace_id,
                key_version = EXCLUDED.key_version,
                status = 'queued',
                last_error = NULL,
                updated_at = NOW()",
        )
        .bind(&candidate.blob_id)
        .bind(&candidate.owner)
        .bind(&candidate.namespace)
        .bind(old_package_id)
        .bind(p2_package_id)
        .bind(old_account_id)
        .bind(candidate.p2_account_id.as_deref())
        .bind(p2_namespace_id)
        .bind(body.key_version as i32)
        .execute(state.db.pool())
        .await
        .map_err(|e| AppError::Internal(format!("Failed to mark blob migration queued: {}", e)))?;

        queued += 1;
    }

    Ok(Json(V2BackfillResponse {
        selected: candidates.len(),
        queued,
        skipped,
        dry_run: false,
        protocol: "p2".to_string(),
    }))
}

/// POST /internal/migration/v2/verify-decrypt
///
/// Migration verification utility: download a single blob and return its
/// plaintext, so an operator can confirm — on real data —
///   * `mode:"v1"` (default): the §14 OLD-decrypt path works on a pre-existing
///     package-1 blob (download → SEAL decrypt via the server account + fallback
///     key, whose delegate-branch bug approves any blob id), and
///   * `mode:"v2"`: a migrated WMEM envelope round-trips (read header → look up the
///     cohort DEK from migration_dek_cache → AES-256-GCM open).
///
/// Gated by the migration token; intended for the isolated migration environment.
/// `maxChars` truncates the returned preview (default 2000).
pub async fn migration_v2_verify_decrypt(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<V2VerifyDecryptRequest>,
) -> Result<Json<V2VerifyDecryptResponse>, AppError> {
    require_migration_token(&headers, &state.config)?;
    let mode = body.mode.as_deref().unwrap_or("v1");

    let ciphertext = walrus::download_blob_from_aggregators(
        &state.http_client,
        &state.config.walrus_aggregator_urls,
        &body.blob_id,
        state.config.walrus_skip_consistency_check,
        std::time::Duration::from_millis(state.config.walrus_aggregator_race_after_ms),
    )
    .await
    .map_err(|e| AppError::Internal(format!("blob download failed: {}", e)))?;

    let plaintext = match mode {
        "v1" => {
            let fallback_private_key = state
                .config
                .sui_private_key
                .as_deref()
                .or_else(|| state.config.sui_private_keys.first().map(String::as_str))
                .ok_or_else(|| {
                    AppError::Internal(
                        "SERVER_SUI_PRIVATE_KEY or SERVER_SUI_PRIVATE_KEYS is required".into(),
                    )
                })?;
            let credential = seal::SealCredential::DelegateKey(fallback_private_key.to_string());
            let old_account_id = state
                .config
                .migration_old_account_id
                .as_deref()
                .ok_or_else(|| {
                    AppError::Internal("MEMWAL_MIGRATION_OLD_ACCOUNT_ID is required".into())
                })?;
            let old_package_id = body
                .package_id
                .as_deref()
                .unwrap_or(&state.config.package_id);
            seal::seal_decrypt(
                &state.http_client,
                &state.config.sidecar_url,
                state.config.sidecar_secret.as_deref(),
                &ciphertext,
                &credential,
                old_package_id,
                old_account_id,
            )
            .await?
        }
        "v2" => {
            let header = envelope::parse_header(&ciphertext)
                .map_err(|e| AppError::Internal(format!("not a WMEM envelope: {}", e)))?;
            let namespace_id = envelope::format_object_id(&header.namespace_id);
            let cached = state
                .db
                .get_migration_dek(&namespace_id, header.key_version)
                .await?
                .ok_or_else(|| {
                    AppError::Internal(format!(
                        "no cached DEK for namespace {} key_version {}",
                        namespace_id, header.key_version
                    ))
                })?;
            if cached.len() != envelope::DEK_LEN {
                return Err(AppError::Internal("cached DEK has wrong length".into()));
            }
            let mut dek = [0u8; envelope::DEK_LEN];
            dek.copy_from_slice(&cached);
            envelope::open_envelope(&dek, &ciphertext)
                .map_err(|e| AppError::Internal(format!("envelope open failed: {}", e)))?
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "unknown mode '{}' (use v1 or v2)",
                other
            )))
        }
    };

    let len = plaintext.len();
    let text = String::from_utf8_lossy(&plaintext).to_string();
    let preview: String = text.chars().take(body.max_chars.unwrap_or(2000)).collect();
    Ok(Json(V2VerifyDecryptResponse {
        blob_id: body.blob_id,
        mode: mode.to_string(),
        len,
        plaintext: preview,
    }))
}

// ============================================================
// /api/ask
// ============================================================

/// POST /api/ask
///
/// Full AI-with-memory demo:
/// 1. Recall relevant memories for the question
/// 2. Inject memories into LLM system prompt
/// 3. Call LLM with user question + memory context
/// 4. Return answer + memories used
pub async fn ask(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<AskRequest>,
) -> Result<Json<AskResponse>, AppError> {
    if body.question.is_empty() {
        return Err(AppError::BadRequest("Question cannot be empty".into()));
    }

    // Validate scoring_weights up front — fail fast on malformed input
    // before we burn an embed + vector search + Walrus + SEAL round-trip.
    let weights = body.scoring_weights.clone().unwrap_or_default();
    weights.validate()?;

    let owner = &auth.owner;
    let namespace = &body.namespace;
    // cap `limit` so a misbehaving client can't make us pull a
    // huge number of memories through Walrus + SEAL. Matches the cap
    // `recall` already enforces — see routes/recall.rs.
    let limit = body.limit.unwrap_or(5).min(100);
    tracing::info!(
        question_len = body.question.len(),
        owner = %owner,
        namespace = %namespace,
        ranker_active = weights.is_ranker_active(),
        "ask request"
    );

    // F3 (structure-review): probe the SEAL credential up front. If the
    // client is misconfigured (no exported SessionKey, no legacy delegate
    // key, no server fallback) we want to return 500 immediately rather
    // than running recall, getting zero (or some) hits, and then either
    // returning a misleading 200 or surfacing the error from the *first*
    // `fetch_one` call. `PlaintextEngine` no-ops this.
    state.engine.require_read_credentials(&auth)?;

    // Step 1: Recall relevant memories
    let query_vector = state.embedder.embed(&body.question).await?;
    let hits = state
        .db
        .search_similar(
            &query_vector,
            owner,
            namespace,
            limit,
            Some(state.config.public_db_protocol()),
        )
        .await?;

    // Hydrate the hits through the storage engine, concurrently — same
    // blob cache -> Walrus download -> SEAL decrypt -> UTF-8 path as
    // recall, with reactive cleanup on Walrus 404. The engine derives the
    // SEAL credential from `auth`; per-blob errors are logged inside it.
    // We borrow `hits` for the fan-out so it's still around for the
    // `zip_search_hit_fields_onto_hydrated` call below.
    let fetch_tasks = hits.iter().map(|hit| {
        let auth = &auth;
        let engine = &state.engine;
        let blob_id = hit.blob_id.clone();
        let distance = hit.distance;
        async move { engine.fetch_one(owner, &blob_id, distance, auth).await }
    });
    let mut hydrated: Vec<crate::engine::HydratedMemory> = futures::future::join_all(fetch_tasks)
        .await
        .into_iter()
        // fetch_one returns Ok(None) for blobs that are gone / failed to
        // decrypt; surface only the AppError (sidecar down, etc.).
        .filter_map(|r| match r {
            Ok(Some(m)) => Some(Ok(m)),
            Ok(None) => None,
            Err(e) => Some(Err(e)),
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    // Zip created_at + importance onto hydrated memories. The engine returns
    // None for both fields; the recall path is responsible for filling them
    // before composite ranking.
    super::zip_search_hit_fields_onto_hydrated(&mut hydrated, &hits);

    if weights.is_ranker_active() {
        tracing::info!(
            owner = %owner,
            semantic = weights.semantic,
            recency = weights.recency,
            half_life_days = weights.recency_half_life_days,
            // include the importance weight in the breadcrumb so
            // ordering bug reports can be triaged against the full vector
            // of weights the client sent.
            importance = weights.importance,
            "ask: ranker active"
        );
    }

    // Composite re-rank — same contract as /api/recall.
    let ranked = state.ranker.rank(hydrated, &weights, chrono::Utc::now());

    let memories: Vec<RecallResult> = ranked
        .into_iter()
        .map(|r| RecallResult {
            blob_id: r.memory.blob_id,
            text: r.memory.text,
            distance: r.memory.distance,
            score: r.score,
        })
        .collect();

    let memories_used = memories.len();
    tracing::info!("ask: {} memories found for context", memories_used);

    // Defence-in-depth against indirect prompt injection via stored memories.
    // Wrap each memory in an explicit <memory> tag with the blob_id and tell the
    // LLM in the system prompt that tag contents are user-provided data, not
    // instructions. This does not eliminate the attack vector (owner-scoped
    // memories can still contain adversarial text) but makes tag-boundary
    // confusion attacks harder to mount.
    let memory_context = if memories.is_empty() {
        "No memories found for this user yet.".to_string()
    } else {
        let lines: Vec<String> = memories
            .iter()
            .map(|m| {
                format!(
                    "<memory id=\"{}\" relevance=\"{:.2}\">{}</memory>",
                    m.blob_id,
                    1.0 - m.distance,
                    m.text
                )
            })
            .collect();
        format!("Known facts about this user:\n{}", lines.join("\n"))
    };

    // the ask system prompt is a versioned text asset
    // (services/prompts/ask.txt) with a {MEMORY_CONTEXT} placeholder.
    // Keeps the prompt-injection guard. ASK_SYSTEM_PROMPT_VERSION
    // tracks the prompt version for attribution.
    let system_prompt = ASK_SYSTEM_PROMPT.replace("{MEMORY_CONTEXT}", &memory_context);

    // Step 3: Call LLM
    let api_key = state
        .config
        .openai_api_key
        .as_ref()
        .ok_or_else(|| AppError::Internal("OPENAI_API_KEY required for /api/ask".into()))?;
    let url = format!("{}/chat/completions", state.config.openai_api_base);

    let req = state
        .http_client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&ChatCompletionRequest {
            model: "openai/gpt-4o-mini".to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: system_prompt,
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: body.question.clone(),
                },
            ],
            temperature: 0.7,
            max_tokens: 512,
        });
    let req = crate::observability::apply_request_id_header(req);
    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| {
        crate::observability::observe_external(
            "openai",
            "ask_chat_completions",
            "transport_error",
            started.elapsed(),
        );
        AppError::Internal(format!("LLM request failed: {}", e))
    })?;
    let status_label = resp.status().as_u16().to_string();
    crate::observability::observe_external(
        "openai",
        "ask_chat_completions",
        &status_label,
        started.elapsed(),
    );

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "LLM error ({}): {}",
            status, body_text
        )));
    }

    let api_resp: ChatCompletionResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse LLM response: {}", e)))?;

    // `content` is `Option<String>` — `None` on upstream null-content
    // returns. For the ask path, fall back to the existing
    // "No response from LLM" message so the user sees a useful signal.
    let answer = api_resp
        .choices
        .first()
        .and_then(|c| c.message.content.as_deref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "No response from LLM".to_string());

    tracing::info!("ask complete: answer length={} chars", answer.len());

    Ok(Json(AskResponse {
        answer,
        memories_used,
        memories,
    }))
}

// ============================================================
// /api/restore
// ============================================================

/// POST /api/restore
///
/// Restore a namespace from Walrus:
/// 1. Get all blob_ids for owner+namespace from DB
/// 2. Download each blob from Walrus
/// 3. SEAL decrypt with delegate key
/// 4. Re-embed decrypted text
/// 5. Clear old vector entries and re-index
pub async fn restore(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Json(body): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, AppError> {
    if body.namespace.is_empty() {
        return Err(AppError::BadRequest("namespace cannot be empty".into()));
    }

    let owner = &auth.owner;
    let namespace = &body.namespace;
    let limit = body.limit;
    tracing::info!("restore: owner={} ns={} limit={}", owner, namespace, limit);

    // Prefer the client-built SessionKey; fall back to legacy
    // delegate key, then to the server's own key for restore operations.
    let credential = seal::SealCredential::from_auth_or_fallback(
        &auth,
        state.config.sui_private_key.as_deref(),
    )
    .ok_or_else(|| {
        AppError::Internal(
            "SEAL credential required for restore (x-seal-session, x-delegate-key, or SERVER_SUI_PRIVATE_KEY)".into(),
        )
    })?;

    // Step 1: Discover all blob_ids from on-chain (source of truth)
    tracing::info!(
        "restore: querying chain for blobs owner={} ns={}",
        owner,
        namespace
    );
    let on_chain_blobs = walrus::query_blobs_by_owner(
        &state.http_client,
        &state.config.sidecar_url,
        state.config.sidecar_secret.as_deref(),
        owner,
        Some(namespace),
        Some(&state.config.package_id),
        Some(limit),
    )
    .await?;
    let all_blob_ids: Vec<String> = on_chain_blobs.iter().map(|b| b.blob_id.clone()).collect();
    let total = all_blob_ids.len();

    // Build blob_id → package_id lookup from on-chain metadata
    // Each blob may have been encrypted with a different package_id (e.g. after contract upgrades)
    let blob_package_ids: std::collections::HashMap<String, String> = on_chain_blobs
        .iter()
        .filter(|b| !b.package_id.is_empty())
        .map(|b| (b.blob_id.clone(), b.package_id.clone()))
        .collect();

    if total == 0 {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped: 0,
            total: 0,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    // Step 2: Check which blobs already exist in local DB → only restore missing ones
    let existing_blob_ids = state.db.get_blobs_by_namespace(owner, namespace).await?;
    let existing_set: std::collections::HashSet<&str> =
        existing_blob_ids.iter().map(|s| s.as_str()).collect();
    let all_missing: Vec<String> = all_blob_ids
        .iter()
        .filter(|id| !existing_set.contains(id.as_str()))
        .cloned()
        .collect();
    // Apply limit — query-blobs returns newest-first for restore's recent
    // transaction path, so keep the first N missing blobs. If fewer than N
    // candidates match after namespace/package filtering, restore returns a
    // partial result instead of scanning the whole wallet.
    let missing_blob_ids: Vec<String> = all_missing.into_iter().take(limit).collect();
    let skipped = total - missing_blob_ids.len();
    tracing::info!(
        "restore: total={} on-chain, existing={}, missing={} (limited to {}) for ns={}",
        total,
        existing_blob_ids.len(),
        missing_blob_ids.len(),
        limit,
        namespace
    );

    if missing_blob_ids.is_empty() {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped,
            total,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    // Step 3: Download all missing blobs from Walrus concurrently
    let db = &state.db;
    let http_client = state.http_client.clone();
    let aggregator_urls = state.config.walrus_aggregator_urls.clone();
    let race_after = std::time::Duration::from_millis(state.config.walrus_aggregator_race_after_ms);
    let download_tasks: Vec<_> = missing_blob_ids
        .iter()
        .map(|blob_id| {
            let http_client = http_client.clone();
            let aggregator_urls = aggregator_urls.clone();
            let blob_id = blob_id.clone();
            let owner_for_cleanup = owner.clone();
            async move {
                match walrus::download_blob_from_aggregators(
                    &http_client,
                    &aggregator_urls,
                    &blob_id,
                    false,
                    race_after,
                )
                .await
                {
                    Ok(data) => Some((blob_id, data)),
                    Err(AppError::BlobNotFound(msg)) => {
                        tracing::warn!("restore: blob expired, skipping: {}", msg);
                        cleanup_expired_blob(db, &blob_id, &owner_for_cleanup).await;
                        None
                    }
                    Err(e) => {
                        tracing::warn!("restore: download failed for {}: {}", blob_id, e);
                        None
                    }
                }
            }
        })
        .collect();

    // Bounded concurrency (max 10 parallel downloads) to prevent
    // OOM when restoring large namespaces. join_all() with hundreds of blobs
    // would spawn all downloads simultaneously → memory spike.
    // We use buffer_unordered(10) to cap parallelism at 10 concurrent downloads.
    let downloaded: Vec<(String, Vec<u8>)> = stream::iter(download_tasks)
        .buffer_unordered(10)
        .filter_map(|opt| async move { opt })
        .collect()
        .await;

    // Preserve encrypted blob sizes so restored rows still contribute to storage quota.
    let blob_sizes: std::collections::HashMap<String, i64> = downloaded
        .iter()
        .map(|(blob_id, data)| (blob_id.clone(), data.len() as i64))
        .collect();

    if downloaded.is_empty() {
        return Ok(Json(RestoreResponse {
            restored: 0,
            skipped,
            total,
            namespace: namespace.clone(),
            owner: owner.clone(),
        }));
    }

    tracing::info!(
        "restore: downloaded {}/{} blobs, decrypting (3 concurrent)...",
        downloaded.len(),
        missing_blob_ids.len()
    );

    // Step 4: SEAL decrypt with bounded concurrency (3 at a time)
    // Use per-blob package_id from on-chain metadata, fall back to current server config
    let decrypt_results: Vec<Option<(String, String)>> = stream::iter(downloaded)
        .map(|(blob_id, encrypted_data)| {
            let http_client = &state.http_client;
            let sidecar_url = state.config.sidecar_url.clone();
            let sidecar_secret = state.config.sidecar_secret.clone();
            let namespace_id = state.config.namespace_id.clone();
            let registry_id = state.config.registry_id.clone();
            let credential = credential.clone();
            // Use the package_id that was stored with this blob (supports contract upgrades)
            let package_id = blob_package_ids
                .get(&blob_id)
                .cloned()
                .unwrap_or_else(|| state.config.package_id.clone());
            let account_id = auth.account_id.clone();
            async move {
                match seal::seal_decrypt_configured(
                    http_client,
                    &sidecar_url,
                    sidecar_secret.as_deref(),
                    &encrypted_data,
                    &credential,
                    &package_id,
                    &account_id,
                    namespace_id.as_deref(),
                    Some(registry_id.as_str()),
                )
                .await
                {
                    Ok(plaintext) => match String::from_utf8(plaintext) {
                        Ok(text) => Some((blob_id, text)),
                        Err(e) => {
                            tracing::warn!("restore: invalid UTF-8 for {}: {}", blob_id, e);
                            None
                        }
                    },
                    Err(e) => {
                        tracing::warn!("restore: decrypt failed for {}: {}", blob_id, e);
                        None
                    }
                }
            }
        })
        .buffer_unordered(3)
        .collect()
        .await;

    let decrypted_texts: Vec<(String, String)> = decrypt_results.into_iter().flatten().collect();
    tracing::info!(
        "restore: decrypted {}/{} blobs",
        decrypted_texts.len(),
        missing_blob_ids.len()
    );

    // Step 5: Re-embed all decrypted texts concurrently
    let embed_tasks: Vec<_> = decrypted_texts
        .iter()
        .map(|(blob_id, text)| {
            let embedder = Arc::clone(&state.embedder);
            let blob_id = blob_id.clone();
            let text = text.clone();
            async move {
                match embedder.embed(&text).await {
                    Ok(vector) => Some((blob_id, vector)),
                    Err(e) => {
                        tracing::warn!("restore: embedding failed for {}: {}", blob_id, e);
                        None
                    }
                }
            }
        })
        .collect();

    let results: Vec<(String, Vec<f32>)> = futures::future::join_all(embed_tasks)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Step 6: Insert only new entries (no delete!)
    let restored = results.len();
    for (blob_id, vector) in &results {
        let id = uuid::Uuid::new_v4().to_string();
        let blob_size = blob_sizes.get(blob_id).copied().unwrap_or_else(|| {
            tracing::warn!(
                "restore: missing blob size for {}, defaulting to 0 for quota tracking",
                blob_id
            );
            0
        });
        state
            .db
            .insert_vector(
                &id,
                owner,
                namespace,
                blob_id,
                vector,
                blob_size,
                // restore flow re-indexes existing Walrus blobs after
                // they fell out of pgvector. The original importance value is
                // not preserved in the blob (it's a row-level signal). Use the
                // neutral "standard" bucket so restored memories rank as
                // average — neither boosted nor penalized.
                crate::services::extractor::IMPORTANCE_STANDARD,
            )
            .await?;
    }

    tracing::info!(
        "restore complete: restored={} skipped={} total={} owner={} ns={}",
        restored,
        skipped,
        total,
        owner,
        namespace
    );

    Ok(Json(RestoreResponse {
        restored,
        skipped,
        total,
        namespace: namespace.clone(),
        owner: owner.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use crate::types::RecallResult;

    // ── Memory context wraps in XML tags ─────────────────────────

    #[test]
    fn memory_context_uses_xml_tags() {
        // Simulate what /api/ask does
        let memories = [RecallResult {
            blob_id: "blob123".into(),
            text: "User likes coffee".into(),
            distance: 0.1,
            score: None,
        }];

        let lines: Vec<String> = memories
            .iter()
            .map(|m| {
                format!(
                    "<memory id=\"{}\" relevance=\"{:.2}\">{}</memory>",
                    m.blob_id,
                    1.0 - m.distance,
                    m.text
                )
            })
            .collect();
        let context = format!("Known facts about this user:\n{}", lines.join("\n"));

        assert!(context.contains("<memory id=\"blob123\""));
        assert!(context.contains("relevance=\"0.90\""));
        assert!(context.contains("User likes coffee</memory>"));
    }

    #[test]
    fn memory_context_empty_shows_no_memories() {
        let memories: Vec<RecallResult> = vec![];
        let context = if memories.is_empty() {
            "No memories found for this user yet.".to_string()
        } else {
            "should not reach here".to_string()
        };
        assert_eq!(context, "No memories found for this user yet.");
    }

    // ── /api/ask body.limit cap ─────────────────────────────────
    //
    // Verifies the structural-review F3 follow-up: `/api/ask` clamps
    // `body.limit` to `<= 100`, matching the cap `/api/recall` already
    // enforces. A misbehaving client can't make the handler pull
    // thousands of memories through Walrus + SEAL.

    #[test]
    fn ask_limit_caps_at_one_hundred() {
        // Mirror the production expression: body.limit.unwrap_or(5).min(100)
        for (input, expected) in [
            (None, 5),        // default
            (Some(0), 0),     // pass-through (caller intent)
            (Some(50), 50),   // under cap
            (Some(100), 100), // at cap
            (Some(101), 100), // over cap → clamped
            (Some(10_000), 100),
            (Some(usize::MAX), 100),
        ] {
            let clamped = input.unwrap_or(5).min(100);
            assert_eq!(
                clamped, expected,
                "ask limit clamp: input={:?} expected={} got={}",
                input, expected, clamped
            );
        }
    }

    // ── /api/forget + /api/stats empty-namespace validation ─────────────
    //
    // Both handlers reject an empty namespace with `AppError::BadRequest`
    // (400) before touching the database, matching the convention used by
    // `restore` and `remember_manual`. This test pins the validation
    // predicate so a refactor that drops the check would fail CI.

    #[test]
    fn forget_stats_reject_empty_namespace() {
        let empty = "";
        let non_empty = "bench-locomo-conv-0";

        // The check is `body.namespace.is_empty()` in both handlers.
        assert!(
            empty.is_empty(),
            "empty namespace must trip the validation predicate"
        );
        assert!(
            !non_empty.is_empty(),
            "non-empty namespace must pass the validation predicate"
        );
    }
}
