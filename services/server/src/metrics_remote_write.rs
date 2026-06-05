//! Prometheus remote_write push to OpenObserve (WALM-81).
//!
//! The relayer exposes `/metrics` (Prometheus pull). OpenObserve cannot scrape
//! a pull endpoint, so to keep a single OpenObserve service (no collector) we
//! periodically gather the registry and push it via the Prometheus
//! remote_write protocol — snappy-compressed protobuf — to OpenObserve's
//! `/prometheus/api/v1/write` endpoint.
//!
//! Opt-in: disabled (no-op) unless `ZO_REMOTE_WRITE_URL` is set, so production
//! behaviour is unchanged until an environment explicitly enables it.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REMOTE_WRITE_URL_ENV: &str = "ZO_REMOTE_WRITE_URL";
/// Full `Authorization` header value, e.g. `Basic <base64(email:password)>`.
const REMOTE_WRITE_AUTH_ENV: &str = "ZO_REMOTE_WRITE_AUTH";
const REMOTE_WRITE_INTERVAL_ENV: &str = "ZO_REMOTE_WRITE_INTERVAL_SECS";
const DEFAULT_INTERVAL_SECS: u64 = 30;

// ── Prometheus remote_write protobuf (minimal subset) ──────────────────────
// Matches prometheus/prompb `WriteRequest`. Only the fields OpenObserve needs.

#[derive(Clone, PartialEq, prost::Message)]
struct WriteRequest {
    #[prost(message, repeated, tag = "1")]
    timeseries: Vec<TimeSeries>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct TimeSeries {
    #[prost(message, repeated, tag = "1")]
    labels: Vec<Label>,
    #[prost(message, repeated, tag = "2")]
    samples: Vec<Sample>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct Label {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(string, tag = "2")]
    value: String,
}

#[derive(Clone, PartialEq, prost::Message)]
struct Sample {
    #[prost(double, tag = "1")]
    value: f64,
    #[prost(int64, tag = "2")]
    timestamp: i64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format a histogram bucket upper bound the way Prometheus does (`+Inf` for the
/// open top bucket).
fn format_le(upper_bound: f64) -> String {
    if upper_bound.is_infinite() {
        "+Inf".to_string()
    } else {
        upper_bound.to_string()
    }
}

fn series(name: &str, base: &[Label], extra: &[Label], value: f64, ts_ms: i64) -> TimeSeries {
    let mut labels = Vec::with_capacity(base.len() + extra.len() + 1);
    labels.push(Label {
        name: "__name__".to_string(),
        value: name.to_string(),
    });
    labels.extend_from_slice(base);
    labels.extend_from_slice(extra);
    TimeSeries {
        labels,
        samples: vec![Sample {
            value,
            timestamp: ts_ms,
        }],
    }
}

/// Convert gathered Prometheus metric families into remote_write time series.
/// Histograms expand to `_bucket{le}` / `_sum` / `_count`; summaries to
/// `{quantile}` / `_sum` / `_count`.
fn build_timeseries(families: &[prometheus::proto::MetricFamily], ts_ms: i64) -> Vec<TimeSeries> {
    use prometheus::proto::MetricType;
    let mut out = Vec::new();
    for mf in families {
        let name = mf.get_name();
        for m in mf.get_metric() {
            let base: Vec<Label> = m
                .get_label()
                .iter()
                .map(|l| Label {
                    name: l.get_name().to_string(),
                    value: l.get_value().to_string(),
                })
                .collect();
            match mf.get_field_type() {
                MetricType::COUNTER => {
                    out.push(series(name, &base, &[], m.get_counter().get_value(), ts_ms));
                }
                MetricType::GAUGE => {
                    out.push(series(name, &base, &[], m.get_gauge().get_value(), ts_ms));
                }
                MetricType::UNTYPED => {
                    out.push(series(name, &base, &[], m.get_untyped().get_value(), ts_ms));
                }
                MetricType::HISTOGRAM => {
                    let h = m.get_histogram();
                    let bucket_name = format!("{}_bucket", name);
                    for b in h.get_bucket() {
                        let le = [Label {
                            name: "le".to_string(),
                            value: format_le(b.get_upper_bound()),
                        }];
                        out.push(series(
                            &bucket_name,
                            &base,
                            &le,
                            b.get_cumulative_count() as f64,
                            ts_ms,
                        ));
                    }
                    let inf = [Label {
                        name: "le".to_string(),
                        value: "+Inf".to_string(),
                    }];
                    out.push(series(
                        &bucket_name,
                        &base,
                        &inf,
                        h.get_sample_count() as f64,
                        ts_ms,
                    ));
                    out.push(series(
                        &format!("{}_sum", name),
                        &base,
                        &[],
                        h.get_sample_sum(),
                        ts_ms,
                    ));
                    out.push(series(
                        &format!("{}_count", name),
                        &base,
                        &[],
                        h.get_sample_count() as f64,
                        ts_ms,
                    ));
                }
                MetricType::SUMMARY => {
                    let s = m.get_summary();
                    for q in s.get_quantile() {
                        let quantile = [Label {
                            name: "quantile".to_string(),
                            value: q.get_quantile().to_string(),
                        }];
                        out.push(series(name, &base, &quantile, q.get_value(), ts_ms));
                    }
                    out.push(series(
                        &format!("{}_sum", name),
                        &base,
                        &[],
                        s.get_sample_sum(),
                        ts_ms,
                    ));
                    out.push(series(
                        &format!("{}_count", name),
                        &base,
                        &[],
                        s.get_sample_count() as f64,
                        ts_ms,
                    ));
                }
            }
        }
    }
    out
}

async fn push_once(
    http_client: &reqwest::Client,
    url: &str,
    auth: Option<&str>,
) -> Result<(), String> {
    let timeseries = build_timeseries(&prometheus::gather(), now_millis());
    if timeseries.is_empty() {
        return Ok(());
    }
    let mut buf = Vec::new();
    prost::Message::encode(&WriteRequest { timeseries }, &mut buf).map_err(|e| e.to_string())?;
    let compressed = snap::raw::Encoder::new()
        .compress_vec(&buf)
        .map_err(|e| e.to_string())?;

    let mut request = http_client
        .post(url)
        .header("Content-Type", "application/x-protobuf")
        .header("Content-Encoding", "snappy")
        .header("X-Prometheus-Remote-Write-Version", "0.1.0")
        .body(compressed);
    if let Some(auth) = auth {
        request = request.header("Authorization", auth);
    }

    let resp = request.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("status {} body {}", status, body));
    }
    Ok(())
}

/// Spawn the background remote_write loop when `ZO_REMOTE_WRITE_URL` is set.
/// No-op otherwise (returns immediately), so production is unaffected until an
/// environment opts in.
pub fn spawn(http_client: reqwest::Client) {
    let url = match std::env::var(REMOTE_WRITE_URL_ENV) {
        Ok(u) if !u.trim().is_empty() => u,
        _ => return,
    };
    let auth = std::env::var(REMOTE_WRITE_AUTH_ENV).ok().filter(|a| !a.is_empty());
    let interval_secs = std::env::var(REMOTE_WRITE_INTERVAL_ENV)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_INTERVAL_SECS);

    tracing::info!(
        "metrics remote_write enabled → {} every {}s",
        url,
        interval_secs
    );

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        loop {
            ticker.tick().await;
            if let Err(e) = push_once(&http_client, &url, auth.as_deref()).await {
                tracing::warn!(
                    target: "memwal::remote_write",
                    "metrics remote_write push failed: {}",
                    e
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use prometheus::{register_histogram_vec, register_int_counter_vec, Registry};

    #[test]
    fn format_le_handles_inf() {
        assert_eq!(format_le(f64::INFINITY), "+Inf");
        assert_eq!(format_le(0.5), "0.5");
    }

    #[test]
    fn counter_and_histogram_expand_to_expected_series() {
        // Use a private registry so the test doesn't depend on global state.
        let registry = Registry::new();
        let counter = register_int_counter_vec!(
            prometheus::opts!("rw_test_total", "test counter"),
            &["route"]
        )
        .unwrap();
        registry.register(Box::new(counter.clone())).unwrap();
        counter.with_label_values(&["/api/recall"]).inc();

        let hist = register_histogram_vec!(
            prometheus::histogram_opts!("rw_test_seconds", "test hist", vec![0.1, 0.5]),
            &["route"]
        )
        .unwrap();
        registry.register(Box::new(hist.clone())).unwrap();
        hist.with_label_values(&["/api/recall"]).observe(0.2);

        let series = build_timeseries(&registry.gather(), 1_700_000_000_000);
        let names: Vec<String> = series
            .iter()
            .map(|t| {
                t.labels
                    .iter()
                    .find(|l| l.name == "__name__")
                    .map(|l| l.value.clone())
                    .unwrap_or_default()
            })
            .collect();

        assert!(names.contains(&"rw_test_total".to_string()));
        assert!(names.contains(&"rw_test_seconds_bucket".to_string()));
        assert!(names.contains(&"rw_test_seconds_sum".to_string()));
        assert!(names.contains(&"rw_test_seconds_count".to_string()));
        // The +Inf bucket carries the total observation count.
        let inf = series.iter().find(|t| {
            t.labels.iter().any(|l| l.name == "__name__" && l.value == "rw_test_seconds_bucket")
                && t.labels.iter().any(|l| l.name == "le" && l.value == "+Inf")
        });
        assert!(inf.is_some(), "expected a +Inf bucket series");
    }

    #[test]
    fn empty_registry_yields_no_series() {
        let registry = Registry::new();
        assert!(build_timeseries(&registry.gather(), 0).is_empty());
    }
}
