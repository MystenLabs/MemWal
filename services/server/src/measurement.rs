//! Admin measurements collected from this process.
//!
//! Collection starts when migration 025 is applied. Nothing here reconstructs
//! earlier retrieval bytes, plaintext lengths, encoded allocation, delegate
//! events, or provider bills.
//!
//! Encoded size is absent from `WalrusUploadResponse`. DelegateKeyAdded and
//! DelegateKeyRemoved are emitted by the Move package, but the indexer only
//! stores AccountCreated. No billing export is configured.

use chrono::{DateTime, SecondsFormat, Utc};
use prometheus::{Histogram, HistogramOpts};
use sqlx::PgPool;
use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock};
use uuid::Uuid;

pub const SCHEMA_VERSION: i32 = 1;

static RESPONSE_BODY_BYTES: LazyLock<Histogram> = LazyLock::new(|| {
    prometheus::register_histogram!(HistogramOpts::new(
        "memwal_http_response_body_bytes",
        "Uncompressed JSON response-body bytes encoded for a completed recall. Not wire bytes, not TLS overhead, and not proof the client received the body."
    )
    .buckets(vec![128.0, 512.0, 1024.0, 4096.0, 16384.0, 65536.0, 262144.0, 1_048_576.0]))
    .expect("memwal_http_response_body_bytes")
});

static RESPONSE_BODY_DURATION_SECONDS: LazyLock<Histogram> = LazyLock::new(|| {
    prometheus::register_histogram!(HistogramOpts::new(
        "memwal_http_response_body_duration_seconds",
        "Seconds from recall handler start through JSON body encoding. Not time-to-headers and not client receipt."
    )
    .buckets(vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]))
    .expect("memwal_http_response_body_duration_seconds")
});

pub fn response_body_sample_count() -> u64 {
    let _ = &*RESPONSE_BODY_DURATION_SECONDS;
    RESPONSE_BODY_BYTES.get_sample_count()
}

tokio::task_local! {
    static UPSTREAM_BYTES: Arc<AtomicI64>;
}

pub fn upstream_scope() -> Arc<AtomicI64> {
    Arc::new(AtomicI64::new(0))
}

pub async fn with_upstream<T>(counter: Arc<AtomicI64>, fut: impl Future<Output = T>) -> T {
    UPSTREAM_BYTES.scope(counter, fut).await
}

pub fn note_upstream_bytes(bytes: i64) {
    let _ = UPSTREAM_BYTES.try_with(|counter| {
        counter.fetch_add(bytes, Ordering::Relaxed);
    });
}

pub fn nearest_rank(sorted: &[i64], percentile: u8) -> Option<i64> {
    if sorted.is_empty() || percentile == 0 || percentile > 100 {
        return None;
    }
    let rank = ((u32::from(percentile) * sorted.len() as u32) + 99) / 100;
    let index = rank.saturating_sub(1) as usize;
    sorted.get(index.min(sorted.len() - 1)).copied()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PercentileSet {
    pub samples: usize,
    pub p50: Option<i64>,
    pub p90: Option<i64>,
    pub p99: Option<i64>,
}

pub fn percentiles_of(values: impl IntoIterator<Item = i64>) -> PercentileSet {
    let mut values: Vec<i64> = values.into_iter().filter(|value| *value >= 0).collect();
    values.sort_unstable();
    PercentileSet {
        samples: values.len(),
        p50: nearest_rank(&values, 50),
        p90: nearest_rank(&values, 90),
        p99: nearest_rank(&values, 99),
    }
}

#[derive(Debug, Clone)]
pub struct RetrievalObservation {
    pub duration_ms: Option<i64>,
    pub relayer_body_bytes: Option<i64>,
    pub upstream_bytes: Option<i64>,
    pub node_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetrievalSummary {
    pub requests: usize,
    pub latency_ms: PercentileSet,
    pub relayer_body_bytes: PercentileSet,
    pub upstream_bytes: PercentileSet,
    pub node_bytes: PercentileSet,
}

pub fn summarize_retrievals(rows: &[RetrievalObservation]) -> RetrievalSummary {
    RetrievalSummary {
        requests: rows.len(),
        latency_ms: percentiles_of(rows.iter().filter_map(|row| row.duration_ms)),
        relayer_body_bytes: percentiles_of(rows.iter().filter_map(|row| row.relayer_body_bytes)),
        upstream_bytes: percentiles_of(rows.iter().filter_map(|row| row.upstream_bytes)),
        node_bytes: percentiles_of(rows.iter().filter_map(|row| row.node_bytes)),
    }
}
pub fn record_retrieval(
    pool: PgPool,
    owner: String,
    namespace: String,
    operation: &'static str,
    outcome: &'static str,
    returned: i32,
    top_k: i32,
    duration_ms: i64,
    relayer_body_bytes: i64,
    upstream_bytes: i64,
) {
    RESPONSE_BODY_BYTES.observe(relayer_body_bytes.max(0) as f64);
    RESPONSE_BODY_DURATION_SECONDS.observe(duration_ms.max(0) as f64 / 1000.0);
    tokio::spawn(async move {
        let now = Utc::now();
        let started = now - chrono::Duration::milliseconds(duration_ms.max(0));
        if let Err(error) = sqlx::query(
            "INSERT INTO retrieval_requests (
                id, started_at, completed_at, owner, operation, route, namespace,
                outcome, returned_count, top_k, duration_ms, relayer_body_bytes,
                upstream_bytes, node_bytes, schema_version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14)
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(started)
        .bind(now)
        .bind(owner)
        .bind(operation)
        .bind("/api/recall")
        .bind(namespace)
        .bind(outcome)
        .bind(returned)
        .bind(top_k)
        .bind(duration_ms)
        .bind(relayer_body_bytes)
        .bind(upstream_bytes)
        .bind(SCHEMA_VERSION)
        .execute(&pool)
        .await
        {
            tracing::warn!("measurement: retrieval record failed: {error}");
        }
    });
}

pub fn record_plaintext(
    pool: PgPool,
    owner: String,
    namespace: String,
    bytes: i64,
    source: &'static str,
) {
    if bytes < 0 {
        return;
    }
    tokio::spawn(async move {
        if let Err(error) = sqlx::query(
            "INSERT INTO plaintext_observations (id, owner, namespace, plaintext_bytes, schema_version, source)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(owner)
        .bind(namespace)
        .bind(bytes)
        .bind(SCHEMA_VERSION)
        .bind(source)
        .execute(&pool)
        .await
        {
            tracing::warn!("measurement: plaintext observation failed: {error}");
        }
    });
}

pub fn record_audit(pool: PgPool, action: &'static str, outcome: &'static str, summary: String) {
    tokio::spawn(async move {
        if let Err(error) = sqlx::query(
            "INSERT INTO admin_audit_log (id, principal, action, outcome, summary)
             VALUES ($1, 'shared-admin-key', $2, $3, $4)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(action)
        .bind(outcome)
        .bind(summary)
        .execute(&pool)
        .await
        {
            tracing::warn!("measurement: audit write failed: {error}");
        }
    });
}

pub async fn ensure_daily_snapshot(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO inventory_snapshots (
            snapshot_day, snapshot_at, definition_version, logical_rows, distinct_blobs,
            known_plaintext_bytes, plaintext_known_rows, known_encrypted_bytes,
            encrypted_known_rows, known_encoded_bytes, unknown_size_rows
        )
        SELECT
            (NOW() AT TIME ZONE 'UTC')::date,
            NOW(),
            1,
            COUNT(*)::BIGINT,
            COUNT(DISTINCT blob_id)::BIGINT,
            SUM(plaintext_bytes) FILTER (WHERE plaintext_bytes IS NOT NULL),
            COUNT(*) FILTER (WHERE plaintext_bytes IS NOT NULL)::BIGINT,
            SUM(blob_size_bytes) FILTER (WHERE blob_size_bytes > 0),
            COUNT(*) FILTER (WHERE blob_size_bytes > 0)::BIGINT,
            NULL,
            COUNT(*) FILTER (WHERE blob_size_bytes <= 0)::BIGINT
        FROM vector_entries
        ON CONFLICT (snapshot_day) DO NOTHING
        "#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug)]
pub struct Coverage {
    pub retrieval_records: i64,
    pub retrieval_since: Option<String>,
    pub plaintext_observations: i64,
    pub plaintext_since: Option<String>,
    pub snapshots: i64,
    pub snapshot_since: Option<String>,
    pub audit_events: i64,
}

pub async fn coverage(pool: &PgPool) -> Result<Coverage, sqlx::Error> {
    let retrieval: (i64, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT COUNT(*)::BIGINT, MIN(completed_at) FROM retrieval_requests")
            .fetch_one(pool)
            .await?;
    let plaintext: (i64, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT COUNT(*)::BIGINT, MIN(recorded_at) FROM plaintext_observations")
            .fetch_one(pool)
            .await?;
    let snapshots: (i64, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT COUNT(*)::BIGINT, MIN(snapshot_at) FROM inventory_snapshots")
            .fetch_one(pool)
            .await?;
    let audits: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM admin_audit_log")
        .fetch_one(pool)
        .await?;
    Ok(Coverage {
        retrieval_records: retrieval.0,
        retrieval_since: retrieval.1.map(stamp),
        plaintext_observations: plaintext.0,
        plaintext_since: plaintext.1.map(stamp),
        snapshots: snapshots.0,
        snapshot_since: snapshots.1.map(stamp),
        audit_events: audits,
    })
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::{nearest_rank, summarize_retrievals, RetrievalObservation};

    #[test]
    fn percentile_uses_the_population_not_an_average_of_tails() {
        let values = [10, 20, 30, 40, 100];
        assert_eq!(nearest_rank(&values, 50), Some(30));
        assert_eq!(nearest_rank(&values, 99), Some(100));
        assert_eq!(nearest_rank(&[], 50), None);
    }

    #[test]
    fn missing_fields_stay_out_of_the_percentile_population() {
        let summary = summarize_retrievals(&[
            RetrievalObservation { duration_ms: Some(10), relayer_body_bytes: Some(100), upstream_bytes: Some(0), node_bytes: None },
            RetrievalObservation { duration_ms: Some(20), relayer_body_bytes: Some(200), upstream_bytes: Some(50), node_bytes: None },
            RetrievalObservation { duration_ms: Some(90), relayer_body_bytes: None, upstream_bytes: None, node_bytes: None },
        ]);
        assert_eq!(summary.requests, 3);
        assert_eq!(summary.latency_ms.samples, 3);
        assert_eq!(summary.latency_ms.p50, Some(20));
        assert_eq!(summary.relayer_body_bytes.samples, 2);
        assert_eq!(summary.upstream_bytes.p50, Some(0));
        assert_eq!(summary.node_bytes.samples, 0);
        assert_eq!(summary.node_bytes.p99, None);
    }
}
