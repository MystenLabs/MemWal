use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};

use crate::types::{AppError, SearchHit};

/// Metadata for enriched memory insertion
pub struct InsertMemoryMeta {
    pub memory_type: String,
    pub importance: f32,
    pub source: String,
    pub metadata: serde_json::Value,
    pub content_hash: Option<String>,
}

impl Default for InsertMemoryMeta {
    fn default() -> Self {
        Self {
            memory_type: "fact".to_string(),
            importance: 0.5,
            source: "user".to_string(),
            metadata: serde_json::json!({}),
            content_hash: None,
        }
    }
}

/// An existing memory entry for consolidation comparison
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ExistingMemory {
    pub id: String,
    pub blob_id: String,
    pub distance: f64,
    pub blob_size_bytes: i64,
    pub memory_type: Option<String>,
    pub importance: Option<f32>,
}

/// Info returned by find_by_content_hash_full for duplicate detection.
/// Contains the stored values so responses reflect actual DB state.
#[derive(Debug, Clone)]
pub struct DuplicateInfo {
    pub id: String,
    pub memory_type: String,
    pub importance: f32,
}

/// Memory statistics returned by get_memory_stats
#[derive(Debug)]
pub struct MemoryStats {
    pub total: usize,
    pub by_type: std::collections::HashMap<String, usize>,
    pub avg_importance: f64,
    pub oldest_memory: Option<String>,
    pub newest_memory: Option<String>,
    pub total_access_count: i64,
    pub storage_bytes: i64,
}

pub struct VectorDb {
    pool: PgPool,
}

impl VectorDb {
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

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

        let migration_004 = include_str!("../migrations/004_memory_structure.sql");
        sqlx::raw_sql(migration_004)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 004: {}", e)))?;

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
        self.insert_vector_enriched(id, owner, namespace, blob_id, vector, blob_size_bytes, InsertMemoryMeta::default()).await.map(|_| ())
    }

    /// Insert a vector entry with enriched metadata.
    /// Uses ON CONFLICT on the unique content_hash index (active rows) to
    /// handle concurrent duplicate inserts safely — the losing writer
    /// bumps access_count instead of inserting a duplicate row.
    /// Returns `(is_new, id, blob_id)`. If `is_new` is false, the returned `id` and `blob_id`
    /// are from the existing memory.
    pub async fn insert_vector_enriched(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
        meta: InsertMemoryMeta,
    ) -> Result<(bool, String, String), AppError> {
        let embedding = Vector::from(vector.to_vec());

        // ON CONFLICT targets idx_ve_content_hash_active
        // RETURNING id, blob_id lets us grab the actual row (inserted or updated).
        let row: (String, String) = sqlx::query_as(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, memory_type, importance, source, metadata, content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (owner, namespace, content_hash)
             WHERE content_hash IS NOT NULL AND valid_until IS NULL AND superseded_by IS NULL
             DO UPDATE SET access_count = vector_entries.access_count + 1,
                           last_accessed_at = NOW()
             RETURNING id, blob_id",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(&meta.memory_type)
        .bind(meta.importance)
        .bind(&meta.source)
        .bind(&meta.metadata)
        .bind(&meta.content_hash)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)))?;

        // If the returned ID matches our generated ID, it was a fresh insert.
        // If not, it means the ON CONFLICT UPDATE returned the existing row.
        let actual_id = row.0;
        let actual_blob_id = row.1;
        let is_new = actual_id == id;

        tracing::debug!("inserted vector: is_new={}, id={}, blob_id={}, owner={}, ns={}, type={}, importance={:.2}",
            is_new, actual_id, actual_blob_id, owner, namespace, meta.memory_type, meta.importance);
        Ok((is_new, actual_id, actual_blob_id))
    }

    /// Insert a vector entry within an existing transaction.
    /// This is used for reserve-then-upload flows so duplicate content hashes
    /// can be serialized before the Walrus upload happens.
    pub async fn insert_vector_enriched_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
        meta: InsertMemoryMeta,
    ) -> Result<(bool, String, String), AppError> {
        let embedding = Vector::from(vector.to_vec());

        let row: (String, String) = sqlx::query_as(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, memory_type, importance, source, metadata, content_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (owner, namespace, content_hash)
             WHERE content_hash IS NOT NULL AND valid_until IS NULL AND superseded_by IS NULL
             DO UPDATE SET access_count = vector_entries.access_count + 1,
                           last_accessed_at = NOW()
             RETURNING id, blob_id",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(&meta.memory_type)
        .bind(meta.importance)
        .bind(&meta.source)
        .bind(&meta.metadata)
        .bind(&meta.content_hash)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector in tx: {}", e)))?;

        let actual_id = row.0;
        let actual_blob_id = row.1;
        let is_new = actual_id == id;
        Ok((is_new, actual_id, actual_blob_id))
    }

    /// Update blob_id inside an active transaction.
    pub async fn update_blob_id_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: &str,
        blob_id: &str,
    ) -> Result<(), AppError> {
        sqlx::query("UPDATE vector_entries SET blob_id = $2 WHERE id = $1")
            .bind(id)
            .bind(blob_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to finalize blob_id: {}", e)))?;
        Ok(())
    }

    /// Search for similar vectors using pgvector cosine distance (<=>)
    /// Returns blob_id, distance, and enriched metadata for composite scoring.
    /// By default, excludes expired/superseded memories.
    pub async fn search_similar(
        &self,
        query_vector: &[f32],
        owner: &str,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        self.search_similar_filtered(query_vector, owner, namespace, limit, true, None, None).await
    }

    /// Search with full filtering options (type filter, importance threshold, expired inclusion)
    pub async fn search_similar_filtered(
        &self,
        query_vector: &[f32],
        owner: &str,
        namespace: &str,
        limit: usize,
        exclude_expired: bool,
        memory_types: Option<&[String]>,
        min_importance: Option<f32>,
    ) -> Result<Vec<SearchHit>, AppError> {
        let embedding = Vector::from(query_vector.to_vec());

        // Build dynamic query with optional filters
        let mut conditions = vec![
            "owner = $2".to_string(),
            "namespace = $3".to_string(),
        ];
        if exclude_expired {
            conditions.push("(valid_until IS NULL AND superseded_by IS NULL)".to_string());
        }
        if let Some(types) = memory_types {
            if !types.is_empty() {
                let type_list: Vec<String> = types.iter().map(|t| format!("'{}'", t.replace('\'', "''"))).collect();
                conditions.push(format!("memory_type IN ({})", type_list.join(",")));
            }
        }
        if let Some(min_imp) = min_importance {
            conditions.push(format!("importance >= {}", min_imp));
        }

        let where_clause = conditions.join(" AND ");
        let query = format!(
            "SELECT id, blob_id, (embedding <=> $1)::float8 AS distance, \
             memory_type, importance::float4, created_at::text, access_count \
             FROM vector_entries \
             WHERE {} \
             ORDER BY embedding <=> $1 \
             LIMIT $4",
            where_clause
        );

        let rows: Vec<(String, String, f64, Option<String>, Option<f32>, Option<String>, Option<i32>)> = sqlx::query_as(&query)
            .bind(embedding)
            .bind(owner)
            .bind(namespace)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to search vectors: {}", e)))?;

        let results = rows
            .into_iter()
            .map(|(id, blob_id, distance, memory_type, importance, created_at, access_count)| SearchHit {
                id,
                blob_id,
                distance,
                memory_type,
                importance,
                created_at,
                access_count,
            })
            .collect();

        Ok(results)
    }

    /// Find semantically similar existing memories for consolidation.
    /// Returns memories within a distance threshold for comparison.
    pub async fn find_similar_existing(
        &self,
        vector: &[f32],
        owner: &str,
        namespace: &str,
        threshold: f64,
        limit: usize,
    ) -> Result<Vec<ExistingMemory>, AppError> {
        let embedding = Vector::from(vector.to_vec());

        let rows: Vec<(String, String, f64, i64, Option<String>, Option<f32>)> = sqlx::query_as(
            "SELECT id, blob_id, (embedding <=> $1)::float8 AS distance, blob_size_bytes, memory_type, importance::float4 \
             FROM vector_entries \
             WHERE owner = $2 AND namespace = $3 \
               AND valid_until IS NULL AND superseded_by IS NULL \
               AND (embedding <=> $1)::float8 < $4 \
             ORDER BY embedding <=> $1 \
             LIMIT $5",
        )
        .bind(embedding)
        .bind(owner)
        .bind(namespace)
        .bind(threshold)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to find similar existing: {}", e)))?;

        Ok(rows.into_iter().map(|(id, blob_id, distance, blob_size_bytes, memory_type, importance)| ExistingMemory {
            id, blob_id, distance, blob_size_bytes, memory_type, importance,
        }).collect())
    }

    /// Check if an exact duplicate exists by content hash.
    /// Returns (id, blob_id) so callers can return consistent mapping.
    pub async fn find_by_content_hash(
        &self,
        owner: &str,
        namespace: &str,
        content_hash: &str,
    ) -> Result<Option<(String, String)>, AppError> {
        let result: Option<(String, String)> = sqlx::query_as(
            "SELECT id, blob_id FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND content_hash = $3 \
               AND valid_until IS NULL AND superseded_by IS NULL \
             LIMIT 1",
        )
        .bind(owner)
        .bind(namespace)
        .bind(content_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to check content hash: {}", e)))?;

        Ok(result)
    }

    /// Extended duplicate check: returns full metadata (id, blob_id, memory_type, importance)
    /// so that duplicate responses can return the stored values instead of request values.
    pub async fn find_by_content_hash_full(
        &self,
        owner: &str,
        namespace: &str,
        content_hash: &str,
    ) -> Result<Option<(DuplicateInfo, String)>, AppError> {
        let result: Option<(String, String, Option<String>, Option<f32>)> = sqlx::query_as(
            "SELECT id, blob_id, memory_type, importance::float4 FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND content_hash = $3 \
               AND valid_until IS NULL AND superseded_by IS NULL \
             LIMIT 1",
        )
        .bind(owner)
        .bind(namespace)
        .bind(content_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to check content hash: {}", e)))?;

        Ok(result.map(|(id, blob_id, memory_type, importance)| {
            (DuplicateInfo {
                id,
                memory_type: memory_type.unwrap_or_else(|| "fact".to_string()),
                importance: importance.unwrap_or(0.5),
            }, blob_id)
        }))
    }

    /// Soft-invalidate a memory (mark as superseded by a newer version)
    pub async fn supersede_memory(
        &self,
        old_id: &str,
        new_id: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE vector_entries SET superseded_by = $2, valid_until = NOW() WHERE id = $1",
        )
        .bind(old_id)
        .bind(new_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to supersede memory: {}", e)))?;

        tracing::info!("superseded memory {} -> {}", old_id, new_id);
        Ok(())
    }

    /// Bump access_count and last_accessed_at for a memory
    pub async fn touch_memory(&self, id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE vector_entries SET access_count = access_count + 1, last_accessed_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to touch memory: {}", e)))?;

        Ok(())
    }

    /// Bump access_count and last_accessed_at for a memory by blob_id
    #[allow(dead_code)]
    pub async fn touch_by_blob_id(&self, blob_id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE vector_entries SET access_count = access_count + 1, last_accessed_at = NOW() WHERE blob_id = $1",
        )
        .bind(blob_id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to touch memory by blob_id: {}", e)))?;

        Ok(())
    }

    /// Soft-delete a memory (set valid_until to now)
    pub async fn soft_delete_memory(&self, id: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE vector_entries SET valid_until = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to soft delete memory: {}", e)))?;

        tracing::info!("soft-deleted memory {}", id);
        Ok(())
    }

    /// Get memory statistics for an owner + namespace
    pub async fn get_memory_stats(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<MemoryStats, AppError> {
        // Total active memories
        let (total,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM vector_entries WHERE owner = $1 AND namespace = $2 AND valid_until IS NULL AND superseded_by IS NULL",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to count memories: {}", e)))?;

        // Count by type
        let type_rows: Vec<(Option<String>, i64)> = sqlx::query_as(
            "SELECT memory_type, COUNT(*) FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND valid_until IS NULL AND superseded_by IS NULL \
             GROUP BY memory_type",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to count by type: {}", e)))?;

        let by_type: std::collections::HashMap<String, usize> = type_rows
            .into_iter()
            .map(|(t, c)| (t.unwrap_or_else(|| "fact".to_string()), c as usize))
            .collect();

        // Avg importance, total access count
        let (avg_importance, total_access): (Option<f64>, Option<i64>) = sqlx::query_as(
            "SELECT AVG(importance)::float8, SUM(access_count)::bigint FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND valid_until IS NULL AND superseded_by IS NULL",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get memory stats: {}", e)))?;

        // Oldest and newest
        let (oldest, newest): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT MIN(created_at)::text, MAX(created_at)::text FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND valid_until IS NULL AND superseded_by IS NULL",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get memory dates: {}", e)))?;

        // Storage bytes
        let (storage,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 AND valid_until IS NULL AND superseded_by IS NULL",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage: {}", e)))?;

        Ok(MemoryStats {
            total: total as usize,
            by_type,
            avg_importance: avg_importance.unwrap_or(0.0),
            oldest_memory: oldest,
            newest_memory: newest,
            total_access_count: total_access.unwrap_or(0),
            storage_bytes: storage,
        })
    }

    /// Get all active memories for a given owner + namespace (used by consolidation).
    /// Returns memories with their IDs, blob_ids, embeddings, and metadata.
    pub async fn get_active_memories(
        &self,
        owner: &str,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<ExistingMemory>, AppError> {
        let rows: Vec<(String, String, i64, Option<String>, Option<f32>)> = sqlx::query_as(
            "SELECT id, blob_id, blob_size_bytes, memory_type, importance::float4 \
             FROM vector_entries \
             WHERE owner = $1 AND namespace = $2 \
               AND valid_until IS NULL AND superseded_by IS NULL \
             ORDER BY created_at ASC \
             LIMIT $3",
        )
        .bind(owner)
        .bind(namespace)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get active memories: {}", e)))?;

        Ok(rows.into_iter().map(|(id, blob_id, blob_size_bytes, memory_type, importance)| ExistingMemory {
            id, blob_id, distance: 0.0, blob_size_bytes, memory_type, importance,
        }).collect())
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

    /// Get total storage used by a user (sum of blob_size_bytes for active entries only).
    /// Excludes soft-deleted (valid_until set) and superseded entries so that
    /// forget/supersede properly free up quota.
    pub async fn get_storage_used(&self, owner: &str) -> Result<i64, AppError> {
        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries \
             WHERE owner = $1 AND valid_until IS NULL AND superseded_by IS NULL",
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
