use crate::sui::{EventFilter, EventId, EventPage, EventSource, EventSourceError, SuiEvent};
use async_trait::async_trait;
use std::time::Duration;
use tonic::transport::Channel;

#[derive(Debug)]
struct GrpcError(String);

impl std::fmt::Display for GrpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for GrpcError {}

pub struct GrpcEventSource {
    client: sui_rpc::proto::sui::rpc::v2alpha::ledger_service_client::LedgerServiceClient<Channel>,
    last_event_id: Option<EventId>,
    last_grpc_cursor: Option<tonic::codegen::Bytes>,
}

impl GrpcEventSource {
    /// Creates a gRPC event source, optionally seeded with a persisted resume
    /// position `(EventId, opaque watermark cursor)`. The watermark cursor is
    /// opaque and cannot be reconstructed from the `EventId`, so without this
    /// seed the source would re-scan from genesis after every restart.
    pub async fn new(
        rpc_url: String,
        resume: Option<(EventId, Vec<u8>)>,
    ) -> Result<Self, tonic::transport::Error> {
        let channel = tonic::transport::Endpoint::new(rpc_url)?
            .connect_timeout(Duration::from_secs(10))
            .connect()
            .await?;
        let client = sui_rpc::proto::sui::rpc::v2alpha::ledger_service_client::LedgerServiceClient::new(channel);
        let (last_event_id, last_grpc_cursor) = match resume {
            Some((id, token)) => (Some(id), Some(tonic::codegen::Bytes::from(token))),
            None => (None, None),
        };
        Ok(Self {
            client,
            last_event_id,
            last_grpc_cursor,
        })
    }

    fn classify_tonic_error(status: &tonic::Status) -> EventSourceError {
        use tonic::Code;
        match status.code() {
            Code::Unavailable | Code::DeadlineExceeded | Code::ResourceExhausted => {
                EventSourceError::transient(status.clone())
            }
            _ => EventSourceError::permanent(status.clone()),
        }
    }
}

#[async_trait]
impl EventSource for GrpcEventSource {
    async fn query_events(
        &mut self,
        filter: EventFilter,
        cursor: Option<EventId>,
        limit: usize,
    ) -> Result<EventPage, EventSourceError> {
        if limit == 0 {
            return Err(EventSourceError::permanent(GrpcError(
                "limit must be > 0".to_string(),
            )));
        }

        let after = if cursor == self.last_event_id {
            self.last_grpc_cursor.clone()
        } else {
            None
        };

        use sui_rpc::proto::sui::rpc::v2alpha as alpha;

        let proto_filter = match filter {
            EventFilter::MoveEventType {
                package_id,
                module,
                event,
            } => {
                let mut type_filter = alpha::EventTypeFilter::default();
                type_filter.r#type = Some(format!("{}::{}::{}", package_id, module, event));

                let mut pred = alpha::EventPredicate::default();
                pred.predicate = Some(alpha::event_predicate::Predicate::EventType(type_filter));

                let mut literal = alpha::EventLiteral::default();
                literal.polarity = Some(alpha::event_literal::Polarity::Include(pred));

                let mut term = alpha::EventTerm::default();
                term.literals = vec![literal];

                let mut f = alpha::EventFilter::default();
                f.terms = vec![term];
                Some(f)
            }
        };

        let mut options = alpha::QueryOptions::default();
        options.limit_items = Some(limit as u32);
        options.after = after;
        options.before = None;
        options.ordering = alpha::Ordering::Ascending as i32;

        let mut request = alpha::ListEventsRequest::default();
        request.filter = proto_filter;
        request.options = Some(options);

        let mut stream = self
            .client
            .list_events(request)
            .await
            .map_err(|e| Self::classify_tonic_error(&e))?
            .into_inner();

        let mut events = Vec::new();
        let mut last_watermark_cursor: Option<tonic::codegen::Bytes> = None;
        let mut last_event_id: Option<EventId> = None;
        let mut has_next_page = false;

        while let Some(response) = stream.message().await.map_err(|e| {
            if e.code() == tonic::Code::Ok {
                EventSourceError::transient(e)
            } else {
                Self::classify_tonic_error(&e)
            }
        })? {
            use alpha::list_events_response::Response;
            match response.response {
                Some(Response::Item(item)) => {
                    if let Some(watermark) = item.watermark {
                        if let Some(cursor) = watermark.cursor {
                            last_watermark_cursor = Some(cursor);
                        }
                    }
                    if let Some(event) = item.event {
                        let domain_event = map_proto_event(
                            event,
                            item.transaction_digest,
                            item.event_index.map(|i| i as u64),
                        )?;
                        last_event_id = Some(domain_event.id.clone());
                        events.push(domain_event);
                    }
                }
                Some(Response::Watermark(watermark)) => {
                    if let Some(cursor) = watermark.cursor {
                        last_watermark_cursor = Some(cursor);
                    }
                }
                Some(Response::End(end)) => {
                    has_next_page = end.reason == alpha::QueryEndReason::ItemLimit as i32;
                    break;
                }
                None => {}
                _ => {}
            }
        }

        self.last_event_id = last_event_id.clone();
        self.last_grpc_cursor = last_watermark_cursor;

        // Surface the opaque watermark so the app can persist it and seed a
        // future restart via `GrpcEventSource::new`.
        let resume_token = self.last_grpc_cursor.as_ref().map(|b| b.to_vec());

        Ok(EventPage {
            events,
            next_cursor: last_event_id,
            has_next_page,
            resume_token,
        })
    }
}

fn map_proto_event(
    event: sui_rpc::proto::sui::rpc::v2::Event,
    tx_digest: Option<String>,
    event_index: Option<u64>,
) -> Result<SuiEvent, EventSourceError> {
    let bcs = event
        .contents
        .and_then(|c| c.value)
        .map(|b| b.to_vec())
        .unwrap_or_default();

    Ok(SuiEvent {
        id: EventId {
            tx_digest: tx_digest.unwrap_or_default(),
            event_seq: event_index.unwrap_or(0),
        },
        package_id: event.package_id.unwrap_or_default(),
        module: event.module.unwrap_or_default(),
        event_type: event.event_type.unwrap_or_default(),
        bcs,
        json: None,
        timestamp_ms: None,
    })
}

#[cfg(all(test, feature = "grpc_smoke"))]
mod smoke_tests {
    use super::*;

    #[tokio::test]
    async fn test_grpc_connectivity_and_list_events() {
        let rpc_url = std::env::var("SUI_RPC_URL")
            .unwrap_or_else(|_| "https://fullnode.testnet.sui.io:443".to_string());

        let mut source = GrpcEventSource::new(rpc_url, None)
            .await
            .expect("should connect to gRPC endpoint");

        // Query with a harmless filter that likely returns no results
        let page = source
            .query_events(
                EventFilter::MoveEventType {
                    package_id: "0x0000000000000000000000000000000000000000000000000000000000000002"
                        .to_string(),
                    module: "coin".to_string(),
                    event: "CoinCreated".to_string(),
                },
                None,
                1,
            )
            .await
            .expect("query_events should not fail");

        // We only care that the call succeeds; empty result is fine.
        tracing::info!("smoke test received {} events", page.events.len());
    }
}
