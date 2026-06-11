use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventId {
    pub tx_digest: String,
    pub event_seq: u64,
}

impl fmt::Display for EventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.tx_digest, self.event_seq)
    }
}

impl std::str::FromStr for EventId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (tx_digest, seq) = s.rsplit_once(':').ok_or("missing colon in cursor")?;
        Ok(EventId {
            tx_digest: tx_digest.to_string(),
            event_seq: seq.parse().map_err(|e| format!("invalid event_seq: {}", e))?,
        })
    }
}

#[derive(Debug, Clone)]
pub enum EventFilter {
    MoveEventType {
        package_id: String,
        module: String,
        event: String,
    },
}

#[derive(Debug, Clone)]
pub struct SuiEvent {
    pub id: EventId,
    pub package_id: String,
    pub module: String,
    pub event_type: String,
    pub bcs: Vec<u8>,
    pub json: Option<serde_json::Value>,
    pub timestamp_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct EventPage {
    pub events: Vec<SuiEvent>,
    pub next_cursor: Option<EventId>,
    pub has_next_page: bool,
    /// Opaque, source-specific cursor that must be persisted to resume after a
    /// restart (used by the gRPC source, whose watermark cursor cannot be
    /// reconstructed from `next_cursor`). `None` for sources that resume purely
    /// from `next_cursor` (e.g. JSON-RPC).
    pub resume_token: Option<Vec<u8>>,
}

#[derive(Debug, Error)]
pub enum EventSourceError {
    #[error("transient error: {source}")]
    Transient { source: Box<dyn std::error::Error + Send + Sync> },
    #[error("permanent error: {source}")]
    Permanent { source: Box<dyn std::error::Error + Send + Sync> },
}

impl EventSourceError {
    pub fn transient<E: std::error::Error + Send + Sync + 'static>(source: E) -> Self {
        EventSourceError::Transient { source: Box::new(source) }
    }
    pub fn permanent<E: std::error::Error + Send + Sync + 'static>(source: E) -> Self {
        EventSourceError::Permanent { source: Box::new(source) }
    }
}

#[async_trait]
pub trait EventSource: Send {
    async fn query_events(
        &mut self,
        filter: EventFilter,
        cursor: Option<EventId>,
        limit: usize,
    ) -> Result<EventPage, EventSourceError>;
}

#[cfg(feature = "grpc")]
pub mod grpc;
