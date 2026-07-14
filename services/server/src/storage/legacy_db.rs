use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::str::FromStr;

use crate::types::AppError;

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
        let mut migrator = sqlx::migrate!("./migrations_legacy");
        // The old V1 database already contains migration history from Apalis.
        // Only validate and apply migrations owned by the security-delete subsystem.
        migrator.set_ignore_missing(true);
        migrator
            .run(&pool)
            .await
            .map_err(|error| AppError::Internal(format!("legacy migration failed: {error}")))?;
        tracing::info!("legacy db connected, security-delete migrations applied");
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
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
