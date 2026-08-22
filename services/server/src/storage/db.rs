use pgvector::Vector;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::types::{AppError, SearchHit};

/// Tombstone retention for both the read-API `must_resync` clock and the
/// background sweep. Keep a single constant so the two cannot drift.
pub const TOMBSTONE_RETENTION: chrono::Duration = chrono::Duration::days(30);

pub struct VectorDb {
    pool: PgPool,
}

#[cfg(test)]
impl VectorDb {
    pub(crate) fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
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
            include_str!("../../migrations/014_memory_read_api_columns.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        // Mirrors the ordering in VectorDb::new(): batched Rust backfill
        // must complete before 015 validates NOT NULL, and the invalid-
        // index recovery check must run before 016's CREATE INDEX
        // CONCURRENTLY IF NOT EXISTS.
        super::backfill_updated_at(&pool).await.unwrap();

        sqlx::raw_sql(include_str!(
            "../../migrations/015_memory_read_api_updated_at_not_null.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();

        super::recover_invalid_pagination_index(&pool)
            .await
            .unwrap();

        for migration in [
            include_str!("../../migrations/016_memory_read_api_index.sql"),
            include_str!("../../migrations/017_memory_expiry_columns.sql"),
            include_str!("../../migrations/018_memory_expiry_synced_at_index.sql"),
            include_str!("../../migrations/019_memory_read_api_updated_at_set_not_null.sql"),
            include_str!("../../migrations/020_read_api_followups.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }

        Some(VectorDb { pool })
    }

    /// Regression test for the migration-order fixes: batched Rust
    /// backfill, the CHECK/VALIDATE NOT NULL fast path split across
    /// migrations 015/019, and invalid-index recovery ahead of
    /// migration 016.
    ///
    /// Gated on a dedicated env var (rather than `DATABASE_URL`, which
    /// `test_db()` above already uses for the lighter-weight vector-only
    /// schema) so it never runs as part of the normal suite by accident —
    /// it exercises the FULL `VectorDb::new()` migration pipeline
    /// (001-019) end to end, which is disruptive to run against a
    /// database other tests share concurrently. Point
    /// `MIGRATION_PIPELINE_TEST_DATABASE_URL` at a throwaway local
    /// database to run it, e.g.:
    /// `createdb -h localhost -U memwal memwal_migration_test`.
    #[tokio::test]
    async fn full_migration_pipeline_runs_end_to_end() {
        let Ok(database_url) = std::env::var("MIGRATION_PIPELINE_TEST_DATABASE_URL") else {
            eprintln!("skipping: MIGRATION_PIPELINE_TEST_DATABASE_URL is not configured");
            return;
        };

        let db = VectorDb::new(&database_url)
            .await
            .expect("full migration pipeline should complete cleanly");

        let remaining_nulls: i64 =
            sqlx::query_scalar("SELECT count(*) FROM vector_entries WHERE updated_at IS NULL")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(
            remaining_nulls, 0,
            "backfill should have cleared every NULL updated_at row"
        );

        let index_valid: Option<bool> = sqlx::query_scalar(
            "SELECT indisvalid FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid \
             WHERE relname = 'idx_vector_entries_owner_updated_id'",
        )
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        assert_eq!(
            index_valid,
            Some(true),
            "pagination index should exist and be valid"
        );

        let constraint_dropped: Option<String> = sqlx::query_scalar(
            "SELECT conname FROM pg_constraint WHERE conname = 'vector_entries_updated_at_not_null'",
        )
        .fetch_optional(&db.pool)
        .await
        .unwrap();
        assert_eq!(
            constraint_dropped, None,
            "the temporary CHECK constraint should have been dropped by migration 019"
        );

        // Running the whole pipeline a second time (simulating a restart)
        // must still be clean and idempotent.
        VectorDb::new(&database_url)
            .await
            .expect("second run of the full migration pipeline should also complete cleanly");
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
            None,
            None,
            None,
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
            None,
            None,
            None,
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

    #[tokio::test]
    async fn insert_vector_persists_agent_and_package_id() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-{}", uuid::Uuid::new_v4());

        db.insert_vector(
            &id,
            "0xtest-owner",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            Some("agent-abc"),
            Some("0xpkg-123"),
            None,
        )
        .await
        .unwrap();

        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT agent_id, package_id FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .unwrap();

        assert_eq!(row.0.as_deref(), Some("agent-abc"));
        assert_eq!(row.1.as_deref(), Some("0xpkg-123"));

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
    }

    #[tokio::test]
    async fn insert_vector_persists_end_epoch() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-{}", uuid::Uuid::new_v4());

        db.insert_vector(
            &id,
            "0xtest-owner",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            None,
            None,
            Some(457),
        )
        .await
        .unwrap();

        let row: (Option<i32>,) =
            sqlx::query_as("SELECT end_epoch FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .unwrap();

        assert_eq!(row.0, Some(457));

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
    }

    /// Reproduces an Apalis retry re-entering `insert_vector` with the same
    /// primary key (`jobs.rs` sets `vector_id = remember_job_id`): the second
    /// call takes the `ON CONFLICT (id) DO UPDATE` branch. Console's
    /// `updated_after` incremental sync depends on `updated_at` actually
    /// advancing on that branch, not just the insert succeeding.
    #[tokio::test]
    async fn insert_vector_bumps_updated_at_on_conflict() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-conflict-{}", uuid::Uuid::new_v4());

        db.insert_vector(
            &id,
            "0xtest-owner-conflict",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            Some("agent-abc"),
            Some("0xpkg-123"),
            None,
        )
        .await
        .unwrap();

        let first_updated_at: chrono::DateTime<chrono::Utc> =
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap();

        // Force a measurable time gap so a naive "insert succeeded" assertion
        // couldn't accidentally pass — the row must actually move forward.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Simulate the Apalis retry: same id, same conflict branch.
        db.insert_vector(
            &id,
            "0xtest-owner-conflict",
            "test-ns",
            "blob-1-retried",
            &[0.2_f32; 1536],
            43,
            0.5,
            Some("agent-abc"),
            Some("0xpkg-123"),
            None,
        )
        .await
        .unwrap();

        let second_updated_at: chrono::DateTime<chrono::Utc> =
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap();

        assert!(
            second_updated_at > first_updated_at,
            "updated_at must advance on ON CONFLICT DO UPDATE (first={:?}, second={:?})",
            first_updated_at,
            second_updated_at
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
    }

    #[tokio::test]
    async fn rows_needing_expiry_refresh_returns_null_and_stale_rows_only() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let owner = format!("0xtest-{}", uuid::Uuid::new_v4());

        // never synced (NULL expiry_synced_at) — should be selected
        db.insert_vector(
            &format!("{}-a", owner),
            &owner,
            "ns",
            "blob-a",
            &[0.0_f32; 1536],
            1,
            0.5,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        // synced recently — should NOT be selected
        sqlx::query("INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, expiry_synced_at) VALUES ($1, $2, 'ns', 'blob-b', $3, 1, NOW())")
            .bind(format!("{}-b", owner)).bind(&owner).bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .execute(db.pool()).await.unwrap();

        // synced 25 hours ago (stale, past a 24h threshold) — should be selected
        sqlx::query("INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, expiry_synced_at) VALUES ($1, $2, 'ns', 'blob-c', $3, 1, NOW() - INTERVAL '25 hours')")
            .bind(format!("{}-c", owner)).bind(&owner).bind(pgvector::Vector::from(vec![0.0_f32; 1536]))
            .execute(db.pool()).await.unwrap();

        // This shared local test database accumulates NULL/stale
        // expiry_synced_at rows across many prior test runs (thousands, in
        // practice), and ties among NULL values are unordered in Postgres.
        // A small limit (e.g. 10, as in the original design sketch) would
        // make this test flaky/order-dependent against that cruft — request
        // a limit generous enough to comfortably outrun it instead.
        let rows = db.rows_needing_expiry_refresh(50_000).await.unwrap();
        let blob_ids: std::collections::HashSet<_> = rows
            .iter()
            .filter(|r| r.0 == owner)
            .map(|r| r.2.clone())
            .collect();

        assert!(blob_ids.contains("blob-a"));
        assert!(blob_ids.contains("blob-c"));
        assert!(!blob_ids.contains("blob-b"));

        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(&owner)
            .execute(db.pool())
            .await;
    }

    /// "Never touch updated_at" is a load-bearing plan constraint for the
    /// expiry sweep (Console's `updated_after` incremental sync depends on
    /// it not moving for reasons unrelated to the row's own content — see
    /// `insert_vector_bumps_updated_at_on_conflict` above for the positive
    /// case). Regression-protects the negative case for both new
    /// write-paths the sweep uses.
    #[tokio::test]
    async fn mark_expiry_scheduled_never_touches_updated_at() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-expiry-scheduled-updated-at-{}", uuid::Uuid::new_v4());

        db.insert_vector(
            &id,
            "0xtest-owner-expiry-scheduled-updated-at",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let original_updated_at: chrono::DateTime<chrono::Utc> =
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap();

        // Force a measurable time gap so a naive "call succeeded" assertion
        // couldn't accidentally pass — updated_at must genuinely not move.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Pure bookkeeping (no API-visible field changes) — must never bump
        // updated_at, or every read that schedules a staleness check would
        // spuriously reappear in Console's incremental sync.
        db.mark_expiry_scheduled(&[id.clone()]).await.unwrap();

        let after_updated_at: chrono::DateTime<chrono::Utc> =
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap();

        assert_eq!(
            original_updated_at, after_updated_at,
            "mark_expiry_scheduled must never touch updated_at"
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
    }

    /// `set_memory_expiry` previously never bumped `updated_at` at all —
    /// deliberately, to avoid the ~24h re-verification sweep making every
    /// synced row reappear in Console's incremental sync — but that also
    /// meant the *first* real write (a row's expiry resolving from unknown
    /// to known) was invisible to a client that had already synced that
    /// row, silently breaking per-memory expiry tracking for exactly the
    /// rows synced before their expiry was known. The fix conditions the
    /// bump on the value actually changing (`IS DISTINCT FROM`, null-safe).
    /// This test pins all three cases: first real write bumps, an unchanged
    /// re-verification does not, and a genuine later change bumps again.
    #[tokio::test]
    async fn set_memory_expiry_bumps_updated_at_only_when_value_changes() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-expiry-set-updated-at-{}", uuid::Uuid::new_v4());

        db.insert_vector(
            &id,
            "0xtest-owner-expiry-set-updated-at",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let fetch_updated_at = |id: String, pool: sqlx::PgPool| async move {
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap()
        };

        let before_first_write = fetch_updated_at(id.clone(), db.pool().clone()).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // First real write: NULL -> a real value. Must bump updated_at so a
        // client that already synced this row's still-unknown expiry sees
        // the populated value on its next incremental poll.
        let first_expires_at = chrono::Utc::now();
        db.set_memory_expiry(&id, 500, first_expires_at)
            .await
            .unwrap();
        let after_first_write = fetch_updated_at(id.clone(), db.pool().clone()).await;
        assert!(
            after_first_write > before_first_write,
            "the first real expiry write must bump updated_at (unsynced -> synced is a real \
             API-visible change), got before={:?} after={:?}",
            before_first_write,
            after_first_write
        );

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Routine re-verification with the SAME end_epoch but a DIFFERENT
        // expires_at (the real caller recomputes expires_at from a fresh
        // `now()` on every sweep tick — see `expires_at_from_epoch` — so it
        // never matches the previous write byte-for-byte even when nothing
        // actually changed) must NOT bump updated_at, or every synced row
        // would spam Console's incremental sync roughly once a day
        // regardless of whether anything actually changed.
        let reverify_expires_at = first_expires_at + chrono::Duration::seconds(7);
        db.set_memory_expiry(&id, 500, reverify_expires_at)
            .await
            .unwrap();
        let after_reverify = fetch_updated_at(id.clone(), db.pool().clone()).await;
        assert_eq!(
            after_first_write, after_reverify,
            "re-verifying with an unchanged end_epoch (even with a recomputed expires_at) \
             must not bump updated_at"
        );

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // A genuine later change (e.g. the on-chain lease was extended,
        // moving end_epoch) must bump updated_at again — this is a real
        // content change, not routine housekeeping.
        let second_expires_at = first_expires_at + chrono::Duration::hours(1);
        db.set_memory_expiry(&id, 501, second_expires_at)
            .await
            .unwrap();
        let after_real_change = fetch_updated_at(id.clone(), db.pool().clone()).await;
        assert!(
            after_real_change > after_reverify,
            "a genuine end_epoch/expires_at change must bump updated_at, got prior={:?} \
             after={:?}",
            after_reverify,
            after_real_change
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
    }

    /// The mainline write path, which the test above does not reach.
    ///
    /// `insert_vector` writes `end_epoch` but never `expires_at`. So when the
    /// sweep first resolves that row, `end_epoch` is already equal and only
    /// `expires_at` changes. Guarding the bump on `end_epoch` alone made that
    /// write invisible to incremental sync: a client that synced the row in
    /// the up-to-5-minute window before the sweep kept `expires_at: null`
    /// forever, which is the whole of WALM-296 silently not working.
    #[tokio::test]
    async fn set_memory_expiry_bumps_updated_at_when_only_expires_at_appears() {
        let Some(db) = test_db().await else {
            eprintln!("skipping DB integration test: DATABASE_URL is not configured");
            return;
        };
        let id = format!("test-expiry-inserted-end-epoch-{}", uuid::Uuid::new_v4());

        // end_epoch supplied at INSERT, exactly as the wallet-job path does.
        db.insert_vector(
            &id,
            "0xtest-owner-expiry-inserted-end-epoch",
            "test-ns",
            "blob-1",
            &[0.1_f32; 1536],
            42,
            0.5,
            None,
            None,
            Some(500),
        )
        .await
        .unwrap();

        let fetch_updated_at = |id: String, pool: sqlx::PgPool| async move {
            sqlx::query_as("SELECT updated_at FROM vector_entries WHERE id = $1")
                .bind(&id)
                .fetch_one(&pool)
                .await
                .map(|(v,): (chrono::DateTime<chrono::Utc>,)| v)
                .unwrap()
        };

        let before = fetch_updated_at(id.clone(), db.pool().clone()).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Same end_epoch the row already carries; only expires_at changes.
        db.set_memory_expiry(&id, 500, chrono::Utc::now())
            .await
            .unwrap();
        let after = fetch_updated_at(id.clone(), db.pool().clone()).await;
        assert!(
            after > before,
            "populating expires_at on a row that already had end_epoch must bump updated_at, \
             otherwise the row never re-enters incremental sync and the client keeps null \
             forever; got before={:?} after={:?}",
            before,
            after
        );

        let _ = sqlx::query("DELETE FROM vector_entries WHERE id = $1")
            .bind(&id)
            .execute(db.pool())
            .await;
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

/// Name of the keyset-pagination index migration 016 builds. Shared
/// between the invalid-index recovery check and (in spirit) migration
/// 016's own `CREATE INDEX CONCURRENTLY IF NOT EXISTS` -- kept as a
/// constant here so the two names can't drift apart.
const PAGINATION_INDEX_NAME: &str = "idx_vector_entries_owner_updated_id";

/// Backfill `vector_entries.updated_at` from `created_at` in bounded
/// batches.
///
/// This cannot be a plain migration file's `UPDATE ... WHERE
/// updated_at IS NULL` (the naive version this replaced) on a
/// real-sized table: a single unbatched full-table UPDATE can run long
/// enough to hit a statement/idle timeout. Postgres rolls back the
/// ENTIRE update atomically on timeout -- there is no partial-UPDATE
/// commit -- which propagates as an error/panic out of
/// `VectorDb::new()`. Under Railway's restart policy that becomes a
/// crash-loop with zero net progress between attempts: restart ->
/// reconnect -> same unbatched UPDATE -> same timeout, forever.
/// LIVE-CONFIRMED against the dev DB (113k rows): the single-statement
/// version could not complete under a short timeout, while this batched
/// version (5000 rows/iteration) completed in ~281s.
///
/// It also cannot be pushed into a `DO $$ ... $$` block inside a
/// migration file: Postgres does not allow `COMMIT` inside a
/// procedural block executed as a single statement, which is exactly
/// what batching needs (each batch must commit on its own so a crash
/// or restart mid-backfill doesn't lose progress already made). So the
/// loop has to live in application code, where each iteration below is
/// its own bare statement against the pool -- not wrapped in an
/// explicit transaction -- and therefore commits independently. A
/// later restart resumes near where the last successful batch left
/// off, because already-backfilled rows no longer match `WHERE
/// updated_at IS NULL`.
///
/// Called from `VectorDb::new()` after migration 014 (which adds the
/// nullable `updated_at` column) and before migration 015 (which
/// requires no NULL rows remain before it can validate its NOT NULL
/// constraint).
async fn backfill_updated_at(pool: &PgPool) -> Result<(), AppError> {
    const BATCH_SIZE: i64 = 5000;
    let mut total_rows: u64 = 0;

    loop {
        let result = sqlx::query(
            "UPDATE vector_entries SET updated_at = created_at \
             WHERE id IN (SELECT id FROM vector_entries WHERE updated_at IS NULL LIMIT $1)",
        )
        .bind(BATCH_SIZE)
        .execute(pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to backfill updated_at: {}", e)))?;

        let rows_affected = result.rows_affected();
        total_rows += rows_affected;
        if rows_affected == 0 {
            break;
        }
    }

    if total_rows > 0 {
        tracing::info!(
            rows = total_rows,
            "backfilled vector_entries.updated_at from created_at"
        );
    }

    Ok(())
}

/// Detect and recover from an INVALID `idx_vector_entries_owner_updated_id`
/// left behind by an interrupted `CREATE INDEX CONCURRENTLY` build.
///
/// Migration 013 runs `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and
/// `IF NOT EXISTS` matches by index NAME only -- it has no idea whether
/// an existing index with that name is actually usable. A
/// `CONCURRENTLY` build that gets interrupted (process crash,
/// statement timeout, deploy killing the connection mid-build) leaves
/// behind a permanently INVALID index under the target name. From that
/// point on, every future `VectorDb::new()` sees the name already
/// exists, silently no-ops migration 013 forever, and every
/// memories-listing query keyset-paginating on `(owner, updated_at,
/// id)` silently degrades to a sequential scan -- with no error ever
/// surfaced.
///
/// Called immediately before migration 013 runs. If an INVALID index is
/// found, it is dropped (via `DROP INDEX CONCURRENTLY`, which -- like
/// `CREATE INDEX CONCURRENTLY` -- cannot run inside a transaction
/// block, hence the bare `sqlx::query(..).execute(pool)` with no
/// explicit transaction wrapper) so migration 013's own `CREATE INDEX
/// CONCURRENTLY IF NOT EXISTS` can actually rebuild it. The recovery is
/// logged at `warn` level so it is visible in observability rather than
/// silently happening on every boot.
async fn recover_invalid_pagination_index(pool: &PgPool) -> Result<(), AppError> {
    let index_is_invalid: Option<bool> = sqlx::query_scalar(
        "SELECT pg_index.indisvalid FROM pg_index \
         JOIN pg_class ON pg_class.oid = pg_index.indexrelid \
         WHERE pg_class.relname = $1",
    )
    .bind(PAGINATION_INDEX_NAME)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        AppError::Internal(format!(
            "Failed to check validity of {}: {}",
            PAGINATION_INDEX_NAME, e
        ))
    })?;

    if index_is_invalid == Some(false) {
        tracing::warn!(
            index = PAGINATION_INDEX_NAME,
            "found INVALID pagination index, likely left behind by an interrupted \
             CREATE INDEX CONCURRENTLY build -- dropping it so migration 013 can rebuild it"
        );

        let drop_stmt = format!("DROP INDEX CONCURRENTLY {}", PAGINATION_INDEX_NAME);
        sqlx::query(&drop_stmt).execute(pool).await.map_err(|e| {
            AppError::Internal(format!(
                "Failed to drop invalid index {}: {}",
                PAGINATION_INDEX_NAME, e
            ))
        })?;
    }

    Ok(())
}

/// Release storage reservations given only a pool handle.
///
/// Several wallet-job error paths hold a `&PgPool` rather than an `AppState`
/// (`update_remember_job_after_wallet_error` and friends), and threading state
/// through all of them just to release quota would be a much larger change than
/// this fix warrants. Releasing does not need config: when quota is unlimited
/// no reservation was ever written, so the delete simply matches nothing.
///
/// Infallible for the same reason as the method: a failed release is recovered
/// by the TTL and the terminal-job reconcile, and must never turn a successful
/// write into a failed request.
pub async fn release_storage_reservations_with_pool(pool: &PgPool, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let started = std::time::Instant::now();
    let result = sqlx::query("DELETE FROM storage_reservations WHERE id = ANY($1)")
        .bind(ids)
        .execute(pool)
        .await;

    match result {
        Ok(_) => {
            crate::observability::observe_db("quota.release_reservations", "ok", started.elapsed());
        }
        Err(e) => {
            crate::observability::observe_db(
                "quota.release_reservations",
                "error",
                started.elapsed(),
            );
            // TTL and the terminal-job reconcile are the backstops. Log
            // loudly but do not propagate.
            tracing::warn!(
                "failed to release {} storage reservation(s), falling back to TTL: {}",
                ids.len(),
                e
            );
        }
    }
}

/// One pending write awaiting admission against an owner's storage quota.
///
/// `id` is supplied by the caller rather than generated here, because the
/// release site must be able to name the reservation without extra plumbing:
///   * enqueued paths pass the `remember_jobs.id` the vector row will use, so
///     `jobs.rs` can release from the job id it already carries. Nothing new
///     has to be threaded through the serialized `WalletOperation` payloads.
///   * inline paths pass a fresh UUID and release it themselves a few lines
///     later.
#[derive(Debug, Clone)]
pub struct StorageReservationRequest {
    pub id: String,
    pub bytes: i64,
}

/// Outcome of an atomic quota admission.
///
/// `Rejected` is a normal outcome, not an error, so the caller owns the
/// response shape. `used` is the total observed under the lock (committed
/// rows plus live reservations) and feeds the existing 402 message verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageAdmission {
    Admitted,
    Rejected { used: i64 },
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

        // per-owner storage quota reservations. Makes quota admission atomic
        // with the eventual insert (GH #532 / WALM-359).
        let migration_014_reservations =
            include_str!("../../migrations/014_storage_reservations.sql");
        sqlx::raw_sql(migration_014_reservations)
            .execute(&pool)
            .await
            .map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run migration 014 (storage reservations): {}",
                    e
                ))
            })?;

        // owner-scoped read API: updated_at cursor column + agent_id/package_id.
        // Split across 014-019 (see each file's header, and
        // backfill_updated_at's / recover_invalid_pagination_index's doc
        // comments above) to avoid holding ACCESS EXCLUSIVE across the
        // full-table backfill or index build.
        let migration_014_read_api =
            include_str!("../../migrations/014_memory_read_api_columns.sql");
        sqlx::raw_sql(migration_014_read_api)
            .execute(&pool)
            .await
            .map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run migration 014 (read API columns): {}",
                    e
                ))
            })?;

        // Backfill runs as batched Rust code, not a migration file, since
        // Postgres can't COMMIT mid-loop inside a plain migration
        // statement — see backfill_updated_at()'s doc comment.
        backfill_updated_at(&pool).await?;

        // Requires the backfill above to have already completed — this
        // validates NOT NULL and will error if any updated_at row is
        // still NULL.
        let migration_015 =
            include_str!("../../migrations/015_memory_read_api_updated_at_not_null.sql");
        sqlx::raw_sql(migration_015)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 015: {}", e)))?;

        // Must run before migration 016's CREATE INDEX CONCURRENTLY IF NOT
        // EXISTS, which would otherwise silently no-op forever against a
        // permanently INVALID index from an interrupted build.
        recover_invalid_pagination_index(&pool).await?;

        // keyset-pagination index for the memories listing endpoint.
        // Must stay in its own file/transaction — see 016's header comment.
        let migration_016 = include_str!("../../migrations/016_memory_read_api_index.sql");
        sqlx::raw_sql(migration_016)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 016: {}", e)))?;

        // per-memory expiry columns.
        let migration_017 = include_str!("../../migrations/017_memory_expiry_columns.sql");
        sqlx::raw_sql(migration_017)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 017: {}", e)))?;

        // index on expiry_synced_at so the periodic expiry refresh sweep
        // doesn't full-scan vector_entries every tick. Must stay
        // in its own file/transaction — see 018's header comment.
        let migration_018 = include_str!("../../migrations/018_memory_expiry_synced_at_index.sql");
        sqlx::raw_sql(migration_018)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 018: {}", e)))?;

        // Finalizes updated_at NOT NULL cheaply using the validated CHECK
        // constraint 015 set up — see 019's header.
        let migration_019 =
            include_str!("../../migrations/019_memory_read_api_updated_at_set_not_null.sql");
        sqlx::raw_sql(migration_019)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 019: {}", e)))?;

        let migration_020 = include_str!("../../migrations/020_read_api_followups.sql");
        sqlx::raw_sql(migration_020)
            .execute(&pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to run migration 020: {}", e)))?;

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
        agent_id: Option<&str>,
        package_id: Option<&str>,
        end_epoch: Option<i32>,
    ) -> Result<(), AppError> {
        let embedding = Vector::from(vector.to_vec());

        let started = std::time::Instant::now();
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to begin insert tx: {}", e)))?;
        let result = sqlx::query(
            "INSERT INTO vector_entries (id, owner, namespace, blob_id, embedding, blob_size_bytes, importance, agent_id, package_id, end_epoch)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
                owner = EXCLUDED.owner,
                namespace = EXCLUDED.namespace,
                blob_id = EXCLUDED.blob_id,
                embedding = EXCLUDED.embedding,
                blob_size_bytes = EXCLUDED.blob_size_bytes,
                importance = EXCLUDED.importance,
                agent_id = EXCLUDED.agent_id,
                package_id = EXCLUDED.package_id,
                end_epoch = EXCLUDED.end_epoch,
                updated_at = NOW()",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(importance)
        .bind(agent_id)
        .bind(package_id)
        .bind(end_epoch)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert vector: {}", e)));
        crate::observability::observe_db("vector.insert", db_status(&result), started.elapsed());
        result?;
        sqlx::query("DELETE FROM memory_tombstones WHERE memory_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to clear tombstone: {}", e)))?;
        tx.commit()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to commit insert tx: {}", e)))?;

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
        let mut tx = self.pool.begin().await.map_err(|e| {
            AppError::Internal(format!("Failed to begin plaintext insert tx: {}", e))
        })?;
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
                importance = EXCLUDED.importance,
                updated_at = NOW()",
        )
        .bind(id)
        .bind(owner)
        .bind(namespace)
        .bind(blob_id)
        .bind(embedding)
        .bind(blob_size_bytes)
        .bind(plaintext)
        .bind(importance)
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to insert plaintext vector: {}", e)));
        crate::observability::observe_db(
            "vector.insert_plaintext",
            db_status(&result),
            started.elapsed(),
        );
        result?;
        sqlx::query("DELETE FROM memory_tombstones WHERE memory_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to clear tombstone: {}", e)))?;
        tx.commit().await.map_err(|e| {
            AppError::Internal(format!("Failed to commit plaintext insert tx: {}", e))
        })?;

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
        let result = sqlx::query(
            "WITH removed AS (
                DELETE FROM vector_entries
                WHERE owner = $1 AND namespace = $2
                RETURNING id, owner, namespace, blob_id
             )
             INSERT INTO memory_tombstones (memory_id, owner, namespace, blob_id)
             SELECT id, owner, namespace, blob_id FROM removed
             ON CONFLICT (memory_id) DO UPDATE SET deleted_at = NOW()",
        )
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
            "WITH removed AS (
                DELETE FROM vector_entries
                WHERE blob_id = $1 AND owner = $2 AND namespace = $3
                RETURNING id, owner, namespace, blob_id
             )
             INSERT INTO memory_tombstones (memory_id, owner, namespace, blob_id)
             SELECT id, owner, namespace, blob_id FROM removed
             ON CONFLICT (memory_id) DO UPDATE SET deleted_at = NOW()",
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

    /// Drop tombstones older than `TOMBSTONE_RETENTION`. Batched so a large
    /// backlog cannot lock the table for one giant delete.
    pub async fn sweep_expired_tombstones(&self) -> Result<u64, AppError> {
        let secs = TOMBSTONE_RETENTION.num_seconds();
        let mut total = 0u64;
        loop {
            let result = sqlx::query(
                "DELETE FROM memory_tombstones
                 WHERE memory_id IN (
                    SELECT memory_id FROM memory_tombstones
                    WHERE deleted_at < NOW() - make_interval(secs => $1)
                    LIMIT 1000
                 )",
            )
            .bind(secs)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to sweep tombstones: {}", e)))?;
            let n = result.rows_affected();
            total += n;
            if n < 1000 {
                break;
            }
        }
        Ok(total)
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

    /// Rows whose expiry data has never been synced, or was synced more
    /// than 24h ago. Returns (owner, id, blob_id) tuples — the minimum a
    /// caller needs to look up on-chain data and write it back. Stamps
    /// nothing itself; the caller must call `mark_expiry_scheduled` before
    /// doing the (potentially slow) on-chain lookup, so a second sweep
    /// tick doesn't re-select the same rows while the first is in flight.
    pub async fn rows_needing_expiry_refresh(
        &self,
        limit: i64,
    ) -> Result<Vec<(String, String, String)>, AppError> {
        sqlx::query_as(
            "SELECT owner, id, blob_id FROM vector_entries
             WHERE expiry_synced_at IS NULL OR expiry_synced_at < NOW() - INTERVAL '24 hours'
             ORDER BY expiry_synced_at ASC NULLS FIRST
             LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Failed to select rows needing expiry refresh: {}",
                e
            ))
        })
    }

    /// Stamp expiry_synced_at = NOW() at SCHEDULE time (not completion) so
    /// a row already picked up by the current sweep tick isn't re-selected
    /// by the next tick while its on-chain lookup is still in flight. A
    /// failed lookup is retried on the next sweep after the 24h window —
    /// acceptable degradation, avoids duplicate-enqueue storms. Never
    /// touches updated_at.
    pub async fn mark_expiry_scheduled(&self, ids: &[String]) -> Result<(), AppError> {
        sqlx::query("UPDATE vector_entries SET expiry_synced_at = NOW() WHERE id = ANY($1)")
            .bind(ids)
            .execute(&self.pool)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to mark expiry scheduled: {}", e)))?;
        Ok(())
    }

    /// Write back a resolved end_epoch/expires_at for one row.
    ///
    /// `updated_at` advances when `end_epoch` changes, and also whenever
    /// `expires_at` is still NULL. The second half matters because
    /// `insert_vector` writes `end_epoch` but not `expires_at`, so on the
    /// mainline write path the sweep's first call finds `end_epoch` already
    /// equal and would otherwise populate `expires_at` invisibly, leaving a
    /// client that synced the row pre-sweep on `null` forever. This was
    /// originally
    /// unconditional-never: the sweep that calls this re-verifies every
    /// row on a ~24h cadence even after it already has a value, and an
    /// unconditional `updated_at = NOW()` on every one of those routine
    /// re-checks would make effectively every memory reappear in Console's
    /// `updated_after` incremental sync roughly once a day regardless of
    /// whether anything actually changed. But that guard was too broad: it
    /// also suppressed the *one* write that must be cursor-visible — the
    /// first time a row's expiry resolves from `NULL` to a real value. A
    /// client that already synced that row before the sweep ran would then
    /// never see the populated `end_epoch`/`expires_at` on any later poll,
    /// silently breaking expiry tracking for exactly the rows synced
    /// before their expiry was known. Conditioning on an actual value
    /// change satisfies both: the first real write bumps `updated_at`
    /// (visible to sync); unchanged re-verifications don't (no spam).
    ///
    /// The change-check deliberately compares `end_epoch` only, not
    /// `expires_at`. `expires_at` is derived from `end_epoch` plus
    /// wall-clock `now` at sweep time (see `expires_at_from_epoch`), so it
    /// recomputes to a slightly different instant on every routine
    /// re-verification even when `end_epoch` hasn't moved at all — an
    /// `expires_at IS DISTINCT FROM $2` condition would be true on
    /// essentially every sweep tick and defeat the anti-spam guard this
    /// comment describes. `expires_at` is still refreshed on every write
    /// (it's deliberately approximate; keeping it current is harmless),
    /// it just doesn't drive whether `updated_at` bumps.
    pub async fn set_memory_expiry(
        &self,
        id: &str,
        end_epoch: i32,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), AppError> {
        sqlx::query(
            "UPDATE vector_entries
             SET end_epoch = $1,
                 expires_at = $2,
                 updated_at = CASE
                     WHEN end_epoch IS DISTINCT FROM $1 OR expires_at IS NULL
                     THEN NOW()
                     ELSE updated_at
                 END
             WHERE id = $3",
        )
        .bind(end_epoch)
        .bind(expires_at)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to set memory expiry: {}", e)))?;
        Ok(())
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

    /// Atomically admit a batch of writes against the owner's storage quota.
    ///
    /// This is the whole fix for GH #532 / WALM-359. The previous
    /// `get_storage_used_with_lock` took a `pg_advisory_xact_lock`, read the
    /// total, and then committed — which released the lock, because xact locks
    /// are transaction scoped. The comparison and the caller's INSERT both
    /// happened outside it, so concurrent requests from one owner all observed
    /// the same pre-insert total and all passed.
    ///
    /// Here the lock, the usage read, the comparison, and the reservation
    /// INSERT all live in one transaction. Nothing else for this owner can
    /// interleave, so a burst is serialized and only what actually fits is
    /// admitted.
    ///
    /// Usage counts committed rows plus live reservations:
    ///   `SUM(vector_entries.blob_size_bytes) + SUM(storage_reservations.bytes)`
    /// Expired reservations are excluded by predicate and opportunistically
    /// deleted for this owner, so a missed release self-heals at `ttl`.
    ///
    /// Admission is all-or-nothing across `reservations`, which preserves the
    /// existing behaviour where a bulk request either lands whole or is
    /// rejected whole.
    ///
    /// `pg_advisory_xact_lock` (not the session-level `pg_advisory_lock`) is
    /// still the right primitive here: with a connection pool the session
    /// variant leaks locks onto pooled connections and deadlocks. Inside an
    /// explicit transaction the lock is released on commit or rollback.
    pub async fn admit_storage_reservations(
        &self,
        owner: &str,
        lock_key: i64,
        max_bytes: i64,
        reservations: &[StorageReservationRequest],
        ttl: std::time::Duration,
    ) -> Result<StorageAdmission, AppError> {
        if reservations.is_empty() {
            return Ok(StorageAdmission::Admitted);
        }

        let started = std::time::Instant::now();
        let ttl_secs = ttl.as_secs().min(i64::MAX as u64) as i64;
        let requested: i64 = reservations.iter().map(|r| r.bytes).sum();

        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to begin tx: {}", e)))?;

        // Serializes every admission for this owner. Held until commit or
        // rollback below, which is what makes check-then-reserve atomic.
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to acquire advisory lock: {}", e)))?;

        // Opportunistic cleanup, scoped to this owner so the write stays
        // small and cannot contend with other owners' admissions. The global
        // sweeper handles owners who never come back.
        sqlx::query("DELETE FROM storage_reservations WHERE owner = $1 AND expires_at <= NOW()")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .map_err(|e| {
                AppError::Internal(format!("Failed to prune expired reservations: {}", e))
            })?;

        let committed: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get storage used: {}", e)))?;

        let reserved: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(bytes)::BIGINT, 0) FROM storage_reservations
             WHERE owner = $1 AND expires_at > NOW()",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to get reserved storage: {}", e)))?;

        let used = committed.0.saturating_add(reserved.0);

        if used.saturating_add(requested) > max_bytes {
            // Rollback releases the advisory lock and writes nothing.
            if let Err(e) = tx.rollback().await {
                tracing::warn!("failed to roll back rejected quota admission: {}", e);
            }
            crate::observability::observe_db(
                "quota.admit_reservations",
                "rejected",
                started.elapsed(),
            );
            return Ok(StorageAdmission::Rejected { used });
        }

        // ON CONFLICT makes admission idempotent. A retried enqueued job
        // re-admitting under the same `remember_jobs.id` refreshes its own
        // reservation instead of double counting itself.
        for reservation in reservations {
            sqlx::query(
                "INSERT INTO storage_reservations (id, owner, bytes, expires_at)
                 VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'))
                 ON CONFLICT (id) DO UPDATE SET
                    owner = EXCLUDED.owner,
                    bytes = EXCLUDED.bytes,
                    expires_at = EXCLUDED.expires_at",
            )
            .bind(&reservation.id)
            .bind(owner)
            .bind(reservation.bytes)
            .bind(ttl_secs)
            .execute(&mut *tx)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to insert reservation: {}", e)))?;
        }

        tx.commit()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to commit tx: {}", e)))?;

        crate::observability::observe_db("quota.admit_reservations", "ok", started.elapsed());
        Ok(StorageAdmission::Admitted)
    }

    /// Release reservations once their bytes are accounted for elsewhere, or
    /// once the write that reserved them is known to be dead.
    ///
    /// Callers release *after* the vector row is committed. That ordering
    /// briefly double counts the same bytes (row + reservation), which is the
    /// safe direction: releasing first would open a window where neither
    /// counts and a concurrent burst could slip through.
    ///
    /// Idempotent by construction — deleting an already released id is a
    /// no-op, so retried jobs and overlapping failure handlers are harmless.
    /// Never returns an error to the caller: a failed release is recovered by
    /// the TTL, and must not turn a successful write into a failed one.
    pub async fn release_storage_reservations(&self, ids: &[String]) {
        release_storage_reservations_with_pool(&self.pool, ids).await
    }

    /// Drop reservations whose `remember_jobs` row is already terminal.
    ///
    /// The explicit release calls in `jobs.rs` handle the common paths
    /// promptly, but a terminal row with a live reservation can still arise:
    /// the stale-job sweeper fails a row directly, a recovery handoff marks a
    /// job failed from a code path that only has a pool handle, or a future
    /// terminal path forgets to release. Reconciling against job status turns
    /// every one of those from a full-TTL overcount into a bounded one, and
    /// keeps the guarantee from depending on nobody ever missing a call site.
    ///
    /// Only reservations keyed by a `remember_jobs.id` are affected. Inline
    /// reservations use local UUIDs with no job row, so they never match here
    /// and are covered by their own release plus the TTL.
    pub async fn release_reservations_for_terminal_jobs(&self) -> Result<u64, AppError> {
        let result = sqlx::query(
            "DELETE FROM storage_reservations r
             USING remember_jobs j
             WHERE r.id = j.id AND j.status IN ('done', 'failed')",
        )
        .execute(&self.pool)
        .await
        .map_err(|e| {
            AppError::Internal(format!(
                "Failed to reconcile reservations against terminal jobs: {}",
                e
            ))
        })?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!(
                "released {} storage reservation(s) held by terminal remember jobs",
                rows
            );
        }
        Ok(rows)
    }

    /// Delete reservations whose TTL has passed, across all owners.
    ///
    /// The admission path already prunes the owner it touches, so this only
    /// matters for owners who reserved, leaked, and never returned. Without it
    /// their rows would sit in the table forever even though the predicate
    /// already stops counting them.
    pub async fn sweep_expired_storage_reservations(&self) -> Result<u64, AppError> {
        let result = sqlx::query("DELETE FROM storage_reservations WHERE expires_at <= NOW()")
            .execute(&self.pool)
            .await
            .map_err(|e| {
                AppError::Internal(format!("Failed to sweep expired reservations: {}", e))
            })?;

        let rows = result.rows_affected();
        if rows > 0 {
            tracing::info!("swept {} expired storage reservation(s)", rows);
        }
        Ok(rows)
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
        let pending = sqlx::query(
            "DELETE FROM mcp_oauth_delegates d
             WHERE d.status = 'pending'
               AND d.created_at <= NOW() - INTERVAL '1 hour'
               AND NOT EXISTS (
                   SELECT 1 FROM mcp_oauth_authorize_sessions s
                   WHERE s.delegate_ref = d.delegate_ref
               )
               AND NOT EXISTS (
                   SELECT 1 FROM mcp_oauth_codes c
                   WHERE c.delegate_ref = d.delegate_ref
               )
               AND NOT EXISTS (
                   SELECT 1 FROM mcp_oauth_grants g
                   WHERE g.delegate_ref = d.delegate_ref
               )",
        )
        .execute(&self.pool)
        .await
        .map_err(|e| {
            AppError::Internal(format!("Failed to prune abandoned oauth delegates: {}", e))
        })?;
        total += pending.rows_affected();
        if total > 0 {
            tracing::info!(
                "Evicted {} expired MCP OAuth session/code/pending-delegate rows",
                total
            );
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

// ============================================================
// Storage quota admission — concurrency regression tests
// ============================================================
//
// These pin the fix for GH #532 / WALM-359 against a real PostgreSQL, because
// the defect only exists in the interleaving of concurrent transactions. An
// in-process fake would serialize the very thing under test and pass against
// the broken code.
//
// Shape mirrors the reproduction on the issue: seed an owner just under quota
// so exactly one more write fits, fire a 20-way burst, and assert exactly one
// admission. Against the old read-then-commit-then-insert code the same
// harness admitted 13 to 20 of 20.
//
// Requires DATABASE_URL (or the local default) to point at a Postgres with
// pgvector. Marked #[ignore] to match the existing convention for tests with
// external dependencies — run with `cargo test -- --ignored`.
#[cfg(test)]
mod quota_admission_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    /// Matches the real default in `rate_limit::RateLimitConfig` (1 GiB).
    const MAX_BYTES: i64 = 1_073_741_824;
    /// Per-request size for the burst. Arbitrary but fixed, so the seed below
    /// can leave room for exactly one.
    const ITEM_BYTES: i64 = 1_048_576;
    const BURST: usize = 20;
    const TTL: Duration = Duration::from_secs(900);

    fn test_database_url() -> String {
        std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://memwal:memwal_secret@localhost:5432/memwal".into())
    }

    async fn test_db() -> VectorDb {
        VectorDb::new(&test_database_url())
            .await
            .expect("test database must be reachable with pgvector installed")
    }

    /// Unique per test so concurrent runs cannot see each other's rows, and so
    /// a failed run leaves no state that poisons the next one.
    fn unique_owner(tag: &str) -> String {
        format!("0xtest-{}-{}", tag, uuid::Uuid::new_v4())
    }

    fn lock_key(owner: &str) -> i64 {
        // Same FNV-1a folding as `rate_limit::stable_hash_i64`. Duplicated
        // rather than imported so this test pins the DB layer's contract on
        // its own, independent of the caller.
        const FNV_OFFSET: u64 = 14_695_981_039_346_656_037;
        const FNV_PRIME: u64 = 1_099_511_628_211;
        let hash = owner
            .bytes()
            .fold(FNV_OFFSET, |acc, b| acc.wrapping_mul(FNV_PRIME) ^ b as u64);
        ((hash >> 32) ^ (hash & 0xFFFF_FFFF)) as i64
    }

    fn zero_vector() -> Vec<f32> {
        vec![0.0; 1536]
    }

    /// Seed committed usage so exactly one `ITEM_BYTES` write still fits.
    async fn seed_to_one_slot_remaining(db: &VectorDb, owner: &str) {
        let seeded = MAX_BYTES - ITEM_BYTES;
        db.insert_vector(
            &format!("seed-{}", uuid::Uuid::new_v4()),
            owner,
            "default",
            "seed-blob",
            &zero_vector(),
            seeded,
            0.5,
            None,
            None,
            None,
        )
        .await
        .expect("seed insert");
    }

    async fn committed_bytes(db: &VectorDb, owner: &str) -> i64 {
        let row: (i64,) = sqlx::query_as(
            "SELECT COALESCE(SUM(blob_size_bytes)::BIGINT, 0) FROM vector_entries WHERE owner = $1",
        )
        .bind(owner)
        .fetch_one(db.pool())
        .await
        .unwrap();
        row.0
    }

    async fn cleanup(db: &VectorDb, owner: &str) {
        let _ = sqlx::query("DELETE FROM vector_entries WHERE owner = $1")
            .bind(owner)
            .execute(db.pool())
            .await;
        let _ = sqlx::query("DELETE FROM storage_reservations WHERE owner = $1")
            .bind(owner)
            .execute(db.pool())
            .await;
    }

    /// Inline path: admission immediately followed by the insert.
    ///
    /// This is the cheap case (microseconds between check and write) and it
    /// still overshot before the fix.
    #[tokio::test]
    #[ignore]
    async fn burst_admits_exactly_one_inline() {
        let db = Arc::new(test_db().await);
        let owner = unique_owner("inline");
        seed_to_one_slot_remaining(&db, &owner).await;

        let mut handles = Vec::with_capacity(BURST);
        for _ in 0..BURST {
            let db = Arc::clone(&db);
            let owner = owner.clone();
            handles.push(tokio::spawn(async move {
                let id = uuid::Uuid::new_v4().to_string();
                let admission = db
                    .admit_storage_reservations(
                        &owner,
                        lock_key(&owner),
                        MAX_BYTES,
                        &[StorageReservationRequest {
                            id: id.clone(),
                            bytes: ITEM_BYTES,
                        }],
                        TTL,
                    )
                    .await
                    .expect("admission must not error");

                if admission != StorageAdmission::Admitted {
                    return false;
                }

                db.insert_vector(
                    &id,
                    &owner,
                    "default",
                    "blob",
                    &zero_vector(),
                    ITEM_BYTES,
                    0.5,
                    None,
                    None,
                    None,
                )
                .await
                .expect("insert");
                db.release_storage_reservations(&[id]).await;
                true
            }));
        }

        let mut admitted = 0usize;
        for h in handles {
            if h.await.unwrap() {
                admitted += 1;
            }
        }

        let total = committed_bytes(&db, &owner).await;
        cleanup(&db, &owner).await;

        assert_eq!(
            admitted, 1,
            "exactly one of {} concurrent requests should be admitted, got {}",
            BURST, admitted
        );
        assert!(
            total <= MAX_BYTES,
            "committed bytes {} must never exceed quota {}",
            total,
            MAX_BYTES
        );
    }

    /// Enqueued path: admission, then a delay standing in for the Walrus
    /// upload, then the insert.
    ///
    /// This is the severe case. The gap is real (documented as up to five
    /// minutes) and before the fix a 150 ms gap was enough to admit the entire
    /// burst. The delay here is what makes the test meaningful, so it must not
    /// be optimised away.
    #[tokio::test]
    #[ignore]
    async fn burst_admits_exactly_one_with_delayed_insert() {
        let db = Arc::new(test_db().await);
        let owner = unique_owner("enqueued");
        seed_to_one_slot_remaining(&db, &owner).await;

        let mut handles = Vec::with_capacity(BURST);
        for _ in 0..BURST {
            let db = Arc::clone(&db);
            let owner = owner.clone();
            handles.push(tokio::spawn(async move {
                let id = uuid::Uuid::new_v4().to_string();
                let admission = db
                    .admit_storage_reservations(
                        &owner,
                        lock_key(&owner),
                        MAX_BYTES,
                        &[StorageReservationRequest {
                            id: id.clone(),
                            bytes: ITEM_BYTES,
                        }],
                        TTL,
                    )
                    .await
                    .expect("admission must not error");

                if admission != StorageAdmission::Admitted {
                    return false;
                }

                // Stands in for embed → encrypt → Walrus upload.
                tokio::time::sleep(Duration::from_millis(150)).await;

                db.insert_vector(
                    &id,
                    &owner,
                    "default",
                    "blob",
                    &zero_vector(),
                    ITEM_BYTES,
                    0.5,
                    None,
                    None,
                    None,
                )
                .await
                .expect("insert");
                db.release_storage_reservations(&[id]).await;
                true
            }));
        }

        let mut admitted = 0usize;
        for h in handles {
            if h.await.unwrap() {
                admitted += 1;
            }
        }

        let total = committed_bytes(&db, &owner).await;
        cleanup(&db, &owner).await;

        assert_eq!(
            admitted, 1,
            "the upload gap must not let extra requests through: got {} of {}",
            admitted, BURST
        );
        assert!(
            total <= MAX_BYTES,
            "committed bytes {} must never exceed quota {}",
            total,
            MAX_BYTES
        );
    }

    /// A reservation must count against quota before any row exists. This is
    /// the single assertion that fails against the pre-fix code.
    #[tokio::test]
    #[ignore]
    async fn reservation_counts_before_the_row_lands() {
        let db = test_db().await;
        let owner = unique_owner("counts");
        seed_to_one_slot_remaining(&db, &owner).await;

        let first = db
            .admit_storage_reservations(
                &owner,
                lock_key(&owner),
                MAX_BYTES,
                &[StorageReservationRequest {
                    id: "res-first".into(),
                    bytes: ITEM_BYTES,
                }],
                TTL,
            )
            .await
            .unwrap();
        assert_eq!(first, StorageAdmission::Admitted);

        // No insert yet — the reservation alone must fill the slot.
        let second = db
            .admit_storage_reservations(
                &owner,
                lock_key(&owner),
                MAX_BYTES,
                &[StorageReservationRequest {
                    id: "res-second".into(),
                    bytes: ITEM_BYTES,
                }],
                TTL,
            )
            .await
            .unwrap();
        assert!(
            matches!(second, StorageAdmission::Rejected { .. }),
            "an outstanding reservation must block the next admission, got {:?}",
            second
        );

        cleanup(&db, &owner).await;
    }

    /// Releasing must hand the quota straight back, so a failed or completed
    /// write does not cost the owner capacity until TTL.
    #[tokio::test]
    #[ignore]
    async fn release_frees_quota_immediately() {
        let db = test_db().await;
        let owner = unique_owner("release");
        seed_to_one_slot_remaining(&db, &owner).await;

        let req = [StorageReservationRequest {
            id: "res-release".into(),
            bytes: ITEM_BYTES,
        }];
        assert_eq!(
            db.admit_storage_reservations(&owner, lock_key(&owner), MAX_BYTES, &req, TTL)
                .await
                .unwrap(),
            StorageAdmission::Admitted
        );

        db.release_storage_reservations(&["res-release".to_string()])
            .await;

        assert_eq!(
            db.admit_storage_reservations(&owner, lock_key(&owner), MAX_BYTES, &req, TTL)
                .await
                .unwrap(),
            StorageAdmission::Admitted,
            "released bytes must be immediately reusable"
        );

        cleanup(&db, &owner).await;
    }

    /// The TTL backstop: a reservation nobody ever released must stop counting,
    /// so a missed release can never make an account permanently unusable.
    #[tokio::test]
    #[ignore]
    async fn expired_reservation_stops_counting() {
        let db = test_db().await;
        let owner = unique_owner("ttl");
        seed_to_one_slot_remaining(&db, &owner).await;

        // Zero TTL: expired the moment it is written, standing in for a
        // reservation whose release never came.
        assert_eq!(
            db.admit_storage_reservations(
                &owner,
                lock_key(&owner),
                MAX_BYTES,
                &[StorageReservationRequest {
                    id: "res-stale".into(),
                    bytes: ITEM_BYTES,
                }],
                Duration::from_secs(0),
            )
            .await
            .unwrap(),
            StorageAdmission::Admitted
        );

        assert_eq!(
            db.admit_storage_reservations(
                &owner,
                lock_key(&owner),
                MAX_BYTES,
                &[StorageReservationRequest {
                    id: "res-after-stale".into(),
                    bytes: ITEM_BYTES,
                }],
                TTL,
            )
            .await
            .unwrap(),
            StorageAdmission::Admitted,
            "an expired reservation must not hold quota"
        );

        db.sweep_expired_storage_reservations().await.unwrap();

        cleanup(&db, &owner).await;
    }

    /// Bulk admission is all-or-nothing, which is what keeps the existing
    /// "reject the whole request" behaviour and the 402 shape intact.
    #[tokio::test]
    #[ignore]
    async fn batch_admission_is_all_or_nothing() {
        let db = test_db().await;
        let owner = unique_owner("batch");
        seed_to_one_slot_remaining(&db, &owner).await;

        // Two items, only one slot.
        let outcome = db
            .admit_storage_reservations(
                &owner,
                lock_key(&owner),
                MAX_BYTES,
                &[
                    StorageReservationRequest {
                        id: "batch-a".into(),
                        bytes: ITEM_BYTES,
                    },
                    StorageReservationRequest {
                        id: "batch-b".into(),
                        bytes: ITEM_BYTES,
                    },
                ],
                TTL,
            )
            .await
            .unwrap();
        assert!(
            matches!(outcome, StorageAdmission::Rejected { .. }),
            "an over-quota batch must be rejected whole, got {:?}",
            outcome
        );

        let leaked: (i64,) =
            sqlx::query_as("SELECT COUNT(*)::BIGINT FROM storage_reservations WHERE owner = $1")
                .bind(&owner)
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(
            leaked.0, 0,
            "a rejected batch must not leave partial reservations behind"
        );

        cleanup(&db, &owner).await;
    }
}
