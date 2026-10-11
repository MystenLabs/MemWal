use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::types::{AppError, AppState};

#[derive(Debug, Deserialize)]
pub struct AdminQuery {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct WalletBalance {
    pub address: String,
    /// Spendable address balance (what durable registration can withdraw).
    pub sui: String,
    pub wal: String,
    /// Address balance plus owned coins, for operator context.
    pub sui_total: String,
    pub wal_total: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct UploaderPool {
    pub wallets: Vec<WalletBalance>,
    pub wal_threshold: String,
    pub sui_threshold: String,
    pub last_updated: String,
}

#[derive(Debug, Serialize)]
pub struct SponsorWallet {
    pub address: Option<String>,
    pub sui: String,
    pub sui_threshold: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct WalletsResponse {
    pub uploader_pool: UploaderPool,
    pub sponsor_wallet: SponsorWallet,
}

#[derive(Debug, Serialize)]
pub struct FailedJob {
    pub id: String,
    pub owner: String,
    pub namespace: String,
    pub status: String,
    pub error_msg: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct UploadErrorsResponse {
    pub results: Vec<FailedJob>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub balance_monitor_interval_secs: u64,
    pub wallet_wal_low_threshold_frost: String,
    pub wallet_sui_low_threshold_mist: String,
    pub sponsor_sui_low_threshold_mist: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarWalletBalance {
    address: String,
    sui_mist: String,
    wal_frost: String,
    #[serde(default)]
    sui_address_balance_mist: String,
    #[serde(default)]
    wal_address_balance_frost: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarWalletMetrics {
    per_wallet: Vec<SidecarWalletBalance>,
}

fn parse_address_or_total(raw: &str, total: u64, invalid: &str) -> Result<u64, AppError> {
    if raw.is_empty() {
        return Ok(total);
    }
    raw.parse::<u64>()
        .map_err(|_| AppError::Internal(invalid.to_string()))
}

fn wallet_status(
    wal_frost: u64,
    wal_threshold: u64,
    sui_mist: u64,
    sui_threshold: u64,
) -> &'static str {
    if wal_frost < wal_threshold || sui_mist < sui_threshold {
        "low"
    } else {
        "ok"
    }
}

#[tracing::instrument(name = "admin.wallets", skip_all)]
pub async fn get_wallets(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WalletsResponse>, AppError> {
    let sidecar_url = &state.config.sidecar_url;
    let wallet_balances_url = format!("{}/internal/wallet-balances", sidecar_url);

    let mut sidecar_request = state.http_client.get(&wallet_balances_url);
    if let Some(secret) = state.config.sidecar_secret.as_deref() {
        sidecar_request = sidecar_request.header("authorization", format!("Bearer {}", secret));
    }
    let response = sidecar_request.send().await.map_err(|e| {
        AppError::Internal(format!("Failed to fetch sidecar wallet metrics: {}", e))
    })?;

    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "Sidecar wallet metrics returned status {}",
            response.status()
        )));
    }

    let sidecar_data: SidecarWalletMetrics = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Invalid sidecar wallet metrics: {}", e)))?;

    let wal_threshold = state.config.wallet_balance_low_threshold_wal;
    let sui_threshold = state.config.wallet_balance_low_threshold_sui;
    let wallets: Vec<WalletBalance> = sidecar_data
        .per_wallet
        .into_iter()
        .map(|entry| {
            if entry.address.trim().is_empty() {
                return Err(AppError::Internal(
                    "Sidecar wallet metrics contained an empty address".to_string(),
                ));
            }
            let sui_total = entry.sui_mist.parse::<u64>().map_err(|_| {
                AppError::Internal(
                    "Sidecar wallet metrics contained invalid SUI balance".to_string(),
                )
            })?;
            let wal_total = entry.wal_frost.parse::<u64>().map_err(|_| {
                AppError::Internal(
                    "Sidecar wallet metrics contained invalid WAL balance".to_string(),
                )
            })?;
            let sui = parse_address_or_total(
                &entry.sui_address_balance_mist,
                sui_total,
                "Sidecar wallet metrics contained invalid SUI address balance",
            )?;
            let wal = parse_address_or_total(
                &entry.wal_address_balance_frost,
                wal_total,
                "Sidecar wallet metrics contained invalid WAL address balance",
            )?;
            Ok(WalletBalance {
                address: entry.address,
                sui: sui.to_string(),
                wal: wal.to_string(),
                sui_total: sui_total.to_string(),
                wal_total: wal_total.to_string(),
                status: wallet_status(wal, wal_threshold, sui, sui_threshold).to_string(),
            })
        })
        .collect::<Result<_, AppError>>()?;

    let sponsor_threshold = state.config.sponsor_balance_low_threshold_sui;
    let mut sponsor_address: Option<String> = None;
    let mut sponsor_sui_mist = "0".to_string();
    let mut sponsor_status = "unknown";

    if let Some(sponsor_key) = &state.config.sponsor_private_key {
        if let Ok(address) = crate::sui::tx_build::sponsor_address(sponsor_key) {
            if let Some(sui_client) = &state.security_delete_background_sui {
                match sui_client.address_balance(&address).await {
                    Ok(balance) => {
                        sponsor_sui_mist = balance.to_string();
                        sponsor_status = if balance < sponsor_threshold {
                            "low"
                        } else {
                            "ok"
                        };
                    }
                    Err(e) => {
                        tracing::warn!("admin.wallets: failed to fetch sponsor balance: {}", e);
                    }
                }
            }
            sponsor_address = Some(address);
        }
    }

    Ok(Json(WalletsResponse {
        uploader_pool: UploaderPool {
            wallets,
            wal_threshold: wal_threshold.to_string(),
            sui_threshold: sui_threshold.to_string(),
            last_updated: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        },
        sponsor_wallet: SponsorWallet {
            address: sponsor_address,
            sui: sponsor_sui_mist,
            sui_threshold: sponsor_threshold.to_string(),
            status: sponsor_status.to_string(),
        },
    }))
}

fn normalized_pagination(params: &AdminQuery) -> (i64, i64) {
    let limit = params.limit.unwrap_or(50).clamp(1, 1000);
    let offset = params.offset.unwrap_or(0).max(0);
    (limit, offset)
}

#[tracing::instrument(name = "admin.upload_errors", skip_all)]
pub async fn get_upload_errors(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AdminQuery>,
) -> Result<Json<UploadErrorsResponse>, AppError> {
    let (limit, offset) = normalized_pagination(&params);

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM remember_jobs WHERE status = 'failed'")
            .fetch_one(state.db.pool())
            .await
            .map_err(|e| AppError::Internal(format!("Failed to count failed jobs: {}", e)))?;

    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, owner, namespace, status, error_msg, created_at, updated_at FROM remember_jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to fetch failed jobs: {}", e)))?;

    let results = rows
        .into_iter()
        .map(
            |(id, owner, namespace, status, error_msg, created_at, updated_at)| FailedJob {
                id,
                owner,
                namespace,
                status,
                error_msg,
                created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                updated_at: updated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            },
        )
        .collect();

    Ok(Json(UploadErrorsResponse {
        results,
        total,
        limit,
        offset,
    }))
}

#[derive(Debug, Serialize)]
pub struct UploadSummaryResponse {
    pub generated_at: String,
    pub window_start: String,
    pub window_end: String,
    pub clamped: bool,
    pub queued_now: i64,
    pub processing_now: i64,
    pub stale_processing: i64,
    pub completed: i64,
    pub completed_prior: i64,
    pub failed: i64,
    pub failed_prior: i64,
    pub success_numerator: i64,
    pub success_denominator: i64,
    pub oldest_queued_at: Option<String>,
    pub definition_version: i32,
}

/// Completed / (completed + terminally failed). None when the period has no
/// terminal outcomes. Queued and in-flight jobs are not in the denominator.
pub fn terminal_success(completed: i64, failed: i64) -> Option<(i64, i64)> {
    let denominator = completed.saturating_add(failed);
    if denominator <= 0 {
        None
    } else {
        Some((completed, denominator))
    }
}

#[tracing::instrument(name = "admin.upload_summary", skip_all)]
pub async fn get_upload_summary(
    State(state): State<Arc<AppState>>,
    Query(query): Query<crate::routes::admin_activity::ActivityQuery>,
) -> Result<Json<UploadSummaryResponse>, AppError> {
    let now = chrono::Utc::now();
    let resolved = crate::routes::admin_activity::resolve_window(
        now,
        query.hours,
        query.start.as_deref(),
        query.end.as_deref(),
        query.prior_start.as_deref(),
    )
    .map_err(AppError::BadRequest)?;
    let row: (i64, i64, i64, i64, i64, i64, i64, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        r#"
        SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::BIGINT,
            COUNT(*) FILTER (
                WHERE status IN ('running', 'uploaded')
                  AND (
                    updated_at >= NOW() - INTERVAL '10 minutes'
                    OR (
                      error_msg LIKE ($5 || '%')
                      AND updated_at >= NOW() - INTERVAL '45 minutes'
                    )
                  )
            )::BIGINT,
            COUNT(*) FILTER (
                WHERE status IN ('running', 'uploaded')
                  AND updated_at < NOW() - INTERVAL '10 minutes'
                  AND NOT (
                    error_msg LIKE ($5 || '%')
                    AND updated_at >= NOW() - INTERVAL '45 minutes'
                  )
            )::BIGINT,
            COUNT(*) FILTER (WHERE status = 'done' AND updated_at > $1 AND updated_at <= $2)::BIGINT,
            COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > $1 AND updated_at <= $2)::BIGINT,
            COUNT(*) FILTER (WHERE status = 'done' AND updated_at > $3 AND updated_at <= $4)::BIGINT,
            COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > $3 AND updated_at <= $4)::BIGINT,
            MIN(created_at) FILTER (WHERE status = 'pending')
        FROM remember_jobs
        "#,
    )
    .bind(resolved.start)
    .bind(resolved.end)
    .bind(resolved.prior_start)
    .bind(resolved.prior_end)
    .bind(crate::jobs::CONGESTION_WAIT_ERROR_PREFIX)
    .fetch_one(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to summarize upload jobs: {e}")))?;
    let (numerator, denominator) = terminal_success(row.3, row.4).unwrap_or((row.3, 0));
    Ok(Json(UploadSummaryResponse {
        generated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        window_start: resolved.start.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        window_end: resolved.end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        clamped: resolved.clamped,
        queued_now: row.0,
        processing_now: row.1,
        stale_processing: row.2,
        completed: row.3,
        failed: row.4,
        completed_prior: row.5,
        failed_prior: row.6,
        success_numerator: numerator,
        success_denominator: denominator,
        oldest_queued_at: row.7.map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        definition_version: 1,
    }))
}

#[derive(Debug, Serialize)]
pub struct CoverageResponse {
    pub generated_at: String,
    pub retrieval_records: i64,
    pub retrieval_since: Option<String>,
    pub plaintext_observations: i64,
    pub plaintext_since: Option<String>,
    pub snapshots: i64,
    pub snapshot_since: Option<String>,
    pub audit_events: i64,
    pub encoded_storage: &'static str,
    pub delegate_lifecycle: &'static str,
    pub provider_bandwidth: &'static str,
}

#[tracing::instrument(name = "admin.coverage", skip_all)]
pub async fn get_coverage(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CoverageResponse>, AppError> {
    let coverage = crate::measurement::coverage(state.db.pool())
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read measurement coverage: {e}")))?;
    crate::measurement::record_audit(
        state.db.pool().clone(),
        "read_coverage",
        "ok",
        "shared admin key".into(),
    );
    Ok(Json(CoverageResponse {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        retrieval_records: coverage.retrieval_records,
        retrieval_since: coverage.retrieval_since,
        plaintext_observations: coverage.plaintext_observations,
        plaintext_since: coverage.plaintext_since,
        snapshots: coverage.snapshots,
        snapshot_since: coverage.snapshot_since,
        audit_events: coverage.audit_events,
        encoded_storage: "unavailable: WalrusUploadResponse has no encoded or allocated size",
        delegate_lifecycle: "unsupported: indexer stores AccountCreated only, not DelegateKeyAdded or DelegateKeyRemoved",
        provider_bandwidth: "unavailable: no provider billing source is configured",
    }))
}



#[tracing::instrument(name = "admin.config", skip_all)]
pub async fn get_admin_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ConfigResponse>, AppError> {
    Ok(Json(ConfigResponse {
        balance_monitor_interval_secs: state.config.balance_monitor_interval_secs,
        wallet_wal_low_threshold_frost: state.config.wallet_balance_low_threshold_wal.to_string(),
        wallet_sui_low_threshold_mist: state.config.wallet_balance_low_threshold_sui.to_string(),
        sponsor_sui_low_threshold_mist: state.config.sponsor_balance_low_threshold_sui.to_string(),
    }))
}

#[derive(Debug, Serialize)]
pub struct InventoryBreakdown {
    pub key: String,
    pub rows: i64,
    pub known_encrypted_bytes: String,
}

/// Current encrypted-size inventory from `vector_entries.blob_size_bytes`.
///
/// Zero is the column default, so a zero row is unknown size, not an empty
/// blob. Shared blobs are counted once in `unique_encrypted_bytes`. Plaintext
/// length and Walrus encoded allocation are not in this table.
#[derive(Debug, Serialize)]
pub struct InventoryResponse {
    pub generated_at: String,
    pub logical_rows: i64,
    pub sized_rows: i64,
    pub unknown_size_rows: i64,
    pub distinct_blobs: i64,
    pub unique_encrypted_bytes: String,
    pub row_sum_encrypted_bytes: String,
    pub plaintext_bytes: Option<String>,
    pub encoded_bytes: Option<String>,
    pub namespaces: Vec<InventoryBreakdown>,
    pub owners: Vec<InventoryBreakdown>,
}

#[tracing::instrument(name = "admin.inventory", skip_all)]
pub async fn get_inventory(
    State(state): State<Arc<AppState>>,
) -> Result<Json<InventoryResponse>, AppError> {
    let totals: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        WITH sized AS (
            SELECT blob_id, MAX(blob_size_bytes) AS blob_bytes
            FROM vector_entries
            WHERE blob_size_bytes > 0
            GROUP BY blob_id
        )
        SELECT
            (SELECT COUNT(*)::BIGINT FROM vector_entries),
            (SELECT COUNT(*)::BIGINT FROM vector_entries WHERE blob_size_bytes > 0),
            (SELECT COUNT(*)::BIGINT FROM vector_entries WHERE blob_size_bytes <= 0),
            (SELECT COUNT(DISTINCT blob_id)::BIGINT FROM vector_entries),
            (SELECT COALESCE(SUM(blob_size_bytes), 0)::BIGINT FROM vector_entries WHERE blob_size_bytes > 0),
            (SELECT COALESCE(SUM(blob_bytes), 0)::BIGINT FROM sized)
        "#,
    )
    .fetch_one(state.db.pool())
    .await
    .map_err(|e| AppError::Internal(format!("Failed to read storage inventory: {e}")))?;

    let namespaces = load_inventory_breakdown(
        state.db.pool(),
        r#"
        SELECT namespace,
               COUNT(*)::BIGINT,
               COALESCE(SUM(blob_size_bytes) FILTER (WHERE blob_size_bytes > 0), 0)::BIGINT
        FROM vector_entries
        GROUP BY namespace
        ORDER BY 3 DESC, 2 DESC
        LIMIT 12
        "#,
    )
    .await?;
    let owners = load_inventory_breakdown(
        state.db.pool(),
        r#"
        SELECT owner,
               COUNT(*)::BIGINT,
               COALESCE(SUM(blob_size_bytes) FILTER (WHERE blob_size_bytes > 0), 0)::BIGINT
        FROM vector_entries
        GROUP BY owner
        ORDER BY 3 DESC, 2 DESC
        LIMIT 12
        "#,
    )
    .await?;

    Ok(Json(InventoryResponse {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        logical_rows: totals.0,
        sized_rows: totals.1,
        unknown_size_rows: totals.2,
        distinct_blobs: totals.3,
        row_sum_encrypted_bytes: totals.4.to_string(),
        unique_encrypted_bytes: totals.5.to_string(),
        plaintext_bytes: None,
        encoded_bytes: None,
        namespaces,
        owners,
    }))
}

async fn load_inventory_breakdown(
    pool: &sqlx::PgPool,
    sql: &str,
) -> Result<Vec<InventoryBreakdown>, AppError> {
    let rows = sqlx::query_as::<_, (String, i64, i64)>(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read inventory breakdown: {e}")))?;
    Ok(rows
        .into_iter()
        .map(|(key, rows, bytes)| InventoryBreakdown {
            key,
            rows,
            known_encrypted_bytes: bytes.to_string(),
        })
        .collect())
}


// ============================================================
// Unit Tests for Admin Dashboard Routes
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_success_excludes_jobs_that_have_not_finished() {
        assert_eq!(super::terminal_success(8, 2), Some((8, 10)));
        assert_eq!(super::terminal_success(0, 0), None);
        assert_eq!(super::terminal_success(3, 0), Some((3, 3)));
    }

    #[test]
    fn wallet_status_respects_the_50_wal_and_5_sui_thresholds() {
        const WAL_50: u64 = 50_000_000_000;
        const SUI_5: u64 = 5_000_000_000;
        assert_eq!(wallet_status(WAL_50 - 1, WAL_50, SUI_5, SUI_5), "low");
        assert_eq!(wallet_status(WAL_50, WAL_50, SUI_5 - 1, SUI_5), "low");
        assert_eq!(wallet_status(WAL_50, WAL_50, SUI_5, SUI_5), "ok");
    }

    #[test]
    fn sidecar_wallet_metrics_require_the_per_wallet_contract() {
        let valid = serde_json::json!({
            "perWallet": [{
                "address": "0x123",
                "suiMist": "1000000000",
                "suiAddressBalanceMist": "400000000",
                "walFrost": "2000000000",
                "walAddressBalanceFrost": "500000000"
            }]
        });
        let parsed: SidecarWalletMetrics = serde_json::from_value(valid).unwrap();
        assert_eq!(parsed.per_wallet.len(), 1);
        assert_eq!(parsed.per_wallet[0].wal_address_balance_frost, "500000000");

        let legacy = serde_json::json!({
            "perWallet": [{
                "address": "0x123",
                "suiMist": "1000000000",
                "walFrost": "2000000000"
            }]
        });
        let legacy_parsed: SidecarWalletMetrics = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy_parsed.per_wallet[0].sui_address_balance_mist, "");
        assert_eq!(
            parse_address_or_total(
                &legacy_parsed.per_wallet[0].wal_address_balance_frost,
                2_000_000_000,
                "invalid",
            )
            .unwrap(),
            2_000_000_000
        );
        assert!(
            serde_json::from_value::<SidecarWalletMetrics>(serde_json::json!({
                "walletWalBalanceFrost": "2000000000"
            }))
            .is_err()
        );
    }

    #[test]
    fn pagination_defaults_and_clamps_untrusted_values() {
        assert_eq!(
            normalized_pagination(&AdminQuery {
                limit: None,
                offset: None,
            }),
            (50, 0)
        );
        assert_eq!(
            normalized_pagination(&AdminQuery {
                limit: Some(0),
                offset: Some(-10),
            }),
            (1, 0)
        );
        assert_eq!(
            normalized_pagination(&AdminQuery {
                limit: Some(5_000),
                offset: Some(40),
            }),
            (1_000, 40)
        );
    }

    #[test]
    fn wallets_response_matches_the_frontend_wire_contract() {
        let response = WalletsResponse {
            uploader_pool: UploaderPool {
                wallets: vec![WalletBalance {
                    address: "0x123".to_string(),
                    sui: "400000000".to_string(),
                    wal: "500000000".to_string(),
                    sui_total: "1000000000".to_string(),
                    wal_total: "2000000000".to_string(),
                    status: "ok".to_string(),
                }],
                wal_threshold: "50000000000".to_string(),
                sui_threshold: "5000000000".to_string(),
                last_updated: "2026-08-10T00:00:00Z".to_string(),
            },
            sponsor_wallet: SponsorWallet {
                address: Some("0x456".to_string()),
                sui: "3000000000".to_string(),
                sui_threshold: "5000000000".to_string(),
                status: "ok".to_string(),
            },
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["uploader_pool"]["wallets"][0]["wal"], "500000000");
        assert_eq!(
            json["uploader_pool"]["wallets"][0]["wal_total"],
            "2000000000"
        );
        assert_eq!(json["uploader_pool"]["sui_threshold"], "5000000000");
        assert_eq!(json["sponsor_wallet"]["sui_threshold"], "5000000000");
    }

    #[test]
    fn upload_errors_response_matches_the_frontend_wire_contract() {
        let response = UploadErrorsResponse {
            results: vec![FailedJob {
                id: "job-1".to_string(),
                owner: "0xowner".to_string(),
                namespace: "default".to_string(),
                status: "failed".to_string(),
                error_msg: Some("upload failed".to_string()),
                created_at: "2026-08-10T00:00:00Z".to_string(),
                updated_at: "2026-08-10T00:01:00Z".to_string(),
            }],
            total: 1,
            limit: 20,
            offset: 0,
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["results"][0]["error_msg"], "upload failed");
        assert_eq!(json["total"], 1);
        assert_eq!(json["limit"], 20);
        assert_eq!(json["offset"], 0);
    }

    #[test]
    fn config_serializes_token_amounts_as_lossless_strings() {
        let response = ConfigResponse {
            balance_monitor_interval_secs: 900,
            wallet_wal_low_threshold_frost: u64::MAX.to_string(),
            wallet_sui_low_threshold_mist: "5000000000".to_string(),
            sponsor_sui_low_threshold_mist: "5000000000".to_string(),
        };

        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["wallet_wal_low_threshold_frost"], u64::MAX.to_string());
        assert!(json["wallet_wal_low_threshold_frost"].is_string());
        assert!(json["wallet_sui_low_threshold_mist"].is_string());
        assert!(json["sponsor_sui_low_threshold_mist"].is_string());
    }
}
