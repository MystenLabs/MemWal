/// MemWal Indexer
///
/// Polls Sui blockchain events and indexes MemWal accounts into PostgreSQL.
/// This eliminates the need for the server to scan the on-chain registry
/// during auth, providing O(1) account lookups instead.
///
/// Indexed events:
/// - AccountCreated: stores account_id → owner mapping
///
/// The indexer tracks its cursor in `indexer_state` table so it can resume
/// from where it left off after restarts.
use serde::{Deserialize, Serialize};
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
// Sui Event Types
// ============================================================

#[derive(Debug, Deserialize)]
struct EventPage {
    data: Vec<SuiEvent>,
    #[serde(rename = "nextCursor")]
    next_cursor: Option<EventCursor>,
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct EventCursor {
    #[serde(rename = "txDigest")]
    tx_digest: String,
    #[serde(rename = "eventSeq")]
    event_seq: String,
}

#[derive(Debug, Deserialize)]
struct SuiEvent {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    event_type: String,
    #[serde(rename = "parsedJson")]
    parsed_json: serde_json::Value,
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
    tracing::info!("starting memwal indexer");
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

    // Load saved cursor (if any)
    let mut cursor = load_cursor(&pool).await;
    if let Some(ref c) = cursor {
        tracing::info!("resuming from cursor: {}:{}", c.tx_digest, c.event_seq);
    } else {
        tracing::info!("starting from beginning (no saved cursor)");
    }

    // Main polling loop
    let event_type = format!("{}::account::AccountCreated", config.package_id);
    let poll_interval = tokio::time::Duration::from_secs(config.poll_interval_secs);

    loop {
        match poll_events(&http_client, &config, &event_type, &cursor).await {
            Ok(page) => {
                let count = page.data.len();
                if count > 0 {
                    tracing::info!("fetched {} events", count);
                }

                for event in &page.data {
                    if let Err(e) = process_event(&pool, event).await {
                        tracing::error!("failed to process event: {}", e);
                    }
                }

                // Update cursor
                if let Some(new_cursor) = page.next_cursor {
                    save_cursor(&pool, &new_cursor).await;
                    cursor = Some(new_cursor);
                }

                // If there are more pages, don't sleep — fetch immediately
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
// Event Polling
// ============================================================

async fn poll_events(
    client: &reqwest::Client,
    config: &Config,
    event_type: &str,
    cursor: &Option<EventCursor>,
) -> Result<EventPage, String> {
    let cursor_json = match cursor {
        Some(c) => serde_json::json!({
            "txDigest": c.tx_digest,
            "eventSeq": c.event_seq,
        }),
        None => serde_json::Value::Null,
    };

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "suix_queryEvents",
        "params": [
            { "MoveEventType": event_type },
            cursor_json,
            50,   // limit
            false  // descending = false (oldest first)
        ]
    });

    let resp = client
        .post(&config.sui_rpc_url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<missing>")
        .to_string();

    let resp_bytes = resp.bytes().await.map_err(|e| {
        format!(
            "Failed to read response body: {} (status={}, content-type={})",
            e, status, content_type
        )
    })?;

    if !status.is_success() {
        return Err(format!(
            "RPC HTTP error: status={}, content-type={}, body={}",
            status,
            content_type,
            body_snippet(&resp_bytes),
        ));
    }

    parse_event_page_response(&resp_bytes, &content_type)
}

fn parse_event_page_response(resp_bytes: &[u8], content_type: &str) -> Result<EventPage, String> {
    let resp_json: serde_json::Value = serde_json::from_slice(resp_bytes).map_err(|e| {
        format!(
            "Failed to parse response JSON: {} (content-type={}, body={})",
            e,
            content_type,
            body_snippet(resp_bytes),
        )
    })?;

    if let Some(error) = resp_json.get("error") {
        return Err(format!("RPC error: {}", error));
    }

    let result = resp_json
        .get("result")
        .ok_or_else(|| "No result in response".to_string())?;

    let page: EventPage = serde_json::from_value(result.clone())
        .map_err(|e| format!("Failed to parse event page: {}", e))?;

    Ok(page)
}

fn body_snippet(bytes: &[u8]) -> String {
    const MAX_CHARS: usize = 512;

    let text = String::from_utf8_lossy(bytes);
    let mut snippet: String = text.chars().take(MAX_CHARS).collect();
    if text.chars().count() > MAX_CHARS {
        snippet.push_str("...");
    }
    snippet.replace('\n', "\\n").replace('\r', "\\r")
}

// ============================================================
// Event Processing
// ============================================================

async fn process_event(pool: &sqlx::PgPool, event: &SuiEvent) -> Result<(), String> {
    let json = &event.parsed_json;

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

async fn load_cursor(pool: &sqlx::PgPool) -> Option<EventCursor> {
    let result: Option<(String,)> =
        sqlx::query_as("SELECT value FROM indexer_state WHERE key = 'event_cursor'")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    result.and_then(|(json_str,)| serde_json::from_str::<EventCursor>(&json_str).ok())
}

async fn save_cursor(pool: &sqlx::PgPool, cursor: &EventCursor) {
    let json_str = serde_json::to_string(cursor).unwrap_or_default();

    if let Err(e) = sqlx::query(
        "INSERT INTO indexer_state (key, value)
         VALUES ('event_cursor', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1",
    )
    .bind(&json_str)
    .execute(pool)
    .await
    {
        tracing::warn!(
            "failed to save cursor (will re-process events on restart): {}",
            e
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_page_response_accepts_valid_rpc_result() {
        let body = br#"{
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "data": [],
                "nextCursor": null,
                "hasNextPage": false
            }
        }"#;

        let page = parse_event_page_response(body, "application/json").unwrap();
        assert_eq!(page.data.len(), 0);
        assert!(!page.has_next_page);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn parse_event_page_response_reports_non_json_body() {
        let err = parse_event_page_response(b"<html>rate limited</html>", "text/html").unwrap_err();

        assert!(err.contains("Failed to parse response JSON"));
        assert!(err.contains("content-type=text/html"));
        assert!(err.contains("<html>rate limited</html>"));
    }

    #[test]
    fn body_snippet_escapes_newlines_and_truncates() {
        let body = format!("{}\nnext", "a".repeat(600));
        let snippet = body_snippet(body.as_bytes());

        assert!(snippet.ends_with("..."));
        assert!(!snippet.contains('\n'));
        assert!(snippet.len() < body.len());
    }
}
