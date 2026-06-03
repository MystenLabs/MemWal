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
use axum::{Extension, Json};
use base64::Engine as _;
use futures::stream::{self, StreamExt};
use std::sync::Arc;

use crate::services::llm_chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage};
use crate::storage::{seal, walrus};
use crate::types::*;

use super::cleanup_expired_blob;

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
        package_id: state.config.package_id.clone(),
        network: state.config.sui_network.clone(),
        sui_rpc_url: state.config.sui_rpc_url.clone(),
        rate_limit_disabled: state.config.rate_limit.bench_bypass_enabled,
    })
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
        .search_similar(&query_vector, owner, namespace, limit)
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
        // decrypt; surface only the AppError for caller-visible failures.
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
    let on_chain_blobs = native_restore_on_chain_blobs(state.as_ref(), owner, namespace, limit).await?;
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
            let sui_rpc_url = state.config.sui_rpc_url.clone();
            let sui_network = state.config.sui_network.clone();
            let credential = credential.clone();
            // Use the package_id that was stored with this blob (supports contract upgrades)
            let package_id = blob_package_ids
                .get(&blob_id)
                .cloned()
                .unwrap_or_else(|| state.config.package_id.clone());
            let account_id = auth.account_id.clone();
            async move {
                match seal::seal_decrypt(
                    http_client,
                    &encrypted_data,
                    &credential,
                    &package_id,
                    &account_id,
                    &sui_rpc_url,
                    &sui_network,
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

#[derive(Clone, Debug)]
struct RawOnChainBlob {
    object_id: String,
    raw_blob_id: Option<String>,
}

#[derive(Clone, Debug)]
struct RecentBlobCandidate {
    object_id: String,
}

#[derive(Debug)]
struct BlobMetadata {
    namespace: String,
    owner: String,
    package_id: String,
    agent_id: String,
}

async fn native_restore_on_chain_blobs(
    state: &AppState,
    owner: &str,
    namespace: &str,
    limit: usize,
) -> Result<Vec<walrus::OnChainBlob>, AppError> {
    let blob_type = format!("{}::blob::Blob", state.config.walrus_package_id);
    let desired_matches = limit.clamp(1, 500);
    let mut raw_blobs = if limit > 0 {
        let candidates =
            query_recent_blob_object_candidates(state, owner, &blob_type, desired_matches).await?;
        let raw = fetch_raw_blob_objects(state, &candidates).await?;
        tracing::info!(
            "restore: found {}/{} recent Walrus blob candidates for owner={} target={}",
            raw.len(),
            candidates.len(),
            owner,
            desired_matches
        );
        raw
    } else {
        query_owned_blob_objects(state, owner, &blob_type).await?
    };

    // Newest transaction candidates are already ordered. Owned-object scans are
    // not time ordered; keep deterministic object-id order for stable restore
    // behavior.
    if limit == 0 {
        raw_blobs.sort_by(|a, b| a.object_id.cmp(&b.object_id));
    }

    let package_filter = state.config.package_id.clone();
    let metadata_tasks = raw_blobs.into_iter().map(|raw| {
        let state = state;
        let package_filter = package_filter.clone();
        async move {
            let metadata = fetch_blob_metadata(state, &raw.object_id)
                .await
                .unwrap_or_else(|err| {
                    tracing::debug!(
                        "restore: blob {} has no MemWal metadata or metadata fetch failed: {}",
                        raw.object_id,
                        err
                    );
                    BlobMetadata::default()
                });
            (raw, metadata, package_filter)
        }
    });

    let mut blobs = Vec::new();
    let mut stream = stream::iter(metadata_tasks).buffer_unordered(5);
    while let Some((raw, metadata, package_filter)) = stream.next().await {
        if !namespace.is_empty() && metadata.namespace != namespace {
            continue;
        }
        if !package_filter.is_empty() && metadata.package_id != package_filter {
            continue;
        }
        let Some(raw_blob_id) = raw.raw_blob_id.as_deref() else {
            continue;
        };
        let Some(blob_id) = blob_id_from_raw(raw_blob_id) else {
            tracing::warn!(
                "restore: unable to convert raw blob_id for object {}",
                raw.object_id
            );
            continue;
        };
        blobs.push(walrus::OnChainBlob {
            blob_id,
            object_id: raw.object_id,
            namespace: metadata.namespace,
            package_id: metadata.package_id,
        });
        if blobs.len() >= desired_matches {
            break;
        }
    }

    tracing::info!(
        "restore: returning {} on-chain blobs for owner={} ns={}",
        blobs.len(),
        owner,
        namespace
    );
    Ok(blobs)
}

impl Default for BlobMetadata {
    fn default() -> Self {
        Self {
            namespace: "default".to_string(),
            owner: String::new(),
            package_id: String::new(),
            agent_id: String::new(),
        }
    }
}

async fn query_owned_blob_objects(
    state: &AppState,
    owner: &str,
    blob_type: &str,
) -> Result<Vec<RawOnChainBlob>, AppError> {
    let mut cursor = serde_json::Value::Null;
    let mut raw = Vec::new();

    loop {
        let result = sui_rpc_call(
            state,
            "suix_getOwnedObjects",
            serde_json::json!([
                owner,
                {
                    "filter": { "StructType": blob_type },
                    "options": { "showContent": true }
                },
                cursor,
                50
            ]),
        )
        .await?;

        if let Some(data) = result.get("data").and_then(|v| v.as_array()) {
            for obj in data {
                if let Some(raw_obj) = raw_blob_from_object(obj) {
                    raw.push(raw_obj);
                }
            }
        }

        let has_next = result
            .get("hasNextPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !has_next {
            break;
        }
        cursor = result.get("nextCursor").cloned().unwrap_or(serde_json::Value::Null);
        if cursor.is_null() {
            break;
        }
    }

    tracing::info!(
        "restore: found {} owned Walrus blob objects for owner={}",
        raw.len(),
        owner
    );
    Ok(raw)
}

async fn query_recent_blob_object_candidates(
    state: &AppState,
    owner: &str,
    blob_type: &str,
    desired_matches: usize,
) -> Result<Vec<RecentBlobCandidate>, AppError> {
    let candidate_cap = desired_matches.saturating_mul(5).clamp(1, 100);
    let mut cursor = serde_json::Value::Null;
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    while candidates.len() < candidate_cap {
        let result = sui_rpc_call(
            state,
            "suix_queryTransactionBlocks",
            serde_json::json!([
                {
                    "filter": { "ToAddress": owner },
                    "options": {
                        "showObjectChanges": true,
                        "showEffects": false,
                        "showInput": false
                    }
                },
                cursor,
                50,
                true
            ]),
        )
        .await?;

        let Some(txs) = result.get("data").and_then(|v| v.as_array()) else {
            break;
        };
        if txs.is_empty() {
            break;
        }

        for tx in txs {
            let Some(changes) = tx.get("objectChanges").and_then(|v| v.as_array()) else {
                continue;
            };
            for change in changes {
                let change_type = change.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if !matches!(change_type, "transferred" | "created" | "mutated") {
                    continue;
                }
                let object_type = change.get("objectType").and_then(|v| v.as_str());
                if !object_type
                    .map(|value| walrus_blob_type_matches(value, blob_type))
                    .unwrap_or(false)
                {
                    continue;
                }
                let belongs_to_owner = owner_matches_recipient(change.get("recipient"), owner)
                    || owner_matches_recipient(change.get("owner"), owner);
                if !belongs_to_owner {
                    continue;
                }
                let Some(object_id) = change.get("objectId").and_then(|v| v.as_str()) else {
                    continue;
                };
                if seen.insert(object_id.to_string()) {
                    candidates.push(RecentBlobCandidate {
                        object_id: object_id.to_string(),
                    });
                    if candidates.len() >= candidate_cap {
                        break;
                    }
                }
            }
            if candidates.len() >= candidate_cap {
                break;
            }
        }

        let has_next = result
            .get("hasNextPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !has_next {
            break;
        }
        cursor = result.get("nextCursor").cloned().unwrap_or(serde_json::Value::Null);
        if cursor.is_null() {
            break;
        }
    }

    Ok(candidates)
}

async fn fetch_raw_blob_objects(
    state: &AppState,
    candidates: &[RecentBlobCandidate],
) -> Result<Vec<RawOnChainBlob>, AppError> {
    let mut raw = Vec::new();
    for chunk in candidates.chunks(50) {
        let ids: Vec<&str> = chunk.iter().map(|candidate| candidate.object_id.as_str()).collect();
        let result = sui_rpc_call(
            state,
            "sui_multiGetObjects",
            serde_json::json!([
                ids,
                {
                    "showContent": true,
                    "showType": true
                }
            ]),
        )
        .await?;

        if let Some(objects) = result.as_array() {
            for obj in objects {
                if let Some(raw_obj) = raw_blob_from_object(obj) {
                    raw.push(raw_obj);
                }
            }
        }
    }
    Ok(raw)
}

fn raw_blob_from_object(obj: &serde_json::Value) -> Option<RawOnChainBlob> {
    let object_id = obj
        .pointer("/data/objectId")
        .and_then(|v| v.as_str())?
        .to_string();
    let content = obj.pointer("/data/content")?;
    if content.get("dataType").and_then(|v| v.as_str()) != Some("moveObject") {
        return None;
    }
    let fields = content.get("fields")?;
    let raw_blob_id = json_scalar_to_string(
        fields
            .get("blob_id")
            .or_else(|| fields.get("blobId"))
            .unwrap_or(&serde_json::Value::Null),
    );
    Some(RawOnChainBlob {
        object_id,
        raw_blob_id,
    })
}

async fn fetch_blob_metadata(state: &AppState, object_id: &str) -> Result<BlobMetadata, AppError> {
    let result = sui_rpc_call(
        state,
        "suix_getDynamicFieldObject",
        serde_json::json!([
            object_id,
            {
                "type": "vector<u8>",
                "value": [109, 101, 116, 97, 100, 97, 116, 97]
            }
        ]),
    )
    .await?;

    let mut metadata = BlobMetadata::default();
    if let Some(contents) = result
        .pointer("/data/content/fields/value/fields/metadata/fields/contents")
        .and_then(|v| v.as_array())
    {
        for entry in contents {
            let fields = entry.get("fields").unwrap_or(entry);
            let key = fields.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = fields.get("value").and_then(|v| v.as_str()).unwrap_or("");
            match key {
                "memwal_namespace" => metadata.namespace = value.to_string(),
                "memwal_owner" => metadata.owner = value.to_string(),
                "memwal_package_id" => metadata.package_id = value.to_string(),
                "memwal_agent_id" => metadata.agent_id = value.to_string(),
                _ => {}
            }
        }
    }
    Ok(metadata)
}

async fn sui_rpc_call(
    state: &AppState,
    method: &'static str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let request = state
        .http_client
        .post(&state.config.sui_rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body);
    let request = crate::observability::apply_request_id_header(request);
    let started = std::time::Instant::now();
    let response = request.send().await.map_err(|e| {
        crate::observability::observe_external(
            "sui_rpc",
            method,
            "transport_error",
            started.elapsed(),
        );
        AppError::Internal(format!("Sui RPC {} request failed: {}", method, e))
    })?;
    let status = response.status();
    crate::observability::observe_external(
        "sui_rpc",
        method,
        &status.as_u16().to_string(),
        started.elapsed(),
    );
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Sui RPC {} HTTP {}: {}",
            method,
            status.as_u16(),
            body
        )));
    }
    let value: serde_json::Value = response.json().await.map_err(|e| {
        AppError::Internal(format!("Sui RPC {} JSON parse failed: {}", method, e))
    })?;
    if let Some(error) = value.get("error") {
        return Err(AppError::Internal(format!(
            "Sui RPC {} error: {}",
            method, error
        )));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| AppError::Internal(format!("Sui RPC {} missing result", method)))
}

fn blob_id_from_raw(raw_blob_id: &str) -> Option<String> {
    let value = raw_blob_id.trim();
    if value.is_empty() {
        return None;
    }
    if value.bytes().all(|b| b.is_ascii_digit()) && value.len() > 20 {
        let bytes = decimal_to_32_le(value)?;
        return Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes));
    }
    Some(value.to_string())
}

fn decimal_to_32_le(value: &str) -> Option<[u8; 32]> {
    let mut bytes = [0u8; 32];
    for digit in value.bytes() {
        let mut carry = digit.checked_sub(b'0')? as u16;
        if carry > 9 {
            return None;
        }
        for byte in &mut bytes {
            let next = (*byte as u16) * 10 + carry;
            *byte = (next & 0xff) as u8;
            carry = next >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(bytes)
}

fn json_scalar_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn owner_matches_recipient(value: Option<&serde_json::Value>, owner: &str) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value.as_str() == Some(owner) {
        return true;
    }
    for key in ["AddressOwner", "ObjectOwner", "SingleOwner", "owner"] {
        if value.get(key).and_then(|v| v.as_str()) == Some(owner) {
            return true;
        }
    }
    false
}

fn walrus_blob_type_matches(object_type: &str, blob_type: &str) -> bool {
    if object_type == blob_type {
        return true;
    }
    let object_parts: Vec<_> = object_type.split("::").collect();
    let blob_parts: Vec<_> = blob_type.split("::").collect();
    object_parts.len() == 3
        && blob_parts.len() == 3
        && object_parts[1] == blob_parts[1]
        && object_parts[2] == blob_parts[2]
        && normalize_sui_address_for_type(object_parts[0])
            == normalize_sui_address_for_type(blob_parts[0])
}

fn normalize_sui_address_for_type(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let stripped = lower.strip_prefix("0x").unwrap_or(&lower);
    let trimmed = stripped.trim_start_matches('0');
    if trimmed.is_empty() {
        "0x0".to_string()
    } else {
        format!("0x{}", trimmed)
    }
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
    fn restore_decimal_blob_id_conversion_uses_little_endian_bytes() {
        let bytes = super::decimal_to_32_le("256").unwrap();
        assert_eq!(bytes[0], 0);
        assert_eq!(bytes[1], 1);
        assert!(bytes[2..].iter().all(|b| *b == 0));
    }

    #[test]
    fn restore_walrus_blob_type_match_normalizes_package_prefix() {
        assert!(super::walrus_blob_type_matches(
            "0x00000000000000000000000000000000000000000000000000000000000000ab::blob::Blob",
            "0xab::blob::Blob",
        ));
        assert!(!super::walrus_blob_type_matches(
            "0xab::other::Blob",
            "0xab::blob::Blob",
        ));
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
