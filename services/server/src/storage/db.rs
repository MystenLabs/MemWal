use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::types::{AppError, SearchHit};

pub struct VectorDb {
    pool: PgPool,
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;
    use std::time::Duration;

    use sqlx::postgres::PgPoolOptions;

    use super::VectorDb;

    static VECTOR_SCHEMA_SETUP_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    fn test_database_url() -> Option<String> {
        std::env::var("DATABASE_URL").ok()
    }

    async fn test_db() -> Option<VectorDb> {
        let database_url = test_database_url()?;
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&database_url)
            .await
            .expect("test database should be available");

        // This test needs only the vector-entry schema. Avoid migrations for
        // unrelated job tables, whose test setup runs concurrently in this
        // binary and has a separate lock.
        let _guard = VECTOR_SCHEMA_SETUP_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        for migration in [
            include_str!("../../migrations/001_init.sql"),
            include_str!("../../migrations/002_add_namespace.sql"),
            include_str!("../../migrations/003_rate_limiter.sql"),
            include_str!("../../migrations/008_benchmark_plaintext.sql"),
            include_str!("../../migrations/009_importance_signal.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        Some(VectorDb { pool })
    }

    #[tokio::test]
    async fn expired_blob_cleanup_is_namespace_scoped() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let suffix = uuid::Uuid::new_v4();
        let owner = format!("0xexpired-cleanup-owner-{suffix}");
        let blob_id = format!("expired-cleanup-blob-{suffix}");
        let queried_namespace = format!("queried-{suffix}");
        let other_namespace = format!("other-{suffix}");
        let vector = vec![0.0; 1536];

        db.insert_vector(
            &format!("queried-row-{suffix}"),
            &owner,
            &queried_namespace,
            &blob_id,
            &vector,
            1,
            0.5,
        )
        .await
        .unwrap();
        db.insert_vector(
            &format!("other-row-{suffix}"),
            &owner,
            &other_namespace,
            &blob_id,
            &vector,
            1,
            0.5,
        )
        .await
        .unwrap();

        // Models the reactive Walrus-404 cleanup triggered while reading
        // `queried_namespace`. A reused ciphertext in another namespace must
        // remain indexed.
        assert_eq!(
            db.delete_by_blob_id(&blob_id, &owner, &queried_namespace)
                .await
                .unwrap(),
            1
        );

        let remaining: Vec<(String, String)> = sqlx::query_as(
            "SELECT namespace, blob_id FROM vector_entries
             WHERE owner = $1 ORDER BY namespace",
        )
        .bind(&owner)
        .fetch_all(db.pool())
        .await
        .unwrap();
        sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(db.pool())
            .await
            .unwrap();

        assert_eq!(
            remaining,
            vec![(other_namespace, blob_id)],
            "the cleanup must not delete an identical blob_id in another namespace"
        );
    }

    // ── find_account_by_owner (backs GET /api/accounts/{owner}/exists) ──
    //
    // `accounts` is populated by the v2-indexer from onchain
    // `AccountCreated` events, not by this server. This test simulates
    // that indexer write directly (a raw INSERT) rather than driving it
    // through any server code path, since the indexer itself is a
    // separate service/binary outside this crate.

    #[tokio::test]
    async fn find_account_by_owner_reflects_indexed_accounts_table() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let suffix = uuid::Uuid::new_v4();
        let owner = format!("0xaccount-exists-owner-{suffix}");
        let account_id = format!("account-{suffix}");

        // No indexed row yet — an address that has never created a
        // MemWalAccount (or whose AccountCreated event hasn't been
        // indexed yet) must resolve to `None`.
        assert_eq!(db.find_account_by_owner(&owner).await.unwrap(), None);

        // Simulate the v2-indexer inserting a row after observing
        // `AccountCreated` onchain.
        sqlx::query("INSERT INTO accounts (account_id, owner) VALUES ($1, $2)")
            .bind(&account_id)
            .bind(&owner)
            .execute(db.pool())
            .await
            .unwrap();

        assert_eq!(
            db.find_account_by_owner(&owner).await.unwrap(),
            Some(account_id.clone())
        );

        sqlx::query("DELETE FROM accounts WHERE owner = $1")
            .bind(&owner)
            .execute(db.pool())
            .await
            .unwrap();
    }

    /// `find_account_by_owner` is an exact, case-sensitive match — it does
    /// not itself lowercase the input. `accounts.owner` is always indexed
    /// in lowercase hex by the v2-indexer (`hex::encode` in
    /// `services/indexer/src/handler.rs`), so callers (the
    /// `account_exists` route handler) are responsible for lowercasing the
    /// caller-supplied address before calling this function. This test
    /// pins down both halves of that contract: an uppercase/mixed-case
    /// lookup against a lowercase-indexed row misses without
    /// normalization, and hits once the same normalization the handler
    /// applies (`to_ascii_lowercase`) is applied here too.
    #[tokio::test]
    async fn find_account_by_owner_is_case_sensitive_requiring_caller_normalization() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let suffix = uuid::Uuid::new_v4();
        // Indexed rows are always lowercase, mirroring the indexer's
        // `hex::encode` output.
        let owner_lower = format!("0xcase-owner-{suffix}").to_ascii_lowercase();
        let owner_upper = owner_lower.to_ascii_uppercase();
        let account_id = format!("account-case-{suffix}");

        sqlx::query("INSERT INTO accounts (account_id, owner) VALUES ($1, $2)")
            .bind(&account_id)
            .bind(&owner_lower)
            .execute(db.pool())
            .await
            .unwrap();

        // Without normalization, an uppercase/mixed-case address for an
        // account that DOES exist would false-negative — this is the bug
        // the route handler's `to_ascii_lowercase()` fixes.
        assert_eq!(
            db.find_account_by_owner(&owner_upper).await.unwrap(),
            None,
            "find_account_by_owner must not silently case-fold internally \
             (that would defeat the btree index via a query-side LOWER())"
        );

        // The handler's normalization step, applied here, must resolve to
        // the same account as the canonical lowercase lookup.
        assert_eq!(
            db.find_account_by_owner(&owner_upper.to_ascii_lowercase())
                .await
                .unwrap(),
            Some(account_id.clone())
        );

        sqlx::query("DELETE FROM accounts WHERE owner = $1")
            .bind(&owner_lower)
            .execute(db.pool())
            .await
            .unwrap();
    }
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

        // composite index on (owner, status, updated_at DESC) for bulk poll
        let migration_006 = include_str!("../../migrations/006_bulk_remember.sql");
        sqlx::raw_sql(migration_006)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 006: {}", e)))?;

        // collapse per-wallet Apalis queues to a single `wallet_jobs`
        // queue. Equivocation locks are no longer a practical concern on Sui
        // (per Will Bradley, Mysten, 2026-05-12); concurrent workers on one
        // wallet + retry handling is sufficient.
        let migration_007 = include_str!("../../migrations/007_collapse_wallet_queues.sql");
        sqlx::raw_sql(migration_007)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 007: {}", e)))?;

        // nullable `plaintext` column for benchmark-mode storage
        // (PlaintextEngine). NULL for all production rows — additive.
        // Renumbered from 007 → 008 during rebase onto dev to avoid collision
        // with the wallet-queue collapse migration.
        let migration_008 = include_str!("../../migrations/008_benchmark_plaintext.sql");
        sqlx::raw_sql(migration_008)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 008: {}", e)))?;

        // importance signal column on vector_entries.
        let migration_009 = include_str!("../../migrations/009_importance_signal.sql");
        sqlx::raw_sql(migration_009)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 009: {}", e)))?;

        tracing::info!("database connected and migrations applied");

        Ok(Self { pool })
    }

    /// Expose a reference to the underlying `PgPool` so job handlers
    /// can run ad-hoc queries (e.g. `remember_jobs` status updates).
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Insert a vector entry (with blob size tracking for storage quota).
    ///
    /// `importance` is the per-fact score set at extraction time
    /// (0.0–1.0, mapped from the extractor LLM's vital/standard/trivial
    /// bucket via `services::extractor::importance_for_bucket`). Stored
    /// on the new `importance` column (migration 009) so the recall
    /// `CompositeRanker` can weight it into the composite score when
    /// `scoring_weights.importance` is non-zero.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vector(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        blob_size_bytes: i64,
        importance: f32,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, importance)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
                owner = EXCLUDED.owner,
                namespace = EXCLUDED.namespace,
                blob_id = EXCLUDED.blob_id,
                embedding = EXCLUDED.embedding,
                blob_size_bytes = EXCLUDED.blob_size_bytes,
                importance = EXCLUDED.importance",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(importance)
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
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_vector_plaintext(
        &self,
        id: &str,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        vector: &[f32],
        plaintext: &str,
        blob_size_bytes: i64,
        importance: f32,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, plaintext, importance)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
                owner = EXCLUDED.owner,
                namespace = EXCLUDED.namespace,
                blob_id = EXCLUDED.blob_id,
                embedding = EXCLUDED.embedding,
                blob_size_bytes = EXCLUDED.blob_size_bytes,
                plaintext = EXCLUDED.plaintext,
                importance = EXCLUDED.importance",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(plaintext)
        .bind(importance)
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
    /// Scoped to `owner` + `namespace` so a recall hit cannot surface a
    /// different tenant's plaintext even when the same blob_id is reused.
    /// The upstream `search_similar` already applies both filters; this is
    /// defence-in-depth against a bug there.
    pub async fn fetch_plaintext_by_blob_id(
        &self,
        blob_id: &str,
        owner: &str,
        namespace: &str,
    ) -> Result<Option<String>, AppError> {
        let started = std::time::Instant::now();
        let result: Result<Option<(Option<String>,)>, AppError> = sqlx::query_as(
            "SELECT plaintext FROM vector_entries
             WHERE blob_id = $1 AND owner = $2 AND namespace = $3
             LIMIT 1",
        )
        .bind(blob_id)
        .bind(owner)
        .bind(namespace)
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

        // `created_at` + `importance` are selected alongside the cosine
        // distance so the recall pipeline can rank by recency / importance
        // without a second round-trip. Both NOT NULL (migration 001 for
        // created_at, 009 for importance) so the row tuple types are
        // non-Option.
        let started = std::time::Instant::now();
        #[allow(clippy::type_complexity)]
        let result: Result<
            Vec<(String, f64, chrono::DateTime<chrono::Utc>, f32)>,
            AppError,
        > = sqlx::query_as(
            "SELECT blob_id, (embedding <=> $1)::float8 AS distance, created_at, importance
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
            .map(|(blob_id, distance, created_at, importance)| SearchHit {
                blob_id,
                distance,
                created_at,
                importance,
            })
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

    /// Delete vector entries for one expired blob within an owner + namespace.
    /// Called reactively when Walrus returns 404 during blob download.
    /// Both owner and namespace are required so cleanup cannot cross either
    /// isolation boundary when ciphertext is reused in multiple rows.
    pub async fn delete_by_blob_id(
        &self,
        blob_id: &str,
        owner: &str,
        namespace: &str,
    ) -> Result<u64, AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query(
            "DELETE FROM vector_entries
             WHERE blob_id = $1 AND owner = $2 AND namespace = $3",
        )
        .bind(blob_id)
        .bind(owner)
        .bind(namespace)
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
                "deleted expired blob from DB: blob_id={}, owner={}, namespace={}, rows={}",
                blob_id,
                owner,
                namespace,
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

    /// Immediately remove a single stale/revoked delegate key from the cache.
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
                "evicted stale/revoked delegate key from cache: {}",
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
    /// Using `pg_advisory_lock` with a connection pool causes deadlocks
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
