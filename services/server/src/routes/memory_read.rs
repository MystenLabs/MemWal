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
}
