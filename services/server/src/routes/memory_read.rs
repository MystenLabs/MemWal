//! GET /v1/owners/{owner}/namespaces|memories|agents — owner-scoped,
//! cursor-paginated read API (WALM-295). See docs/superpowers/specs/
//! 2026-08-04-memory-read-api-design.md.

use axum::extract::{Path, State};
use axum::{Extension, Json};
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
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MemoriesResponse {
    pub memories: Vec<MemoryItem>,
    pub next_cursor: Option<String>,
    pub snapshot_version: u32,
}

pub const SNAPSHOT_VERSION: u32 = 1;

pub(crate) async fn query_owner_namespaces(
    pool: &PgPool,
    owner: &str,
) -> Result<NamespacesResponse, AppError> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT namespace, COUNT(*) AS memory_count, COALESCE(SUM(blob_size_bytes), 0)::BIGINT AS storage_used
         FROM vector_entries WHERE owner = $1 GROUP BY namespace ORDER BY namespace",
    )
    .bind(owner)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(format!("Failed to query namespaces: {}", e)))?;

    let namespaces = rows
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
        snapshot_version: SNAPSHOT_VERSION,
    })
}

/// GET /v1/owners/{owner}/namespaces
pub async fn list_owner_namespaces(
    State(state): State<Arc<AppState>>,
    Extension(auth): Extension<AuthInfo>,
    Path(path_owner): Path<String>,
) -> Result<Json<NamespacesResponse>, AppError> {
    if auth.owner != path_owner {
        return Err(AppError::Forbidden("owner mismatch".to_string()));
    }
    let result = query_owner_namespaces(state.db.pool(), &auth.owner).await?;
    Ok(Json(result))
}

use base64::Engine as _;

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
    base64::engine::general_purpose::STANDARD.encode(json)
}

fn decode_cursor(raw: &str) -> Result<MemoriesCursor, AppError> {
    let bytes = base64::engine::general_purpose::STANDARD
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
    )> = if let Some(raw_cursor) = cursor {
        let c = decode_cursor(&raw_cursor)?;
        sqlx::query_as(
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id
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
            "SELECT id, namespace, blob_id, created_at, updated_at, blob_size_bytes, agent_id, package_id
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
            |(id, namespace, blob_id, created_at, _updated_at, size, agent_id, package_id)| {
                MemoryItem {
                    memory_id: id,
                    namespace_id: namespace,
                    blob_id,
                    created_at,
                    size,
                    agent_id,
                    package_id,
                    // Always "active" until Plan B (WALM-296) adds expires_at
                    // and derives this from it.
                    status: "active",
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
    let result = query_owner_memories(state.db.pool(), &auth.owner, params.updated_after, limit).await?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

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
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        pool
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

        let result = query_owner_namespaces(&pool, &owner).await.unwrap();
        let mut sorted = result.namespaces;
        sorted.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(sorted.len(), 2);
        assert_eq!(sorted[0].name, "personal");
        assert_eq!(sorted[0].memory_count, 1);
        assert_eq!(sorted[0].storage_used, 50);
        assert_eq!(sorted[1].name, "work");
        assert_eq!(sorted[1].memory_count, 2);
        assert_eq!(sorted[1].storage_used, 300);

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn query_owner_namespaces_empty_for_unknown_owner() {
        let pool = test_pool().await;
        let result = query_owner_namespaces(&pool, "0xnobody-here")
            .await
            .unwrap();
        assert!(result.namespaces.is_empty());
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
        assert_eq!(all_ids.len(), 5, "pagination must not skip or duplicate rows");

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
}
