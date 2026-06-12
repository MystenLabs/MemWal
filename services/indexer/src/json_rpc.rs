use crate::sui::{EventFilter, EventId, EventPage, EventSource, EventSourceError, SuiEvent};
use async_trait::async_trait;
use serde::Deserialize;

#[derive(Debug)]
struct JsonRpcError(String);

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JsonRpcError {}

pub struct JsonRpcEventSource {
    client: reqwest::Client,
    rpc_url: String,
    event_type: String,
}

impl JsonRpcEventSource {
    pub fn new(client: reqwest::Client, rpc_url: String, package_id: String) -> Self {
        Self {
            client,
            rpc_url,
            event_type: format!("{}::account::AccountCreated", package_id),
        }
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcEventId {
    #[serde(rename = "txDigest")]
    tx_digest: String,
    #[serde(rename = "eventSeq")]
    event_seq: String,
}

#[derive(Debug, Deserialize)]
struct JsonRpcEvent {
    #[serde(rename = "id")]
    id: JsonRpcEventId,
    #[serde(rename = "packageId")]
    package_id: String,
    #[serde(rename = "transactionModule")]
    module: String,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(rename = "parsedJson")]
    parsed_json: serde_json::Value,
    #[serde(rename = "timestampMs")]
    #[serde(default)]
    timestamp_ms: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcEventPage {
    data: Vec<JsonRpcEvent>,
    #[serde(rename = "nextCursor")]
    next_cursor: Option<JsonRpcEventId>,
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

#[async_trait]
impl EventSource for JsonRpcEventSource {
    async fn query_events(
        &mut self,
        _filter: EventFilter,
        cursor: Option<EventId>,
        limit: usize,
    ) -> Result<EventPage, EventSourceError> {
        let cursor_json = match cursor {
            Some(id) => serde_json::json!({
                "txDigest": id.tx_digest,
                "eventSeq": id.event_seq.to_string(),
            }),
            None => serde_json::Value::Null,
        };

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "suix_queryEvents",
            "params": [
                { "MoveEventType": self.event_type },
                cursor_json,
                limit,
                false
            ]
        });

        let resp = self
            .client
            .post(&self.rpc_url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .json(&body)
            .send()
            .await
            .map_err(EventSourceError::transient)?;

        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<missing>")
            .to_string();

        let resp_bytes = resp.bytes().await.map_err(EventSourceError::transient)?;

        if !status.is_success() {
            let err = JsonRpcError(format!(
                "HTTP error: status={}, body={}",
                status,
                body_snippet(&resp_bytes)
            ));
            if is_transient_http_status(status) {
                return Err(EventSourceError::transient(err));
            }
            return Err(EventSourceError::permanent(err));
        }

        let page = parse_jsonrpc_page(&resp_bytes, &content_type)
            .map_err(JsonRpcError)
            .map_err(EventSourceError::permanent)?;

        let next_cursor = page.next_cursor.map(|c| -> Result<EventId, EventSourceError> {
            let event_seq = c.event_seq.parse().map_err(|e| {
                EventSourceError::permanent(JsonRpcError(format!(
                    "invalid event_seq in cursor: {}",
                    e
                )))
            })?;
            Ok(EventId {
                tx_digest: c.tx_digest,
                event_seq,
            })
        }).transpose()?;

        let events = page
            .data
            .into_iter()
            .map(|event| -> Result<SuiEvent, EventSourceError> {
                let event_seq = event.id.event_seq.parse().map_err(|e| {
                    EventSourceError::permanent(JsonRpcError(format!(
                        "invalid event_seq in event id: {}",
                        e
                    )))
                })?;
                Ok(SuiEvent {
                    id: EventId {
                        tx_digest: event.id.tx_digest,
                        event_seq,
                    },
                    package_id: event.package_id,
                    module: event.module,
                    event_type: event.event_type,
                    bcs: vec![],
                    json: Some(event.parsed_json),
                    timestamp_ms: event.timestamp_ms.and_then(|s| s.parse().ok()),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(EventPage {
            events,
            next_cursor,
            has_next_page: page.has_next_page,
            resume_token: None,
        })
    }
}

fn parse_jsonrpc_page(resp_bytes: &[u8], content_type: &str) -> Result<JsonRpcEventPage, String> {
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

    serde_json::from_value(result.clone())
        .map_err(|e| format!("Failed to parse event page: {}", e))
}

/// Whether an unsuccessful HTTP status should be retried (transient) rather
/// than treated as a permanent, fatal error. 5xx, 429 (rate limit) and 408
/// (request timeout) are the flaky-infra cases the public fullnode produces;
/// other 4xx (bad request, auth, not found) indicate a real client-side bug.
fn is_transient_http_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn server_errors_and_rate_limits_are_transient() {
        // The public fullnode's flaky responses must be retried, not fatal.
        assert!(is_transient_http_status(StatusCode::SERVICE_UNAVAILABLE)); // 503
        assert!(is_transient_http_status(StatusCode::BAD_GATEWAY)); // 502
        assert!(is_transient_http_status(StatusCode::GATEWAY_TIMEOUT)); // 504
        assert!(is_transient_http_status(StatusCode::INTERNAL_SERVER_ERROR)); // 500
        assert!(is_transient_http_status(StatusCode::TOO_MANY_REQUESTS)); // 429
        assert!(is_transient_http_status(StatusCode::REQUEST_TIMEOUT)); // 408
    }

    #[test]
    fn client_errors_are_permanent() {
        assert!(!is_transient_http_status(StatusCode::BAD_REQUEST)); // 400
        assert!(!is_transient_http_status(StatusCode::UNAUTHORIZED)); // 401
        assert!(!is_transient_http_status(StatusCode::NOT_FOUND)); // 404
    }

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

        let page = parse_jsonrpc_page(body, "application/json").unwrap();
        assert_eq!(page.data.len(), 0);
        assert!(!page.has_next_page);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn parse_event_page_response_reports_non_json_body() {
        let err = parse_jsonrpc_page(b"<html>rate limited</html>", "text/html").unwrap_err();

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
