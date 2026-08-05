//! GET /v1/owners/{owner}/namespaces|memories|agents — owner-scoped,
//! cursor-paginated read API (WALM-295). See docs/superpowers/specs/
//! 2026-08-04-memory-read-api-design.md.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use base64::Engine as _;
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;

use crate::types::*;

#[derive(Debug, Serialize)]
pub struct NamespaceSummary {
    pub id: String,
    pub name: String,
    pub memory_count: i64,
    pub storage_used: i64,
}

#[derive(Debug, Serialize)]
pub struct NamespacesResponse {
    pub namespaces: Vec<NamespaceSummary>,
    pub next_cursor: Option<String>,
    pub snapshot_version: u32,
}

#[derive(Debug, Serialize)]
pub struct MemoryItem {
    pub memory_id: String,
    pub namespace_id: String,
    pub blob_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub size: i64,
    pub agent_id: Option<String>,
    pub package_id: Option<String>,
    pub status: String,
    pub end_epoch: Option<i32>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize)]
pub struct MemoriesResponse {
    pub memories: Vec<MemoryItem>,
    pub next_cursor: Option<String>,
    pub snapshot_version: u32,
}

pub const SNAPSHOT_VERSION: u32 = 1;

const DEFAULT_NAMESPACES_LIMIT: i64 = 100;
const MAX_NAMESPACES_LIMIT: i64 = 500;

/// Namespaces' rollup is one row per namespace (`GROUP BY namespace`) with no
/// natural `id` column to tie-break on the way `memories`' `(updated_at, id)`
/// pair does — so the keyset cursor here is the namespace text value itself.
/// (`memories`' `MemoriesCursor` type isn't reused because it carries an
/// `updated_at` field that has no meaning for a rolled-up row spanning many
/// `updated_at` values.)
fn encode_namespace_cursor(namespace: &str) -> String {
    // Same URL_SAFE_NO_PAD rationale as `encode_cursor` above — this value is
    // echoed back verbatim as `next_cursor` and used in a URL query string.
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(namespace.as_bytes())
}

fn decode_namespace_cursor(raw: &str) -> Result<String, AppError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::BadRequest("invalid cursor".to_string()))?;
    String::from_utf8(bytes).map_err(|_| AppError::BadRequest("invalid cursor".to_string()))
}

/// `updated_after`/`cursor` here is a **pagination continuation token**
/// (the opaque `next_cursor` a previous page returned), not a standalone
/// "only namespaces touched since this timestamp" filter — mirroring exactly
/// how `memories`' `updated_after` behaves (see that endpoint's doc note:
/// "must be the opaque next_cursor value ... not a raw timestamp"). The
/// design spec's SQL sketch used `updated_after` as a row-level `WHERE
/// updated_at > $cursor` filter ahead of the `GROUP BY`, which does not
/// compose with real keyset pagination on `namespace` (there is no stable
/// cursor to hand back between pages under that scheme once multiple
/// namespaces share update times). Correct keyset pagination was prioritized
/// as the primary fix; a genuine independent recency filter is not
/// implemented in this pass — see the fix report for the tradeoff.
pub(crate) async fn query_owner_namespaces(
    pool: &PgPool,
    owner: &str,
    cursor: Option<String>,
    limit: i64,
) -> Result<NamespacesResponse, AppError> {
    let limit = limit.clamp(1, MAX_NAMESPACES_LIMIT);
    let cursor_namespace = cursor.as_deref().map(decode_namespace_cursor).transpose()?;

    let rows: Vec<(String, i64, i64)> = if let Some(ref after) = cursor_namespace {
        sqlx::query_as(
            "SELECT namespace, COUNT(*) AS memory_count, COALESCE(SUM(blob_size_bytes), 0)::BIGINT AS storage_used
             FROM vector_entries
             WHERE owner = $1
             GROUP BY namespace
             HAVING namespace > $2
             ORDER BY namespace
             LIMIT $3",
        )
        .bind(owner)
        .bind(after)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT namespace, COUNT(*) AS memory_count, COALESCE(SUM(blob_size_bytes), 0)::BIGINT AS storage_used
             FROM vector_entries
             WHERE owner = $1
             GROUP BY namespace
             ORDER BY namespace
             LIMIT $2",
        )
        .bind(owner)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("Failed to query namespaces: {}", e)))?;

    let has_more = rows.len() as i64 > limit;
    let page: Vec<_> = rows.into_iter().take(limit as usize).collect();

    let next_cursor = if has_more {
        page.last()
            .map(|(name, _, _)| encode_namespace_cursor(name))
    } else {
        None
    };

    let namespaces = page
        .into_iter()
        .map(|(name, memory_count, storage_used)| NamespaceSummary {
            id: name.clone(),
            name,
            memory_count,
            storage_used,
        })
        .collect();

    Ok(NamespacesResponse {
        namespaces,
        next_cursor,
        snapshot_version: SNAPSHOT_VERSION,
    })
}

/// GET /v1/owners/{owner}/namespaces?updated_after=<cursor>&limit=100
pub async fn list_owner_namespaces(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
    params: MemoriesQuery,
) -> Result<Json<NamespacesResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_NAMESPACES_LIMIT);
    if limit < 1 {
        return Err(AppError::BadRequest("limit must be positive".to_string()));
    }
    let result =
        query_owner_namespaces(state.db.pool(), &auth.owner, params.updated_after, limit).await?;
    Ok(Json(result))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct MemoriesCursor {
    updated_at: chrono::DateTime<chrono::Utc>,
    id: String,
}

fn encode_cursor(updated_at: chrono::DateTime<chrono::Utc>, id: &str) -> String {
    let json = serde_json::to_vec(&MemoriesCursor {
        updated_at,
        id: id.to_string(),
    })
    .expect("cursor serializes");
    // URL_SAFE_NO_PAD (not STANDARD): next_cursor is used verbatim in a URL
    // query string per the contract doc. STANDARD emits `+`, `/`, `=`, which
    // corrupt or require percent-encoding most clients won't apply.
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_cursor(raw: &str) -> Result<MemoriesCursor, AppError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| AppError::BadRequest("invalid cursor".to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| AppError::BadRequest("invalid cursor".to_string()))
}

const DEFAULT_MEMORIES_LIMIT: i64 = 100;
const MAX_MEMORIES_LIMIT: i64 = 500;

pub(crate) async fn query_owner_memories(
    pool: &PgPool,
    owner: &str,
    cursor: Option<String>,
    limit: i64,
) -> Result<MemoriesResponse, AppError> {
    let limit = limit.clamp(1, MAX_MEMORIES_LIMIT);

    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
        chrono::DateTime<chrono::Utc>,
        i64,
        Option<String>,
        Option<String>,
        Option<i32>,
        Option<chrono::DateTime<chrono::Utc>>,
    )> = if let Some(raw_cursor) = cursor {
        let c = decode_cursor(&raw_cursor)?;
        sqlx::query_as(
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id, end_epoch, expires_at
             FROM vector_entries
             WHERE owner = $1 AND (updated_at, id) > ($2, $3)
             ORDER BY updated_at, id
             LIMIT $4",
        )
        .bind(owner)
        .bind(c.updated_at)
        .bind(c.id)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id, end_epoch, expires_at
             FROM vector_entries
             WHERE owner = $1
             ORDER BY updated_at, id
             LIMIT $2",
        )
        .bind(owner)
        .bind(limit + 1)
        .fetch_all(pool)
        .await
    }
    .map_err(|e| AppError::Internal(format!("Failed to query memories: {}", e)))?;

    let has_more = rows.len() as i64 > limit;
    let page: Vec<_> = rows.into_iter().take(limit as usize).collect();

    let next_cursor = if has_more {
        page.last().map(|r| encode_cursor(r.4, &r.0))
    } else {
        None
    };

    let memories = page
        .into_iter()
        .map(
            |(
                id,
                namespace,
                blob_id,
                created_at,
                _updated_at,
                size,
                agent_id,
                package_id,
                end_epoch,
                expires_at,
            )| {
                MemoryItem {
                    memory_id: id,
                    namespace_id: namespace,
                    blob_id,
                    created_at,
                    size,
                    agent_id,
                    package_id,
                    status: match expires_at {
                        Some(exp) if exp < chrono::Utc::now() => "expired".to_string(),
                        _ => "active".to_string(), // includes NULL (not yet synced) — optimistic default
                    },
                    end_epoch,
                    expires_at,
                }
            },
        )
        .collect();

    Ok(MemoriesResponse {
        memories,
        next_cursor,
        snapshot_version: SNAPSHOT_VERSION,
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct MemoriesQuery {
    pub updated_after: Option<String>,
    pub limit: Option<i64>,
}

// A plain `axum::extract::Query<MemoriesQuery>` param would reject an
// unparseable `limit` (e.g. `limit=abc`) with Axum's own default
// QueryRejection — a plain-text 400, not this API's `{"error": ...}`
// JSON envelope, and invisible to `record_app_error` metrics. The
// codebase already has a precedent for exactly this problem
// (`SdQuery<T>` in `services/server/src/security_delete_error.rs`,
// mapping `QueryRejection` to that module's own error type) — this
// mirrors the same idea, mapped to `AppError` instead.
impl<S> axum::extract::FromRequestParts<S> for MemoriesQuery
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        axum::extract::Query::<MemoriesQuery>::from_request_parts(parts, state)
            .await
            .map(|axum::extract::Query(q)| q)
            .map_err(|_| AppError::BadRequest("invalid query parameters".to_string()))
    }
}

/// GET /v1/owners/{owner}/memories?updated_after=<cursor>&limit=100
pub async fn list_owner_memories(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
    params: MemoriesQuery,
) -> Result<Json<MemoriesResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_MEMORIES_LIMIT);
    if limit < 1 {
        return Err(AppError::BadRequest("limit must be positive".to_string()));
    }
    let result =
        query_owner_memories(state.db.pool(), &auth.owner, params.updated_after, limit).await?;
    Ok(Json(result))
}

#[derive(Debug, Serialize)]
pub struct DelegateKeyResponse {
    pub label: String,
    pub sui_address: String,
}

#[derive(Debug, Serialize)]
pub struct AgentsResponse {
    pub agents: Vec<DelegateKeyResponse>,
    pub snapshot_version: u32,
}

/// GET /v1/owners/{owner}/agents
pub async fn list_owner_agents(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
) -> Result<Json<AgentsResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    // Short-TTL cached read (WALM-295 design spec: "Cached with the same
    // short TTL pattern as walrus_epoch() ... rather than left uncached") —
    // repeated /agents calls for the same account within the TTL window
    // don't re-hit the chain.
    let keys = crate::storage::sui::list_delegate_keys_cached(
        &state.delegate_keys_cache,
        &state.http_client,
        &state.config.sui_rpc_url,
        &auth.account_id,
        &state.config.package_id,
    )
    .await
    .map_err(|e| AppError::Internal(format!("Failed to list delegate keys: {}", e)))?;

    let agents = keys
        .into_iter()
        .map(|k| DelegateKeyResponse {
            label: k.label,
            sui_address: k.sui_address,
        })
        .collect();

    Ok(Json(AgentsResponse {
        agents,
        snapshot_version: SNAPSHOT_VERSION,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use std::sync::OnceLock;

    // Guards concurrent test threads in THIS module from racing on
    // `CREATE EXTENSION IF NOT EXISTS vector` (001_init.sql) — Postgres
    // does not make that statement safe under concurrent execution
    // despite IF NOT EXISTS (two sessions can both pass the existence
    // check before either commits, then collide on the unique index on
    // pg_extension). Mirrors the same pattern already used in
    // `services/server/src/jobs.rs` (`DB_SETUP_LOCK`) and
    // `services/server/src/storage/db.rs` (`VECTOR_SCHEMA_SETUP_LOCK`).
    static DB_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    fn test_database_url() -> String {
        std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://memwal:memwal_secret@localhost:5432/memwal".into())
    }

    async fn test_pool() -> PgPool {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&test_database_url())
            .await
            .unwrap();
        let _guard = DB_SETUP_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        for migration in [
            include_str!("../../migrations/001_init.sql"),
            include_str!("../../migrations/002_add_namespace.sql"),
            include_str!("../../migrations/003_rate_limiter.sql"),
            include_str!("../../migrations/008_benchmark_plaintext.sql"),
            include_str!("../../migrations/009_importance_signal.sql"),
            include_str!("../../migrations/010_memory_read_api_columns.sql"),
            include_str!("../../migrations/011_memory_read_api_backfill_updated_at.sql"),
            include_str!("../../migrations/012_memory_read_api_updated_at_not_null.sql"),
            include_str!("../../migrations/013_memory_read_api_index.sql"),
            include_str!("../../migrations/014_memory_expiry_columns.sql"),
            include_str!("../../migrations/015_memory_expiry_synced_at_index.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        pool
    }

    /// `next_cursor` is used verbatim in a URL query string per the contract
    /// doc (`?updated_after=<cursor>`) — it must never contain `+`, `/`, or
    /// `=`, which `base64::engine::general_purpose::STANDARD` emits and most
    /// clients won't percent-encode automatically. Search over ids/timestamps
    /// until we find a byte sequence that STANDARD would have encoded with at
    /// least one of those characters, then assert our actual `encode_cursor`
    /// (URL_SAFE_NO_PAD) output round-trips through `decode_cursor` and is
    /// clean of all three.
    #[test]
    fn encode_cursor_is_url_safe_and_round_trips() {
        use base64::Engine as _;

        let mut found_standard_unsafe_case = false;
        for i in 0..500 {
            let id = format!("memory-id-{i}-{}", uuid::Uuid::new_v4());
            let updated_at =
                chrono::DateTime::from_timestamp(1_700_000_000 + i, (i as u32) * 137).unwrap();

            // Sanity check: prove this fixture would have been unsafe under
            // the old STANDARD engine, so the test is actually exercising the
            // bug, not just trivially passing on inputs that never collide.
            let json = serde_json::to_vec(&MemoriesCursor {
                updated_at,
                id: id.clone(),
            })
            .expect("cursor serializes");
            let standard_encoded = base64::engine::general_purpose::STANDARD.encode(&json);
            if standard_encoded.contains('+')
                || standard_encoded.contains('/')
                || standard_encoded.contains('=')
            {
                found_standard_unsafe_case = true;
            }

            let encoded = encode_cursor(updated_at, &id);
            assert!(
                !encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='),
                "encoded cursor must be URL-safe with no padding, got: {}",
                encoded
            );

            let decoded = decode_cursor(&encoded).expect("round-trips");
            assert_eq!(decoded.id, id);
            assert_eq!(decoded.updated_at, updated_at);
        }

        assert!(
            found_standard_unsafe_case,
            "fixture sweep never produced a STANDARD-unsafe cursor — test would not \
             have caught the regression this fix addresses"
        );
    }

    #[tokio::test]
    async fn query_owner_namespaces_rolls_up_counts_and_bytes() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for (id, ns, size) in [
            ("m1", "work", 100i64),
            ("m2", "work", 200i64),
            ("m3", "personal", 50i64),
        ] {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(format!("{}-{}", owner, id))
            .bind(&owner)
            .bind(ns)
            .bind(format!("blob-{}", id))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(size)
            .execute(&pool)
            .await
            .unwrap();
        }

        let result = query_owner_namespaces(&pool, &owner, None, 100)
            .await
            .unwrap();
        let mut sorted = result.namespaces;
        sorted.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(sorted.len(), 2);
        assert_eq!(sorted[0].name, "personal");
        assert_eq!(sorted[0].memory_count, 1);
        assert_eq!(sorted[0].storage_used, 50);
        assert_eq!(sorted[1].name, "work");
        assert_eq!(sorted[1].memory_count, 2);
        assert_eq!(sorted[1].storage_used, 300);
        assert!(
            result.next_cursor.is_none(),
            "single page must not paginate"
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_namespaces_empty_for_unknown_owner() {
        let pool = test_pool().await;
        let result = query_owner_namespaces(&pool, "0xnobody-here", None, 100)
            .await
            .unwrap();
        assert!(result.namespaces.is_empty());
        assert!(result.next_cursor.is_none());
    }

    /// Mirrors `query_owner_memories_paginates_by_updated_at_and_id`'s style:
    /// seed multiple namespaces for one owner, paginate with a small limit
    /// using the namespace-text keyset cursor, and assert the union of all
    /// pages equals the full set exactly once (no gaps, no duplicates).
    #[tokio::test]
    async fn query_owner_namespaces_paginates_by_namespace_cursor() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        // 5 distinct namespaces, alphabetically: alpha, bravo, charlie, delta, echo.
        for ns in ["alpha", "bravo", "charlie", "delta", "echo"] {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(format!("{}-{}", owner, ns))
            .bind(&owner)
            .bind(ns)
            .bind(format!("blob-{}", ns))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(10_i64)
            .execute(&pool)
            .await
            .unwrap();
        }

        let mut all_names: Vec<String> = Vec::new();
        let mut cursor = None;
        loop {
            let page = query_owner_namespaces(&pool, &owner, cursor.clone(), 2)
                .await
                .unwrap();
            assert!(page.namespaces.len() <= 2);
            all_names.extend(page.namespaces.iter().map(|n| n.name.clone()));
            cursor = page.next_cursor.clone();
            if cursor.is_none() {
                break;
            }
        }

        let mut sorted = all_names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted,
            vec!["alpha", "bravo", "charlie", "delta", "echo"],
            "pagination must not skip or duplicate namespaces, got {:?}",
            all_names
        );
        // Also verify ordering was preserved across page boundaries (not
        // just that the union matched — a shuffled union would still pass
        // the assertion above).
        assert_eq!(all_names, sorted);

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_memories_paginates_by_updated_at_and_id() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for i in 0..5 {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, agent_id, package_id)
                 VALUES ($1, $2, 'default', $3, $4, $5, $6, $7)",
            )
            .bind(format!("{}-m{}", owner, i))
            .bind(&owner)
            .bind(format!("blob-{}", i))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(10_i64)
            .bind(format!("agent-{}", i))
            .bind("0xpkg")
            .execute(&pool)
            .await
            .unwrap();
        }

        let page1 = query_owner_memories(&pool, &owner, None, 2).await.unwrap();
        assert_eq!(page1.memories.len(), 2);
        assert!(page1.next_cursor.is_some());

        let page2 = query_owner_memories(&pool, &owner, page1.next_cursor.clone(), 2)
            .await
            .unwrap();
        assert_eq!(page2.memories.len(), 2);

        let page3 = query_owner_memories(&pool, &owner, page2.next_cursor.clone(), 2)
            .await
            .unwrap();
        assert_eq!(page3.memories.len(), 1);
        assert!(page3.next_cursor.is_none());

        let mut all_ids: Vec<String> = page1
            .memories
            .iter()
            .chain(page2.memories.iter())
            .chain(page3.memories.iter())
            .map(|m| m.memory_id.clone())
            .collect();
        all_ids.sort();
        all_ids.dedup();
        assert_eq!(
            all_ids.len(),
            5,
            "pagination must not skip or duplicate rows"
        );

        assert_eq!(page1.memories[0].agent_id.as_deref(), Some("agent-0"));
        assert_eq!(page1.memories[0].status, "active");

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_memories_handles_updated_at_tie_via_id_tiebreak() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        for i in 0..3 {
            sqlx::query(
                "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
                 VALUES ($1, $2, 'default', $3, $4, $5)",
            )
            .bind(format!("{}-t{}", owner, i))
            .bind(&owner)
            .bind(format!("blob-t{}", i))
            .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .bind(10_i64)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Force all 3 rows to the exact same updated_at — a real tie,
        // not just three inserts close in time.
        let tied_at = chrono::Utc::now();
        sqlx::query("UPDATE vector_entries SET updated_at = $1 WHERE owner = $2")
            .bind(tied_at)
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();

        let mut seen = Vec::new();
        let mut cursor = None;
        for _ in 0..5 {
            let page = query_owner_memories(&pool, &owner, cursor.clone(), 1)
                .await
                .unwrap();
            if page.memories.is_empty() {
                break;
            }
            seen.push(page.memories[0].memory_id.clone());
            cursor = page.next_cursor.clone();
            if cursor.is_none() {
                break;
            }
        }

        seen.sort();
        seen.dedup();
        assert_eq!(
            seen.len(),
            3,
            "all 3 tied rows must appear exactly once across pages, got {:?}",
            seen
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_memories_derives_status_from_expires_at() {
        let pool = test_pool().await;
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        // Row 1: expired (expires_at in the past)
        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, end_epoch, expires_at)
             VALUES ($1, $2, 'default', 'blob-expired', $3, 10, 100, NOW() - INTERVAL '1 day')",
        )
        .bind(format!("{}-expired", owner))
        .bind(&owner)
        .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
        .execute(&pool)
        .await
        .unwrap();

        // Row 2: active (expires_at in the future)
        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, end_epoch, expires_at)
             VALUES ($1, $2, 'default', 'blob-active', $3, 10, 900, NOW() + INTERVAL '30 days')",
        )
        .bind(format!("{}-active", owner))
        .bind(&owner)
        .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
        .execute(&pool)
        .await
        .unwrap();

        // Row 3: not yet synced (NULL expires_at)
        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
             VALUES ($1, $2, 'default', 'blob-unsynced', $3, 10)",
        )
        .bind(format!("{}-unsynced", owner))
        .bind(&owner)
        .bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
        .execute(&pool)
        .await
        .unwrap();

        let result = query_owner_memories(&pool, &owner, None, 10).await.unwrap();
        let by_blob: std::collections::HashMap<_, _> = result
            .memories
            .iter()
            .map(|m| (m.blob_id.clone(), m))
            .collect();

        assert_eq!(by_blob["blob-expired"].status, "expired");
        assert_eq!(by_blob["blob-active"].status, "active");
        assert_eq!(by_blob["blob-unsynced"].status, "active"); // optimistic default pending sync
        assert_eq!(by_blob["blob-active"].end_epoch, Some(900));
        assert!(by_blob["blob-active"].expires_at.is_some());
        assert_eq!(by_blob["blob-unsynced"].end_epoch, None);
        assert_eq!(by_blob["blob-unsynced"].expires_at, None);

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }
}
