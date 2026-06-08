use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};
use opentelemetry::{
    global,
    propagation::{Extractor, Injector},
    trace::TracerProvider as _,
    KeyValue,
};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, propagation::TraceContextPropagator, trace::SdkTracerProvider,
    Resource,
};
use prometheus::{Encoder, HistogramOpts, HistogramVec, IntCounterVec, IntGauge, IntGaugeVec};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::types::AppState;

const X_REQUEST_ID: &str = "x-request-id";
const X_CORRELATION_ID: &str = "x-correlation-id";
const OTLP_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_ENDPOINT";
const OTLP_HEADERS_ENV: &str = "OTEL_EXPORTER_OTLP_HEADERS";
const OTLP_TRACES_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";
const OTLP_LOGS_ENDPOINT_ENV: &str = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT";
const OTEL_SERVICE_NAME_ENV: &str = "OTEL_SERVICE_NAME";
const DEFAULT_OTEL_SERVICE_NAME: &str = "memwal-relayer";

#[derive(Clone, Debug)]
pub struct RequestContext {
    request_id: String,
    route: String,
}

tokio::task_local! {
    static REQUEST_CONTEXT: RequestContext;
}

pub struct TelemetryGuard {
    tracer_provider: Option<SdkTracerProvider>,
    logger_provider: Option<SdkLoggerProvider>,
}

impl TelemetryGuard {
    pub fn shutdown(self) {
        if let Some(tracer_provider) = self.tracer_provider {
            if let Err(err) = tracer_provider.shutdown() {
                eprintln!("failed to shut down OpenTelemetry tracer provider: {err:?}");
            }
        }
        if let Some(logger_provider) = self.logger_provider {
            if let Err(err) = logger_provider.shutdown() {
                eprintln!("failed to shut down OpenTelemetry logger provider: {err:?}");
            }
        }
    }
}

struct OtlpTelemetry {
    tracer_provider: SdkTracerProvider,
    logger_provider: SdkLoggerProvider,
    endpoint: String,
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

pub fn init_tracing() -> TelemetryGuard {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "memwal_server=info,tower_http=info".into());
    let json_logs = std::env::var("LOG_FORMAT")
        .map(|value| value.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    global::set_text_map_propagator(TraceContextPropagator::new());
    let otlp = match build_otlp_telemetry() {
        Ok(otlp) => otlp,
        Err(err) => {
            eprintln!("OpenTelemetry disabled: {err}");
            None
        }
    };

    if json_logs {
        match otlp {
            Some(otlp) => {
                let tracer = otlp.tracer_provider.tracer(otel_service_name());
                let trace_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                let log_layer =
                    opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(
                        &otlp.logger_provider,
                    );

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(
                        tracing_subscriber::fmt::layer()
                            .json()
                            .flatten_event(true)
                            .with_current_span(true),
                    )
                    .with(trace_layer)
                    .with(log_layer)
                    .init();

                tracing::info!(endpoint = %otlp.endpoint, "OpenTelemetry OTLP export enabled");
                TelemetryGuard {
                    tracer_provider: Some(otlp.tracer_provider),
                    logger_provider: Some(otlp.logger_provider),
                }
            }
            None => {
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(
                        tracing_subscriber::fmt::layer()
                            .json()
                            .flatten_event(true)
                            .with_current_span(true),
                    )
                    .init();
                TelemetryGuard {
                    tracer_provider: None,
                    logger_provider: None,
                }
            }
        }
    } else {
        match otlp {
            Some(otlp) => {
                let tracer = otlp.tracer_provider.tracer(otel_service_name());
                let trace_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                let log_layer =
                    opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(
                        &otlp.logger_provider,
                    );

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(tracing_subscriber::fmt::layer().with_target(true))
                    .with(trace_layer)
                    .with(log_layer)
                    .init();

                tracing::info!(endpoint = %otlp.endpoint, "OpenTelemetry OTLP export enabled");
                TelemetryGuard {
                    tracer_provider: Some(otlp.tracer_provider),
                    logger_provider: Some(otlp.logger_provider),
                }
            }
            None => {
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(tracing_subscriber::fmt::layer().with_target(true))
                    .init();
                TelemetryGuard {
                    tracer_provider: None,
                    logger_provider: None,
                }
            }
        }
    }
}

fn build_otlp_telemetry() -> Result<Option<OtlpTelemetry>, String> {
    use opentelemetry_otlp::{WithExportConfig as _, WithHttpConfig as _};

    let Some(base_endpoint) = env_non_empty(OTLP_ENDPOINT_ENV) else {
        return Ok(None);
    };
    let headers = parse_otlp_headers(env_non_empty(OTLP_HEADERS_ENV).as_deref());
    let traces_endpoint = signal_endpoint(&base_endpoint, OTLP_TRACES_ENDPOINT_ENV, "/v1/traces");
    let logs_endpoint = signal_endpoint(&base_endpoint, OTLP_LOGS_ENDPOINT_ENV, "/v1/logs");

    let span_exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(traces_endpoint)
        .with_headers(headers.clone())
        .build()
        .map_err(|err| format!("build OTLP trace exporter: {err}"))?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_resource(otel_resource())
        .with_batch_exporter(span_exporter)
        .build();
    global::set_tracer_provider(tracer_provider.clone());

    let log_exporter = opentelemetry_otlp::LogExporter::builder()
        .with_http()
        .with_endpoint(logs_endpoint)
        .with_headers(headers)
        .build()
        .map_err(|err| format!("build OTLP log exporter: {err}"))?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_resource(otel_resource())
        .with_batch_exporter(log_exporter)
        .build();

    Ok(Some(OtlpTelemetry {
        tracer_provider,
        logger_provider,
        endpoint: base_endpoint,
    }))
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn otel_service_name() -> String {
    std::env::var(OTEL_SERVICE_NAME_ENV).unwrap_or_else(|_| DEFAULT_OTEL_SERVICE_NAME.to_string())
}

fn parse_otlp_headers(raw: Option<&str>) -> HashMap<String, String> {
    raw.unwrap_or_default()
        .split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn signal_endpoint(base: &str, signal_env: &str, suffix: &str) -> String {
    env_non_empty(signal_env).unwrap_or_else(|| format!("{}{}", base.trim_end_matches('/'), suffix))
}

fn otel_resource() -> Resource {
    let mut attributes = vec![
        KeyValue::new("service.name", otel_service_name()),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
    ];
    if let Some(environment) = env_non_empty("RAILWAY_ENVIRONMENT_NAME")
        .or_else(|| env_non_empty("DEPLOYMENT_ENVIRONMENT"))
        .or_else(|| env_non_empty("NODE_ENV"))
    {
        attributes.push(KeyValue::new("deployment.environment.name", environment));
    }
    Resource::builder_empty()
        .with_attributes(attributes)
        .build()
}

pub async fn request_context_middleware(mut request: Request, next: Next) -> Response {
    let request_id = resolve_request_id(request.headers());
    let route = route_label(request.uri().path());
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let span_name = format!("{method} {route}");
    let started = Instant::now();
    let parent_context = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });

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
        "otel.name" = %span_name,
        "otel.kind" = "server",
        request_id = %request_id,
        "http.request.method" = %method,
        "http.route" = %route,
        "url.path" = %path,
        "http.response.status_code" = tracing::field::Empty,
        "otel.status_code" = tracing::field::Empty,
        status = tracing::field::Empty,
        latency_ms = tracing::field::Empty,
    );
    let _ = span.set_parent(parent_context);
    HTTP_REQUESTS_IN_FLIGHT.inc();

    let context = RequestContext {
        request_id: request_id.clone(),
        route: route.clone(),
    };

    REQUEST_CONTEXT
        .scope(context, async move {
            let request_span = span.clone();
            let mut response = next.run(request).instrument(request_span).await;
            let status = response.status();
            let elapsed = started.elapsed();
            span.record("status", status.as_u16());
            span.record("http.response.status_code", status.as_u16());
            if status.is_server_error() {
                span.record("otel.status_code", "error");
            }
            span.record("latency_ms", elapsed.as_millis() as u64);

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
    update_db_pool_metrics(state.db.pool());

    let encoder = prometheus::TextEncoder::new();
    let mut buffer = Vec::new();
    match encoder.encode(&prometheus::gather(), &mut buffer) {
        Ok(()) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, encoder.format_type())
            .body(Body::from(buffer))
            .expect("build metrics response"),
        Err(err) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from(format!("failed to encode metrics: {}", err)))
            .expect("build metrics error response"),
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
    let req = match current_request_id() {
        Some(request_id) => req.header(X_REQUEST_ID, request_id),
        None => req,
    };
    apply_trace_context(req)
}

fn apply_trace_context(mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let mut headers = Vec::new();
    let context = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut HeaderInjector(&mut headers));
    });
    for (key, value) in headers {
        req = req.header(key, value);
    }
    req
}

struct HeaderExtractor<'a>(&'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

struct HeaderInjector<'a>(&'a mut Vec<(String, String)>);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.push((key.to_string(), value));
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
    use super::{is_safe_request_id, parse_otlp_headers, route_label, signal_endpoint};

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

    #[test]
    fn otlp_headers_follow_key_value_comma_format() {
        let headers = parse_otlp_headers(Some("Authorization=Basic abc, x-scope-orgid = memwal"));

        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("Basic abc")
        );
        assert_eq!(
            headers.get("x-scope-orgid").map(String::as_str),
            Some("memwal")
        );
    }

    #[test]
    fn otlp_signal_endpoint_appends_suffix_to_base_endpoint() {
        std::env::remove_var("MEMWAL_TEST_OTLP_ENDPOINT");

        assert_eq!(
            signal_endpoint(
                "http://openobserve:5080/api/default/",
                "MEMWAL_TEST_OTLP_ENDPOINT",
                "/v1/logs",
            ),
            "http://openobserve:5080/api/default/v1/logs"
        );
    }
}
