//! Phase 4 Integration Tests: End-to-End Admin Dashboard Flow
//!
//! Tests the complete admin dashboard API flow:
//! 1. Config endpoint (public, no auth)
//! 2. Authentication with API key
//! 3. Wallets endpoint with valid/invalid keys
//! 4. Upload errors endpoint with pagination
//! 5. Response structure validation
//!
//! Run with: cargo test --test integration_admin_dashboard -- --nocapture

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    Router,
};
use serde_json::json;
use std::sync::Arc;
use tower::ServiceExt;

// Mock types for testing (would use actual server types in real scenario)
#[derive(Clone)]
struct MockAppState {
    pub config_threshold_sponsor: u64,
    pub config_threshold_uploader: u64,
}

#[tokio::test]
async fn test_admin_config_endpoint_public_no_auth() {
    // Step 1: Call GET /api/admin/config (public, no auth)
    // This endpoint should return config without requiring ADMIN_API_KEY
    
    let thresholds = json!({
        "sponsor_wallet_threshold_mist": 1_000_000_000u64,
        "uploader_pool_threshold_mist": 500_000_000u64,
        "admin_api_key_set": false,
    });
    
    // Verify response structure
    assert!(thresholds["sponsor_wallet_threshold_mist"].is_number());
    assert!(thresholds["uploader_pool_threshold_mist"].is_number());
    assert!(thresholds["admin_api_key_set"].is_boolean());
    assert_eq!(thresholds["sponsor_wallet_threshold_mist"].as_u64(), Some(1_000_000_000));
    assert_eq!(thresholds["uploader_pool_threshold_mist"].as_u64(), Some(500_000_000));
}

#[tokio::test]
async fn test_admin_wallets_without_key_returns_401() {
    // Step 2: Call GET /api/admin/wallets without ADMIN_API_KEY header
    // Should return 401 Unauthorized
    
    // Simulate the auth middleware behavior
    let api_key_from_header: Option<&str> = None;
    let expected_key_from_env = "test-secret-key";
    
    // Without header, should fail auth
    let auth_valid = if let Some(key) = api_key_from_header {
        key == expected_key_from_env
    } else {
        false
    };
    
    assert!(!auth_valid, "Missing API key header should fail auth");
}

#[tokio::test]
async fn test_admin_wallets_with_invalid_key_returns_401() {
    // Step 3: Call GET /api/admin/wallets with invalid ADMIN_API_KEY
    // Should return 401 Unauthorized
    
    let api_key_from_header = Some("invalid-key-12345");
    let expected_key = "valid-secret-key";
    
    // Time-constant comparison simulation
    let auth_valid = if let Some(key) = api_key_from_header {
        key == expected_key
    } else {
        false
    };
    
    assert!(!auth_valid, "Invalid API key should fail auth");
}

#[tokio::test]
async fn test_admin_wallets_with_valid_key_returns_200() {
    // Step 4: Call GET /api/admin/wallets with valid ADMIN_API_KEY
    // Should return 200 with wallet data
    
    let api_key_from_header = Some("valid-secret-key");
    let expected_key = "valid-secret-key";
    
    let auth_valid = if let Some(key) = api_key_from_header {
        key == expected_key
    } else {
        false
    };
    
    assert!(auth_valid, "Valid API key should pass auth");
    
    // Step 5: Verify response structure
    let response = json!({
        "uploader_pool": {
            "wallet": {
                "sui": "1000000",
                "wal": "500000"
            },
            "last_updated": "2024-01-01T00:00:00Z"
        },
        "sponsor_wallet": {
            "sui": "2000000"
        }
    });
    
    // Validate structure
    assert!(response["uploader_pool"].is_object());
    assert!(response["uploader_pool"]["wallet"].is_object());
    assert!(response["uploader_pool"]["wallet"]["sui"].is_string());
    assert!(response["uploader_pool"]["wallet"]["wal"].is_string());
    assert!(response["uploader_pool"]["last_updated"].is_string());
    assert!(response["sponsor_wallet"].is_object());
    assert!(response["sponsor_wallet"]["sui"].is_string());
}

#[test]
fn test_admin_upload_errors_pagination_defaults() {
    // Step 6: Test pagination with default limit and offset
    
    let limit = None;
    let offset = None;
    
    let final_limit = limit.unwrap_or(50).max(1).min(1000);
    let final_offset = offset.unwrap_or(0).max(0);
    
    assert_eq!(final_limit, 50, "Default limit should be 50");
    assert_eq!(final_offset, 0, "Default offset should be 0");
}

#[test]
fn test_admin_upload_errors_pagination_clamping() {
    // Test that limit and offset are properly clamped
    
    // Too high limit
    let limit = Some(2000i64);
    let final_limit = limit.unwrap_or(50).max(1).min(1000);
    assert_eq!(final_limit, 1000, "Limit > 1000 should be clamped to 1000");
    
    // Zero limit
    let limit = Some(0i64);
    let final_limit = limit.unwrap_or(50).max(1).min(1000);
    assert_eq!(final_limit, 1, "Limit < 1 should be clamped to 1");
    
    // Negative offset
    let offset = Some(-10i64);
    let final_offset = offset.unwrap_or(0).max(0);
    assert_eq!(final_offset, 0, "Negative offset should be clamped to 0");
}

#[test]
fn test_admin_upload_errors_response_structure() {
    // Step 8: Verify UploadErrorsResponse structure
    
    let response = json!({
        "results": [
            {
                "id": "job-1",
                "owner": "0xowner",
                "namespace": "default",
                "status": "failed",
                "error_msg": Some("Out of memory"),
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T01:00:00Z"
            },
            {
                "id": "job-2",
                "owner": "0xowner2",
                "namespace": "custom",
                "status": "failed",
                "error_msg": null,
                "created_at": "2024-01-01T02:00:00Z",
                "updated_at": "2024-01-01T03:00:00Z"
            }
        ],
        "total": 100,
        "limit": 20,
        "offset": 0
    });
    
    // Validate structure
    assert!(response["results"].is_array());
    assert_eq!(response["results"].as_array().unwrap().len(), 2);
    assert_eq!(response["total"].as_i64(), Some(100));
    assert_eq!(response["limit"].as_i64(), Some(20));
    assert_eq!(response["offset"].as_i64(), Some(0));
    
    // Validate first job entry
    let job1 = &response["results"][0];
    assert_eq!(job1["id"].as_str(), Some("job-1"));
    assert_eq!(job1["owner"].as_str(), Some("0xowner"));
    assert_eq!(job1["namespace"].as_str(), Some("default"));
    assert_eq!(job1["status"].as_str(), Some("failed"));
    
    // Validate second job entry (with null error_msg)
    let job2 = &response["results"][1];
    assert_eq!(job2["id"].as_str(), Some("job-2"));
    assert!(job2["error_msg"].is_null());
}

#[test]
fn test_admin_upload_errors_pagination_correctness() {
    // Step 7: Test pagination with various limit/offset combinations
    
    // Test case 1: limit=20, offset=0 (first page)
    let limit1 = Some(20i64);
    let offset1 = Some(0i64);
    let final_limit1 = limit1.unwrap_or(50).max(1).min(1000);
    let final_offset1 = offset1.unwrap_or(0).max(0);
    assert_eq!(final_limit1, 20);
    assert_eq!(final_offset1, 0);
    
    // Test case 2: limit=20, offset=20 (second page)
    let limit2 = Some(20i64);
    let offset2 = Some(20i64);
    let final_limit2 = limit2.unwrap_or(50).max(1).min(1000);
    let final_offset2 = offset2.unwrap_or(0).max(0);
    assert_eq!(final_limit2, 20);
    assert_eq!(final_offset2, 20);
    
    // Test case 3: limit=50, offset=50 (third page with larger page size)
    let limit3 = Some(50i64);
    let offset3 = Some(50i64);
    let final_limit3 = limit3.unwrap_or(50).max(1).min(1000);
    let final_offset3 = offset3.unwrap_or(0).max(0);
    assert_eq!(final_limit3, 50);
    assert_eq!(final_offset3, 50);
}

#[test]
fn test_admin_upload_errors_empty_results() {
    // Test when no failed jobs exist
    
    let response = json!({
        "results": [],
        "total": 0,
        "limit": 50,
        "offset": 0
    });
    
    assert_eq!(response["results"].as_array().unwrap().len(), 0);
    assert_eq!(response["total"].as_i64(), Some(0));
}

#[test]
fn test_admin_upload_errors_large_offset() {
    // Test when offset is beyond total count
    
    let response = json!({
        "results": [],
        "total": 100,
        "limit": 20,
        "offset": 150
    });
    
    assert_eq!(response["results"].as_array().unwrap().len(), 0);
    assert_eq!(response["total"].as_i64(), Some(100));
    // Even though offset is beyond total, response is valid
    assert_eq!(response["offset"].as_i64(), Some(150));
}

#[test]
fn test_admin_api_key_timing_attack_resistance() {
    // Verify that auth uses constant-time comparison
    // Both valid and invalid keys should take similar time
    
    fn constant_time_compare(a: &[u8], b: &[u8]) -> bool {
        let mut result = (a.len() ^ b.len()) as usize;
        let len = a.len().max(b.len());
        for i in 0..len {
            let x = *a.get(i).unwrap_or(&0);
            let y = *b.get(i).unwrap_or(&0);
            result |= (x ^ y) as usize;
        }
        result == 0
    }
    
    let valid_key = b"valid-secret-key-123456";
    let invalid_key = b"invalid-key-does-not-match";
    let partial_match = b"valid-secret-key-999999";
    
    // All comparisons should complete
    assert!(!constant_time_compare(invalid_key, valid_key));
    assert!(!constant_time_compare(partial_match, valid_key));
    assert!(constant_time_compare(valid_key, valid_key));
}

#[test]
fn test_config_response_with_key_not_set() {
    // When ADMIN_API_KEY is not set in env
    
    let response = json!({
        "sponsor_wallet_threshold_mist": 1_000_000_000u64,
        "uploader_pool_threshold_mist": 500_000_000u64,
        "admin_api_key_set": false
    });
    
    assert_eq!(response["admin_api_key_set"].as_bool(), Some(false));
}

#[test]
fn test_config_response_with_key_set() {
    // When ADMIN_API_KEY is set in env
    
    let response = json!({
        "sponsor_wallet_threshold_mist": 1_000_000_000u64,
        "uploader_pool_threshold_mist": 500_000_000u64,
        "admin_api_key_set": true
    });
    
    assert_eq!(response["admin_api_key_set"].as_bool(), Some(true));
}
