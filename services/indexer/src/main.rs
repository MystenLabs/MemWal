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
mod sui;
mod json_rpc;

use std::time::Duration;

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

    // Connect to PostgreSQL
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to PostgreSQL");

    // Run migration
    sqlx::raw_sql(MIGRATION_SQL)
        .execute(&pool)
        .await
        .expect("Failed to run migration");

    tracing::info!("database connected, tables ready");

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("memwal-indexer/0.1")
        .build()
        .expect("Failed to build HTTP client");

    let event_source = json_rpc::JsonRpcEventSource::new(
        http_client,
        config.sui_rpc_url,
        config.package_id.clone(),
    );

    let filter = sui::EventFilter::MoveEventType {
        package_id: config.package_id.clone(),
        module: "account".to_string(),
        event: "AccountCreated".to_string(),
    };

    let poll_interval = tokio::time::Duration::from_secs(config.poll_interval_secs);

    // Load cursor
    let mut cursor = load_cursor(&pool).await;
    if let Some(ref c) = cursor {
        tracing::info!("resuming from cursor: {}", c);
    } else {
        tracing::info!("starting from beginning (no saved cursor)");
    }

    let mut event_source = Box::new(event_source) as Box<dyn sui::EventSource>;

    loop {
        match event_source.query_events(filter.clone(), cursor.clone(), 50).await {
            Ok(page) => {
                let count = page.events.len();
                if count > 0 {
                    tracing::info!("fetched {} events", count);
                }

                for event in &page.events {
                    if let Err(e) = process_event(&pool, event).await {
                        tracing::error!("failed to process event: {}", e);
                    }
                }

                if let Some(new_cursor) = page.next_cursor {
                    save_cursor(&pool, &new_cursor).await;
                    cursor = Some(new_cursor);
                }

                if page.has_next_page {
                    continue;
                }
            }
            Err(e) => {
                tracing::error!("failed to poll events: {}", e);
            }
        }

        tokio::time::sleep(poll_interval).await;
    }
}

// ============================================================
// Event Processing
// ============================================================

async fn process_event(pool: &sqlx::PgPool, event: &sui::SuiEvent) -> Result<(), String> {
    let json = event.json.as_ref().ok_or("missing parsed json")?;

    let account_id = json
        .get("account_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing account_id in event".to_string())?;

    let owner = json
        .get("owner")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing owner in event".to_string())?;

    sqlx::query(
        "INSERT INTO accounts (account_id, owner)
         VALUES ($1, $2)
         ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .bind(owner)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to insert account: {}", e))?;

    tracing::info!("indexed account: {} (owner: {})", account_id, owner);
    Ok(())
}

// ============================================================
// Cursor Persistence
// ============================================================

async fn load_cursor(pool: &sqlx::PgPool) -> Option<sui::EventId> {
    let result: Option<(String,)> = sqlx::query_as(
        "SELECT value FROM indexer_state WHERE key = 'event_cursor'"
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    result.and_then(|(json_str,)| {
        // Try new string format first
        if let Ok(id) = json_str.parse::<sui::EventId>() {
            return Some(id);
        }
        // Fall back to old JSON format
        #[derive(serde::Deserialize)]
        struct OldCursor {
            #[serde(rename = "txDigest")]
            tx_digest: String,
            #[serde(rename = "eventSeq")]
            event_seq: String,
        }
        serde_json::from_str::<OldCursor>(&json_str).ok().map(|c| sui::EventId {
            tx_digest: c.tx_digest,
            event_seq: c.event_seq.parse().unwrap_or(0),
        })
    })
}

async fn save_cursor(pool: &sqlx::PgPool, cursor: &sui::EventId) {
    let cursor_str = cursor.to_string();
    if let Err(e) = sqlx::query(
        "INSERT INTO indexer_state (key, value)
         VALUES ('event_cursor', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1",
    )
    .bind(&cursor_str)
    .execute(pool)
    .await
    {
        tracing::warn!("failed to save cursor: {}", e);
    }
}

// ============================================================
// Helpers
// ============================================================

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
