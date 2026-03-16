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

        // Run migration
        let migration_sql = include_str!("../migrations/001_init.sql");
        sqlx::raw_sql(migration_sql)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migrations: {}", e)))?;

        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Insert a vector entry
    pub async fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        blob_id: &str,
        vector: &[f32],
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        sqlx::query(
            "INSERT INTO vector_entries (id, owner, blob_id, embedding)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(id)
        .bind(owner)
        .bind(blob_id)
        .bind(embedding)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        tracing::debug!("inserted vector: id={}, blob_id={}, owner={}", id, blob_id, owner);
        Ok(())
    }

    /// Search for similar vectors using pgvector cosine distance (<=>)
    /// Returns blob_id and distance for each match
    pub async fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        let embedding = Vector::from(query_vector.to_vec());

        let rows: Vec<(String, f64)> = sqlx::query_as(
            "SELECT blob_id, (embedding <=> $1)::float8 AS distance
             FROM vector_entries
             WHERE owner = $2
             ORDER BY embedding <=> $1
             LIMIT $3",
        )
        .bind(embedding)
        .bind(owner)
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
