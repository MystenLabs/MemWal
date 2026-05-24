//! Slack notification client for terminal job failures.
//!
//! ENG-1784: push alerts to a Slack Incoming Webhook when a remember job
//! reaches a terminal failure state, so on-call sees the incident without
//! having to tail logs.
//!
//! Two failure shapes are surfaced today:
//!
//! 1. **Wallet retries exhausted** — the wallet pool tried every key in
//!    rotation up to `MAX_ATTEMPTS` and every attempt returned a
//!    permanent error (e.g. Enoki `balance::split` MoveAbort, Walrus 4xx,
//!    sidecar timeout reclassified as Permanent). This is the scenario
//!    Henry described in the ENG-1784 brief.
//! 2. **Post-upload handoff enqueue failure** — Walrus upload (and maybe
//!    on-chain transfer) succeeded, but the follow-up recovery / index
//!    job could not be enqueued because Apalis / Redis itself rejected
//!    the push. The wallet pool was not involved.
//!
//! Pattern mirrors `x-wallet/backend/src/clients/slack.rs`:
//!
//! * **Optional**: the client is constructed only when `SLACK_WEBHOOK_URL`
//!   is set. Absent → alerter is `None` → every notify call is a no-op.
//! * **Fire-and-forget**: callers spawn the notify future and ignore the
//!   result. A failed Slack POST must never fail the wallet job.
//! * **Multi-layer rate control**:
//!     - 5-minute in-memory dedup by SHA-256 of the error message →
//!       protects against a single fan-out incident (one upstream
//!       failure mode replicated across many jobs).
//!     - Sliding 60-second window global cap of 30 messages →
//!       protects against diverse-error storms that bypass dedup.
//!     - Single retry on Slack 429 / 5xx, then drop with a tracing
//!       warning so we don't infinite-loop on a Slack-side outage.

use std::collections::{HashMap, VecDeque};
use std::error::Error as StdError;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Boxed error for fire-and-forget callers; the alerter never has a typed
/// error worth matching on — every failure path just gets logged.
pub type SlackError = Box<dyn StdError + Send + Sync + 'static>;
pub type SlackResult<T> = std::result::Result<T, SlackError>;

/// Identical errors arriving inside this window are suppressed. Enoki and
/// sidecar incidents typically produce the same message on every retry;
/// without this, a 30-minute incident posts hundreds of near-identical
/// messages.
const DEDUP_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Sliding-window global cap. Even with dedup, a single relayer-wide
/// failure can produce a diverse error storm (different request IDs,
/// timestamps, blob IDs) that defeats per-error dedup. This cap protects
/// the channel from outright flooding.
const GLOBAL_RATE_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_RATE_MAX: usize = 30;

/// HTTP timeout for the webhook POST. Slack normally responds in well
/// under a second; anything beyond a few seconds is almost certainly an
/// upstream outage. Capping the timeout prevents long-running tasks
/// accumulating during a Slack-side incident.
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// Retry delay when Slack returns 429 / 5xx. Single retry only — if the
/// retry also fails we drop the alert; the wallet job's terminal status
/// is already persisted in `remember_jobs`, so on-call can still find
/// the failure via the DB.
const RETRY_DELAY: Duration = Duration::from_millis(750);

/// Why this remember job is in a terminal failed state. Pick the variant
/// that matches your code path so the Slack message wording is accurate.
#[derive(Debug, Clone, Copy)]
pub enum FailureKind {
    /// The wallet pool rotated through every key it had and every attempt
    /// returned a permanent error. This is the "Enoki down across all
    /// wallets" scenario from the ENG-1784 brief.
    WalletRetriesExhausted {
        /// Configured maximum attempts (e.g. `MAX_ATTEMPTS = 3`). The
        /// alert reads `{attempts}/{attempts} exhausted` because the
        /// only way we land in this branch is by burning all of them.
        attempts: u32,
    },
    /// Upload succeeded but the follow-up workflow couldn't be enqueued
    /// because the job queue (Apalis / Redis) rejected the push. The
    /// wallet pool itself was healthy — the queue layer wasn't.
    HandoffEnqueueFailure,
}

impl FailureKind {
    fn label(&self) -> String {
        match self {
            FailureKind::WalletRetriesExhausted { attempts } => {
                format!("{} / {} wallet retries exhausted", attempts, attempts)
            }
            FailureKind::HandoffEnqueueFailure => {
                "post-upload handoff enqueue failed (job queue infra)".to_string()
            }
        }
    }

    fn headline(&self) -> &'static str {
        match self {
            FailureKind::WalletRetriesExhausted { .. } => {
                "🔴 MemWal — Remember Job Failed (wallet retries exhausted)"
            }
            FailureKind::HandoffEnqueueFailure => {
                "🔴 MemWal — Remember Job Failed (queue handoff)"
            }
        }
    }
}

/// All inputs to a single Slack alert. Grouping into a struct keeps the
/// call sites readable as we add fields (e.g. blob_id, attempt count).
pub struct RememberJobFailedAlert<'a> {
    pub job_id: Option<&'a str>,
    pub owner: Option<&'a str>,
    pub namespace: Option<&'a str>,
    pub error_msg: &'a str,
    pub kind: FailureKind,
}

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

/// Inner state guarded by a single sync mutex. We hold the lock only
/// across in-memory map / queue operations (no `.await` inside the lock
/// scope), so `std::sync::Mutex` is correct here and avoids the
/// `tokio::sync::Mutex` await-friendly version.
struct RateState {
    /// `error_signature → last_sent_at`.
    dedup: HashMap<String, Instant>,
    /// Sliding-window timestamps of sends in the last `GLOBAL_RATE_WINDOW`.
    /// `VecDeque` so we can pop expired entries in O(1) per stale element.
    recent_sends: VecDeque<Instant>,
}

#[derive(Clone)]
pub struct SlackClient {
    http: Client,
    webhook_url: String,
    state: std::sync::Arc<Mutex<RateState>>,
    /// Identifies the running relayer in the alert footer
    /// (e.g. `prod` / `staging` / `dev` from `MEMWAL_ENV`).
    env_label: String,
    /// Optional short git SHA for the footer.
    server_commit: Option<String>,
}

impl SlackClient {
    pub fn new(webhook_url: String, env_label: String, server_commit: Option<String>) -> Self {
        let http = Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            // `Client::builder()` only fails if the system has no working
            // TLS backend — at which point the rest of the relayer is
            // dead anyway, so a panic here is safe and surfaces it loudly.
            .expect("reqwest client should build (TLS backend required)");
        Self {
            http,
            webhook_url,
            state: std::sync::Arc::new(Mutex::new(RateState {
                dedup: HashMap::new(),
                recent_sends: VecDeque::new(),
            })),
            env_label,
            server_commit,
        }
    }

    /// Notify Slack that a remember job has terminally failed. The Slack
    /// POST is rate-limited by error-signature dedup AND by a global
    /// 60-second cap; suppressed alerts return `Ok(())` so fire-and-forget
    /// callers don't log a false "Slack failed" warning.
    pub async fn notify_remember_job_failed(
        &self,
        alert: RememberJobFailedAlert<'_>,
    ) -> SlackResult<()> {
        let sanitized = sanitize_for_slack(alert.error_msg);

        if self.should_suppress(&sanitized) {
            info!(
                error_signature = %short_hash(&sanitized),
                "Slack alert suppressed (dedup or global rate cap)"
            );
            return Ok(());
        }

        let payload = self.build_payload(&alert, &sanitized);
        self.send_with_retry(&payload).await
    }

    /// Send a simple text notification. Retained for unit tests and any
    /// one-off operator-driven message; production paths should use the
    /// typed helpers so the format stays consistent across alerts.
    #[allow(dead_code)]
    pub async fn send_notification(&self, text: &str) -> SlackResult<()> {
        self.send_with_retry(&SlackMessage {
            text: text.to_string(),
            blocks: None,
        })
        .await
    }

    /// Returns `true` if this signature has been alerted within
    /// `DEDUP_WINDOW`, OR if the global rate cap is exhausted. Both
    /// checks happen under one lock so a burst can't slip past both.
    fn should_suppress(&self, sanitized_error_msg: &str) -> bool {
        let key = hash_error(sanitized_error_msg);
        let now = Instant::now();

        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            // Poisoned mutex: prefer to send the alert than swallow it.
            Err(poisoned) => poisoned.into_inner(),
        };

        // GC expired dedup keys to bound map size.
        state
            .dedup
            .retain(|_, ts| now.duration_since(*ts) < DEDUP_WINDOW);
        // GC expired global-window timestamps.
        while state
            .recent_sends
            .front()
            .is_some_and(|t| now.duration_since(*t) >= GLOBAL_RATE_WINDOW)
        {
            state.recent_sends.pop_front();
        }

        // Per-error dedup: if we already alerted on this signature within
        // the window, suppress regardless of global budget.
        if let Some(last) = state.dedup.get(&key) {
            if now.duration_since(*last) < DEDUP_WINDOW {
                return true;
            }
        }

        // Global cap: if we've already sent `GLOBAL_RATE_MAX` in the last
        // window, drop this one too (caller will see Ok and the failure
        // is still in the DB).
        if state.recent_sends.len() >= GLOBAL_RATE_MAX {
            warn!(
                cap = GLOBAL_RATE_MAX,
                window_secs = GLOBAL_RATE_WINDOW.as_secs(),
                "Slack global rate cap reached — dropping alert"
            );
            return true;
        }

        // Record the send intent. We do this under the same lock so two
        // simultaneous callers can't both see "below cap" and both send,
        // exceeding the cap by one or two messages.
        state.dedup.insert(key, now);
        state.recent_sends.push_back(now);
        false
    }

    fn build_payload(
        &self,
        alert: &RememberJobFailedAlert<'_>,
        sanitized_error: &str,
    ) -> SlackMessage {
        let fallback_text = format!(
            "🔴 MemWal: remember job failed — {}",
            truncate(sanitized_error, 120)
        );

        let header = SlackBlock {
            block_type: "header".to_string(),
            text: Some(SlackText {
                text_type: "plain_text".to_string(),
                text: alert.kind.headline().to_string(),
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
                    text: format!("*Job ID:*\n`{}`", alert.job_id.unwrap_or("-")),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!("*Namespace:*\n`{}`", alert.namespace.unwrap_or("-")),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!(
                        "*Owner:*\n`{}`",
                        alert
                            .owner
                            .map(shorten_owner)
                            .unwrap_or_else(|| "-".to_string())
                    ),
                },
                SlackText {
                    text_type: "mrkdwn".to_string(),
                    text: format!("*Failure mode:*\n{}", alert.kind.label()),
                },
            ]),
        };

        let error_block = SlackBlock {
            block_type: "section".to_string(),
            elements: None,
            fields: None,
            text: Some(SlackText {
                text_type: "mrkdwn".to_string(),
                // Triple-backtick fence + truncation to stay under
                // Slack's 3000-char per-text limit even after multiline
                // tracebacks.
                text: format!("*Error:*\n```{}```", truncate(sanitized_error, 2400)),
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

    async fn send_with_retry(&self, payload: &SlackMessage) -> SlackResult<()> {
        match self.send_once(payload).await {
            Ok(()) => Ok(()),
            Err(SendError::Transient { status, body }) => {
                warn!(
                    status = %status,
                    "Slack webhook returned transient error — retrying once after {}ms",
                    RETRY_DELAY.as_millis()
                );
                tokio::time::sleep(RETRY_DELAY).await;
                match self.send_once(payload).await {
                    Ok(()) => Ok(()),
                    Err(retry_err) => Err(format!(
                        "Slack send failed twice: first={} {}, retry={}",
                        status, body, retry_err
                    )
                    .into()),
                }
            }
            Err(SendError::Permanent(msg)) => Err(msg.into()),
        }
    }

    async fn send_once(&self, payload: &SlackMessage) -> std::result::Result<(), SendError> {
        let response = self
            .http
            .post(&self.webhook_url)
            .json(payload)
            .send()
            .await
            .map_err(|e| SendError::Permanent(format!("HTTP send failed: {}", e)))?;

        let status = response.status();
        if status.is_success() {
            info!("Slack notification delivered");
            return Ok(());
        }

        let body = response.text().await.unwrap_or_default();
        if is_retryable(status) {
            Err(SendError::Transient { status, body })
        } else {
            Err(SendError::Permanent(format!(
                "Slack webhook failed with status {}: {}",
                status, body
            )))
        }
    }
}

enum SendError {
    /// Slack returned a status that indicates a temporary issue
    /// (429 rate-limited or 5xx upstream). One retry is worth attempting.
    Transient { status: StatusCode, body: String },
    /// Slack rejected the request for a reason that won't get better on
    /// retry (4xx other than 429, or a transport error).
    Permanent(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Transient { status, body } => write!(f, "transient {}: {}", status, body),
            SendError::Permanent(msg) => write!(f, "permanent: {}", msg),
        }
    }
}

fn is_retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
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

/// Truncate by char count (not byte), appending an ellipsis when over.
/// Char-based slicing keeps multi-byte UTF-8 (emoji in error messages,
/// non-ASCII namespace names) from panicking.
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let taken: String = s.chars().take(max_chars).collect();
    format!("{}…", taken)
}

/// Display a Sui address as `0x12345678…abcd` so on-call can identify
/// accounts without copy/pasting 66-character strings. Uses char-based
/// slicing instead of byte slicing so non-ASCII strings (shouldn't occur
/// for Sui addresses but defense-in-depth) don't panic.
fn shorten_owner(owner: &str) -> String {
    let char_count = owner.chars().count();
    if char_count <= 12 {
        return owner.to_string();
    }
    let head: String = owner.chars().take(8).collect();
    let tail: String = owner.chars().skip(char_count - 4).collect();
    format!("{}…{}", head, tail)
}

/// Strip embedded credentials from a message before we post it to a
/// shared Slack channel.
///
/// Concrete vectors this catches:
///
/// * Connection URLs in error display impls:
///   `redis://memwal:hunter2@host:6379` → `redis://***@host:6379`
/// * Postgres connection errors:
///   `postgresql://app:s3cret@db.host:5432/memwal` → `postgresql://***@db.host:5432/memwal`
///
/// Best-effort only. We never want to add complex regex / parsing that
/// could itself fail; if the upstream error format changes and starts
/// leaking secrets in a different shape, that's a separate ticket.
fn sanitize_for_slack(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut cursor = 0;
    let bytes = msg.as_bytes();
    while cursor < bytes.len() {
        // Look for a scheme-separator `://` starting at `cursor`.
        if let Some(scheme_end) = find_subsequence(&bytes[cursor..], b"://") {
            let absolute_scheme_end = cursor + scheme_end + 3;
            // Look for `@` between scheme end and the next whitespace/end.
            let tail = &bytes[absolute_scheme_end..];
            let scan_limit = tail
                .iter()
                .position(|b| matches!(*b, b' ' | b'\t' | b'\n' | b'\r' | b'/' | b'?' | b'#'))
                .unwrap_or(tail.len());
            if let Some(at_pos) = tail[..scan_limit].iter().position(|b| *b == b'@') {
                // Found `scheme://user:pass@`. Append the scheme prefix,
                // then `***@`, then continue past the `@`.
                out.push_str(&msg[cursor..absolute_scheme_end]);
                out.push_str("***@");
                cursor = absolute_scheme_end + at_pos + 1;
                continue;
            }
        }

        // No more credential patterns; flush the rest.
        out.push_str(&msg[cursor..]);
        break;
    }
    out
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Validate `SLACK_WEBHOOK_URL` looks like a Slack incoming webhook so a
/// typo at deploy time fails fast (visible in startup logs) instead of at
/// first failure event (silent when nobody's looking).
pub fn looks_like_slack_webhook(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("https://hooks.slack.com/services/")
        // Reasonable lower bound on the path-after-services length so we
        // catch `https://hooks.slack.com/services/` alone as invalid.
        && trimmed.len() > "https://hooks.slack.com/services/".len() + 5
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_client() -> SlackClient {
        SlackClient::new(
            "https://hooks.slack.com/services/TEST/CHANNEL/TOKEN".to_string(),
            "test".to_string(),
            Some("abcdef1".to_string()),
        )
    }

    // ============================================================
    // Dedup + global rate cap
    // ============================================================

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
    fn global_rate_cap_stops_diverse_error_storm() {
        let client = new_client();
        // 30 distinct errors all go through (under the cap of 30).
        for i in 0..GLOBAL_RATE_MAX {
            assert!(
                !client.should_suppress(&format!("error storm #{}", i)),
                "burst entry #{} should not be suppressed",
                i
            );
        }
        // The 31st distinct error is suppressed by the global cap.
        assert!(
            client.should_suppress("error storm #31 (over cap)"),
            "31st distinct error in the burst should be suppressed"
        );
    }

    // ============================================================
    // Owner / truncation safety
    // ============================================================

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
    fn shorten_owner_does_not_panic_on_multibyte_chars() {
        // Three-byte UTF-8 chars (Japanese characters). If we sliced
        // by bytes this would panic at a non-char-boundary; char-based
        // slicing handles it safely.
        let exotic = "メメメメメメメメメメメメメメメメ";
        let result = shorten_owner(exotic);
        // Should produce `<first 8 chars>…<last 4 chars>` without panic.
        assert!(result.contains('…'));
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdefghij", 5), "abcde…");
    }

    #[test]
    fn truncate_does_not_split_multibyte_chars() {
        // 5 four-byte emoji chars + cap of 3.
        let s = "🦀🦀🦀🦀🦀";
        assert_eq!(truncate(s, 3), "🦀🦀🦀…");
    }

    // ============================================================
    // Credential sanitization
    // ============================================================

    #[test]
    fn sanitize_strips_basic_auth_in_redis_url() {
        let leak = "failed: cannot connect to redis://memwal:hunter2@127.0.0.1:6379 — io error";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("hunter2"), "password must be stripped");
        assert!(!cleaned.contains("memwal:"), "username must be stripped");
        assert!(cleaned.contains("redis://***@127.0.0.1:6379"));
        assert!(cleaned.contains("io error"), "non-credential text preserved");
    }

    #[test]
    fn sanitize_strips_basic_auth_in_postgres_url() {
        let leak = "Database(sqlx error) at postgresql://app:s3cret@db.host:5432/memwal";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("s3cret"));
        assert!(!cleaned.contains("app:"));
        assert!(cleaned.contains("postgresql://***@db.host:5432/memwal"));
    }

    #[test]
    fn sanitize_strips_multiple_credentials() {
        let leak = "primary redis://a:b@h1:6379 secondary postgresql://x:y@h2:5432/db down";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("a:b"));
        assert!(!cleaned.contains("x:y"));
        assert_eq!(cleaned.matches("***@").count(), 2);
    }

    #[test]
    fn sanitize_is_noop_for_clean_messages() {
        let clean = "Enoki API error: balance::split MoveAbort at module 0x2::balance";
        assert_eq!(sanitize_for_slack(clean), clean);
    }

    #[test]
    fn sanitize_skips_url_with_no_credentials() {
        let no_creds = "fetched https://hooks.slack.com/services/T0/B0/TOKEN successfully";
        assert_eq!(sanitize_for_slack(no_creds), no_creds);
    }

    // ============================================================
    // URL validation
    // ============================================================

    #[test]
    fn looks_like_slack_webhook_accepts_valid_urls() {
        assert!(looks_like_slack_webhook(
            "https://hooks.slack.com/services/T012/B345/abcdef"
        ));
        assert!(looks_like_slack_webhook(
            " https://hooks.slack.com/services/T012/B345/abcdef "
        ));
    }

    #[test]
    fn looks_like_slack_webhook_rejects_bogus_urls() {
        assert!(!looks_like_slack_webhook("not a url"));
        assert!(!looks_like_slack_webhook("https://example.com/whatever"));
        assert!(!looks_like_slack_webhook("http://hooks.slack.com/services/x"));
        assert!(!looks_like_slack_webhook("https://hooks.slack.com/services/"));
        assert!(!looks_like_slack_webhook("https://hooks.slack.com/services/x"));
    }

    // ============================================================
    // Payload shape
    // ============================================================

    fn alert<'a>(kind: FailureKind, error_msg: &'a str) -> RememberJobFailedAlert<'a> {
        RememberJobFailedAlert {
            job_id: Some("job-123"),
            owner: Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
            namespace: Some("default"),
            error_msg,
            kind,
        }
    }

    #[test]
    fn payload_for_wallet_retry_exhaustion_includes_attempt_count() {
        let client = new_client();
        let a = alert(
            FailureKind::WalletRetriesExhausted { attempts: 3 },
            "balance::split MoveAbort",
        );
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();

        assert!(json.contains("wallet retries exhausted"));
        assert!(json.contains("3 / 3"));
        assert!(json.contains("job-123"));
        assert!(json.contains("0xe5c911"));
        assert!(json.contains("balance::split MoveAbort"));
        assert!(json.contains("env `test`"));
        assert!(json.contains("server commit `abcdef1`"));
    }

    #[test]
    fn payload_for_handoff_uses_distinct_headline() {
        let client = new_client();
        let a = alert(FailureKind::HandoffEnqueueFailure, "queue down");
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();

        // Distinct headline so on-call can tell the two scenarios apart.
        assert!(json.contains("queue handoff"));
        assert!(!json.contains("wallet retries exhausted"));
        assert!(json.contains("post-upload handoff enqueue failed"));
    }

    #[test]
    fn payload_omits_commit_footer_when_absent() {
        let client = SlackClient::new(
            "https://hooks.slack.com/services/TEST/CHANNEL/TOKEN".to_string(),
            "dev".to_string(),
            None,
        );
        let a = alert(FailureKind::HandoffEnqueueFailure, "boom");
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("server commit"));
        assert!(json.contains("env `dev`"));
    }

    #[test]
    fn payload_sanitizes_credentials_in_error() {
        let client = new_client();
        let a = alert(
            FailureKind::HandoffEnqueueFailure,
            "cannot connect to redis://app:hunter2@host:6379",
        );
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();
        assert!(!json.contains("hunter2"));
        assert!(json.contains("redis://***@host:6379"));
    }

    // ============================================================
    // Retry classification
    // ============================================================

    #[test]
    fn retryable_statuses_cover_429_and_5xx() {
        assert!(is_retryable(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable(StatusCode::BAD_GATEWAY));
        assert!(is_retryable(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_retryable(StatusCode::GATEWAY_TIMEOUT));
    }

    #[test]
    fn non_retryable_4xx_does_not_trigger_retry() {
        assert!(!is_retryable(StatusCode::BAD_REQUEST));
        assert!(!is_retryable(StatusCode::FORBIDDEN));
        assert!(!is_retryable(StatusCode::NOT_FOUND));
    }
}
