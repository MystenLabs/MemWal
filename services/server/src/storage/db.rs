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

    use super::{oauth_rows, VectorDb};

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
            include_str!("../../migrations/010_restore_failed_blobs.sql"),
            include_str!("../../migrations/014_storage_quota_reservations.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        Some(VectorDb { pool })
    }

    async fn oauth_test_db() -> Option<VectorDb> {
        let db = test_db().await?;
        sqlx::raw_sql(include_str!("../../migrations/011_mcp_oauth.sql"))
            .execute(db.pool())
            .await
            .expect("OAuth migration must create tables on a fresh test database");
        Some(db)
    }

    #[tokio::test]
    async fn oauth_migration_011_creates_required_tables() {
        let Some(db) = oauth_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let tables: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = current_schema()
               AND table_name IN ('mcp_oauth_clients', 'mcp_oauth_delegates',
                                  'mcp_oauth_authorize_sessions', 'mcp_oauth_codes',
                                  'mcp_oauth_grants', 'mcp_oauth_tokens')",
        )
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert_eq!(tables.0, 6);
    }

    #[tokio::test]
    async fn concurrent_refresh_rotation_has_exactly_one_winner() {
        let Some(db) = oauth_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let suffix = uuid::Uuid::new_v4();
        let client_id = format!("mwc_{suffix}");
        let delegate_ref = format!("mwd_{suffix}");
        let grant_id = format!("mwg_{suffix}");
        let presented = crate::oauth::hash_token(&format!("mwr_{suffix}"));
        let now = chrono::Utc::now();

        sqlx::query(
            "INSERT INTO mcp_oauth_clients
             (client_id, client_name, redirect_uris, grant_types, response_types,
              token_endpoint_auth_method, scope, status)
             VALUES ($1, 'refresh concurrency test', ARRAY['http://localhost/callback'],
                     ARRAY['authorization_code','refresh_token'], ARRAY['code'],
                     'none', 'memwal:read offline_access', 'active')",
        )
        .bind(&client_id)
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO mcp_oauth_delegates
             (delegate_ref, account_id, owner_address, delegate_public_key,
              delegate_address, encrypted_private_key, label, status)
             VALUES ($1, $2, $3, $4, $5, 'v1.test.test', 'test', 'active')",
        )
        .bind(&delegate_ref)
        .bind(format!("account-{suffix}"))
        .bind(format!("owner-{suffix}"))
        .bind(hex::encode(uuid::Uuid::new_v4().as_bytes()).repeat(2))
        .bind(format!("address-{suffix}"))
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO mcp_oauth_grants
             (grant_id, client_id, delegate_ref, account_id, owner_address, scope, resource)
             VALUES ($1, $2, $3, $4, $5, 'memwal:read offline_access', 'https://example.test/api/mcp')",
        )
        .bind(&grant_id)
        .bind(&client_id)
        .bind(&delegate_ref)
        .bind(format!("account-{suffix}"))
        .bind(format!("owner-{suffix}"))
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO mcp_oauth_tokens (token_sha256, grant_id, token_type, expires_at)
             VALUES ($1, $2, 'refresh', $3)",
        )
        .bind(&presented)
        .bind(&grant_id)
        .bind(now + chrono::Duration::minutes(5))
        .execute(db.pool())
        .await
        .unwrap();

        let pair = |label: &str| {
            let access = oauth_rows::OAuthTokenRow {
                token_sha256: crate::oauth::hash_token(&format!("access-{label}-{suffix}")),
                grant_id: grant_id.clone(),
                token_type: "access".to_string(),
                expires_at: now + chrono::Duration::minutes(5),
            };
            let refresh = oauth_rows::OAuthTokenRow {
                token_sha256: crate::oauth::hash_token(&format!("refresh-{label}-{suffix}")),
                grant_id: grant_id.clone(),
                token_type: "refresh".to_string(),
                expires_at: now + chrono::Duration::minutes(10),
            };
            (access, refresh)
        };
        let (access_a, refresh_a) = pair("a");
        let (access_b, refresh_b) = pair("b");
        let first = db.rotate_oauth_refresh_token(&presented, &client_id, &access_a, &refresh_a);
        let second = db.rotate_oauth_refresh_token(&presented, &client_id, &access_b, &refresh_b);
        let (first, second) = tokio::join!(first, second);
        let winners =
            usize::from(first.unwrap().is_some()) + usize::from(second.unwrap().is_some());
        assert_eq!(
            winners, 1,
            "a refresh token must have exactly one concurrent consumer"
        );

        sqlx::query("DELETE FROM mcp_oauth_clients WHERE client_id = $1")
            .bind(&client_id)
            .execute(db.pool())
            .await
            .unwrap();
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

    // ============================================================
    // Storage quota admission atomicity (GH #532 / WALM-359)
    //
    // Before the fix these burst tests admitted 12 to 20 of 20 and the owner
    // finished over quota; the delayed-insert case, which models the enqueued
    // write paths, reached 20/20. They now assert exactly one admission.
    // ============================================================

    const QUOTA_TEST_MAX: i64 = 1_073_741_824; // rate_limit.rs default
    const QUOTA_TEST_REQ: i64 = 1_557_504; // max manual ciphertext
    const QUOTA_TEST_BURST: usize = 20; // 60 weighted/min ÷ weight 3
    const QUOTA_TEST_TTL: i64 = 900;

    /// Pool sized like production (`VectorDb::new` uses 10) so the burst is
    /// genuinely concurrent rather than serialized by pool starvation.
    async fn quota_test_db() -> Option<VectorDb> {
        let database_url = test_database_url()?;
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .acquire_timeout(Duration::from_secs(20))
            .connect(&database_url)
            .await
            .expect("test database should be available");
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
            include_str!("../../migrations/010_restore_failed_blobs.sql"),
            include_str!("../../migrations/014_storage_quota_reservations.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        Some(VectorDb { pool })
    }

    fn quota_lock_key(s: &str) -> i64 {
        // Mirrors rate_limit::stable_hash_i64 (private to that module).
        const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
        const FNV_PRIME: u64 = 1_099_511_628_211;
        let mut hash = FNV_OFFSET;
        for b in s.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        (hash & 0x7FFF_FFFF_FFFF_FFFF) as i64
    }

    /// Seed the owner so exactly ONE more request fits under the quota.
    async fn quota_seed_one_slot(db: &VectorDb, owner: &str) {
        sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, importance)
             VALUES ($1, $2, 'default', $3, $4, $5, 0.5)",
        )
        .bind(format!("seed-{owner}"))
        .bind(owner)
        .bind(format!("seedblob-{owner}"))
        .bind(pgvector::Vector::from(vec![0.05f32; 1536]))
        .bind(QUOTA_TEST_MAX - QUOTA_TEST_REQ - 1024)
        .execute(db.pool())
        .await
        .unwrap();
    }

    async fn quota_total(db: &VectorDb, owner: &str) -> i64 {
        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(db.pool())
        .await
        .unwrap();
        row.0
    }

    async fn quota_cleanup(db: &VectorDb, owner: &str) {
        sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(owner)
            .execute(db.pool())
            .await
            .unwrap();
        sqlx::query("DELETE FROM storage_quota_reservations WHERE owner = $1")
            .bind(owner)
            .execute(db.pool())
            .await
            .unwrap();
    }

    /// Run a concurrent burst. `gap_ms` models the enqueued paths, where the
    /// insert happens in the wallet worker after a Walrus upload.
    async fn quota_burst(gap_ms: u64) -> (usize, i64) {
        let Some(db) = quota_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return (usize::MAX, 0);
        };
        let db = std::sync::Arc::new(db);
        let owner = format!("quota-burst-{}", uuid::Uuid::new_v4());
        let lock_key = quota_lock_key(&owner);
        quota_seed_one_slot(&db, &owner).await;

        let mut handles = Vec::new();
        for i in 0..QUOTA_TEST_BURST {
            let db = std::sync::Arc::clone(&db);
            let owner = owner.clone();
            handles.push(tokio::spawn(async move {
                let reservation_id = format!("{owner}-{i}");
                let admitted = db
                    .try_reserve_storage(
                        &owner,
                        lock_key,
                        &[(reservation_id.clone(), QUOTA_TEST_REQ)],
                        QUOTA_TEST_MAX,
                        QUOTA_TEST_TTL,
                    )
                    .await
                    .unwrap();
                if admitted.is_err() {
                    return false;
                }
                if gap_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(gap_ms)).await;
                }
                db.insert_vector(
                    &reservation_id,
                    &owner,
                    "default",
                    &format!("blob-{reservation_id}"),
                    &vec![0.1f32; 1536],
                    QUOTA_TEST_REQ,
                    0.5,
                )
                .await
                .unwrap();
                db.release_storage_reservation(&reservation_id)
                    .await
                    .unwrap();
                true
            }));
        }
        let mut admitted = 0usize;
        for h in handles {
            if h.await.unwrap() {
                admitted += 1;
            }
        }
        let total = quota_total(&db, &owner).await;
        quota_cleanup(&db, &owner).await;
        (admitted, total)
    }

    /// Inline write paths (`remember_manual`, benchmark analyze).
    #[tokio::test]
    async fn storage_quota_burst_admits_exactly_one_inline() {
        let (admitted, total) = quota_burst(0).await;
        if admitted == usize::MAX {
            return;
        }
        assert_eq!(
            admitted, 1,
            "expected exactly one admission, got {admitted}"
        );
        assert!(
            total <= QUOTA_TEST_MAX,
            "quota breached: total={total} max={QUOTA_TEST_MAX}"
        );
    }

    /// Enqueued write paths: the insert lands long after admission returns.
    /// This is the case that reached 20/20 bypass before the fix.
    #[tokio::test]
    async fn storage_quota_burst_admits_exactly_one_with_delayed_insert() {
        let (admitted, total) = quota_burst(150).await;
        if admitted == usize::MAX {
            return;
        }
        assert_eq!(
            admitted, 1,
            "delayed insert must not widen the admission window, got {admitted}"
        );
        assert!(
            total <= QUOTA_TEST_MAX,
            "quota breached: total={total} max={QUOTA_TEST_MAX}"
        );
    }

    /// A released reservation must return its bytes to the owner.
    #[tokio::test]
    async fn released_reservation_frees_quota() {
        let Some(db) = quota_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let owner = format!("quota-release-{}", uuid::Uuid::new_v4());
        let lock_key = quota_lock_key(&owner);
        quota_seed_one_slot(&db, &owner).await;
        let items = vec![("rsv-a".to_string(), QUOTA_TEST_REQ)];

        assert!(db
            .try_reserve_storage(&owner, lock_key, &items, QUOTA_TEST_MAX, QUOTA_TEST_TTL)
            .await
            .unwrap()
            .is_ok());
        // Second attempt is refused while the first is outstanding.
        assert!(db
            .try_reserve_storage(
                &owner,
                lock_key,
                &[("rsv-b".to_string(), QUOTA_TEST_REQ)],
                QUOTA_TEST_MAX,
                QUOTA_TEST_TTL
            )
            .await
            .unwrap()
            .is_err());

        db.release_storage_reservation("rsv-a").await.unwrap();

        // Freed again once released.
        assert!(db
            .try_reserve_storage(
                &owner,
                lock_key,
                &[("rsv-b".to_string(), QUOTA_TEST_REQ)],
                QUOTA_TEST_MAX,
                QUOTA_TEST_TTL
            )
            .await
            .unwrap()
            .is_ok());

        db.release_storage_reservation("rsv-b").await.unwrap();
        quota_cleanup(&db, &owner).await;
    }

    /// A reservation whose release was lost must not strand quota forever.
    #[tokio::test]
    async fn expired_reservation_does_not_strand_quota() {
        let Some(db) = quota_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let owner = format!("quota-expiry-{}", uuid::Uuid::new_v4());
        let lock_key = quota_lock_key(&owner);
        quota_seed_one_slot(&db, &owner).await;

        // TTL of 0 leaves an already-expired reservation, standing in for a
        // worker that died between admission and insertion.
        assert!(db
            .try_reserve_storage(
                &owner,
                lock_key,
                &[("rsv-stale".to_string(), QUOTA_TEST_REQ)],
                QUOTA_TEST_MAX,
                0
            )
            .await
            .unwrap()
            .is_ok());

        // The next admission sweeps it and succeeds rather than being blocked.
        assert!(db
            .try_reserve_storage(
                &owner,
                lock_key,
                &[("rsv-next".to_string(), QUOTA_TEST_REQ)],
                QUOTA_TEST_MAX,
                QUOTA_TEST_TTL
            )
            .await
            .unwrap()
            .is_ok());

        db.release_storage_reservation("rsv-next").await.unwrap();
        quota_cleanup(&db, &owner).await;
    }

    /// Bulk admission stays all-or-nothing: a batch that does not fit reserves
    /// nothing, so a partial batch is never silently admitted.
    #[tokio::test]
    async fn bulk_admission_is_all_or_nothing() {
        let Some(db) = quota_test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let owner = format!("quota-bulk-{}", uuid::Uuid::new_v4());
        let lock_key = quota_lock_key(&owner);
        quota_seed_one_slot(&db, &owner).await; // room for exactly one

        let two = vec![
            ("bulk-1".to_string(), QUOTA_TEST_REQ),
            ("bulk-2".to_string(), QUOTA_TEST_REQ),
        ];
        assert!(
            db.try_reserve_storage(&owner, lock_key, &two, QUOTA_TEST_MAX, QUOTA_TEST_TTL)
                .await
                .unwrap()
                .is_err(),
            "a batch exceeding the quota must be rejected as a whole"
        );

        let leaked: (i64,) = sqlx::query_as(
            "SELECT COUNT(*)::BIGINT FROM storage_quota_reservations WHERE owner = $1",
        )
        .bind(&owner)
        .fetch_one(db.pool())
        .await
        .unwrap();
        assert_eq!(leaked.0, 0, "rejected batch must not leave reservations");

        quota_cleanup(&db, &owner).await;
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

        // Permanent restore-failure negative cache (GH #501 / WALM-299).
        let migration_010 = include_str!("../../migrations/010_restore_failed_blobs.sql");
        sqlx::raw_sql(migration_010)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 010: {}", e)))?;

        // MCP OAuth 2.1 (Claude custom connectors): client registry,
        // server-custodied delegate keys, and authorization state.
        let migration_011 = include_str!("../../migrations/011_mcp_oauth.sql");
        sqlx::raw_sql(migration_011)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 011: {}", e)))?;

        // Durable idempotency, preparation, and paid-upload recovery state.
        let migration_012 = include_str!("../../migrations/012_remember_write_idempotency.sql");
        sqlx::raw_sql(migration_012)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 012: {}", e)))?;

        // Build the owner/key uniqueness constraint without blocking writes.
        let migration_013 =
            include_str!("../../migrations/013_remember_write_idempotency_index.sql");
        sqlx::raw_sql(migration_013)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 013: {}", e)))?;

        // Atomic storage-quota admission (GH #532).
        let migration_014 = include_str!("../../migrations/014_storage_quota_reservations.sql");
        sqlx::raw_sql(migration_014)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 014: {}", e)))?;

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

    /// Atomically admit `items` against `owner`'s storage quota.
    ///
    /// Holds `pg_advisory_xact_lock` across BOTH the usage read and the
    /// reservation insert, so concurrent callers for one owner serialize and
    /// each sees the previous one's commitment. This is the property
    /// `get_storage_used_with_lock` lacked: it committed (releasing the lock)
    /// before its caller inserted, so every concurrent caller read the same
    /// pre-insert total and all passed (GH #532).
    ///
    /// Mirrors the shape already used by `security_delete_store::claim_blobs`,
    /// where `lock_and_check_cap` and `insert_batch` share one transaction.
    ///
    /// Admission is all-or-nothing across `items`, preserving the existing
    /// behavior where a bulk request either fully passes or is rejected.
    ///
    /// Returns `Ok(Ok(()))` when admitted, or `Ok(Err(used_bytes))` when the
    /// request would exceed `max_bytes`, where `used_bytes` is the owner's
    /// current committed + reserved usage (for the error message).
    pub async fn try_reserve_storage(
        &self,
        owner: &str,
        lock_key: i64,
        items: &[(String, i64)],
        max_bytes: i64,
        ttl_seconds: i64,
    ) -> Result<Result<(), i64>, AppError> {
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

        // Expired reservations must not count against the owner. Sweeping them
        // inside the lock keeps the read below consistent with the insert.
        sqlx::query(
            "DELETE FROM storage_quota_reservations WHERE owner = $1 AND expires_at <= NOW()",
        )
        .bind(owner)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to sweep reservations: {}", e)))?;

        let committed: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        let reserved: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(bytes)::BIGINT, 0) FROM storage_quota_reservations WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get reserved storage: {}", e)))?;

        let used = committed.0 + reserved.0;
        let additional: i64 = items.iter().map(|(_, bytes)| *bytes).sum();

        if used + additional > max_bytes {
            // Rollback rather than commit: the sweep above is not worth
            // persisting on a rejected admission, and it will run again.
            tx.rollback()
                .await
                .map_err(|e| AppError::Internal(format!("Failed to rollback tx: {}", e)))?;
            crate::observability::observe_db(
                "quota.try_reserve_storage",
                "rejected",
                started.elapsed(),
            );
            return Ok(Err(used));
        }

        for (id, bytes) in items {
            sqlx::query(
                "INSERT INTO storage_quota_reservations (id, owner, bytes, expires_at)
                 VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::INTERVAL)
                 ON CONFLICT (id) DO UPDATE SET
                    owner = EXCLUDED.owner,
                    bytes = EXCLUDED.bytes,
                    expires_at = EXCLUDED.expires_at",
            )
            .bind(id)
            .bind(owner)
            .bind(bytes)
            .bind(ttl_seconds.to_string())
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to reserve storage: {}", e)))?;
        }

        tx.commit()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to commit tx: {}", e)))?;

        crate::observability::observe_db("quota.try_reserve_storage", "ok", started.elapsed());
        Ok(Ok(()))
    }

    /// Release a storage reservation once the row has landed, or once the
    /// write has terminally failed. Idempotent: releasing an unknown or
    /// already-released id is a no-op, so retries and duplicate terminal
    /// transitions are safe.
    pub async fn release_storage_reservation(&self, reservation_id: &str) -> Result<(), AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query("DELETE FROM storage_quota_reservations WHERE id = $1")
            .bind(reservation_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to release reservation: {}", e)));
        crate::observability::observe_db(
            "quota.release_reservation",
            db_status(&result),
            started.elapsed(),
        );
        result?;
        Ok(())
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

    // ============================================================
    // MCP OAuth (Claude custom connectors) — see `../oauth.rs` and
    // `../../migrations/010_mcp_oauth.sql`. Methods are only called from
    // `routes/oauth.rs` and `mcp_proxy.rs`'s bearer resolution.
    // ============================================================

    pub async fn insert_oauth_client(
        &self,
        client: &oauth_rows::OAuthClientRow,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_clients
                (client_id, client_secret_sha256, client_name, redirect_uris, grant_types,
                 response_types, token_endpoint_auth_method, scope, status, registered_ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(&client.client_id)
        .bind(&client.client_secret_sha256)
        .bind(&client.client_name)
        .bind(&client.redirect_uris)
        .bind(&client.grant_types)
        .bind(&client.response_types)
        .bind(&client.token_endpoint_auth_method)
        .bind(&client.scope)
        .bind(&client.status)
        .bind(&client.registered_ip)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth client: {}", e)))?;
        Ok(())
    }

    pub async fn fetch_oauth_client(
        &self,
        client_id: &str,
    ) -> Result<Option<oauth_rows::OAuthClientRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthClientRow>(
            "SELECT client_id, client_secret_sha256, client_name, redirect_uris, grant_types,
                    response_types, token_endpoint_auth_method, scope, status, registered_ip
             FROM mcp_oauth_clients WHERE client_id = $1 AND status = 'active'",
        )
        .bind(client_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch oauth client: {}", e)))
    }

    pub async fn touch_oauth_client_last_used(&self, client_id: &str) -> Result<(), AppError> {
        sqlx::query("UPDATE mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = $1")
            .bind(client_id)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to touch oauth client: {}", e)))?;
        Ok(())
    }

    /// Total DCR-registered clients that never completed a grant, created in
    /// the given window. Backstop for decision D5 (Anthropic's shared egress
    /// CIDR is exempted from per-IP throttling, so this global cap is the
    /// remaining defense against a registration flood).
    pub async fn count_unconsumed_oauth_clients(
        &self,
        within: std::time::Duration,
    ) -> Result<i64, AppError> {
        let secs = within.as_secs().min(i64::MAX as u64) as i64;
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM mcp_oauth_clients c
             WHERE c.created_at > NOW() - ($1 * INTERVAL '1 second')
               AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id)",
        )
        .bind(secs)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| {
            AppError::Internal(format!("Failed to count unconsumed oauth clients: {}", e))
        })?;
        Ok(row.0)
    }

    pub async fn insert_oauth_delegate(
        &self,
        delegate: &oauth_rows::OAuthDelegateRow,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_delegates
                (delegate_ref, account_id, owner_address, delegate_public_key, delegate_address,
                 encrypted_private_key, label, status, tx_digest)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&delegate.delegate_ref)
        .bind(&delegate.account_id)
        .bind(&delegate.owner_address)
        .bind(&delegate.delegate_public_key)
        .bind(&delegate.delegate_address)
        .bind(&delegate.encrypted_private_key)
        .bind(&delegate.label)
        .bind(&delegate.status)
        .bind(&delegate.tx_digest)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth delegate: {}", e)))?;
        Ok(())
    }

    pub async fn fetch_oauth_delegate(
        &self,
        delegate_ref: &str,
    ) -> Result<Option<oauth_rows::OAuthDelegateRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthDelegateRow>(
            "SELECT delegate_ref, account_id, owner_address, delegate_public_key, delegate_address,
                    encrypted_private_key, label, status, tx_digest
             FROM mcp_oauth_delegates WHERE delegate_ref = $1",
        )
        .bind(delegate_ref)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch oauth delegate: {}", e)))
    }

    /// A delegate this account already activated for a *previous* OAuth
    /// grant, if any. Checked before minting a brand-new delegate keypair at
    /// `/oauth/authorize` time so a user reconnecting the same account
    /// doesn't have to sign another on-chain `add_delegate_key` tx and burn
    /// another slot toward the on-chain 20-key cap.
    pub async fn find_reusable_oauth_delegate(
        &self,
        account_id: &str,
    ) -> Result<Option<oauth_rows::OAuthDelegateRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthDelegateRow>(
            "SELECT delegate_ref, account_id, owner_address, delegate_public_key, delegate_address,
                    encrypted_private_key, label, status, tx_digest
             FROM mcp_oauth_delegates
             WHERE account_id = $1 AND status = 'active'
             ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to query reusable oauth delegate: {}", e)))
    }

    pub async fn activate_oauth_delegate(
        &self,
        delegate_ref: &str,
        account_id: &str,
        owner_address: &str,
        tx_digest: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE mcp_oauth_delegates
             SET account_id = $2, owner_address = $3, tx_digest = $4, status = 'active', updated_at = NOW()
             WHERE delegate_ref = $1",
        )
        .bind(delegate_ref)
        .bind(account_id)
        .bind(owner_address)
        .bind(tx_digest)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to activate oauth delegate: {}", e)))?;
        Ok(())
    }

    /// Admin-style operation, not yet called from any route — reserved for
    /// a future "revoke this delegate everywhere" admin action distinct
    /// from `revoke_oauth_grant` (a delegate can in principle be shared
    /// across grants from different clients via the reuse path in
    /// `routes/oauth.rs::session_account`).
    #[allow(dead_code)]
    pub async fn revoke_oauth_delegate(&self, delegate_ref: &str) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE mcp_oauth_delegates SET status = 'revoked', updated_at = NOW() WHERE delegate_ref = $1",
        )
        .bind(delegate_ref)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to revoke oauth delegate: {}", e)))?;
        Ok(())
    }

    pub async fn insert_oauth_session(
        &self,
        session: &oauth_rows::OAuthSessionRow,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_authorize_sessions
                (session_id, client_id, redirect_uri, state, scope, resource, code_challenge,
                 code_challenge_method, delegate_ref, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(&session.session_id)
        .bind(&session.client_id)
        .bind(&session.redirect_uri)
        .bind(&session.state)
        .bind(&session.scope)
        .bind(&session.resource)
        .bind(&session.code_challenge)
        .bind(&session.code_challenge_method)
        .bind(&session.delegate_ref)
        .bind(&session.status)
        .bind(session.expires_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth session: {}", e)))?;
        Ok(())
    }

    pub async fn fetch_oauth_session(
        &self,
        session_id: &str,
    ) -> Result<Option<oauth_rows::OAuthSessionRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthSessionRow>(
            "SELECT session_id, client_id, redirect_uri, state, scope, resource, code_challenge,
                    code_challenge_method, delegate_ref, status, expires_at
             FROM mcp_oauth_authorize_sessions
             WHERE session_id = $1 AND expires_at > NOW()",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch oauth session: {}", e)))
    }

    /// Atomically claim a pending session so it can't be completed twice —
    /// `UPDATE ... WHERE status = 'pending' RETURNING *` is the Postgres
    /// equivalent of the WALM-30 prior art's Redis `GETDEL` single-use
    /// guarantee (decision D3).
    pub async fn consume_oauth_session(
        &self,
        session_id: &str,
    ) -> Result<Option<oauth_rows::OAuthSessionRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthSessionRow>(
            "UPDATE mcp_oauth_authorize_sessions
             SET status = 'consumed'
             WHERE session_id = $1 AND status = 'pending' AND expires_at > NOW()
             RETURNING session_id, client_id, redirect_uri, state, scope, resource, code_challenge,
                       code_challenge_method, delegate_ref, status, expires_at",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to consume oauth session: {}", e)))
    }

    pub async fn insert_oauth_code(&self, code: &oauth_rows::OAuthCodeRow) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_codes
                (code_sha256, client_id, redirect_uri, scope, resource, code_challenge,
                 code_challenge_method, delegate_ref, account_id, owner_address, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(&code.code_sha256)
        .bind(&code.client_id)
        .bind(&code.redirect_uri)
        .bind(&code.scope)
        .bind(&code.resource)
        .bind(&code.code_challenge)
        .bind(&code.code_challenge_method)
        .bind(&code.delegate_ref)
        .bind(&code.account_id)
        .bind(&code.owner_address)
        .bind(code.expires_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth code: {}", e)))?;
        Ok(())
    }

    /// Single-use consume via `DELETE ... RETURNING` — the first successful
    /// exchange deletes the row; any replay finds nothing. Also filters on
    /// `client_id` so a code minted for one client can never be redeemed by
    /// another, even under a future refactor bug (defense in depth, same
    /// reasoning as the WALM-30 prior art's `app_auth_token` doc comment).
    pub async fn consume_oauth_code(
        &self,
        client_id: &str,
        code_sha256: &str,
    ) -> Result<Option<oauth_rows::OAuthCodeRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthCodeRow>(
            "DELETE FROM mcp_oauth_codes
             WHERE code_sha256 = $1 AND client_id = $2 AND expires_at > NOW()
             RETURNING code_sha256, client_id, redirect_uri, scope, resource, code_challenge,
                       code_challenge_method, delegate_ref, account_id, owner_address, expires_at",
        )
        .bind(code_sha256)
        .bind(client_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to consume oauth code: {}", e)))
    }

    pub async fn insert_oauth_grant(
        &self,
        grant: &oauth_rows::OAuthGrantRow,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_grants
                (grant_id, client_id, delegate_ref, account_id, owner_address, scope, resource)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&grant.grant_id)
        .bind(&grant.client_id)
        .bind(&grant.delegate_ref)
        .bind(&grant.account_id)
        .bind(&grant.owner_address)
        .bind(&grant.scope)
        .bind(&grant.resource)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth grant: {}", e)))?;
        Ok(())
    }

    /// Revokes a grant and every token derived from it in one statement —
    /// this is the entire "disconnect this connector" operation (and the
    /// refresh-token-reuse-detection response, see `resolve_oauth_bearer`).
    pub async fn revoke_oauth_grant(&self, grant_id: &str) -> Result<(), AppError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to start tx: {}", e)))?;
        sqlx::query("UPDATE mcp_oauth_grants SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL")
            .bind(grant_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to revoke oauth grant: {}", e)))?;
        sqlx::query(
            "UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL",
        )
        .bind(grant_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to revoke oauth grant tokens: {}", e)))?;
        tx.commit().await.map_err(|e| {
            AppError::Internal(format!("Failed to commit oauth grant revocation: {}", e))
        })?;
        Ok(())
    }

    pub async fn insert_oauth_token(
        &self,
        token: &oauth_rows::OAuthTokenRow,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO mcp_oauth_tokens (token_sha256, grant_id, token_type, expires_at)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(&token.token_sha256)
        .bind(&token.grant_id)
        .bind(&token.token_type)
        .bind(token.expires_at)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert oauth token: {}", e)))?;
        Ok(())
    }

    /// Resolve a hashed bearer token all the way to the delegate it
    /// authorizes, joining through the grant. This is the query the proxy's
    /// `resolve_oauth_bearer` (PR3) runs on every MCP request, so it's a
    /// single round trip rather than N+1.
    pub async fn fetch_oauth_token_with_delegate(
        &self,
        token_sha256: &str,
    ) -> Result<Option<oauth_rows::OAuthTokenWithDelegateRow>, AppError> {
        sqlx::query_as::<_, oauth_rows::OAuthTokenWithDelegateRow>(
            "SELECT t.token_sha256, t.grant_id, t.token_type, t.expires_at, t.revoked_at,
                    g.client_id, g.account_id, g.owner_address, g.scope, g.revoked_at AS grant_revoked_at,
                    d.delegate_ref, d.encrypted_private_key, d.delegate_public_key, d.status AS delegate_status
             FROM mcp_oauth_tokens t
             JOIN mcp_oauth_grants g ON g.grant_id = t.grant_id
             JOIN mcp_oauth_delegates d ON d.delegate_ref = g.delegate_ref
             WHERE t.token_sha256 = $1",
        )
        .bind(token_sha256)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch oauth token: {}", e)))
    }

    pub async fn revoke_oauth_token(&self, token_sha256: &str) -> Result<(), AppError> {
        sqlx::query("UPDATE mcp_oauth_tokens SET revoked_at = NOW() WHERE token_sha256 = $1")
            .bind(token_sha256)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to revoke oauth token: {}", e)))?;
        Ok(())
    }

    /// Atomically consume one active refresh token and insert its replacement
    /// pair. The grant's client id is checked inside the same transaction.
    pub async fn rotate_oauth_refresh_token(
        &self,
        presented_sha256: &str,
        client_id: &str,
        access: &oauth_rows::OAuthTokenRow,
        refresh: &oauth_rows::OAuthTokenRow,
    ) -> Result<Option<oauth_rows::OAuthTokenWithDelegateRow>, AppError> {
        let mut tx = self.pool.begin().await.map_err(|e| {
            AppError::Internal(format!("Failed to start oauth refresh rotation: {}", e))
        })?;
        let consumed = sqlx::query_as::<_, oauth_rows::OAuthTokenWithDelegateRow>(
            "UPDATE mcp_oauth_tokens t
             SET revoked_at = NOW()
             FROM mcp_oauth_grants g, mcp_oauth_delegates d
             WHERE t.token_sha256 = $1
               AND t.grant_id = g.grant_id
               AND g.delegate_ref = d.delegate_ref
               AND t.token_type = 'refresh'
               AND t.revoked_at IS NULL
               AND t.expires_at > NOW()
               AND g.revoked_at IS NULL
               AND g.client_id = $2
             RETURNING t.token_sha256, t.grant_id, t.token_type, t.expires_at, t.revoked_at,
                       g.client_id, g.account_id, g.owner_address, g.scope,
                       g.revoked_at AS grant_revoked_at, d.delegate_ref,
                       d.encrypted_private_key, d.delegate_public_key,
                       d.status AS delegate_status",
        )
        .bind(presented_sha256)
        .bind(client_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to consume oauth refresh token: {}", e)))?;
        if consumed.is_none() {
            tx.rollback().await.map_err(|e| {
                AppError::Internal(format!("Failed to roll back oauth refresh rotation: {}", e))
            })?;
            return Ok(None);
        }
        for token in [access, refresh] {
            sqlx::query(
                "INSERT INTO mcp_oauth_tokens (token_sha256, grant_id, token_type, expires_at)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(&token.token_sha256)
            .bind(&token.grant_id)
            .bind(&token.token_type)
            .bind(token.expires_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                AppError::Internal(format!("Failed to insert rotated oauth token: {}", e))
            })?;
        }
        tx.commit().await.map_err(|e| {
            AppError::Internal(format!("Failed to commit oauth refresh rotation: {}", e))
        })?;
        Ok(consumed)
    }

    /// Periodic sweep for the hourly eviction task (mirrors
    /// `evict_expired_delegate_keys`): clears expired authorize sessions and
    /// authorization codes. Grants/tokens/clients/delegates are durable and
    /// are NOT touched here — only ever revoked explicitly.
    pub async fn evict_expired_oauth_state(&self) -> Result<u64, AppError> {
        let mut total = 0u64;
        let sessions =
            sqlx::query("DELETE FROM mcp_oauth_authorize_sessions WHERE expires_at <= NOW()")
                .execute(&self.pool)
                .await
                .map_err(|e| {
                    AppError::Internal(format!("Failed to evict expired oauth sessions: {}", e))
                })?;
        total += sessions.rows_affected();
        let codes = sqlx::query("DELETE FROM mcp_oauth_codes WHERE expires_at <= NOW()")
            .execute(&self.pool)
            .await
            .map_err(|e| {
                AppError::Internal(format!("Failed to evict expired oauth codes: {}", e))
            })?;
        total += codes.rows_affected();
        if total > 0 {
            tracing::info!("Evicted {} expired MCP OAuth session/code rows", total);
        }
        Ok(total)
    }

    /// DCR clients registered more than 24h ago that never completed a
    /// grant. Claude registers a fresh client on every new connection
    /// (expected, per Anthropic's docs), so this table grows without bound
    /// unless swept — see the plan's "DCR client-table growth" risk note.
    pub async fn prune_unconsumed_oauth_clients(&self) -> Result<u64, AppError> {
        let result = sqlx::query(
            "DELETE FROM mcp_oauth_clients c
             WHERE c.created_at <= NOW() - INTERVAL '24 hours'
               AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = c.client_id)",
        )
        .execute(&self.pool)
        .await
        .map_err(|e| {
            AppError::Internal(format!("Failed to prune unconsumed oauth clients: {}", e))
        })?;
        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("Pruned {} unconsumed MCP OAuth DCR clients", rows);
        }
        Ok(rows)
    }

    /// Return blob_ids that have permanently failed to restore for `owner` +
    /// `namespace` (GH #501 / WALM-299). Used by restore() to exclude blobs
    /// that already failed decrypt/validation once and should never be
    /// re-downloaded and re-decrypt-attempted on every subsequent restore() call.
    pub async fn get_failed_blob_ids(
        &self,
        owner: &str,
        namespace: &str,
    ) -> Result<Vec<String>, AppError> {
        let started = std::time::Instant::now();
        let result: Result<Vec<(String,)>, AppError> = sqlx::query_as(
            "SELECT blob_id FROM restore_failed_blobs
             WHERE owner = $1 AND namespace = $2",
        )
        .bind(owner)
        .bind(namespace)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get failed blobs: {}", e)));
        crate::observability::observe_db(
            "vector.get_failed_blob_ids",
            db_status(&result),
            started.elapsed(),
        );
        let rows = result?;

        Ok(rows.into_iter().map(|(blob_id,)| blob_id).collect())
    }

    /// Record that `blob_id` permanently failed to restore for `owner` +
    /// `namespace` (GH #501 / WALM-299). `reason` is `"decrypt_permanent"`
    /// (SEAL rejected it deterministically) or `"invalid_utf8"`
    /// (decrypt succeeded but the plaintext wasn't valid UTF-8). Repeated
    /// calls for the same (owner, namespace, blob_id) bump `attempts`
    /// instead of erroring or duplicating the row.
    pub async fn record_restore_failure(
        &self,
        owner: &str,
        namespace: &str,
        blob_id: &str,
        reason: &str,
    ) -> Result<(), AppError> {
        let started = std::time::Instant::now();
        let result = sqlx::query(
            "INSERT INTO restore_failed_blobs (owner, namespace, blob_id, reason)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (owner, namespace, blob_id) DO UPDATE SET
                attempts = restore_failed_blobs.attempts + 1,
                last_attempt_at = now(),
                reason = EXCLUDED.reason",
        )
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(reason)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to record restore failure: {}", e)));
        crate::observability::observe_db(
            "vector.record_restore_failure",
            db_status(&result),
            started.elapsed(),
        );
        result?;

        Ok(())
    }
}

/// Row types for the MCP OAuth tables (`sqlx::FromRow`) — kept in their own
/// submodule so `db.rs`'s existing tuple-based queries elsewhere aren't
/// disturbed by this file's naming.
pub mod oauth_rows {
    use chrono::{DateTime, Utc};

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthClientRow {
        pub client_id: String,
        pub client_secret_sha256: Option<String>,
        pub client_name: String,
        pub redirect_uris: Vec<String>,
        pub grant_types: Vec<String>,
        pub response_types: Vec<String>,
        pub token_endpoint_auth_method: String,
        pub scope: String,
        pub status: String,
        pub registered_ip: Option<String>,
    }

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthDelegateRow {
        pub delegate_ref: String,
        pub account_id: Option<String>,
        pub owner_address: Option<String>,
        pub delegate_public_key: String,
        pub delegate_address: String,
        pub encrypted_private_key: String,
        pub label: String,
        pub status: String,
        pub tx_digest: Option<String>,
    }

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthSessionRow {
        pub session_id: String,
        pub client_id: String,
        pub redirect_uri: String,
        pub state: Option<String>,
        pub scope: String,
        pub resource: String,
        pub code_challenge: String,
        pub code_challenge_method: String,
        pub delegate_ref: String,
        pub status: String,
        pub expires_at: DateTime<Utc>,
    }

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthCodeRow {
        pub code_sha256: String,
        pub client_id: String,
        pub redirect_uri: String,
        pub scope: String,
        pub resource: String,
        pub code_challenge: String,
        pub code_challenge_method: String,
        pub delegate_ref: String,
        pub account_id: String,
        pub owner_address: String,
        pub expires_at: DateTime<Utc>,
    }

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthGrantRow {
        pub grant_id: String,
        pub client_id: String,
        pub delegate_ref: String,
        pub account_id: String,
        pub owner_address: String,
        pub scope: String,
        pub resource: String,
    }

    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthTokenRow {
        pub token_sha256: String,
        pub grant_id: String,
        pub token_type: String,
        pub expires_at: DateTime<Utc>,
    }

    /// Denormalized join result for resolving a bearer token straight
    /// through to signable delegate material — what `resolve_oauth_bearer`
    /// (PR3) needs in one round trip. Most fields are unread until PR3
    /// wires up the proxy-side consumer.
    #[allow(dead_code)]
    #[derive(Debug, Clone, sqlx::FromRow)]
    pub struct OAuthTokenWithDelegateRow {
        pub token_sha256: String,
        pub grant_id: String,
        pub token_type: String,
        pub expires_at: DateTime<Utc>,
        pub revoked_at: Option<DateTime<Utc>>,
        pub client_id: String,
        pub account_id: String,
        pub owner_address: String,
        pub scope: String,
        pub grant_revoked_at: Option<DateTime<Utc>>,
        pub delegate_ref: String,
        pub encrypted_private_key: String,
        pub delegate_public_key: String,
        pub delegate_status: String,
    }
}
