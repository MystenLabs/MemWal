//! Slack notification client for terminal job failures.
//!
//! ENG-1784: Push alerts to a Slack Incoming Webhook when a remember job
//! fails after wallet rotation has exhausted all retries (i.e. every wallet
//! in the pool returned a non-retryable error).
//!
//! Design (mirrors `x-wallet/backend/src/clients/slack.rs`):
//!
//! * **Optional**: `SlackClient` is constructed only when `SLACK_WEBHOOK_URL`
//!   is set. When absent the alerter is `None` and every notify call is a
//!   no-op; the rest of the server is unaware.
//! * **Fire-and-forget**: callers spawn the notify future and ignore the
//!   result. A failed Slack POST must never fail the wallet job.
//! * **In-memory dedup**: Enoki / sidecar incidents can fan out into dozens
//!   of identical failures within seconds. We hash the error message and
//!   suppress duplicates within a 5-minute window so the on-call channel
//!   isn't flooded; suppressions are logged for visibility.

use std::collections::HashMap;
use std::error::Error as StdError;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Boxed error for fire-and-forget callers; the alerter never has a typed
/// error worth matching on — every failure path just gets logged.
pub type SlackError = Box<dyn StdError + Send + Sync + 'static>;
pub type SlackResult<T> = std::result::Result<T, SlackError>;

/// Cool-down for identical error signatures. An Enoki outage typically
/// produces the same `dry_run_failed: balance::split` message on every
/// retry; without this window a 30-minute incident posts hundreds of
/// near-identical messages.
const DEDUP_WINDOW: Duration = Duration::from_secs(5 * 60);

/// `text` block is the fallback Slack uses for notifications + accessibility.
/// `blocks` carries the rich layout shown in the channel.
#[derive(Debug, Serialize)]
struct SlackMessage {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocks: Option<Vec<SlackBlock>>,
}

#[derive(Debug, Serialize)]
struct SlackBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<SlackText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<Vec<SlackText>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elements: Option<Vec<SlackText>>,
}

#[derive(Debug, Serialize)]
struct SlackText {
    #[serde(rename = "type")]
    text_type: String,
    text: String,
}

/// Slack notifier. Cheap to clone — wraps `reqwest::Client` which is
/// internally `Arc`-counted, and an `Arc<Mutex<...>>` dedup map.
#[derive(Clone)]
pub struct SlackClient {
    http: Client,
    webhook_url: String,
    /// `error_signature → last_sent_at`. We log + skip when the same
    /// signature re-appears within `DEDUP_WINDOW`.
    dedup: std::sync::Arc<Mutex<HashMap<String, Instant>>>,
    /// Identifies the running relayer in the alert footer
    /// (e.g. `prod` / `staging` / `dev` from `MEMWAL_ENV`).
    env_label: String,
    /// Optional git SHA / build identifier, surfaced in the footer.
    server_commit: Option<String>,
}

impl SlackClient {
    pub fn new(webhook_url: String, env_label: String, server_commit: Option<String>) -> Self {
        Self {
            http: Client::new(),
            webhook_url,
            dedup: std::sync::Arc::new(Mutex::new(HashMap::new())),
            env_label,
            server_commit,
        }
    }

    /// Notify Slack that a remember job has terminally failed after the
    /// wallet pool exhausted retries. Returns `Ok(())` on success, or after
    /// suppression. Network errors are surfaced for caller logging but the
    /// recommended use is fire-and-forget via `tokio::spawn`.
    pub async fn notify_remember_job_failed(
        &self,
        job_id: Option<&str>,
        owner: Option<&str>,
        namespace: Option<&str>,
        wallet_attempts: u32,
        max_attempts: u32,
        error_msg: &str,
    ) -> SlackResult<()> {
        if self.should_suppress(error_msg) {
            info!(
                error_signature = %short_hash(error_msg),
                "Slack alert suppressed (within dedup window)"
            );
            return Ok(());
        }

        let payload = self.build_remember_failed_payload(
            job_id,
            owner,
            namespace,
            wallet_attempts,
            max_attempts,
            error_msg,
        );
        self.send_payload(&payload).await
    }

    /// Send a raw text-only notification. Helpful for ad-hoc one-off alerts
    /// and unit tests; the typed `notify_*` helpers should be preferred for
    /// production paths so the format stays consistent.
    #[allow(dead_code)]
    pub async fn send_notification(&self, text: &str) -> SlackResult<()> {
        self.send_payload(&SlackMessage {
            text: text.to_string(),
            blocks: None,
        })
        .await
    }

    /// Returns `true` if an identical `error_msg` has been alerted within
    /// the dedup window. Updates the timestamp atomically when we DO send.
    fn should_suppress(&self, error_msg: &str) -> bool {
        let key = hash_error(error_msg);
        let now = Instant::now();

        let mut map = match self.dedup.lock() {
            Ok(guard) => guard,
            // Poisoned mutex: better to send the alert than swallow it.
            Err(poisoned) => poisoned.into_inner(),
        };

        if let Some(last) = map.get(&key) {
            if now.duration_since(*last) < DEDUP_WINDOW {
                return true;
            }
        }
        map.insert(key, now);

        // Best-effort GC of expired entries so the map doesn't grow
        // unbounded across long-running processes.
        map.retain(|_, ts| now.duration_since(*ts) < DEDUP_WINDOW);
        false
    }

    fn build_remember_failed_payload(
        &self,
        job_id: Option<&str>,
        owner: Option<&str>,
        namespace: Option<&str>,
        wallet_attempts: u32,
        max_attempts: u32,
        error_msg: &str,
    ) -> SlackMessage {
        let fallback_text = format!(
            "🔴 MemWal: remember job failed (all wallets exhausted) — {}",
            truncate(error_msg, 120)
        );

        let header = SlackBlock {
            block_type: "header".to_string(),
            text: Some(SlackText {
                text_type: "plain_text".to_string(),
                text: "🔴 MemWal — Remember Job Failed".to_string(),
            }),
            fields: None,
            elements: None,
        };

        let fields = SlackBlock {
            block_type: "section".to_string(),
            text: None,
            elements: None,
            fields: Some(vec![
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!("*Job ID:*\n`{}`", job_id.unwrap_or("-")),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!("*Namespace:*\n`{}`", namespace.unwrap_or("-")),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!("*Owner:*\n`{}`", owner.map(shorten_owner).unwrap_or_else(|| "-".to_string())),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!(
                        "*Wallet attempts:*\n{} / {} exhausted",
                        wallet_attempts, max_attempts
                    ),
                },
            ]),
        };

        let error_block = SlackBlock {
            block_type: "section".to_string(),
            elements: None,
            fields: None,
            text: Some(SlackText {
                text_type: "mrkdwn".to_string(),
                // Triple-backtick code fence renders Slack `code block`.
                // Truncate so a multi-paragraph traceback doesn't blow past
                // Slack's 3000-char per-text limit.
                text: format!("*Error:*\n```{}```", truncate(error_msg, 2400)),
            }),
        };

        let footer_text = match &self.server_commit {
            Some(sha) => format!("server commit `{}` · env `{}`", sha, self.env_label),
            None => format!("env `{}`", self.env_label),
        };
        let context = SlackBlock {
            block_type: "context".to_string(),
            text: None,
            fields: None,
            elements: Some(vec![SlackText {
                text_type: "mrkdwn".to_string(),
                text: footer_text,
            }]),
        };

        SlackMessage {
            text: fallback_text,
            blocks: Some(vec![header, fields, error_block, context]),
        }
    }

    async fn send_payload(&self, payload: &SlackMessage) -> SlackResult<()> {
        let response = self
            .http
            .post(&self.webhook_url)
            .json(payload)
            .send()
            .await
            .map_err(|e| -> SlackError { format!("Failed to POST Slack webhook: {}", e).into() })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            warn!(
                status = %status,
                body = %body,
                "Slack webhook returned non-success status"
            );
            return Err(format!("Slack webhook failed with status {}: {}", status, body).into());
        }

        info!("Slack notification delivered");
        Ok(())
    }
}

// ============================================================
// Helpers
// ============================================================

fn hash_error(msg: &str) -> String {
    let digest = Sha256::digest(msg.as_bytes());
    hex::encode(&digest[..8])
}

fn short_hash(msg: &str) -> String {
    hash_error(msg)
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let taken: String = s.chars().take(max_chars).collect();
    format!("{}…", taken)
}

fn shorten_owner(owner: &str) -> String {
    // 0x1234...abcd style display so on-call can identify accounts without
    // copy/pasting 66-character addresses out of Slack.
    let len = owner.len();
    if len <= 12 {
        return owner.to_string();
    }
    let head = &owner[..8];
    let tail = &owner[len.saturating_sub(4)..];
    format!("{}…{}", head, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_client() -> SlackClient {
        SlackClient::new(
            "https://hooks.slack.com/services/TEST".to_string(),
            "test".to_string(),
            Some("abcdef1".to_string()),
        )
    }

    #[test]
    fn dedup_suppresses_same_error_within_window() {
        let client = new_client();
        assert!(!client.should_suppress("Enoki API error: balance::split"));
        assert!(client.should_suppress("Enoki API error: balance::split"));
        assert!(client.should_suppress("Enoki API error: balance::split"));
    }

    #[test]
    fn dedup_lets_different_errors_through() {
        let client = new_client();
        assert!(!client.should_suppress("error one"));
        assert!(!client.should_suppress("error two"));
        assert!(!client.should_suppress("error three"));
    }

    #[test]
    fn shorten_owner_keeps_short_addresses_intact() {
        assert_eq!(shorten_owner("short"), "short");
        assert_eq!(shorten_owner("0xabcdef12"), "0xabcdef12");
    }

    #[test]
    fn shorten_owner_truncates_full_sui_address() {
        let address = "0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994";
        assert_eq!(shorten_owner(address), "0xe5c911…4994");
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdefghij", 5), "abcde…");
    }

    #[test]
    fn payload_includes_all_known_fields() {
        let client = new_client();
        let payload = client.build_remember_failed_payload(
            Some("job-123"),
            Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
            Some("default"),
            3,
            3,
            "balance::split MoveAbort",
        );

        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("Remember Job Failed"));
        assert!(json.contains("job-123"));
        assert!(json.contains("0xe5c911"));
        assert!(json.contains("3 / 3 exhausted"));
        assert!(json.contains("balance::split MoveAbort"));
        assert!(json.contains("env `test`"));
        assert!(json.contains("server commit `abcdef1`"));
    }

    #[test]
    fn payload_omits_commit_footer_when_absent() {
        let client = SlackClient::new(
            "https://hooks.slack.com/services/TEST".to_string(),
            "dev".to_string(),
            None,
        );
        let payload = client.build_remember_failed_payload(
            None, None, None, 0, 0, "boom",
        );
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("server commit"));
        assert!(json.contains("env `dev`"));
    }
}
