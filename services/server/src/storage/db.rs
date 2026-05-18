use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::types::{AppError, SearchHit};

pub struct VectorDb {
    pool: PgPool,
}

fn db_status<T>(result: &Result<T, AppError>) -> &'static str {
    if result.is_ok() {
        "ok"
    } else {
        "error"
    }
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
        let migration_001 = include_str!("../../migrations/001_init.sql");
        sqlx::raw_sql(migration_001)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 001: {}", e)))?;

        let migration_002 = include_str!("../../migrations/002_add_namespace.sql");
        sqlx::raw_sql(migration_002)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 002: {}", e)))?;

        let migration_003 = include_str!("../../migrations/003_rate_limiter.sql");
        sqlx::raw_sql(migration_003)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 003: {}", e)))?;

        let migration_004 = include_str!("../../migrations/004_delegate_key_cache_expires.sql");
        sqlx::raw_sql(migration_004)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 004: {}", e)))?;

        let migration_005 = include_str!("../../migrations/005_remember_jobs.sql");
        sqlx::raw_sql(migration_005)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 005: {}", e)))?;

        // ENG-1408: composite index on (owner, status, updated_at DESC) for bulk poll
        let migration_006 = include_str!("../../migrations/006_bulk_remember.sql");
        sqlx::raw_sql(migration_006)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 006: {}", e)))?;

        // MEM-35: collapse per-wallet Apalis queues to a single `wallet_jobs`
        // queue. Equivocation locks are no longer a practical concern on Sui
        // (per Will Bradley, Mysten, 2026-05-12); concurrent workers on one
        // wallet + retry handling is sufficient.
        let migration_007 = include_str!("../../migrations/007_collapse_wallet_queues.sql");
        sqlx::raw_sql(migration_007)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 007: {}", e)))?;

        // ENG-1747: nullable `plaintext` column for benchmark-mode storage
        // (PlaintextEngine). NULL for all production rows — additive.
        // Renumbered from 007 → 008 during rebase onto dev to avoid collision
        // with MEM-35's 007_collapse_wallet_queues.sql.
        let migration_008 = include_str!("../../migrations/008_benchmark_plaintext.sql");
        sqlx::raw_sql(migration_008)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 008: {}", e)))?;

        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Expose a reference to the underlying `PgPool` so job handlers
    /// can run ad-hoc queries (e.g. `remember_jobs` status updates).
    pub fn pool(&self) -> &PgPool {
        &self.pool
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

        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
                owner = EXCLUDED.owner,
                namespace = EXCLUDED.namespace,
                blob_id = EXCLUDED.blob_id,
                embedding = EXCLUDED.embedding,
                blob_size_bytes = EXCLUDED.blob_size_bytes",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)));
        crate::observability::observe_db("vector.insert", db_status(&result), started.elapsed());
        result?;

        tracing::debug!(
            "inserted vector: id={}, blob_id={}, owner={}, ns={}, size={}B",
            id,
            blob_id,
            owner,
            namespace,
            blob_size_bytes
        );
        Ok(())
    }

    /// Insert a vector entry with its plaintext (benchmark mode only —
    /// PlaintextEngine). Production rows never use this; they go through
    /// `insert_vector` and leave the `plaintext` column NULL.
    ///
    /// BENCHMARK MODE IS NOT FOR PRODUCTION USE — storing plaintext
    /// memories defeats SEAL's confidentiality guarantee.
    pub async fn insert_vector_plaintext(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        plaintext: &str,
        blob_size_bytes: i64,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, plaintext)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
                owner = EXCLUDED.owner,
                namespace = EXCLUDED.namespace,
                blob_id = EXCLUDED.blob_id,
                embedding = EXCLUDED.embedding,
                blob_size_bytes = EXCLUDED.blob_size_bytes,
                plaintext = EXCLUDED.plaintext",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(plaintext)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert plaintext vector: {}", e)));
        crate::observability::observe_db(
            "vector.insert_plaintext",
            db_status(&result),
            started.elapsed(),
        );
        result?;

        tracing::debug!(
            "inserted plaintext vector: id={}, blob_id={}, owner={}, ns={}, size={}B",
            id,
            blob_id,
            owner,
            namespace,
            blob_size_bytes
        );
        Ok(())
    }

    /// Fetch the plaintext for a benchmark-mode row by its synthetic
    /// blob_id. Returns `Ok(None)` if the row doesn't exist; `Ok(Some(""))`
    /// vs `Ok(None)` distinguishes "empty plaintext" from "no row".
    /// Returns `Ok(None)` when the row exists but `plaintext` is NULL (a
    /// production row in a benchmark DB — shouldn't happen, handled gracefully).
    ///
    /// LOW-S1 / MED-1: scoped to `owner` so a recall hit on one user's
    /// blob can't surface another user's plaintext. The upstream
    /// `search_similar` already filters by owner; this is defence-in-depth
    /// against a bug there.
    pub async fn fetch_plaintext_by_blob_id(
        &self,
        blob_id: &str,
        owner: &str,
    ) -> Result<Option<String>, AppError> {
        let started = std::time::Instant::now();
        let result: Result<Option<(Option<String>,)>, AppError> = sqlx::query_as(
            "SELECT plaintext FROM vector_entries WHERE blob_id = $1 AND owner = $2 LIMIT 1",
        )
        .bind(blob_id)
        .bind(owner)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch plaintext: {}", e)));
        crate::observability::observe_db(
            "vector.fetch_plaintext",
            db_status(&result),
            started.elapsed(),
        );
        let row = result?;

        Ok(row.and_then(|(plaintext,)| plaintext))
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

        let started = std::time::Instant::now();
        let result: Result<Vec<(String, f64)>, AppError> = sqlx::query_as(
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
        .map_err(|e| AppError::Internal(format!("Failed to search vectors: {}", e)));
        crate::observability::observe_db(
            "vector.search_similar",
            db_status(&result),
            started.elapsed(),
        );
        let rows = result?;

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
        let started = std::time::Instant::now();
        let result: Result<Vec<(String,)>, AppError> = sqlx::query_as(
            "SELECT DISTINCT blob_id FROM vector_entries
             WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get blobs by namespace: {}", e)));
        crate::observability::observe_db(
            "vector.get_blobs_by_namespace",
            db_status(&result),
            started.elapsed(),
        );
        let rows = result?;

        Ok(rows.into_iter().map(|(blob_id,)| blob_id).collect())
    }

    /// Count + total stored bytes for a given owner + namespace.
    /// Used by `POST /api/stats` for harness verification. Returns
    /// `(memory_count, storage_bytes)`; both 0 if the namespace is empty.
    pub async fn namespace_stats(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<(i64, i64), AppError> {
        let started = std::time::Instant::now();
        let result: Result<(i64, i64), AppError> = sqlx::query_as(
            "SELECT COUNT(*)::BIGINT, COALESCE(SUM(blob_size_bytes)::BIGINT, 0)
             FROM vector_entries WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get namespace stats: {}", e)));
        crate::observability::observe_db(
            "vector.namespace_stats",
            db_status(&result),
            started.elapsed(),
        );
        let row = result?;

        Ok(row)
    }

    /// Hard-delete all vector index rows for a given owner + namespace.
    /// (Walrus blobs themselves persist — Walrus has no delete; this only
    /// removes the local `vector_entries` rows, so the memories stop being
    /// retrievable and stop counting toward storage quota.) Reachable via
    /// `POST /api/forget` — authed, owner-scoped.
    pub async fn delete_by_namespace(&self, owner: &str, namespace: &str) -> Result<u64, AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query("DELETE FROM vector_entries WHERE owner = $1 AND namespace = $2")
            .bind(owner)
            .bind(namespace)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete by namespace: {}", e)));
        crate::observability::observe_db(
            "vector.delete_by_namespace",
            db_status(&result),
            started.elapsed(),
        );
        let result = result?;

        let rows = result.rows_affected();
        tracing::info!(
            "deleted {} entries for owner={}, ns={}",
            rows,
            owner,
            namespace
        );
        Ok(rows)
    }

    /// Delete a vector entry by blob_id (used for expired blob cleanup).
    /// Called reactively when Walrus returns 404 during blob download.
    /// LOW-10: Requires owner to prevent cross-user blob deletion.
    pub async fn delete_by_blob_id(&self, blob_id: &str, owner: &str) -> Result<u64, AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query("DELETE FROM vector_entries WHERE blob_id = $1 AND owner = $2")
            .bind(blob_id)
            .bind(owner)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete vector by blob_id: {}", e)));
        crate::observability::observe_db(
            "vector.delete_by_blob_id",
            db_status(&result),
            started.elapsed(),
        );
        let result = result?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!(
                "deleted expired blob from DB: blob_id={}, owner={}, rows={}",
                blob_id,
                owner,
                rows
            );
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
        let started = std::time::Instant::now();
        let result: Result<Option<(String, String)>, AppError> = sqlx::query_as(
            "SELECT account_id, owner FROM delegate_key_cache WHERE public_key = $1 AND expires_at > NOW()",
        )
        .bind(public_key_hex)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query cache: {}", e)));
        crate::observability::observe_db(
            "delegate_cache.get",
            db_status(&result),
            started.elapsed(),
        );

        result
    }

    /// Cache a verified delegate key → account mapping.
    pub async fn cache_delegate_key(
        &self,
        public_key_hex: &str,
        account_id: &str,
        owner: &str,
    ) -> Result<(), AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO delegate_key_cache (public_key, account_id, owner, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
             ON CONFLICT (public_key)
             DO UPDATE SET account_id = $2, owner = $3, cached_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'",
        )
        .bind(public_key_hex)
        .bind(account_id)
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to cache delegate key: {}", e)));
        crate::observability::observe_db(
            "delegate_cache.set",
            db_status(&result),
            started.elapsed(),
        );
        result?;

        tracing::debug!(
            "cached delegate key: {} -> account {}",
            public_key_hex,
            account_id
        );
        Ok(())
    }

    /// Periodically called to evict expired keys
    pub async fn evict_expired_delegate_keys(&self) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM delegate_key_cache WHERE expires_at <= NOW()")
            .execute(&self.pool)
            .await
            .map_err(|e| {
                AppError::Internal(format!("Failed to evict expired delegate keys: {}", e))
            })?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("Evicted {} expired delegate keys from cache", rows);
        }
        Ok(rows)
    }

    /// Mark worker-claimed remember jobs as failed when no worker has updated
    /// them within the stale TTL. Pending rows are left alone because they may
    /// simply be waiting behind legitimate queue backlog.
    pub async fn fail_stale_remember_jobs(
        &self,
        stale_after: std::time::Duration,
    ) -> Result<u64, AppError> {
        let stale_after_secs = stale_after.as_secs().min(i64::MAX as u64) as i64;
        let result = sqlx::query(
            "UPDATE remember_jobs
             SET status = 'failed',
                 error_msg = COALESCE(error_msg, 'stale/orphaned remember job'),
                 updated_at = NOW()
             WHERE status IN ('running', 'uploaded')
               AND updated_at < NOW() - ($1 * INTERVAL '1 second')",
        )
        .bind(stale_after_secs)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fail stale remember jobs: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::warn!("Marked {} stale remember jobs as failed", rows);
        }
        Ok(rows)
    }

    /// LOW-3 fix: Immediately remove a single stale/revoked delegate key from the cache.
    ///
    /// Called when `verify_delegate_key_onchain` returns `Err` for a cached entry,
    /// meaning the key has been revoked on-chain. Without this, every subsequent
    /// request with the revoked key would hit the cache, fail the RPC verify, log
    /// noise, and waste an RPC call — in an infinite loop until TTL expiry.
    pub async fn delete_cached_key(&self, public_key_hex: &str) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM delegate_key_cache WHERE public_key = $1")
            .bind(public_key_hex)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to delete stale cached key: {}", e)))?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!(
                "LOW-3: evicted stale/revoked delegate key from cache: {}",
                public_key_hex
            );
        }
        Ok(rows)
    }

    // ============================================================
    // Storage Quota (still PostgreSQL — tracks per-row blob sizes)
    // ============================================================

    /// Acquire an advisory lock and get storage used within a single transaction.
    ///
    /// MED-21 bugfix: using `pg_advisory_lock` with a connection pool causes deadlocks
    /// because it's session-level. We use `pg_advisory_xact_lock` inside an explicit
    /// transaction so the lock is automatically released on commit/rollback.
    pub async fn get_storage_used_with_lock(
        &self,
        owner: &str,
        lock_key: i64,
    ) -> Result<i64, AppError> {
        let started = std::time::Instant::now();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to begin tx: {}", e)))?;

        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to acquire advisory lock: {}", e)))?;

        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        tx.commit()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to commit tx: {}", e)))?;

        crate::observability::observe_db("quota.storage_used_with_lock", "ok", started.elapsed());
        Ok(row.0)
    }

    // ============================================================
    // Accounts (populated by v2-indexer)
    // ============================================================

    /// Find an account by owner address (from indexed accounts table).
    /// Returns `Some(account_id)` if the owner has a registered account.
    #[allow(dead_code)]
    pub async fn find_account_by_owner(&self, owner: &str) -> Result<Option<String>, AppError> {
        let result: Option<(String,)> =
            sqlx::query_as("SELECT account_id FROM accounts WHERE owner = $1")
                .bind(owner)
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| AppError::Internal(format!("Failed to query accounts: {}", e)))?;

        Ok(result.map(|(id,)| id))
    }
}
