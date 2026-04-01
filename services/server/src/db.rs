use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::types::{AppError, SearchHit};

pub struct VectorDb {
    pool: PgPool,
}

impl VectorDb {
    /// Initialize database connection pool and run migrations
    pub async fn new(database_url: &str) -> Result<Self, AppError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to connect to database: {}", e)))?;

        // Run migrations
        let migration_001 = include_str!("../migrations/001_init.sql");
        sqlx::raw_sql(migration_001)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 001: {}", e)))?;

        let migration_002 = include_str!("../migrations/002_add_namespace.sql");
        sqlx::raw_sql(migration_002)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 002: {}", e)))?;

        let migration_003 = include_str!("../migrations/003_rate_limiter.sql");
        sqlx::raw_sql(migration_003)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 003: {}", e)))?;

        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Insert a vector entry (with blob size tracking for storage quota)
    pub async fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        tracing::debug!("inserted vector: id={}, blob_id={}, owner={}, ns={}, size={}B", id, blob_id, owner, namespace, blob_size_bytes);
        Ok(())
    }

    /// Search for similar vectors using pgvector cosine distance (<=>)
    /// Returns blob_id and distance for each match
    pub async fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        let embedding = Vector::from(query_vector.to_vec());

        let rows: Vec<(String, f64)> = sqlx::query_as(
            "SELECT blob_id, (embedding <=> $1)::float8 AS distance
             FROM vector_entries
             WHERE owner = $2 AND namespace = $3
             ORDER BY embedding <=> $1
             LIMIT $4",
        )
        .bind(embedding)
        .bind(owner)
        .bind(namespace)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to search vectors: {}", e)))?;

        let results = rows
            .into_iter()
            .map(|(blob_id, distance)| SearchHit { blob_id, distance })
            .collect();

        Ok(results)
    }

    /// Get all blob_ids for a given owner + namespace (used by restore flow)
    pub async fn get_blobs_by_namespace(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<Vec<String>, AppError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT blob_id FROM vector_entries
             WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get blobs by namespace: {}", e)))?;

        Ok(rows.into_iter().map(|(blob_id,)| blob_id).collect())
    }

    /// Delete all vector entries for a given owner + namespace
    #[allow(dead_code)]
    pub async fn delete_by_namespace(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<u64, AppError> {
        let result = sqlx::query(
            "DELETE FROM vector_entries WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to delete by namespace: {}", e)))?;

        let rows = result.rows_affected();
        tracing::info!("deleted {} entries for owner={}, ns={}", rows, owner, namespace);
        Ok(rows)
    }

    /// Delete a vector entry by blob_id (used for expired blob cleanup).
    /// Called reactively when Walrus returns 404 during blob download.
    pub async fn delete_by_blob_id(&self, blob_id: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM vector_entries WHERE blob_id = $1")
            .bind(blob_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete vector by blob_id: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("deleted expired blob from DB: blob_id={}, rows={}", blob_id, rows);
        }
        Ok(rows)
    }

    // ============================================================
    // Delegate Key Cache
    // ============================================================

    /// Look up cached account info for a delegate public key.
    /// Returns `Some((account_id, owner))` if found.
    pub async fn get_cached_account(
        &self,
        public_key_hex: &str,
    ) -> Result<Option<(String, String)>, AppError> {
        let result: Option<(String, String)> = sqlx::query_as(
            "SELECT account_id, owner FROM delegate_key_cache WHERE public_key = $1",
        )
        .bind(public_key_hex)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query cache: {}", e)))?;

        Ok(result)
    }

    /// Cache a verified delegate key → account mapping.
    pub async fn cache_delegate_key(
        &self,
        public_key_hex: &str,
        account_id: &str,
        owner: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO delegate_key_cache (public_key, account_id, owner)
             VALUES ($1, $2, $3)
             ON CONFLICT (public_key)
             DO UPDATE SET account_id = $2, owner = $3, cached_at = NOW()",
        )
        .bind(public_key_hex)
        .bind(account_id)
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to cache delegate key: {}", e)))?;

        tracing::debug!("cached delegate key: {} -> account {}", public_key_hex, account_id);
        Ok(())
    }

    // ============================================================
    // Storage Quota (still PostgreSQL — tracks per-row blob sizes)
    // ============================================================

    /// Get total storage used by a user (sum of blob_size_bytes for active entries).
    pub async fn get_storage_used(&self, owner: &str) -> Result<i64, AppError> {
        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        Ok(row.0)
    }

    // ============================================================
    // Accounts (populated by v2-indexer)
    // ============================================================

    /// Find an account by owner address (from indexed accounts table).
    /// Returns `Some(account_id)` if the owner has a registered account.
    #[allow(dead_code)]
    pub async fn find_account_by_owner(
        &self,
        owner: &str,
    ) -> Result<Option<String>, AppError> {
        let result: Option<(String,)> = sqlx::query_as(
            "SELECT account_id FROM accounts WHERE owner = $1",
        )
        .bind(owner)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query accounts: {}", e)))?;

        Ok(result.map(|(id,)| id))
    }
}
