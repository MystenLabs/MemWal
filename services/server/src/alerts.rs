use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

const ALERT_TO_SLACK_ENV: &str = "ALERT_TO_SLACK";
const MAX_SLACK_ERROR_LEN: usize = 1_500;
const WALRUS_UPGRADE_ALERT_DEDUP_SECS_ENV: &str = "WALRUS_PACKAGE_UPGRADE_ALERT_DEDUP_SECS";
const WALRUS_UPGRADE_ALERT_DEDUP_DEFAULT: Duration = Duration::from_secs(600);
const WALRUS_OBJECT_LOCK_ALERT_DEDUP_SECS_ENV: &str = "WALRUS_OBJECT_LOCK_ALERT_DEDUP_SECS";
const WALRUS_OBJECT_LOCK_ALERT_DEDUP_DEFAULT: Duration = Duration::from_secs(600);

/// Mirrors the `@mysten/walrus` dep version in
/// `services/server/scripts/package.json`. Bump this constant in lockstep
/// when bumping the sidecar dep so the Slack alert reports the actual
/// runtime version, not a stale label.
pub const SIDECAR_WALRUS_DEP_VERSION: &str = "1.1.7";

/// Time-window dedup keyed by a `(String, String)` identity. Suppresses
/// duplicate alerts for the same logical event during a burst.
#[derive(Debug)]
struct AlertDedup {
    seen: Mutex<HashMap<(String, String), Instant>>,
    window: Duration,
}

impl AlertDedup {
    fn new(window: Duration) -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
            window,
        }
    }

    /// Returns `true` if an alert with this key fired within the window —
    /// caller should drop it. On the firing path (returns `false`) the entry
    /// is stamped to `now`, so the window slides from the most-recent fire.
    fn should_suppress(&self, key: (String, String)) -> bool {
        let now = Instant::now();
        let mut guard = self.seen.lock().expect("dedup mutex poisoned");
        // Opportunistic cleanup so the map can't grow without bound on a
        // long-running relayer: drop entries older than 2× the window.
        let cleanup_horizon = self.window.saturating_mul(2);
        guard.retain(|_, fired_at| {
            now.checked_duration_since(*fired_at)
                .map(|elapsed| elapsed < cleanup_horizon)
                .unwrap_or(true)
        });
        if let Some(fired_at) = guard.get(&key) {
            if let Some(elapsed) = now.checked_duration_since(*fired_at) {
                if elapsed < self.window {
                    return true;
                }
            }
        }
        guard.insert(key, now);
        false
    }
}

#[derive(Debug)]
pub struct AlertManager {
    slack: Option<SlackNotifier>,
    /// Suppresses Walrus package-upgrade alert spam during an upgrade burst.
    /// Keyed by `(sui_network, sidecar_walrus_dep_version)` — concurrent queued
    /// jobs all hit EWrongVersion against the same on-chain package change, so
    /// one notification per (network, dep) is enough until the dep bumps or the
    /// window elapses.
    walrus_upgrade_dedup: AlertDedup,
    /// Suppresses Walrus object-lock alert spam. Keyed by
    /// `(sui_network, locked_object_id)` — when one owned object equivocates,
    /// every concurrent job touching it raises the same error, so one
    /// notification per (network, object) is enough until the window elapses.
    walrus_object_lock_dedup: AlertDedup,
}

impl AlertManager {
    pub fn from_env(http_client: reqwest::Client) -> Self {
        let slack = std::env::var(ALERT_TO_SLACK_ENV)
            .ok()
            .and_then(|raw| SlackNotifier::from_env_value(http_client, &raw));

        Self {
            slack,
            walrus_upgrade_dedup: AlertDedup::new(dedup_window_from_env(
                WALRUS_UPGRADE_ALERT_DEDUP_SECS_ENV,
                WALRUS_UPGRADE_ALERT_DEDUP_DEFAULT,
            )),
            walrus_object_lock_dedup: AlertDedup::new(dedup_window_from_env(
                WALRUS_OBJECT_LOCK_ALERT_DEDUP_SECS_ENV,
                WALRUS_OBJECT_LOCK_ALERT_DEDUP_DEFAULT,
            )),
        }
    }

    pub fn slack_enabled(&self) -> bool {
        self.slack.is_some()
    }

    pub async fn notify_walrus_upload_exhausted(
        &self,
        alert: WalrusUploadExhaustedAlert,
    ) -> Result<(), AlertError> {
        let Some(slack) = &self.slack else {
            return Ok(());
        };
        let payload = SlackPayload::for_walrus_upload_exhausted(&alert);
        slack.send_payload(&payload).await
    }

    pub async fn notify_walrus_package_upgrade_detected(
        &self,
        alert: WalrusPackageUpgradeDetectedAlert,
    ) -> Result<(), AlertError> {
        let Some(slack) = &self.slack else {
            return Ok(());
        };
        let key = (
            alert.sui_network.clone(),
            alert.sidecar_walrus_dep_version.clone(),
        );
        if self.walrus_upgrade_dedup.should_suppress(key) {
            return Ok(());
        }
        let payload = SlackPayload::for_walrus_package_upgrade_detected(&alert);
        slack.send_payload(&payload).await
    }

    pub async fn notify_walrus_object_locked(
        &self,
        alert: WalrusObjectLockedAlert,
    ) -> Result<(), AlertError> {
        let Some(slack) = &self.slack else {
            return Ok(());
        };
        // Dedup per (network, object). When object id is unparseable, fall back
        // to a constant so a burst of unparseable locks still collapses to one
        // alert per network rather than spamming.
        let key = (
            alert.sui_network.clone(),
            alert
                .locked_object_id
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
        );
        if self.walrus_object_lock_dedup.should_suppress(key) {
            return Ok(());
        }
        let payload = SlackPayload::for_walrus_object_locked(&alert);
        slack.send_payload(&payload).await
    }
}

/// Read a dedup window (seconds) from `env_var`, falling back to `default`
/// when unset, unparseable, or zero.
fn dedup_window_from_env(env_var: &str, default: Duration) -> Duration {
    std::env::var(env_var)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(default)
}

#[derive(Clone, Debug)]
struct SlackNotifier {
    http_client: reqwest::Client,
    webhook_url: String,
}

impl SlackNotifier {
    fn from_env_value(http_client: reqwest::Client, raw: &str) -> Option<Self> {
        let value = raw.trim();
        if value.is_empty() || is_disabled_env_value(value) {
            return None;
        }

        Some(Self {
            http_client,
            webhook_url: value.to_string(),
        })
    }

    async fn send_payload(&self, payload: &SlackPayload) -> Result<(), AlertError> {
        let resp = self
            .http_client
            .post(&self.webhook_url)
            .json(payload)
            .send()
            .await
            .map_err(|err| AlertError::Transport(err.to_string()))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AlertError::HttpStatus {
                status: status.as_u16(),
                body: truncate(&body, 500),
            });
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct WalrusUploadExhaustedAlert {
    pub remember_job_id: Option<String>,
    pub owner: String,
    pub namespace: String,
    pub attempt: usize,
    pub max_attempts: usize,
    pub wallet_index: usize,
    pub configured_wallets: usize,
    pub sui_network: String,
    pub error: String,
}

/// Fired when the TS sidecar surfaces a MoveAbort from
/// `walrus::system::inner_mut` (EWrongVersion = abort code 1). This means the
/// on-chain Walrus package was upgraded after the sidecar booted, and the
/// cached `@mysten/walrus` client is carrying stale package metadata.
///
/// The sidecar auto-recovers by recreating the client (sidecar logs
/// `[walrus/client] refreshed reason=walrus_package_version_mismatch`), and
/// the next Apalis retry succeeds. This alert is informational — it tells
/// the team that a Walrus on-chain upgrade just affected the upload path so
/// they can verify `@mysten/walrus` dep version is current.
#[derive(Debug, Clone)]
pub struct WalrusPackageUpgradeDetectedAlert {
    pub remember_job_id: Option<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub sui_network: String,
    pub sidecar_walrus_dep_version: String,
    pub on_chain_version_before: Option<String>,
    pub on_chain_version_after: Option<String>,
    pub action_taken: String,
    pub error: String,
}

/// Fired when a wallet job fails because a Sui owned object/version is locked
/// to a competing transaction (equivocation / ">1/3 of validators …
/// non-retriable"). Distinct from the "exhausted retries" alert: this case
/// aborts immediately rather than burning the wallet budget, and the on-call
/// message must name the real cause and surface the locked object + locking
/// transaction so they can check lock status / wait for the epoch boundary.
#[derive(Debug)]
pub struct WalrusObjectLockedAlert {
    pub remember_job_id: Option<String>,
    pub owner: Option<String>,
    pub namespace: Option<String>,
    pub sui_network: String,
    pub locked_object_id: Option<String>,
    pub locked_object_version: Option<String>,
    pub locking_transaction_digest: Option<String>,
    pub error: String,
}

#[derive(Debug)]
pub enum AlertError {
    Transport(String),
    HttpStatus { status: u16, body: String },
}

impl std::fmt::Display for AlertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AlertError::Transport(err) => write!(f, "alert transport error: {}", err),
            AlertError::HttpStatus { status, body } => {
                write!(f, "alert webhook returned HTTP {}: {}", status, body)
            }
        }
    }
}

impl std::error::Error for AlertError {}

#[derive(Serialize)]
struct SlackPayload {
    text: String,
    blocks: Vec<SlackBlock>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum SlackBlock {
    #[serde(rename = "header")]
    Header { text: SlackText },
    #[serde(rename = "section")]
    Section { text: SlackText },
}

#[derive(Serialize)]
struct SlackText {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

impl SlackPayload {
    fn for_walrus_package_upgrade_detected(alert: &WalrusPackageUpgradeDetectedAlert) -> Self {
        let title = "MemWal Walrus on-chain package upgrade detected".to_string();
        let summary = format!(
            "Walrus package upgrade detected on {}; sidecar auto-recovered. Verify @mysten/walrus dep version is current.",
            alert.sui_network,
        );
        let job = alert.remember_job_id.as_deref().unwrap_or("-");
        let owner = alert
            .owner
            .as_deref()
            .map(short_address)
            .unwrap_or_else(|| "-".to_string());
        let namespace = alert.namespace.as_deref().unwrap_or("-");
        let version_line = match (
            alert.on_chain_version_before.as_deref(),
            alert.on_chain_version_after.as_deref(),
        ) {
            (Some(before), Some(after)) => {
                format!("*On-chain system version:* `{}` → `{}`\n", before, after)
            }
            (None, Some(after)) => format!("*On-chain system version (after refresh):* `{}`\n", after),
            (Some(before), None) => format!("*On-chain system version (before refresh):* `{}`\n", before),
            (None, None) => String::new(),
        };
        let details = format!(
            "*Network:* `{}`\n*Sidecar @mysten/walrus dep:* `{}`\n{}*Action taken:* {}\n*Job:* `{}`\n*Owner:* `{}`\n*Namespace:* `{}`\n*Original error:* ```{}```",
            alert.sui_network,
            alert.sidecar_walrus_dep_version,
            version_line,
            alert.action_taken,
            job,
            owner,
            namespace,
            truncate(&alert.error, MAX_SLACK_ERROR_LEN),
        );

        Self {
            text: summary.clone(),
            blocks: vec![
                SlackBlock::Header {
                    text: plain_text(title),
                },
                SlackBlock::Section {
                    text: mrkdwn(summary),
                },
                SlackBlock::Section {
                    text: mrkdwn(details),
                },
            ],
        }
    }

    fn for_walrus_upload_exhausted(alert: &WalrusUploadExhaustedAlert) -> Self {
        let job = alert.remember_job_id.as_deref().unwrap_or("-");
        let title = "MemWal Walrus upload exhausted retries".to_string();
        let summary = format!(
            "Walrus upload failed after {}/{} wallet attempt(s) for job {}.",
            alert.attempt, alert.max_attempts, job
        );
        let details = format!(
            "*Job:* `{}`\n*Owner:* `{}`\n*Namespace:* `{}`\n*Network:* `{}`\n*Wallet index:* `{}`\n*Configured wallets:* `{}`\n*Error:* ```{}```",
            job,
            short_address(&alert.owner),
            alert.namespace,
            alert.sui_network,
            alert.wallet_index,
            alert.configured_wallets,
            truncate(&alert.error, MAX_SLACK_ERROR_LEN),
        );

        Self {
            text: summary.clone(),
            blocks: vec![
                SlackBlock::Header {
                    text: plain_text(title),
                },
                SlackBlock::Section {
                    text: mrkdwn(summary),
                },
                SlackBlock::Section {
                    text: mrkdwn(details),
                },
            ],
        }
    }

    fn for_walrus_object_locked(alert: &WalrusObjectLockedAlert) -> Self {
        let title = "MemWal Walrus upload blocked — Sui object lock".to_string();
        let summary = format!(
            "Walrus upload hit a Sui owned-object lock / equivocation on {}. \
             Not retried (would re-fail against the same locked object); the lock \
             typically clears at the next epoch boundary.",
            alert.sui_network,
        );
        let object = alert.locked_object_id.as_deref().unwrap_or("unparsed");
        let version = alert.locked_object_version.as_deref().unwrap_or("unparsed");
        let locking = alert
            .locking_transaction_digest
            .as_deref()
            .unwrap_or("unparsed");
        let job = alert.remember_job_id.as_deref().unwrap_or("-");
        let owner = alert
            .owner
            .as_deref()
            .map(short_address)
            .unwrap_or_else(|| "-".to_string());
        let namespace = alert.namespace.as_deref().unwrap_or("-");
        let details = format!(
            "*Network:* `{}`\n*Locked object:* `{}`\n*Object version:* `{}`\n*Locked by tx:* `{}`\n*Job:* `{}`\n*Owner:* `{}`\n*Namespace:* `{}`\n*Error:* ```{}```",
            alert.sui_network,
            object,
            version,
            locking,
            job,
            owner,
            namespace,
            truncate(&alert.error, MAX_SLACK_ERROR_LEN),
        );

        Self {
            text: summary.clone(),
            blocks: vec![
                SlackBlock::Header {
                    text: plain_text(title),
                },
                SlackBlock::Section {
                    text: mrkdwn(summary),
                },
                SlackBlock::Section {
                    text: mrkdwn(details),
                },
            ],
        }
    }
}

fn plain_text(text: String) -> SlackText {
    SlackText {
        kind: "plain_text",
        text,
    }
}

fn mrkdwn(text: String) -> SlackText {
    SlackText {
        kind: "mrkdwn",
        text,
    }
}

fn is_disabled_env_value(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

fn short_address(address: &str) -> String {
    if address.len() <= 18 {
        return address.to_string();
    }
    format!("{}...{}", &address[..10], &address[address.len() - 6..])
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    format!("{}...", value.chars().take(max_len).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_env_values_do_not_enable_slack() {
        let client = reqwest::Client::new();
        for raw in ["", "0", "false", "no", "off"] {
            assert!(SlackNotifier::from_env_value(client.clone(), raw).is_none());
        }
    }

    #[test]
    fn webhook_env_value_enables_slack() {
        let client = reqwest::Client::new();
        let notifier =
            SlackNotifier::from_env_value(client, "https://hooks.slack.com/services/T/B/C");
        assert!(notifier.is_some());
    }

    #[test]
    fn slack_payload_contains_upload_context() {
        let payload = SlackPayload::for_walrus_upload_exhausted(&WalrusUploadExhaustedAlert {
            remember_job_id: Some("job-1".into()),
            owner: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef".into(),
            namespace: "default".into(),
            attempt: 5,
            max_attempts: 5,
            wallet_index: 4,
            configured_wallets: 5,
            sui_network: "mainnet".into(),
            error: "walrus upload failed".into(),
        });

        assert!(payload.text.contains("5/5"));
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("job-1"));
        assert!(json.contains("default"));
        assert!(json.contains("mainnet"));
        assert!(json.contains("walrus upload failed"));
    }

    #[test]
    fn walrus_package_upgrade_payload_includes_version_diff() {
        let payload =
            SlackPayload::for_walrus_package_upgrade_detected(&WalrusPackageUpgradeDetectedAlert {
                remember_job_id: Some("job-42".into()),
                owner: Some(
                    "0xabc1234567890abcdef1234567890abcdef1234567890abcdef1234567890def0".into(),
                ),
                namespace: Some("notes".into()),
                sui_network: "mainnet".into(),
                sidecar_walrus_dep_version: "1.1.7".into(),
                on_chain_version_before: Some("3".into()),
                on_chain_version_after: Some("4".into()),
                action_taken: "Sidecar refreshed cached client; Apalis will retry.".into(),
                error: "MoveAbort in 1st command, abort code: 1, in '0xc1b6::system::inner_mut' (instruction 0)".into(),
            });

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("mainnet"));
        assert!(json.contains("1.1.7"));
        assert!(json.contains("job-42"));
        assert!(json.contains("notes"));
        assert!(json.contains("inner_mut"));
        // version-diff line must show both ends
        assert!(json.contains("3"));
        assert!(json.contains("4"));
        // action narrative present
        assert!(json.contains("refreshed"));
    }

    #[test]
    fn walrus_package_upgrade_payload_handles_missing_version_data() {
        // RPC may be down in the error path → both versions null. Payload still ships.
        let payload =
            SlackPayload::for_walrus_package_upgrade_detected(&WalrusPackageUpgradeDetectedAlert {
                remember_job_id: None,
                owner: None,
                namespace: None,
                sui_network: "testnet".into(),
                sidecar_walrus_dep_version: SIDECAR_WALRUS_DEP_VERSION.into(),
                on_chain_version_before: None,
                on_chain_version_after: None,
                action_taken: "n/a".into(),
                error: "MoveAbort EWrongVersion".into(),
            });

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("testnet"));
        assert!(json.contains("EWrongVersion"));
        // owner / job / namespace fall back to "-"
        assert!(json.contains("`-`"));
    }

    #[test]
    fn walrus_package_upgrade_payload_truncates_oversized_error() {
        // Slack error block uses MAX_SLACK_ERROR_LEN truncation — make sure that
        // contract still holds for the new payload formatter.
        let huge_error = "X".repeat(MAX_SLACK_ERROR_LEN * 2);
        let payload =
            SlackPayload::for_walrus_package_upgrade_detected(&WalrusPackageUpgradeDetectedAlert {
                remember_job_id: None,
                owner: None,
                namespace: None,
                sui_network: "mainnet".into(),
                sidecar_walrus_dep_version: "1.1.7".into(),
                on_chain_version_before: None,
                on_chain_version_after: None,
                action_taken: "client refreshed".into(),
                error: huge_error,
            });

        let json = serde_json::to_string(&payload).unwrap();
        // truncation marker present
        assert!(json.contains("..."));
        // total payload comfortably under twice the cap (header + metadata + body)
        assert!(json.len() < MAX_SLACK_ERROR_LEN * 3);
    }

    fn key(a: &str, b: &str) -> (String, String) {
        (a.to_string(), b.to_string())
    }

    #[test]
    fn alert_dedup_lets_first_through() {
        let dedup = AlertDedup::new(Duration::from_secs(600));
        assert!(!dedup.should_suppress(key("mainnet", "1.1.7")));
    }

    #[test]
    fn alert_dedup_suppresses_burst_within_window() {
        // Concurrent jobs all raise the same logical event — only the first
        // fires; the rest are suppressed until the window elapses.
        let dedup = AlertDedup::new(Duration::from_secs(600));
        assert!(!dedup.should_suppress(key("mainnet", "obj-A")));
        for _ in 0..50 {
            assert!(dedup.should_suppress(key("mainnet", "obj-A")));
        }
    }

    #[test]
    fn alert_dedup_separates_distinct_keys() {
        // Different network or different second component are independent events.
        let dedup = AlertDedup::new(Duration::from_secs(600));
        assert!(!dedup.should_suppress(key("mainnet", "obj-A")));
        assert!(!dedup.should_suppress(key("testnet", "obj-A")));
        assert!(!dedup.should_suppress(key("mainnet", "obj-B")));
        // …but a repeat on the same key is still suppressed.
        assert!(dedup.should_suppress(key("mainnet", "obj-A")));
    }

    #[test]
    fn alert_dedup_re_fires_after_window_expires() {
        // Very short window → immediately past it on the second call.
        let dedup = AlertDedup::new(Duration::from_millis(1));
        assert!(!dedup.should_suppress(key("mainnet", "1.1.7")));
        std::thread::sleep(Duration::from_millis(5));
        assert!(!dedup.should_suppress(key("mainnet", "1.1.7")));
    }

    #[test]
    fn walrus_object_locked_payload_surfaces_lock_metadata_not_exhausted_copy() {
        let payload = SlackPayload::for_walrus_object_locked(&WalrusObjectLockedAlert {
            remember_job_id: Some("3d607892".into()),
            owner: Some(
                "0xab27e2141234567890abcdef1234567890abcdef1234567890abcdef0064e132".into(),
            ),
            namespace: Some("autonomous-participation".into()),
            sui_network: "testnet".into(),
            locked_object_id: Some("0x36f866a4d400ec3dd5d8b0bac30cc36ab6d56172634a6b4dea9e2a554a43b08e".into()),
            locked_object_version: Some("884613305".into()),
            locking_transaction_digest: Some("8bjFgRyXRRYwrzQapgEjpHnGhdfNDY7d6xA82BtHrp3F".into()),
            error: "Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable)".into(),
        });

        let json = serde_json::to_string(&payload).unwrap();
        // Names the real cause, NOT the misleading "exhausted retries" copy.
        assert!(json.contains("object lock") || json.contains("Sui object lock"));
        assert!(!json.to_lowercase().contains("exhausted retries"));
        // Surfaces lock metadata for triage.
        assert!(json.contains("0x36f866a4d400ec3dd5d8b0bac30cc36ab6d56172634a6b4dea9e2a554a43b08e"));
        assert!(json.contains("884613305"));
        assert!(json.contains("8bjFgRyXRRYwrzQapgEjpHnGhdfNDY7d6xA82BtHrp3F"));
        assert!(json.contains("testnet"));
        assert!(json.contains("autonomous-participation"));
    }

    #[test]
    fn walrus_object_locked_payload_handles_unparsed_metadata() {
        // When the error didn't yield object/version/digest, the payload still
        // ships with explicit `unparsed` placeholders rather than crashing.
        let payload = SlackPayload::for_walrus_object_locked(&WalrusObjectLockedAlert {
            remember_job_id: None,
            owner: None,
            namespace: None,
            sui_network: "mainnet".into(),
            locked_object_id: None,
            locked_object_version: None,
            locking_transaction_digest: None,
            error: "equivocation detected".into(),
        });

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("unparsed"));
        assert!(json.contains("mainnet"));
    }
}
