/// Walrus Memory Indexer
///
/// Polls Sui blockchain events and indexes Walrus Memory accounts into PostgreSQL.
/// This eliminates the need for the server to scan the on-chain registry
/// during auth, providing O(1) account lookups instead.
///
/// Indexed events:
/// - AccountCreated: stores account_id → owner mapping
///
/// The indexer tracks its cursor in `indexer_state` table so it can resume
/// from where it left off after restarts.
mod app;
mod extractors;
mod json_rpc;
mod sui;

// ============================================================
// Config
// ============================================================

#[derive(Debug, Clone)]
struct Config {
    database_url: String,
    sui_rpc_url: String,
    package_id: String,
    poll_interval_secs: u64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            sui_rpc_url: std::env::var("SUI_RPC_URL")
                .unwrap_or_else(|_| "https://fullnode.mainnet.sui.io:443".to_string()),
            package_id: std::env::var("MEMWAL_PACKAGE_ID").expect("MEMWAL_PACKAGE_ID must be set"),
            poll_interval_secs: std::env::var("POLL_INTERVAL_SECS")
                .unwrap_or_else(|_| "5".to_string())
                .parse()
                .expect("POLL_INTERVAL_SECS must be a number"),
        }
    }
}

// ============================================================
// Migration
// ============================================================

const MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    owner      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner);

CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

// ============================================================
// Main
// ============================================================

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "memwal_indexer=debug".into()),
        )
        .init();

    let config = Config::from_env();
    tracing::info!("starting Walrus Memory indexer");
    tracing::info!("  database: {}", redact_url(&config.database_url));
    tracing::info!("  sui rpc: {}", config.sui_rpc_url);
    tracing::info!("  package: {}", config.package_id);
    tracing::info!("  poll interval: {}s", config.poll_interval_secs);

    // Install Any driver for PostgreSQL
    sqlx::any::install_drivers(&[sqlx::postgres::any::DRIVER])
        .expect("Failed to install PostgreSQL driver");

    // Connect to database
    let pool = sqlx::any::AnyPoolOptions::new()
        .max_connections(3)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to database");

    // Run migration
    sqlx::raw_sql(MIGRATION_SQL)
        .execute(&pool)
        .await
        .expect("Failed to run migration");

    tracing::info!("database connected, tables ready");

    let filter = sui::EventFilter::MoveEventType {
        package_id: config.package_id.clone(),
        module: "account".to_string(),
        event: "AccountCreated".to_string(),
    };

    #[cfg(not(feature = "grpc"))]
    let event_source: Box<dyn sui::EventSource> = {
        use std::time::Duration;
        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("memwal-indexer/0.1")
            .build()
            .expect("Failed to build HTTP client");
        Box::new(json_rpc::JsonRpcEventSource::new(
            http_client,
            config.sui_rpc_url,
            config.package_id,
        ))
    };

    #[cfg(feature = "grpc")]
    let event_source: Box<dyn sui::EventSource> = {
        let resume = load_grpc_resume(&pool).await;
        if resume.is_some() {
            tracing::info!("resuming gRPC source from persisted watermark cursor");
        }
        let grpc_source = sui::grpc::GrpcEventSource::new(config.sui_rpc_url, resume)
            .await
            .expect("Failed to create gRPC event source");
        Box::new(grpc_source)
    };

    let mut app = app::IndexerApp::new(
        event_source,
        pool,
        filter,
        50,
        tokio::time::Duration::from_secs(config.poll_interval_secs),
    );

    if let Err(e) = app.run().await {
        tracing::error!("indexer exited with error: {}", e);
        std::process::exit(1);
    }
}

// ============================================================
// Helpers
// ============================================================

/// Loads the gRPC resume seed `(EventId, opaque watermark cursor)` from
/// `indexer_state`. Returns `None` unless both the cursor and a previously
/// persisted resume token are present (e.g. a fresh DB, or a cursor carried
/// over from the JSON-RPC source, which has no gRPC watermark).
#[cfg(feature = "grpc")]
async fn load_grpc_resume(pool: &sqlx::AnyPool) -> Option<(sui::EventId, Vec<u8>)> {
    let cursor: Option<(String,)> =
        sqlx::query_as("SELECT value FROM indexer_state WHERE key = 'event_cursor'")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let token: Option<(String,)> =
        sqlx::query_as("SELECT value FROM indexer_state WHERE key = 'event_resume_token'")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    let cursor = cursor?.0.parse::<sui::EventId>().ok()?;
    let token = hex::decode(token?.0).ok()?;
    Some((cursor, token))
}

fn redact_url(url: &str) -> String {
    // Redact password in DATABASE_URL for logging
    if let Some(at_pos) = url.find('@') {
        if let Some(colon_pos) = url[..at_pos].rfind(':') {
            let scheme_end = url.find("://").map(|p| p + 3).unwrap_or(0);
            if colon_pos > scheme_end {
                return format!("{}****{}", &url[..colon_pos + 1], &url[at_pos..]);
            }
        }
    }
    url.to_string()
}
