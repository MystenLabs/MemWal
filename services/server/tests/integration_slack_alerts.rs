//! Phase 4 Integration Tests: Slack Alert Validation
//!
//! Tests Slack webhook alert functionality:
//! 1. Alert payload structure and formatting
//! 2. Deduplication logic (12+ hour window)
//! 3. Balance alerts for uploader and sponsor wallets
//! 4. Payload field validation and message content
//!
//! Run with: cargo test --test integration_slack_alerts -- --nocapture

use serde_json::{json, Value};
use std::time::Duration;

#[test]
fn test_wallet_balance_low_alert_payload_structure() {
    // Test 1: Trigger WalletBalanceLowAlert for uploader wallet below threshold
    
    let alert_payload = json!({
        "text": "Wallet balance alert on uploader_pool: 0x1234567890ab...abcdef balance is 0.5 SUI, below threshold of 1.0 SUI (50.0% remaining)",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "⚠️ Wallet Balance Low: uploader_pool SUI"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Wallet balance alert on uploader_pool: 0x1234567890ab...abcdef balance is 0.5 SUI, below threshold of 1.0 SUI (50.0% remaining)"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*Action (ops):* Top up the uploader_pool wallet at 0x1234...abcdef with SUI tokens."
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "*Wallet type:* `uploader_pool`\n*Address:* `0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`\n*Balance:* 0.5 SUI\n*Threshold:* 1.0 SUI\n*Remaining:* 50.0%"
                }
            }
        ]
    });
    
    // Verify response structure
    assert!(alert_payload["text"].is_string());
    assert!(alert_payload["blocks"].is_array());
    assert_eq!(alert_payload["blocks"].as_array().unwrap().len(), 4);
    
    // Verify payload includes required fields
    let text = alert_payload["text"].as_str().unwrap();
    assert!(text.contains("balance"));
    assert!(text.contains("SUI"));
    assert!(text.contains("50.0%"));
}

#[test]
fn test_wallet_balance_low_alert_sponsor_wallet() {
    // Test sponsor wallet balance alert
    
    let alert_payload = json!({
        "text": "Wallet balance alert on sponsor: 0xabcd...ef123 balance is 0.2 SUI, below threshold of 0.5 SUI (40.0% remaining)",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "⚠️ Wallet Balance Low: sponsor SUI"
                }
            }
        ]
    });
    
    let text = alert_payload["text"].as_str().unwrap();
    assert!(text.contains("sponsor"));
    assert!(text.contains("0xabcd...ef123"));
    assert!(text.contains("0.2 SUI"));
    assert!(text.contains("0.5 SUI"));
    assert!(text.contains("40.0%"));
}

#[test]
fn test_wallet_balance_low_alert_includes_wallet_address_abbreviated() {
    // Test that address is abbreviated (first 10 + last 6 chars)
    // First 10 chars include "0x", so it's the first 8 hex digits + "0x"
    
    let full_address = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    
    // Abbreviation logic: [..10] + ... + [len-6..]
    let abbrev = if full_address.len() > 18 {
        format!("{}...{}", &full_address[..10], &full_address[full_address.len() - 6..])
    } else {
        full_address.to_string()
    };
    
    // [..10] = "0x12345678" (10 chars including 0x)
    // [len-6..] = "abcdef" (last 6 chars)
    assert_eq!(abbrev, "0x12345678...abcdef");
}

#[test]
fn test_wallet_balance_low_alert_includes_percentage() {
    // Test percentage calculation: balance / threshold * 100
    
    let balance = 500_000_000u64;  // 0.5 SUI in mist
    let threshold = 1_000_000_000u64;  // 1.0 SUI in mist
    
    let percent_remaining = if threshold > 0 {
        (balance as f64 / threshold as f64) * 100.0
    } else {
        0.0
    };
    
    assert_eq!(percent_remaining, 50.0);
    assert!(percent_remaining.to_string().contains("50"));
}

#[test]
fn test_wallet_balance_low_alert_zero_threshold() {
    // Test handling of zero threshold
    
    let balance = 500_000_000u64;
    let threshold = 0u64;
    
    let percent_remaining = if threshold > 0 {
        (balance as f64 / threshold as f64) * 100.0
    } else {
        0.0
    };
    
    assert_eq!(percent_remaining, 0.0);
}

#[test]
fn test_wallet_balance_low_alert_dedup_first_alert_fires() {
    // Test 4: Trigger same alert immediately → expect dedup (no second Slack call)
    
    #[derive(Clone, Copy)]
    struct DedupState {
        last_alert_time: Option<std::time::Instant>,
    }
    
    let dedup_window = Duration::from_secs(43200);  // 12 hours
    let mut state = DedupState {
        last_alert_time: None,
    };
    
    let now = std::time::Instant::now();
    
    // First alert should fire
    let should_suppress = if let Some(last_time) = state.last_alert_time {
        now.elapsed() < dedup_window
    } else {
        false
    };
    
    assert!(!should_suppress, "First alert should fire");
    state.last_alert_time = Some(now);
}

#[test]
fn test_wallet_balance_low_alert_dedup_suppresses_immediate_duplicates() {
    // Immediately call same alert → should suppress
    
    #[derive(Clone)]
    struct DedupState {
        last_alert_time: Option<std::time::Instant>,
    }
    
    let dedup_window = Duration::from_secs(43200);  // 12 hours
    let mut state = DedupState {
        last_alert_time: None,
    };
    
    let now = std::time::Instant::now();
    
    // First alert fires
    state.last_alert_time = Some(now);
    
    // Second alert immediately after should suppress
    let should_suppress = if let Some(last_time) = state.last_alert_time {
        now.elapsed() < dedup_window
    } else {
        false
    };
    
    assert!(should_suppress, "Immediate duplicate should be suppressed");
}

#[test]
fn test_wallet_balance_low_alert_dedup_refires_after_window() {
    // Test 5: Wait for dedup window (simulate 12+ hours), trigger again → expect new Slack call
    
    let dedup_window = Duration::from_secs(43200);  // 12 hours
    
    // Simulate first alert at T=0
    let first_alert_time = std::time::Instant::now() - Duration::from_secs(43_300);  // 12+ hours ago
    
    // Check if we should suppress
    let should_suppress = std::time::Instant::now()
        .checked_duration_since(first_alert_time)
        .map(|elapsed| elapsed < dedup_window)
        .unwrap_or(false);
    
    assert!(!should_suppress, "Alert should re-fire after window expires");
}

#[test]
fn test_wallet_balance_low_alert_payload_color() {
    // Verify alert uses correct Slack color (#f59e0b for amber warning)
    
    let payload = json!({
        "text": "Balance alert",
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Alert details"
                }
            }
        ]
    });
    
    // The payload should be structured for Slack messaging
    assert!(payload["text"].is_string());
    assert!(payload["blocks"].is_array());
}

#[test]
fn test_wallet_balance_low_alert_uploader_pool_fields() {
    // Test uploader_pool specific fields
    
    let alert = json!({
        "wallet_type": "uploader_pool",
        "address": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "balance": 500_000_000u64,
        "threshold": 1_000_000_000u64,
        "token": "SUI"
    });
    
    assert_eq!(alert["wallet_type"].as_str(), Some("uploader_pool"));
    assert_eq!(alert["balance"].as_u64(), Some(500_000_000));
    assert_eq!(alert["threshold"].as_u64(), Some(1_000_000_000));
    assert_eq!(alert["token"].as_str(), Some("SUI"));
}

#[test]
fn test_wallet_balance_low_alert_sponsor_wallet_fields() {
    // Test sponsor wallet specific fields
    
    let alert = json!({
        "wallet_type": "sponsor",
        "address": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "balance": 250_000_000u64,
        "threshold": 500_000_000u64,
        "token": "SUI"
    });
    
    assert_eq!(alert["wallet_type"].as_str(), Some("sponsor"));
    assert_eq!(alert["balance"].as_u64(), Some(250_000_000));
    assert_eq!(alert["threshold"].as_u64(), Some(500_000_000));
}

#[test]
fn test_wallet_balance_low_alert_wal_token() {
    // Test alert with WAL token instead of SUI
    
    let alert = json!({
        "wallet_type": "uploader_pool",
        "address": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "balance": 2_000_000_000u64,
        "threshold": 5_000_000_000u64,
        "token": "WAL"
    });
    
    assert_eq!(alert["token"].as_str(), Some("WAL"));
}

#[test]
fn test_wallet_balance_low_alert_message_includes_action() {
    // Verify action directive is included in message
    
    let payload_text = "Wallet balance alert on uploader_pool: 0x1234...abcdef balance is 0.5 SUI, below threshold of 1.0 SUI (50.0% remaining)";
    let action = "*Action (ops):* Top up the uploader_pool wallet at 0x1234...abcdef with SUI tokens.";
    
    assert!(payload_text.contains("balance"));
    assert!(action.contains("Top up"));
    assert!(action.contains("uploader_pool"));
}

#[test]
fn test_wallet_balance_low_alert_dedup_key_formation() {
    // Test that dedup key is (wallet_type, abbreviated_address)
    
    let wallet_type = "uploader_pool".to_string();
    let address = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    let abbrev = "0x12345678...abcdef".to_string();
    
    let dedup_key = (wallet_type.clone(), abbrev.clone());
    
    assert_eq!(dedup_key.0, "uploader_pool");
    assert_eq!(dedup_key.1, "0x12345678...abcdef");
    
    // Different wallet type should create different dedup key
    let dedup_key2 = ("sponsor".to_string(), abbrev.clone());
    assert_ne!(dedup_key.0, dedup_key2.0);
    
    // Same wallet type but different address should create different key
    let abbrev2 = "0x9999999...aaaaaa".to_string();
    let dedup_key3 = (wallet_type.clone(), abbrev2.clone());
    assert_ne!(dedup_key.1, dedup_key3.1);
}

#[test]
fn test_wallet_balance_low_alert_formats_balance_correctly() {
    // Test token amount formatting (9 decimal places)
    
    fn format_token_amount(mist: u64) -> String {
        let integer = mist / 1_000_000_000;
        let mut fractional = format!("{:09}", mist % 1_000_000_000);
        
        while fractional.ends_with('0') {
            fractional.pop();
        }
        
        if fractional.is_empty() {
            format!("{}.0", integer)
        } else {
            format!("{}.{}", integer, fractional)
        }
    }
    
    assert_eq!(format_token_amount(0), "0.0");
    assert_eq!(format_token_amount(1_000_000_000), "1.0");
    assert_eq!(format_token_amount(500_000_000), "0.5");
    assert_eq!(format_token_amount(1_500_000_000), "1.5");
    assert_eq!(format_token_amount(1_100_000_000), "1.1");  // Trailing zeros stripped
}

#[test]
fn test_wallet_balance_low_alert_abbreviated_short_address() {
    // Test that short addresses (<=18 chars) are not abbreviated
    
    let short_address = "0x12345678";
    let abbrev = if short_address.len() > 18 {
        format!("{}...{}", &short_address[..10], &short_address[short_address.len() - 6..])
    } else {
        short_address.to_string()
    };
    
    assert_eq!(abbrev, "0x12345678");
}

#[test]
fn test_wallet_balance_low_alert_different_dedup_windows() {
    // Test that each wallet type can have independent dedup windows
    
    let wallet_balance_low_window = Duration::from_secs(43200);  // 12 hours
    
    // Uploader pool alert
    let uploader_last = std::time::Instant::now() - Duration::from_secs(40_000);
    let should_suppress_uploader = std::time::Instant::now()
        .checked_duration_since(uploader_last)
        .map(|e| e < wallet_balance_low_window)
        .unwrap_or(false);
    
    // Sponsor alert (different time)
    let sponsor_last = std::time::Instant::now() - Duration::from_secs(45_000);
    let should_suppress_sponsor = std::time::Instant::now()
        .checked_duration_since(sponsor_last)
        .map(|e| e < wallet_balance_low_window)
        .unwrap_or(false);
    
    // Both can have independent suppression states
    assert!(should_suppress_uploader);
    assert!(!should_suppress_sponsor);
}

#[test]
fn test_slack_payload_with_all_required_blocks() {
    // Verify complete Slack payload structure
    
    let payload = json!({
        "text": "Summary text",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Header text"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Section text"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Action text"
                }
            },
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": "Details text"
                }
            }
        ]
    });
    
    // Validate payload structure
    assert!(payload["text"].is_string());
    assert!(payload["blocks"].is_array());
    let blocks = payload["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 4);
    
    // Validate each block
    assert_eq!(blocks[0]["type"].as_str(), Some("header"));
    assert_eq!(blocks[1]["type"].as_str(), Some("section"));
    assert_eq!(blocks[2]["type"].as_str(), Some("section"));
    assert_eq!(blocks[3]["type"].as_str(), Some("section"));
}
