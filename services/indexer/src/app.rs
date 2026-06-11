use crate::extractors::AccountCreatedExtractor;
use crate::sui::{EventFilter, EventId, EventSource, EventSourceError};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FatalError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("event source permanent error: {0}")]
    EventSourcePermanent(String),
    #[error("too many parse failures in window")]
    TooManyParseFailures,
    #[error("too many consecutive empty pages")]
    TooManyEmptyPages,
}

pub struct IndexerApp {
    event_source: Box<dyn EventSource>,
    pool: sqlx::AnyPool,
    filter: EventFilter,
    limit: usize,
    poll_interval: Duration,
    empty_page_count: u32,
    parse_failures: Vec<std::time::Instant>,
}

impl IndexerApp {
    pub fn new(
        event_source: Box<dyn EventSource>,
        pool: sqlx::AnyPool,
        filter: EventFilter,
        limit: usize,
        poll_interval: Duration,
    ) -> Self {
        Self {
            event_source,
            pool,
            filter,
            limit,
            poll_interval,
            empty_page_count: 0,
            parse_failures: Vec::new(),
        }
    }

    pub async fn run(&mut self) -> Result<(), FatalError> {
        let mut running = true;
        while running {
            let more_pages = match self.run_once().await {
                Ok(more_pages) => more_pages,
                Err(FatalError::EventSourcePermanent(ref msg)) => {
                    tracing::error!("fatal event source error: {}", msg);
                    return Err(FatalError::EventSourcePermanent(msg.clone()));
                }
                Err(e) => {
                    tracing::error!("fatal error: {}", e);
                    return Err(e);
                }
            };

            if running {
                // When the backlog spans multiple pages, fetch the next page
                // immediately instead of waiting a full poll interval — otherwise
                // initial sync / catch-up degrades to O(pages * poll_interval).
                // A zero sleep still lets ctrl_c win the select when signalled.
                let wait = if more_pages {
                    Duration::ZERO
                } else {
                    self.poll_interval
                };
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = tokio::signal::ctrl_c() => {
                        tracing::info!("shutdown signal received, stopping after current iteration");
                        running = false;
                    }
                }
            }
        }

        tracing::info!("shutting down gracefully");
        Ok(())
    }

    /// Runs a single poll cycle. Returns `true` when there are more pages to
    /// drain immediately (so the caller should skip the poll-interval sleep).
    pub async fn run_once(&mut self) -> Result<bool, FatalError> {
        let cursor = self.load_cursor().await?;

        let page = match self
            .event_source
            .query_events(self.filter.clone(), cursor, self.limit)
            .await
        {
            Ok(page) => page,
            Err(EventSourceError::Transient { source }) => {
                tracing::warn!("transient error: {}, sleeping", source);
                return Ok(false);
            }
            Err(EventSourceError::Permanent { source }) => {
                return Err(FatalError::EventSourcePermanent(source.to_string()));
            }
        };

        // Empty page guard
        if page.events.is_empty() {
            if page.has_next_page {
                self.empty_page_count += 1;
                if self.empty_page_count >= 3 {
                    return Err(FatalError::TooManyEmptyPages);
                }
            }
            return Ok(false);
        }
        self.empty_page_count = 0;

        // Extract and track parse failures. `last_seen_event_id` advances over
        // *every* event (parsed or not) so the cursor can move past an event we
        // fail to decode — otherwise a single un-parseable event at the tail of
        // the stream would be re-fetched every poll and trip the parse-failure
        // guard, crash-looping the indexer instead of skipping the bad event.
        let mut rows = Vec::new();
        let mut last_seen_event_id: Option<EventId> = None;
        let now = std::time::Instant::now();
        self.parse_failures.retain(|t| now.duration_since(*t) < Duration::from_secs(300));

        for event in &page.events {
            last_seen_event_id = Some(event.id.clone());
            match AccountCreatedExtractor::extract(event) {
                Ok(row) => {
                    rows.push(row);
                }
                Err(e) => {
                    tracing::warn!("parse failure for event {}: {}", event.id, e);
                    self.parse_failures.push(now);
                }
            }
        }

        if self.parse_failures.len() > 10 {
            return Err(FatalError::TooManyParseFailures);
        }

        // Prefer the source-provided cursor (authoritative pagination position);
        // fall back to the last event we saw so the cursor still advances past
        // skipped events when the source returns no explicit next cursor.
        let cursor_to_save = page.next_cursor.clone().or(last_seen_event_id);
        let inserted = rows.len();

        // Persist accounts, cursor, and (gRPC) resume token in a single
        // transaction so the cursor never advances past un-persisted rows.
        let mut tx = self.pool.begin().await?;
        for row in rows {
            sqlx::query(
                "INSERT INTO accounts (account_id, owner)
                 VALUES ($1, $2)
                 ON CONFLICT (account_id) DO NOTHING",
            )
            .bind(&row.account_id)
            .bind(&row.owner)
            .execute(&mut *tx)
            .await?;
        }
        if let Some(ref id) = cursor_to_save {
            self.save_cursor_in_tx(&mut tx, id).await?;
        }
        if let Some(ref token) = page.resume_token {
            self.save_resume_token_in_tx(&mut tx, token).await?;
        }
        tx.commit().await?;

        if let Some(ref id) = cursor_to_save {
            tracing::info!(
                "indexed {} account(s) from {} event(s), cursor at {}",
                inserted,
                page.events.len(),
                id
            );
        }

        Ok(page.has_next_page)
    }

    async fn load_cursor(&self) -> Result<Option<EventId>, sqlx::Error> {
        let result: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM indexer_state WHERE key = 'event_cursor'"
        )
        .fetch_optional(&self.pool)
        .await?;

        Ok(result.and_then(|(json_str,)| {
            if let Ok(id) = json_str.parse::<EventId>() {
                return Some(id);
            }
            #[derive(serde::Deserialize)]
            struct OldCursor {
                #[serde(rename = "txDigest")]
                tx_digest: String,
                #[serde(rename = "eventSeq")]
                event_seq: String,
            }
            serde_json::from_str::<OldCursor>(&json_str).ok().map(|c| EventId {
                tx_digest: c.tx_digest,
                event_seq: c.event_seq.parse().unwrap_or(0),
            })
        }))
    }

    async fn save_cursor_in_tx<'a>(
        &self,
        tx: &mut sqlx::Transaction<'a, sqlx::Any>,
        cursor: &EventId,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO indexer_state (key, value)
             VALUES ('event_cursor', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1",
        )
        .bind(cursor.to_string())
        .execute(&mut **tx)
        .await
        .map(|_| ())
    }

    /// Persists the source's opaque resume token (hex-encoded) alongside the
    /// cursor. Only the gRPC source emits one; the JSON-RPC source resumes from
    /// the `EventId` cursor alone and leaves this untouched.
    async fn save_resume_token_in_tx<'a>(
        &self,
        tx: &mut sqlx::Transaction<'a, sqlx::Any>,
        token: &[u8],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO indexer_state (key, value)
             VALUES ('event_resume_token', $1)
             ON CONFLICT (key) DO UPDATE SET value = $1",
        )
        .bind(hex::encode(token))
        .execute(&mut **tx)
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sui::{EventFilter, EventId, EventPage, EventSource, EventSourceError, SuiEvent};
    use async_trait::async_trait;

    struct MockEventSource {
        pages: Vec<EventPage>,
        call_count: usize,
    }

    #[async_trait]
    impl EventSource for MockEventSource {
        async fn query_events(
            &mut self,
            _filter: EventFilter,
            _cursor: Option<EventId>,
            _limit: usize,
        ) -> Result<EventPage, EventSourceError> {
            if self.call_count < self.pages.len() {
                let page = self.pages[self.call_count].clone();
                self.call_count += 1;
                Ok(page)
            } else {
                Ok(EventPage {
                    events: vec![],
                    next_cursor: None,
                    has_next_page: false,
                    resume_token: None,
                })
            }
        }
    }

    #[tokio::test]
    async fn app_batches_and_saves_cursor() {
        let _ = sqlx::any::install_drivers(&[sqlx::sqlite::any::DRIVER]);

        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:?cache=shared")
            .await
            .expect("sqlite in-memory");

        sqlx::raw_sql(
            "CREATE TABLE accounts (account_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
             CREATE TABLE indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        )
        .execute(&pool)
        .await
        .unwrap();

        let mock = MockEventSource {
            pages: vec![EventPage {
                events: vec![
                    SuiEvent {
                        id: EventId { tx_digest: "0x1".to_string(), event_seq: 0 },
                        package_id: "0xpkg".to_string(),
                        module: "account".to_string(),
                        event_type: "0xpkg::account::AccountCreated".to_string(),
                        bcs: vec![],
                        json: Some(serde_json::json!({"account_id": "acc1", "owner": "own1"})),
                        timestamp_ms: None,
                    },
                ],
                next_cursor: Some(EventId { tx_digest: "0x1".to_string(), event_seq: 0 }),
                has_next_page: false,
                resume_token: None,
            }],
            call_count: 0,
        };

        let mut app = IndexerApp::new(
            Box::new(mock),
            pool.clone(),
            EventFilter::MoveEventType {
                package_id: "0xpkg".to_string(),
                module: "account".to_string(),
                event: "AccountCreated".to_string(),
            },
            50,
            Duration::from_secs(3600), // long poll interval so test doesn't loop
        );

        app.run_once().await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);

        let cursor: (String,) = sqlx::query_as(
            "SELECT value FROM indexer_state WHERE key = 'event_cursor'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cursor.0, "0x1:0");
    }

    #[tokio::test]
    async fn cursor_advances_past_unparseable_tail_event() {
        let _ = sqlx::any::install_drivers(&[sqlx::sqlite::any::DRIVER]);

        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:?cache=shared")
            .await
            .expect("sqlite in-memory");

        sqlx::raw_sql(
            "CREATE TABLE accounts (account_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
             CREATE TABLE indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        )
        .execute(&pool)
        .await
        .unwrap();

        let good = SuiEvent {
            id: EventId { tx_digest: "0x1".to_string(), event_seq: 0 },
            package_id: "0xpkg".to_string(),
            module: "account".to_string(),
            event_type: "0xpkg::account::AccountCreated".to_string(),
            bcs: vec![],
            json: Some(serde_json::json!({"account_id": "acc1", "owner": "own1"})),
            timestamp_ms: None,
        };
        // Un-parseable: no JSON and empty BCS so the extractor fails.
        let bad = SuiEvent {
            id: EventId { tx_digest: "0x1".to_string(), event_seq: 1 },
            package_id: "0xpkg".to_string(),
            module: "account".to_string(),
            event_type: "0xpkg::account::AccountCreated".to_string(),
            bcs: vec![],
            json: None,
            timestamp_ms: None,
        };

        let mock = MockEventSource {
            pages: vec![EventPage {
                events: vec![good, bad],
                next_cursor: None, // force fallback to last-seen event id
                has_next_page: false,
                resume_token: None,
            }],
            call_count: 0,
        };

        let mut app = IndexerApp::new(
            Box::new(mock),
            pool.clone(),
            EventFilter::MoveEventType {
                package_id: "0xpkg".to_string(),
                module: "account".to_string(),
                event: "AccountCreated".to_string(),
            },
            50,
            Duration::from_secs(3600),
        );

        app.run_once().await.unwrap();

        // Only the good event is persisted...
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);

        // ...but the cursor advances past the un-parseable tail event so it is
        // not re-fetched on the next poll.
        let cursor: (String,) = sqlx::query_as(
            "SELECT value FROM indexer_state WHERE key = 'event_cursor'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cursor.0, "0x1:1");
    }
}
