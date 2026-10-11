use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

use crate::types::{AppError, AppState};

#[derive(Debug, Clone, Serialize)]
pub struct QualitySource {
    pub id: &'static str,
    pub name: &'static str,
    pub capability: &'static str,
    pub health: &'static str,
    pub coverage: &'static str,
    pub classification: &'static str,
    pub population: &'static str,
    pub observed: Option<i64>,
    pub expected: Option<i64>,
    pub coverage_percent: Option<f64>,
    pub since: Option<String>,
    pub last_success: Option<String>,
    pub complete_through: Option<String>,
    pub limitation: String,
    pub detail: String,
    pub view: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub struct QualityFacts {
    pub checked_at: String,
    pub retrieval_records: i64,
    pub retrieval_since: Option<String>,
    pub plaintext_observations: i64,
    pub plaintext_since: Option<String>,
    pub snapshots: i64,
    pub snapshot_since: Option<String>,
    pub audit_events: i64,
    pub logical_rows: Option<i64>,
    pub sized_rows: Option<i64>,
    pub unknown_size_rows: Option<i64>,
    pub inventory_error: bool,
    pub jobs_done: Option<i64>,
    pub jobs_failed: Option<i64>,
    pub jobs_error: bool,
    pub response_body_samples: u64,
}

#[derive(Debug, Serialize)]
pub struct QualityResponse {
    pub generated_at: String,
    pub checked_at: String,
    pub common_completeness: Option<String>,
    pub oldest_healthy_update: Option<String>,
    pub sources: Vec<QualitySource>,
}

fn percent(observed: i64, expected: i64) -> Option<f64> {
    if expected <= 0 {
        return None;
    }
    Some((observed as f64 / expected as f64) * 100.0)
}

fn counted(records: i64) -> (&'static str, &'static str) {
    if records == 0 {
        ("collection_path_unverified", "historical_unavailable")
    } else {
        ("healthy", "request_detail")
    }
}

pub fn build_quality_sources(facts: &QualityFacts) -> Vec<QualitySource> {
    let (retrieval_health, retrieval_coverage) = counted(facts.retrieval_records);
    let (plain_health, plain_coverage) = counted(facts.plaintext_observations);
    let encrypted = if facts.inventory_error {
        QualitySource {
            id: "encrypted_size",
            name: "Encrypted payload length",
            capability: "implemented",
            health: "failed",
            coverage: "unknown",
            classification: "measured",
            population: "vector_entries rows",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "The inventory query failed. Sized and unknown rows were not read.".into(),
            detail: "vector_entries.blob_size_bytes. Zero is the column default, so a failed read must not be shown as zero unknown rows.".into(),
            view: Some("storage"),
        }
    } else {
        let logical = facts.logical_rows.unwrap_or(0);
        let sized = facts.sized_rows.unwrap_or(0);
        let unknown = facts.unknown_size_rows.unwrap_or(0);
        QualitySource {
            id: "encrypted_size",
            name: "Encrypted payload length",
            capability: "implemented",
            health: "healthy",
            coverage: if unknown > 0 { "partial" } else { "complete" },
            classification: "measured",
            population: "logical vector rows, not unique blobs and not storage allocations",
            observed: Some(sized),
            expected: Some(logical),
            coverage_percent: percent(sized, logical),
            since: None,
            last_success: Some(facts.checked_at.clone()),
            complete_through: Some(facts.checked_at.clone()),
            limitation: format!(
                "{unknown} rows have blob_size_bytes <= 0. Zero is the column default, so those rows are ambiguous: unknown legacy size, not a proven empty payload."
            ),
            detail: "Positive blob_size_bytes is a measured encrypted length. Shared blobs are not deduplicated in this row count.".into(),
            view: Some("storage"),
        }
    };
    let jobs = if facts.jobs_error {
        QualitySource {
            id: "upload_jobs",
            name: "Upload job lifecycle",
            capability: "implemented",
            health: "failed",
            coverage: "unknown",
            classification: "measured",
            population: "remember_jobs",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "The job count query failed. Failure count is unknown, not zero.".into(),
            detail: "remember_jobs status done and failed.".into(),
            view: Some("uploads"),
        }
    } else {
        QualitySource {
            id: "upload_jobs",
            name: "Upload job lifecycle",
            capability: "implemented",
            health: "unknown",
            coverage: "complete",
            classification: "measured",
            population: "remember_jobs terminal statuses",
            observed: facts.jobs_done,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: Some(facts.checked_at.clone()),
            complete_through: Some(facts.checked_at.clone()),
            limitation: format!(
                "{} completed and {} failed jobs are retained. In-flight jobs are a current count, not a period total.",
                facts.jobs_done.unwrap_or(0),
                facts.jobs_failed.unwrap_or(0)
            ),
            detail: "Failed count is a measured job status, not a collector failure.".into(),
            view: Some("uploads"),
        }
    };

    vec![
        QualitySource {
            id: "account_activity",
            name: "Account activity",
            capability: "implemented",
            health: "unknown",
            coverage: "aggregate_only",
            classification: "measured",
            population: "top owners with completed uploads, not every account",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "GET /api/admin/activity returns the top owners. That is not complete account coverage, so this check does not call it healthy.".into(),
            detail: "Write counts and top owners. Delegate activity is not in that response.".into(),
            view: Some("activity"),
        },
        jobs,
        QualitySource {
            id: "retrieval_requests",
            name: "Retrieval request records",
            capability: "implemented",
            health: retrieval_health,
            coverage: retrieval_coverage,
            classification: "measured",
            population: "logical retrieval requests recorded after collection began",
            observed: Some(facts.retrieval_records),
            expected: None,
            coverage_percent: None,
            since: facts.retrieval_since.clone(),
            last_success: facts.retrieval_since.clone(),
            complete_through: facts.retrieval_since.clone(),
            limitation: if facts.retrieval_records == 0 {
                "Collection is implemented and the table was read. No retrieval has been recorded yet. This is not an unsupported source and not a failed query.".into()
            } else {
                "Request rows are retained. They do not include node-transfer bytes.".into()
            },
            detail: "retrieval_requests. Response-body histograms are a separate source.".into(),
            view: Some("retrieval"),
        },
        QualitySource {
            id: "response_bytes",
            name: "Relayer response-byte distribution",
            capability: "implemented",
            health: if facts.response_body_samples == 0 { "collection_path_unverified" } else { "healthy" },
            coverage: if facts.response_body_samples == 0 { "historical_unavailable" } else { "aggregate_only" },
            classification: "measured",
            population: "uncompressed JSON body bytes encoded for a completed recall",
            observed: Some(i64::try_from(facts.response_body_samples).unwrap_or(i64::MAX)),
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "memwal_http_response_body_bytes counts encoded JSON bytes, not wire or TLS bytes, and not client receipt. A zero sample count means no recall has been observed since this process registered the histogram.".into(),
            detail: "Separate from memwal_http_request_duration_seconds, which is time to response handling, not body-terminal duration.".into(),
            view: Some("retrieval"),
        },
        QualitySource {
            id: "aggregator_bytes",
            name: "Aggregator download bytes",
            capability: "not_implemented",
            health: "disabled",
            coverage: "historical_unavailable",
            classification: "measured",
            population: "bytes received from an aggregator per download attempt",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "Attempt-level aggregator body bytes are not retained. Do not substitute encrypted payload size.".into(),
            detail: "Aggregator to relayer is relayer ingress, not relayer outbound egress.".into(),
            view: Some("retrieval"),
        },
        QualitySource {
            id: "node_egress",
            name: "Storage-node transfer",
            capability: "unsupported_by_source",
            health: "unknown",
            coverage: "historical_unavailable",
            classification: "reported_pending",
            population: "fragment bytes correlated to a logical request",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "No node provider exposes per-request correlation to this relayer. Unknown is not zero traffic.".into(),
            detail: "A reported cold-read figure is a separate source and is not ingested here.".into(),
            view: Some("retrieval"),
        },
        QualitySource {
            id: "plaintext_size",
            name: "Plaintext length",
            capability: "implemented",
            health: plain_health,
            coverage: plain_coverage,
            classification: "measured",
            population: "authorized plaintext length observations, not decrypted historical memories",
            observed: Some(facts.plaintext_observations),
            expected: None,
            coverage_percent: None,
            since: facts.plaintext_since.clone(),
            last_success: facts.plaintext_since.clone(),
            complete_through: facts.plaintext_since.clone(),
            limitation: if facts.plaintext_observations == 0 {
                "The observation table was read and is empty. Historical memories are not decrypted to fill it.".into()
            } else {
                "Observations are new writes only. They do not backfill older rows.".into()
            },
            detail: "plaintext_observations.".into(),
            view: Some("storage"),
        },
        encrypted,
        QualitySource {
            id: "encoded_storage",
            name: "Encoded storage allocation",
            capability: "not_implemented",
            health: "disabled",
            coverage: "historical_unavailable",
            classification: "reported_pending",
            population: "Walrus encoded or allocated bytes per blob",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "WalrusUploadResponse has no encoded or allocated size. Encrypted payload bytes are not encoded storage.".into(),
            detail: "External protocol metadata would be required. A fixed multiplier is not used.".into(),
            view: Some("storage"),
        },
        QualitySource {
            id: "inventory_snapshots",
            name: "Inventory snapshots",
            capability: "implemented",
            health: "unknown",
            coverage: if facts.snapshots == 0 { "historical_unavailable" } else { "partial" },
            classification: "measured",
            population: "daily inventory snapshot rows",
            observed: Some(facts.snapshots),
            expected: None,
            coverage_percent: None,
            since: facts.snapshot_since.clone(),
            last_success: facts.snapshot_since.clone(),
            complete_through: facts.snapshot_since.clone(),
            limitation: "One snapshot is not a reconstructable history. Deletions before the first snapshot cannot be rebuilt.".into(),
            detail: "inventory_snapshots. Included here because the coverage summary already counts them.".into(),
            view: Some("storage"),
        },
        QualitySource {
            id: "delegate_lifecycle",
            name: "Delegate lifecycle",
            capability: "not_implemented",
            health: "disabled",
            coverage: "historical_unavailable",
            classification: "measured",
            population: "delegate key add and remove events",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "The indexer stores AccountCreated only, not DelegateKeyAdded or DelegateKeyRemoved.".into(),
            detail: "Auth cache is not a delegate registry.".into(),
            view: Some("accounts"),
        },
        QualitySource {
            id: "admin_audit",
            name: "Admin audit events",
            capability: "implemented",
            health: if facts.audit_events == 0 { "collecting_no_samples" } else { "healthy" },
            coverage: "aggregate_only",
            classification: "measured",
            population: "admin audit log rows written by instrumented admin reads",
            observed: Some(facts.audit_events),
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: Some(facts.checked_at.clone()),
            complete_through: None,
            limitation: "The count is retained audit rows, not a complete history of every admin action.".into(),
            detail: "admin_audit_log. Shown in the inventory because the coverage summary already counts it.".into(),
            view: Some("access"),
        },
        QualitySource {
            id: "wallet_balances",
            name: "Wallet balances",
            capability: "implemented",
            health: "unknown",
            coverage: "complete",
            classification: "measured",
            population: "current uploader and sponsor balances",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "This check does not call the wallet route, so health is unknown rather than zero failures. Balances are current, not historical spend.".into(),
            detail: "GET /api/admin/wallets. Low means below the configured threshold.".into(),
            view: Some("wallets"),
        },
        QualitySource {
            id: "provider_cost",
            name: "Provider usage and cost",
            capability: "external_dependency",
            health: "unknown",
            coverage: "historical_unavailable",
            classification: "reported_pending",
            population: "provider-reported outbound bytes and cost",
            observed: None,
            expected: None,
            coverage_percent: None,
            since: None,
            last_success: None,
            complete_through: None,
            limitation: "No provider billing source is configured. Balance decreases are not provider cost.".into(),
            detail: "External dependency. Not a collector failure.".into(),
            view: Some("wallets"),
        },
    ]
}

pub fn oldest_healthy_update(sources: &[QualitySource]) -> Option<String> {
    sources
        .iter()
        .filter(|source| source.health == "healthy")
        .filter_map(|source| source.last_success.clone())
        .min()
}

#[tracing::instrument(name = "admin.quality", skip_all)]
pub async fn get_quality(
    State(state): State<Arc<AppState>>,
) -> Result<Json<QualityResponse>, AppError> {
    let checked_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let coverage = crate::measurement::coverage(state.db.pool())
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read measurement coverage: {e}")))?;
    let inventory = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT COUNT(*)::BIGINT, COUNT(*) FILTER (WHERE blob_size_bytes > 0)::BIGINT, COUNT(*) FILTER (WHERE blob_size_bytes <= 0)::BIGINT FROM vector_entries",
    )
    .fetch_one(state.db.pool())
    .await;
    let jobs = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COUNT(*) FILTER (WHERE status = 'done')::BIGINT, COUNT(*) FILTER (WHERE status = 'failed')::BIGINT FROM remember_jobs",
    )
    .fetch_one(state.db.pool())
    .await;
    let facts = QualityFacts {
        checked_at: checked_at.clone(),
        retrieval_records: coverage.retrieval_records,
        retrieval_since: coverage.retrieval_since,
        plaintext_observations: coverage.plaintext_observations,
        plaintext_since: coverage.plaintext_since,
        snapshots: coverage.snapshots,
        snapshot_since: coverage.snapshot_since,
        audit_events: coverage.audit_events,
        logical_rows: inventory.as_ref().ok().map(|row| row.0),
        sized_rows: inventory.as_ref().ok().map(|row| row.1),
        unknown_size_rows: inventory.as_ref().ok().map(|row| row.2),
        inventory_error: inventory.is_err(),
        jobs_done: jobs.as_ref().ok().map(|row| row.0),
        jobs_failed: jobs.as_ref().ok().map(|row| row.1),
        jobs_error: jobs.is_err(),
        response_body_samples: crate::measurement::response_body_sample_count(),
    };
    let sources = build_quality_sources(&facts);
    let oldest = oldest_healthy_update(&sources);
    crate::measurement::record_audit(
        state.db.pool().clone(),
        "read_quality",
        "ok",
        "shared admin key".into(),
    );
    Ok(Json(QualityResponse {
        generated_at: checked_at.clone(),
        checked_at,
        common_completeness: None,
        oldest_healthy_update: oldest,
        sources,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> QualityFacts {
        QualityFacts {
            checked_at: "2026-10-12T00:00:00Z".into(),
            retrieval_records: 0,
            retrieval_since: None,
            plaintext_observations: 0,
            plaintext_since: None,
            snapshots: 1,
            snapshot_since: Some("2026-10-11T18:55:10Z".into()),
            audit_events: 12,
            logical_rows: Some(10),
            sized_rows: Some(4),
            unknown_size_rows: Some(6),
            inventory_error: false,
            jobs_done: Some(3),
            jobs_failed: Some(1),
            jobs_error: false,
            response_body_samples: 0,
        }
    }

    #[test]
    fn empty_retrieval_table_is_collecting_not_unsupported() {
        let sources = build_quality_sources(&facts());
        let retrieval = sources.iter().find(|source| source.id == "retrieval_requests").unwrap();
        assert_eq!(retrieval.health, "collection_path_unverified");

        assert_eq!(retrieval.coverage, "historical_unavailable");
        assert_eq!(retrieval.observed, Some(0));
    }

    #[test]
    fn snapshots_and_audit_are_inventory_rows() {
        let sources = build_quality_sources(&facts());
        assert!(sources.iter().any(|source| source.id == "inventory_snapshots" && source.observed == Some(1)));
        assert!(sources.iter().any(|source| source.id == "admin_audit" && source.observed == Some(12)));
    }

    #[test]
    fn legacy_zero_sizes_are_partial_not_empty_payloads() {
        let sources = build_quality_sources(&facts());
        let encrypted = sources.iter().find(|source| source.id == "encrypted_size").unwrap();
        assert_eq!(encrypted.coverage, "partial");
        assert_eq!(encrypted.coverage_percent, Some(40.0));
        assert!(encrypted.limitation.contains("column default"));
    }

    #[test]
    fn a_failed_inventory_query_is_not_zero_unknown_rows() {
        let mut input = facts();
        input.inventory_error = true;
        input.logical_rows = None;
        let sources = build_quality_sources(&input);
        let encrypted = sources.iter().find(|source| source.id == "encrypted_size").unwrap();
        assert_eq!(encrypted.health, "failed");
        assert_eq!(encrypted.observed, None);
    }

    #[test]
    fn unknown_wallet_health_is_not_a_failure() {
        let sources = build_quality_sources(&facts());
        let wallets = sources.iter().find(|source| source.id == "wallet_balances").unwrap();
        assert_eq!(wallets.health, "unknown");
        assert_eq!(sources.iter().filter(|source| source.health == "failed").count(), 0);
    }
}
