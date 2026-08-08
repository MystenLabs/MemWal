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
    pub sui: String,
    pub wal: String,
}

#[derive(Debug, Serialize)]
pub struct UploaderPool {
    pub wallet: WalletBalance,
    pub last_updated: String,
}

#[derive(Debug, Serialize)]
pub struct SponsorWallet {
    pub sui: String,
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
    pub sponsor_wallet_threshold_mist: u64,
    pub uploader_pool_threshold_mist: u64,
    pub admin_api_key_set: bool,
}

#[tracing::instrument(name = "admin.wallets", skip_all)]
pub async fn get_wallets(
    State(state): State<Arc<AppState>>,
) -> Result<Json<WalletsResponse>, AppError> {
    let sidecar_url = &state.config.sidecar_url;
    let health_url = format!("{}/metrics/wallet", sidecar_url);

    let response = state
        .http_client
        .get(&health_url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch sidecar wallet metrics: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "Sidecar wallet metrics returned status {}",
            response.status()
        )));
    }

    let sidecar_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to parse sidecar response: {}", e)))?;

    let wallet_sui_mist = sidecar_data
        .get("walletSuiBalanceMist")
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string();

    let wallet_wal_frost = sidecar_data
        .get("walletWalBalanceFrost")
        .and_then(|v| v.as_str())
        .unwrap_or("0")
        .to_string();

    Ok(Json(WalletsResponse {
        uploader_pool: UploaderPool {
            wallet: WalletBalance {
                sui: wallet_sui_mist,
                wal: wallet_wal_frost,
            },
            last_updated: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        },
        sponsor_wallet: SponsorWallet {
            sui: "0".to_string(),
        },
    }))
}

#[tracing::instrument(name = "admin.upload_errors", skip_all)]
pub async fn get_upload_errors(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AdminQuery>,
) -> Result<Json<UploadErrorsResponse>, AppError> {
    let limit = params.limit.unwrap_or(50).max(1).min(1000);
    let offset = params.offset.unwrap_or(0).max(0);

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM remember_jobs WHERE status = 'failed'",
    )
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
        .map(|(id, owner, namespace, status, error_msg, created_at, updated_at)| FailedJob {
            id,
            owner,
            namespace,
            status,
            error_msg,
            created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            updated_at: updated_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        })
        .collect();

    Ok(Json(UploadErrorsResponse {
        results,
        total,
        limit,
        offset,
    }))
}

#[tracing::instrument(name = "admin.config", skip_all)]
pub async fn get_admin_config(
    State(_state): State<Arc<AppState>>,
) -> Result<Json<ConfigResponse>, AppError> {
    let admin_api_key_set = std::env::var("ADMIN_API_KEY").is_ok();

    Ok(Json(ConfigResponse {
        sponsor_wallet_threshold_mist: 1_000_000_000,
        uploader_pool_threshold_mist: 500_000_000,
        admin_api_key_set,
    }))
}

// ============================================================
// Unit Tests for Admin Dashboard Routes
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    // ── Response structure validation tests ──────────────────

    #[test]
    fn wallet_balance_serialization() {
        let wallet = WalletBalance {
            sui: "1000000".to_string(),
            wal: "500000".to_string(),
        };

        let json = serde_json::to_value(&wallet).unwrap();
        assert_eq!(json["sui"], "1000000");
        assert_eq!(json["wal"], "500000");
    }

    #[test]
    fn uploader_pool_serialization() {
        let uploader_pool = UploaderPool {
            wallet: WalletBalance {
                sui: "1000000".to_string(),
                wal: "500000".to_string(),
            },
            last_updated: "2024-01-01T00:00:00Z".to_string(),
        };

        let json = serde_json::to_value(&uploader_pool).unwrap();
        assert_eq!(json["wallet"]["sui"], "1000000");
        assert_eq!(json["last_updated"], "2024-01-01T00:00:00Z");
    }

    #[test]
    fn wallets_response_structure() {
        let response = WalletsResponse {
            uploader_pool: UploaderPool {
                wallet: WalletBalance {
                    sui: "1000000".to_string(),
                    wal: "500000".to_string(),
                },
                last_updated: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            },
            sponsor_wallet: SponsorWallet {
                sui: "2000000".to_string(),
            },
        };

        let json = serde_json::to_value(&response).unwrap();
        assert!(json["uploader_pool"].is_object());
        assert!(json["sponsor_wallet"].is_object());
        assert_eq!(json["uploader_pool"]["wallet"]["sui"], "1000000");
        assert_eq!(json["sponsor_wallet"]["sui"], "2000000");
    }

    #[test]
    fn failed_job_serialization_with_error() {
        let job = FailedJob {
            id: "job-123".to_string(),
            owner: "0xowner".to_string(),
            namespace: "default".to_string(),
            status: "failed".to_string(),
            error_msg: Some("Out of memory".to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T01:00:00Z".to_string(),
        };

        let json = serde_json::to_value(&job).unwrap();
        assert_eq!(json["id"], "job-123");
        assert_eq!(json["owner"], "0xowner");
        assert_eq!(json["namespace"], "default");
        assert_eq!(json["status"], "failed");
        assert_eq!(json["error_msg"], "Out of memory");
        assert!(json["created_at"].is_string());
        assert!(json["updated_at"].is_string());
    }

    #[test]
    fn failed_job_serialization_without_error() {
        let job = FailedJob {
            id: "job-456".to_string(),
            owner: "0xowner2".to_string(),
            namespace: "custom".to_string(),
            status: "failed".to_string(),
            error_msg: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T01:00:00Z".to_string(),
        };

        let json = serde_json::to_value(&job).unwrap();
        assert!(json["error_msg"].is_null());
    }

    #[test]
    fn upload_errors_response_single_result() {
        let response = UploadErrorsResponse {
            results: vec![
                FailedJob {
                    id: "job-1".to_string(),
                    owner: "0xowner1".to_string(),
                    namespace: "default".to_string(),
                    status: "failed".to_string(),
                    error_msg: Some("Error 1".to_string()),
                    created_at: "2024-01-01T00:00:00Z".to_string(),
                    updated_at: "2024-01-01T00:00:00Z".to_string(),
                },
            ],
            total: 10,
            limit: 1,
            offset: 0,
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["results"].as_array().unwrap().len(), 1);
        assert_eq!(json["total"], 10);
        assert_eq!(json["limit"], 1);
        assert_eq!(json["offset"], 0);
    }

    #[test]
    fn upload_errors_response_empty_results() {
        let response = UploadErrorsResponse {
            results: vec![],
            total: 0,
            limit: 50,
            offset: 0,
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["results"].as_array().unwrap().len(), 0);
        assert_eq!(json["total"], 0);
        assert_eq!(json["limit"], 50);
        assert_eq!(json["offset"], 0);
    }

    #[test]
    fn upload_errors_response_pagination_offset() {
        let response = UploadErrorsResponse {
            results: vec![
                FailedJob {
                    id: "job-21".to_string(),
                    owner: "0xowner".to_string(),
                    namespace: "default".to_string(),
                    status: "failed".to_string(),
                    error_msg: None,
                    created_at: "2024-01-01T00:00:00Z".to_string(),
                    updated_at: "2024-01-01T00:00:00Z".to_string(),
                },
            ],
            total: 100,
            limit: 20,
            offset: 20,
        };

        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["offset"], 20);
        assert_eq!(json["limit"], 20);
        assert_eq!(json["total"], 100);
    }

    #[test]
    fn config_response_serialization_with_key_set() {
        let config = ConfigResponse {
            sponsor_wallet_threshold_mist: 1_000_000_000,
            uploader_pool_threshold_mist: 500_000_000,
            admin_api_key_set: true,
        };

        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["sponsor_wallet_threshold_mist"], 1_000_000_000u64);
        assert_eq!(json["uploader_pool_threshold_mist"], 500_000_000u64);
        assert_eq!(json["admin_api_key_set"], true);
    }

    #[test]
    fn config_response_serialization_without_key_set() {
        let config = ConfigResponse {
            sponsor_wallet_threshold_mist: 1_000_000_000,
            uploader_pool_threshold_mist: 500_000_000,
            admin_api_key_set: false,
        };

        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["admin_api_key_set"], false);
    }

    // ── Limit/offset validation tests ────────────────────────

    #[test]
    fn query_limit_clamped_to_minimum() {
        // In get_upload_errors, limit is clamped: .max(1).min(1000)
        let limit = 0i64;
        let clamped = limit.max(1).min(1000);
        assert_eq!(clamped, 1);
    }

    #[test]
    fn query_limit_clamped_to_maximum() {
        let limit = 2000i64;
        let clamped = limit.max(1).min(1000);
        assert_eq!(clamped, 1000);
    }

    #[test]
    fn query_limit_valid_range_unchanged() {
        let limit = 50i64;
        let clamped = limit.max(1).min(1000);
        assert_eq!(clamped, 50);
    }

    #[test]
    fn query_limit_boundary_at_one() {
        let limit = 1i64;
        let clamped = limit.max(1).min(1000);
        assert_eq!(clamped, 1);
    }

    #[test]
    fn query_limit_boundary_at_max() {
        let limit = 1000i64;
        let clamped = limit.max(1).min(1000);
        assert_eq!(clamped, 1000);
    }

    #[test]
    fn query_offset_clamped_to_minimum() {
        let offset = -10i64;
        let clamped = offset.max(0);
        assert_eq!(clamped, 0);
    }

    #[test]
    fn query_offset_valid_unchanged() {
        let offset = 100i64;
        let clamped = offset.max(0);
        assert_eq!(clamped, 100);
    }

    #[test]
    fn query_offset_exactly_zero() {
        let offset = 0i64;
        let clamped = offset.max(0);
        assert_eq!(clamped, 0);
    }

    #[test]
    fn query_offset_large_value() {
        let offset = 999_999_999i64;
        let clamped = offset.max(0);
        assert_eq!(clamped, 999_999_999);
    }

    // ── Admin query struct tests ─────────────────────────────

    #[test]
    fn admin_query_defaults_are_none() {
        let query = AdminQuery {
            limit: None,
            offset: None,
        };
        assert_eq!(query.limit, None);
        assert_eq!(query.offset, None);
    }

    #[test]
    fn admin_query_with_limit_only() {
        let query = AdminQuery {
            limit: Some(10),
            offset: None,
        };
        assert_eq!(query.limit, Some(10));
        assert_eq!(query.offset, None);
    }

    #[test]
    fn admin_query_with_offset_only() {
        let query = AdminQuery {
            limit: None,
            offset: Some(20),
        };
        assert_eq!(query.limit, None);
        assert_eq!(query.offset, Some(20));
    }

    #[test]
    fn admin_query_with_both_params() {
        let query = AdminQuery {
            limit: Some(50),
            offset: Some(100),
        };
        assert_eq!(query.limit, Some(50));
        assert_eq!(query.offset, Some(100));
    }

    #[test]
    fn admin_query_with_zero_limit() {
        let query = AdminQuery {
            limit: Some(0),
            offset: None,
        };
        assert_eq!(query.limit, Some(0));
    }

    #[test]
    fn admin_query_with_negative_offset() {
        let query = AdminQuery {
            limit: None,
            offset: Some(-10),
        };
        assert_eq!(query.offset, Some(-10));
    }
}
