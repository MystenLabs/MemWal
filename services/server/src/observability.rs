use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use prometheus::{Encoder, HistogramOpts, HistogramVec, IntCounterVec, IntGauge, IntGaugeVec};
use std::future::Future;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tracing::Instrument;
use tracing_subscriber::EnvFilter;

use crate::types::AppState;

const X_REQUEST_ID: &str = "x-request-id";
const X_CORRELATION_ID: &str = "x-correlation-id";

#[derive(Clone, Debug)]
pub struct RequestContext {
    request_id: String,
    route: String,
}

tokio::task_local! {
    static REQUEST_CONTEXT: RequestContext;
}

static HTTP_REQUESTS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_http_requests_total",
        "Total HTTP requests handled by the Walrus Memory relayer.",
        &["method", "route", "status"]
    )
    .expect("register memwal_http_requests_total")
});

static HTTP_REQUEST_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    prometheus::register_histogram_vec!(
        HistogramOpts::new(
            "memwal_http_request_duration_seconds",
            "HTTP request latency in seconds."
        )
        .buckets(vec![
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
        ]),
        &["method", "route", "status"]
    )
    .expect("register memwal_http_request_duration_seconds")
});

static HTTP_REQUESTS_IN_FLIGHT: LazyLock<IntGauge> = LazyLock::new(|| {
    prometheus::register_int_gauge!(
        "memwal_http_requests_in_flight",
        "HTTP requests currently being handled by the Walrus Memory relayer."
    )
    .expect("register memwal_http_requests_in_flight")
});

static ERRORS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_errors_total",
        "Application errors returned by the Walrus Memory relayer.",
        &["kind", "route"]
    )
    .expect("register memwal_errors_total")
});

static RATE_LIMIT_DENIALS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_rate_limit_denials_total",
        "Rate-limit denials by limiter bucket.",
        &["bucket", "route"]
    )
    .expect("register memwal_rate_limit_denials_total")
});

static RATE_LIMIT_FALLBACKS_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_rate_limit_fallbacks_total",
        "Times the relayer used in-memory rate limiting because Redis was unavailable.",
        &["scope"]
    )
    .expect("register memwal_rate_limit_fallbacks_total")
});

static EXTERNAL_REQUEST_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    prometheus::register_histogram_vec!(
        HistogramOpts::new(
            "memwal_external_request_duration_seconds",
            "External service request latency in seconds."
        )
        .buckets(vec![
            0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 180.0,
        ]),
        &["service", "operation", "status"]
    )
    .expect("register memwal_external_request_duration_seconds")
});

static SIDECAR_FAILURES_TOTAL: LazyLock<IntCounterVec> = LazyLock::new(|| {
    prometheus::register_int_counter_vec!(
        "memwal_sidecar_failures_total",
        "Sidecar failures seen by the Rust relayer.",
        &["operation", "reason"]
    )
    .expect("register memwal_sidecar_failures_total")
});

static SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS: LazyLock<IntGauge> = LazyLock::new(|| {
    prometheus::register_int_gauge!(
        "memwal_sidecar_walrus_metrics_scrape_success",
        "Whether the relayer was able to mirror WALM-52 sidecar Walrus metrics into /metrics on the latest scrape."
    )
    .expect("register memwal_sidecar_walrus_metrics_scrape_success")
});

static DB_QUERY_DURATION_SECONDS: LazyLock<HistogramVec> = LazyLock::new(|| {
    prometheus::register_histogram_vec!(
        HistogramOpts::new(
            "memwal_db_query_duration_seconds",
            "Database query latency in seconds."
        )
        .buckets(vec![
            0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
        ]),
        &["operation", "status"]
    )
    .expect("register memwal_db_query_duration_seconds")
});

static DB_POOL: LazyLock<IntGaugeVec> = LazyLock::new(|| {
    prometheus::register_int_gauge_vec!(
        "memwal_db_pool_connections",
        "PostgreSQL pool connections by state.",
        &["state"]
    )
    .expect("register memwal_db_pool_connections")
});

pub fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "memwal_server=info,tower_http=info".into());
    let json_logs = std::env::var("LOG_FORMAT")
        .map(|value| value.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    if json_logs {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .json()
            .flatten_event(true)
            .with_current_span(true)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_target(true)
            .init();
    }
}

pub async fn request_context_middleware(mut request: Request, next: Next) -> Response {
    let request_id = resolve_request_id(request.headers());
    let route = route_label(request.uri().path());
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let started = Instant::now();

    request.extensions_mut().insert(RequestContext {
        request_id: request_id.clone(),
        route: route.clone(),
    });
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        request
            .headers_mut()
            .insert(request_id_header_name(), value);
    }

    let span = tracing::info_span!(
        "http.request",
        request_id = %request_id,
        method = %method,
        route = %route,
        path = %path,
    );
    HTTP_REQUESTS_IN_FLIGHT.inc();

    let context = RequestContext {
        request_id: request_id.clone(),
        route: route.clone(),
    };

    REQUEST_CONTEXT
        .scope(context, async move {
            let mut response = next.run(request).instrument(span).await;
            let status = response.status();
            let elapsed = started.elapsed();

            if let Ok(value) = HeaderValue::from_str(&request_id) {
                response
                    .headers_mut()
                    .insert(request_id_header_name(), value);
            }

            record_http_request(&method, &route, status, elapsed);
            HTTP_REQUESTS_IN_FLIGHT.dec();
            tracing::info!(
                request_id = %request_id,
                method = %method,
                route = %route,
                status = status.as_u16(),
                latency_ms = elapsed.as_millis(),
                "http request complete"
            );
            response
        })
        .await
}

pub async fn metrics(State(state): State<Arc<AppState>>) -> Response {
    let sidecar_walrus_metrics = scrape_sidecar_walrus_metrics(&state).await;
    update_db_pool_metrics(state.db.pool());

    let encoder = prometheus::TextEncoder::new();
    let mut buffer = Vec::new();
    match encoder.encode(&prometheus::gather(), &mut buffer) {
        Ok(()) => {
            if let Some(sidecar_text) = sidecar_walrus_metrics {
                buffer.extend_from_slice(b"\n");
                buffer.extend_from_slice(sidecar_text.as_bytes());
            }
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, encoder.format_type())
                .body(Body::from(buffer))
                .expect("build metrics response")
        }
        Err(err) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from(format!("failed to encode metrics: {}", err)))
            .expect("build metrics error response"),
    }
}

async fn scrape_sidecar_walrus_metrics(state: &AppState) -> Option<String> {
    let url = format!(
        "{}/metrics/walrus",
        state.config.sidecar_url.trim_end_matches('/')
    );
    let started = Instant::now();
    let request = state.http_client.get(&url);
    match tokio::time::timeout(Duration::from_secs(2), request.send()).await {
        Ok(Ok(resp)) => {
            let status = resp.status();
            observe_external(
                "sidecar",
                "metrics_walrus",
                &status.as_u16().to_string(),
                started.elapsed(),
            );
            if !status.is_success() {
                SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(0);
                record_sidecar_failure("metrics_walrus", "http_error");
                tracing::warn!(
                    status = status.as_u16(),
                    "sidecar WALM-52 metrics scrape returned non-success"
                );
                return None;
            }
            match tokio::time::timeout(Duration::from_secs(2), resp.text()).await {
                Ok(Ok(text)) => {
                    SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(1);
                    Some(text)
                }
                Ok(Err(err)) => {
                    SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(0);
                    record_sidecar_failure("metrics_walrus", "body_error");
                    tracing::warn!(error = %err, "sidecar WALM-52 metrics body read failed");
                    None
                }
                Err(_) => {
                    SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(0);
                    record_sidecar_failure("metrics_walrus", "body_timeout");
                    tracing::warn!("sidecar WALM-52 metrics body read timed out");
                    None
                }
            }
        }
        Ok(Err(err)) => {
            observe_external(
                "sidecar",
                "metrics_walrus",
                "transport_error",
                started.elapsed(),
            );
            SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(0);
            record_sidecar_failure("metrics_walrus", "transport_error");
            tracing::warn!(error = %err, "sidecar WALM-52 metrics scrape failed");
            None
        }
        Err(_) => {
            observe_external("sidecar", "metrics_walrus", "timeout", started.elapsed());
            SIDECAR_WALRUS_METRICS_SCRAPE_SUCCESS.set(0);
            record_sidecar_failure("metrics_walrus", "timeout");
            tracing::warn!("sidecar WALM-52 metrics scrape timed out");
            None
        }
    }
}

pub fn current_request_id() -> Option<String> {
    REQUEST_CONTEXT.try_with(|ctx| ctx.request_id.clone()).ok()
}

pub fn current_context() -> Option<RequestContext> {
    REQUEST_CONTEXT.try_with(Clone::clone).ok()
}

pub async fn with_request_context<F>(context: RequestContext, future: F) -> F::Output
where
    F: Future,
{
    REQUEST_CONTEXT.scope(context, future).await
}

pub fn current_route() -> String {
    REQUEST_CONTEXT
        .try_with(|ctx| ctx.route.clone())
        .unwrap_or_else(|_| "background".to_string())
}

pub fn request_id_header_name() -> HeaderName {
    HeaderName::from_static(X_REQUEST_ID)
}

pub fn apply_request_id_header(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match current_request_id() {
        Some(request_id) => req.header(X_REQUEST_ID, request_id),
        None => req,
    }
}

pub fn record_app_error(kind: &'static str) {
    let route = current_route();
    ERRORS_TOTAL.with_label_values(&[kind, &route]).inc();
}

pub fn record_rate_limit_denial(bucket: &str) {
    let route = current_route();
    RATE_LIMIT_DENIALS_TOTAL
        .with_label_values(&[bucket, &route])
        .inc();
}

pub fn record_rate_limit_fallback(scope: &'static str) {
    RATE_LIMIT_FALLBACKS_TOTAL.with_label_values(&[scope]).inc();
}

pub fn observe_external(
    service: &'static str,
    operation: &'static str,
    status: &str,
    elapsed: Duration,
) {
    EXTERNAL_REQUEST_DURATION_SECONDS
        .with_label_values(&[service, operation, status])
        .observe(elapsed.as_secs_f64());
}

pub fn record_sidecar_failure(operation: &'static str, reason: &'static str) {
    SIDECAR_FAILURES_TOTAL
        .with_label_values(&[operation, reason])
        .inc();
}

pub fn observe_db(operation: &'static str, status: &'static str, elapsed: Duration) {
    DB_QUERY_DURATION_SECONDS
        .with_label_values(&[operation, status])
        .observe(elapsed.as_secs_f64());
}

pub fn update_db_pool_metrics(pool: &sqlx::PgPool) {
    DB_POOL
        .with_label_values(&["open"])
        .set(i64::from(pool.size()));
    DB_POOL
        .with_label_values(&["idle"])
        .set(pool.num_idle() as i64);
}

fn record_http_request(method: &str, route: &str, status: StatusCode, elapsed: Duration) {
    let status = status.as_u16().to_string();
    HTTP_REQUESTS_TOTAL
        .with_label_values(&[method, route, &status])
        .inc();
    HTTP_REQUEST_DURATION_SECONDS
        .with_label_values(&[method, route, &status])
        .observe(elapsed.as_secs_f64());
}

fn resolve_request_id(headers: &axum::http::HeaderMap) -> String {
    [X_REQUEST_ID, X_CORRELATION_ID]
        .iter()
        .find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| is_safe_request_id(value))
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn is_safe_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn route_label(path: &str) -> String {
    match path {
        "/health" => "/health".to_string(),
        "/config" => "/config".to_string(),
        "/metrics" => "/metrics".to_string(),
        "/sponsor" => "/sponsor".to_string(),
        "/sponsor/execute" => "/sponsor/execute".to_string(),
        "/api/remember" => "/api/remember".to_string(),
        "/api/remember/bulk" => "/api/remember/bulk".to_string(),
        "/api/remember/bulk/status" => "/api/remember/bulk/status".to_string(),
        "/api/remember/manual" => "/api/remember/manual".to_string(),
        "/api/recall" => "/api/recall".to_string(),
        "/api/recall/manual" => "/api/recall/manual".to_string(),
        "/api/analyze" => "/api/analyze".to_string(),
        "/api/ask" => "/api/ask".to_string(),
        "/api/restore" => "/api/restore".to_string(),
        "/api/forget" => "/api/forget".to_string(),
        "/api/stats" => "/api/stats".to_string(),
        "/api/mcp/sse" => "/api/mcp/sse".to_string(),
        "/api/mcp/messages" => "/api/mcp/messages".to_string(),
        "/api/mcp" => "/api/mcp".to_string(),
        _ if path.starts_with("/api/remember/") => "/api/remember/{job_id}".to_string(),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_safe_request_id, route_label};

    #[test]
    fn request_id_validation_rejects_header_injection() {
        assert!(is_safe_request_id("req-123_ok.test:1"));
        assert!(!is_safe_request_id(""));
        assert!(!is_safe_request_id("bad\nid"));
        assert!(!is_safe_request_id(&"x".repeat(129)));
    }

    #[test]
    fn route_label_normalizes_remember_status_ids() {
        assert_eq!(route_label("/api/remember/abc"), "/api/remember/{job_id}");
        assert_eq!(route_label("/api/recall"), "/api/recall");
        assert_eq!(route_label("/unexpected"), "unknown");
    }
}
