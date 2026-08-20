use sqlx::postgres::{PgConnectOptions, PgConnection, PgPoolOptions};
use sqlx::{Connection, PgPool};
use std::str::FromStr;
use std::time::Duration;

use super::postgres_url::{direct_postgres_url, is_transaction_pooler_url};
use crate::types::AppError;

/// Bound how long a single migrate attempt waits on sqlx's session advisory
/// lock. Combined with retries so a leaked pooler lock (WALM-378) is a
/// transient boot delay, not a hard crash.
const LEGACY_MIGRATION_LOCK_TIMEOUT: &str = "5s";
const LEGACY_MIGRATION_MAX_ATTEMPTS: u32 = 6;

pub struct LegacyDb {
    pool: PgPool,
}

impl LegacyDb {
    pub async fn new(database_url: &str) -> Result<Self, AppError> {
        Self::new_with_search_path(database_url, None).await
    }

    async fn new_with_search_path(
        database_url: &str,
        search_path: Option<&str>,
    ) -> Result<Self, AppError> {
        apply_legacy_migrations(database_url, search_path).await?;

        let mut options = PgConnectOptions::from_str(database_url)
            .map_err(|error| AppError::Internal(format!("legacy db URL invalid: {error}")))?;
        if let Some(search_path) = search_path {
            options = options.options([("search_path", search_path)]);
        }
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(options)
            .await
            .map_err(|error| AppError::Internal(format!("legacy db connect failed: {error}")))?;
        tracing::info!("legacy db connected, security-delete migrations applied");
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

async fn apply_legacy_migrations(
    database_url: &str,
    search_path: Option<&str>,
) -> Result<(), AppError> {
    let migrate_url = direct_postgres_url(database_url);
    if is_transaction_pooler_url(database_url) {
        let original_host = url::Url::parse(database_url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned));
        let direct_host = url::Url::parse(migrate_url.as_ref())
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned));
        tracing::info!(
            original_host,
            direct_host,
            "legacy db: running sqlx migrations on the direct Postgres endpoint (WALM-378)"
        );
    }

    let mut last_error: Option<AppError> = None;
    for attempt in 1..=LEGACY_MIGRATION_MAX_ATTEMPTS {
        match apply_legacy_migrations_once(migrate_url.as_ref(), search_path).await {
            Ok(()) => return Ok(()),
            Err(error)
                if migration_error_is_lock_contention(&error)
                    && attempt < LEGACY_MIGRATION_MAX_ATTEMPTS =>
            {
                let delay = Duration::from_millis(500 * (1u64 << (attempt - 1).min(4)));
                tracing::warn!(
                    attempt,
                    max_attempts = LEGACY_MIGRATION_MAX_ATTEMPTS,
                    retry_in_ms = delay.as_millis() as u64,
                    error = %error,
                    "legacy migration lock contention; retrying. \
                     If this persists, an orphaned sqlx advisory lock is held on a pooled backend \
                     (WALM-378). Release it with pg_terminate_backend on the pg_locks pid."
                );
                tokio::time::sleep(delay).await;
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppError::Internal("legacy migration failed: lock contention retries exhausted".into())
    }))
}

async fn apply_legacy_migrations_once(
    migrate_url: &str,
    search_path: Option<&str>,
) -> Result<(), AppError> {
    let mut options = PgConnectOptions::from_str(migrate_url)
        .map_err(|error| AppError::Internal(format!("legacy db URL invalid: {error}")))?;
    let mut gucs: Vec<(&str, &str)> = vec![("lock_timeout", LEGACY_MIGRATION_LOCK_TIMEOUT)];
    if let Some(search_path) = search_path {
        gucs.push(("search_path", search_path));
    }
    options = options.options(gucs);

    let mut conn = PgConnection::connect_with(&options)
        .await
        .map_err(|error| {
            AppError::Internal(format!("legacy db migrate connect failed: {error}"))
        })?;

    let mut migrator = sqlx::migrate!("./migrations_legacy");
    // The old V1 database already contains migration history from Apalis.
    // Only validate and apply migrations owned by the security-delete subsystem.
    migrator.set_ignore_missing(true);
    let result = migrator
        .run(&mut conn)
        .await
        .map_err(|error| AppError::Internal(format!("legacy migration failed: {error}")));

    // Direct connections drop session locks on close. Still unlock explicitly
    // so a cancelled run cannot leave the lock if the backend is reused.
    let _ = sqlx::query("SELECT pg_advisory_unlock_all()")
        .execute(&mut conn)
        .await;
    let _ = conn.close().await;
    result
}

fn migration_error_is_lock_contention(error: &AppError) -> bool {
    let msg = error.to_string().to_ascii_lowercase();
    msg.contains("lock timeout")
        || msg.contains("deadlock detected")
        || msg.contains("55p03")
        || msg.contains("40p01")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use uuid::Uuid;

    pub async fn fixture() -> Option<(LegacyDb, PgPool, String)> {
        fixture_with_rows(&[]).await
    }

    async fn fixture_with_rows(rows: &[(&str, &str, &str)]) -> Option<(LegacyDb, PgPool, String)> {
        let url = std::env::var("TEST_LEGACY_DATABASE_URL").ok()?;
        let admin = PgPool::connect(&url).await.expect("connect test Postgres");
        let schema = format!("sd_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .expect("create scratch schema");
        let options = PgConnectOptions::from_str(&url)
            .unwrap()
            .options([("search_path", schema.as_str())]);
        let setup = PgPoolOptions::new().connect_with(options).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE vector_entries (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, blob_id TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )",
        )
        .execute(&setup)
        .await
        .unwrap();
        for (id, owner, blob_id) in rows {
            sqlx::query("INSERT INTO vector_entries(id,owner,blob_id) VALUES($1,$2,$3)")
                .bind(id)
                .bind(owner)
                .bind(blob_id)
                .execute(&setup)
                .await
                .unwrap();
        }
        let legacy = LegacyDb::new_with_search_path(&url, Some(&schema))
            .await
            .unwrap();
        Some((legacy, admin, schema))
    }

    #[test]
    fn lock_timeout_errors_are_retryable() {
        assert!(migration_error_is_lock_contention(&AppError::Internal(
            "legacy migration failed: while executing migrations: \
             error returned from database: canceling statement due to lock timeout"
                .into()
        )));
        assert!(migration_error_is_lock_contention(&AppError::Internal(
            "deadlock detected".into()
        )));
        assert!(!migration_error_is_lock_contention(&AppError::Internal(
            "relation \"vector_entries\" does not exist".into()
        )));
    }

    #[tokio::test]
    #[ignore]
    async fn legacy_migration_trigger_captures_new_inserts_and_seed_is_idempotent() {
        let Some((legacy, admin, schema)) = fixture_with_rows(&[("1", "0xa", "pre")]).await else {
            return;
        };
        sqlx::query("INSERT INTO vector_entries (id, owner, blob_id) VALUES ('2','0xa','post')")
            .execute(legacy.pool())
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM delete_blobs_tracking")
            .fetch_one(legacy.pool())
            .await
            .unwrap();
        assert_eq!(count, 2);
        let url = std::env::var("TEST_LEGACY_DATABASE_URL").unwrap();
        let reopened = LegacyDb::new_with_search_path(&url, Some(&schema))
            .await
            .unwrap();
        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(reopened.pool())
                .await
                .unwrap();
        assert_eq!(versions, vec![1, 2]);
        drop(reopened);
        drop(legacy);
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&admin)
            .await
            .unwrap();
    }
}
