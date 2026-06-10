use crate::extractors::AccountCreatedExtractor;
use crate::sui::{EventFilter, EventId, EventSource, EventSourceError};
use sqlx::PgPool;
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
    pool: PgPool,
    filter: EventFilter,
    limit: usize,
    poll_interval: Duration,
    empty_page_count: u32,
    parse_failures: Vec<std::time::Instant>,
}

impl IndexerApp {
    pub fn new(
        event_source: Box<dyn EventSource>,
        pool: PgPool,
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
            match self.run_once().await {
                Ok(()) => {}
                Err(FatalError::EventSourcePermanent(ref msg)) => {
                    tracing::error!("fatal event source error: {}", msg);
                    return Err(FatalError::EventSourcePermanent(msg.clone()));
                }
                Err(e) => {
                    tracing::error!("fatal error: {}", e);
                    return Err(e);
                }
            }

            if running {
                tokio::select! {
                    _ = tokio::time::sleep(self.poll_interval) => {}
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

    pub async fn run_once(&mut self) -> Result<(), FatalError> {
        let cursor = self.load_cursor().await?;

        let page = match self
            .event_source
            .query_events(self.filter.clone(), cursor, self.limit)
            .await
        {
            Ok(page) => page,
            Err(EventSourceError::Transient { source }) => {
                tracing::warn!("transient error: {}, sleeping", source);
                return Ok(());
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
            return Ok(());
        }
        self.empty_page_count = 0;

        // Extract and track parse failures
        let mut rows = Vec::new();
        let mut last_event_id: Option<EventId> = None;
        let now = std::time::Instant::now();
        self.parse_failures.retain(|t| now.duration_since(*t) < Duration::from_secs(300));

        for event in &page.events {
            match AccountCreatedExtractor::extract(event) {
                Ok(row) => {
                    rows.push(row);
                    last_event_id = Some(event.id.clone());
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

        // Persist in a single transaction
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
        if let Some(ref id) = last_event_id {
            self.save_cursor_in_tx(&mut tx, id).await?;
        }
        tx.commit().await?;

        Ok(())
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
        tx: &mut sqlx::Transaction<'a, sqlx::Postgres>,
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
}
