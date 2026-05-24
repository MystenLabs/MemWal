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

use regex::Regex;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
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
    /// The wallet retry budget (Apalis `MAX_ATTEMPTS`) was burned and
    /// every attempt — each running on a fresh `key_pool.next_index()`
    /// wallet — returned a permanent error. Note the wording: this
    /// means the *retry budget* was exhausted, NOT necessarily every
    /// wallet in the pool (the pool can have more wallets than the
    /// retry count). Typical cause: Enoki API error across multiple
    /// wallets, Walrus 4xx persistent, sidecar permanent rejection.
    TerminalWalletFailure {
        /// `MAX_ATTEMPTS` from the apalis worker config. The alert
        /// surfaces this as "permanent failure after N retry attempts"
        /// so on-call knows exactly how much we tried before giving up.
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
            FailureKind::TerminalWalletFailure { attempts } => {
                format!("permanent wallet failure after {} retry attempts", attempts)
            }
            FailureKind::HandoffEnqueueFailure => {
                "post-upload handoff enqueue failed (job queue infra)".to_string()
            }
        }
    }

    fn headline(&self) -> &'static str {
        match self {
            FailureKind::TerminalWalletFailure { .. } => {
                "🔴 MemWal — Remember Job Failed (terminal wallet failure)"
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

/// Compiled once at first sanitize call. `LazyLock` over `OnceLock` so
/// callers don't have to plumb the result through an `Option` everywhere.
///
/// Each pattern targets a known leak vector:
///
/// * `URL_BASIC_AUTH` — `scheme://user:pass@host` → `scheme://***@host`.
///   Catches Redis / Postgres / HTTP connection errors that print the
///   full URL with embedded credentials.
/// * `BEARER` — `Bearer <token>` (case-insensitive) → `Bearer ***`.
///   Catches OAuth / API authorization header echoes.
/// * `KV_SECRET` — `keyword[=:]<value>` (case-insensitive) for the
///   keywords below → `keyword=***`. Catches JSON-like or query-string
///   echoes such as `api_key=sk-...`, `"password": "..."`, etc.
static URL_BASIC_AUTH: LazyLock<Regex> = LazyLock::new(|| {
    // `\w+://` scheme, then any chars up to the first `@` that is NOT
    // preceded by another `://` (so we don't accidentally chew across
    // multiple URLs in one message).
    Regex::new(r"(\w+://)[^/@\s]+@").expect("URL_BASIC_AUTH regex must compile")
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    // `Bearer` (case-insensitive) followed by 1+ space then a non-space
    // token. The token may contain `.` `-` `_` (typical JWT charset).
    Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]+")
        .expect("BEARER regex must compile")
});
static KV_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    // Match `<keyword>[=:]<value>` for any secret-bearing keyword,
    // handling four common shapes:
    //
    //   token=abc          (bare KV)
    //   token: abc         (colon separator with whitespace)
    //   "token": "abc"     (JSON object — keyword AND value quoted)
    //   "api-key": abc     (JSON object — keyword quoted, value bare)
    //
    // `"?\b ... \b"?` lets the keyword carry optional quote marks; the
    // value uses the same trick so a quoted value's closing quote is
    // consumed by the match (and therefore replaced) instead of being
    // left dangling next to the redaction.
    Regex::new(
        r#"(?i)"?\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b"?\s*[=:]\s*"?([^\s",}\)]+)"?"#,
    )
    .expect("KV_SECRET regex must compile")
});

/// Strip embedded credentials from a message before we post it to a
/// shared Slack channel. Best-effort — if upstream error format changes
/// and leaks a secret in a new shape, that's a separate ticket; this
/// covers the patterns we've actually seen in practice.
fn sanitize_for_slack(msg: &str) -> String {
    // Order matters: URL_BASIC_AUTH first so we don't accidentally
    // re-treat the redacted `***@host` as a KV match. Then Bearer
    // (more specific than the generic KV regex), then the catch-all KV.
    let step1 = URL_BASIC_AUTH.replace_all(msg, "${1}***@");
    let step2 = BEARER.replace_all(&step1, "Bearer ***");
    let step3 = KV_SECRET.replace_all(&step2, "${1}=***");
    step3.into_owned()
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

    // Reviewer requirement #5: extend sanitizer to cover common token
    // patterns beyond URL basic-auth.

    #[test]
    fn sanitize_strips_bearer_tokens() {
        let leak = "request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(cleaned.contains("Bearer ***"));
    }

    #[test]
    fn sanitize_strips_bearer_case_insensitive() {
        let leak = "bearer my-token-here failed";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("my-token-here"));
        assert!(cleaned.to_lowercase().contains("bearer ***"));
    }

    #[test]
    fn sanitize_strips_api_key_kv() {
        let leak = "openai 401: api_key=sk-proj-1234567890abcdef invalid";
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("sk-proj-1234567890abcdef"));
        assert!(cleaned.contains("api_key=***"));
    }

    #[test]
    fn sanitize_strips_token_password_secret_kv() {
        let leak = "config: token=abc123 password=hunter2 secret=mysecret access_token=xyz";
        let cleaned = sanitize_for_slack(leak);
        for forbidden in ["abc123", "hunter2", "mysecret", "xyz"] {
            assert!(!cleaned.contains(forbidden), "{} not stripped: {}", forbidden, cleaned);
        }
        assert!(cleaned.contains("token=***"));
        assert!(cleaned.contains("password=***"));
        assert!(cleaned.contains("secret=***"));
        assert!(cleaned.contains("access_token=***"));
    }

    #[test]
    fn sanitize_strips_kv_with_colon_separator() {
        let leak = r#"{"api_key": "sk-1234", "password": "hunter2"}"#;
        let cleaned = sanitize_for_slack(leak);
        assert!(!cleaned.contains("sk-1234"));
        assert!(!cleaned.contains("hunter2"));
        assert!(cleaned.contains("api_key=***"));
        assert!(cleaned.contains("password=***"));
    }

    #[test]
    fn sanitize_strips_apikey_camel_and_kebab_variants() {
        let leak = "headers: apiKey=AAA, api-key=BBB, accessToken=CCC, client_secret=DDD";
        let cleaned = sanitize_for_slack(leak);
        for forbidden in ["AAA", "BBB", "CCC", "DDD"] {
            assert!(!cleaned.contains(forbidden));
        }
    }

    #[test]
    fn sanitize_leaves_non_secret_kv_pairs_alone() {
        // Keywords that should NOT trigger redaction.
        let safe = "count=42 namespace=default endpoint=https://relayer/api";
        let cleaned = sanitize_for_slack(safe);
        assert_eq!(cleaned, safe);
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
    fn payload_for_terminal_wallet_failure_includes_attempt_count() {
        let client = new_client();
        let a = alert(
            FailureKind::TerminalWalletFailure { attempts: 3 },
            "balance::split MoveAbort",
        );
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();

        assert!(json.contains("terminal wallet failure"));
        assert!(json.contains("permanent wallet failure after 3 retry attempts"));
        assert!(json.contains("job-123"));
        assert!(json.contains("0xe5c911"));
        assert!(json.contains("balance::split MoveAbort"));
        assert!(json.contains("env `test`"));
        assert!(json.contains("server commit `abcdef1`"));
    }

    /// Reviewer requirement #4: the alert text must not claim "all
    /// wallets exhausted" or similar misleading wording when only the
    /// retry budget was burned. The wallet pool may contain more
    /// wallets than `MAX_ATTEMPTS`; we don't try them all.
    #[test]
    fn payload_for_terminal_wallet_failure_does_not_claim_all_wallets_exhausted() {
        let client = new_client();
        let a = alert(
            FailureKind::TerminalWalletFailure { attempts: 3 },
            "any error",
        );
        let sanitized = sanitize_for_slack(a.error_msg);
        let payload = client.build_payload(&a, &sanitized);
        let json = serde_json::to_string(&payload).unwrap();

        // Forbidden phrases the first cut accidentally used.
        for forbidden in [
            "all wallets exhausted",
            "wallet pool exhausted",
            "every wallet",
            "wallet retries exhausted", // the old wording — must be gone
        ] {
            assert!(
                !json.contains(forbidden),
                "alert text must not contain {:?}: {}",
                forbidden,
                json
            );
        }
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
        assert!(!json.contains("terminal wallet failure"));
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

    // ============================================================
    // Reviewer requirement #8 — actual retry loop exercised against
    // a mock server, not just classification helpers. Covers:
    //   - 429 then 200 → 1 retry, success, exactly 2 hits
    //   - 503 then 200 → 1 retry, success, exactly 2 hits
    //   - 400 → no retry, Err, exactly 1 hit
    //   - 500 then 500 → 1 retry, give up Err, exactly 2 hits
    // ============================================================

    /// Spawn an axum mock that pops a status code per request from a
    /// shared queue. Records every request body for inspection. Returns
    /// the URL + body recorder + a hit counter.
    async fn spawn_mock_with_status_sequence(
        statuses: Vec<u16>,
    ) -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use axum::http::StatusCode as AxStatus;
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let queue = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
            statuses,
        )));
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let received_for_handler = received.clone();
        let queue_for_handler = queue.clone();
        let hits_for_handler = hits.clone();

        let app = axum::Router::new().route(
            "/webhook",
            axum::routing::post(
                move |axum::Json(body): axum::Json<serde_json::Value>| {
                    let received = received_for_handler.clone();
                    let queue = queue_for_handler.clone();
                    let hits = hits_for_handler.clone();
                    async move {
                        hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        received.lock().unwrap().push(body);
                        let next = queue.lock().unwrap().pop_front().unwrap_or(200);
                        let status = AxStatus::from_u16(next).unwrap_or(AxStatus::OK);
                        (status, "mock-response-body")
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (format!("http://{}/webhook", addr), received, hits)
    }

    fn client_for_mock(url: String) -> SlackClient {
        SlackClient::new(url, "test".to_string(), Some("sha".to_string()))
    }

    #[tokio::test]
    async fn retry_recovers_when_first_call_is_429() {
        let (url, _body, hits) = spawn_mock_with_status_sequence(vec![429, 200]).await;
        let client = client_for_mock(url);
        client
            .send_notification("429-then-200 path")
            .await
            .expect("retry should recover from 429");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_recovers_when_first_call_is_503() {
        let (url, _body, hits) = spawn_mock_with_status_sequence(vec![503, 200]).await;
        let client = client_for_mock(url);
        client
            .send_notification("503-then-200 path")
            .await
            .expect("retry should recover from 5xx");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn no_retry_on_400() {
        let (url, _body, hits) = spawn_mock_with_status_sequence(vec![400, 200]).await;
        let client = client_for_mock(url);
        let err = client
            .send_notification("400 should fail fast")
            .await
            .expect_err("400 must surface as Err without retry");
        // Single hit means we did NOT retry the 400.
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(err.to_string().contains("400"));
    }

    #[tokio::test]
    async fn retry_gives_up_after_second_5xx() {
        let (url, _body, hits) = spawn_mock_with_status_sequence(vec![500, 500]).await;
        let client = client_for_mock(url);
        let err = client
            .send_notification("500-then-500 path")
            .await
            .expect_err("two consecutive 5xx must surface as Err");
        // Exactly two hits — original + one retry, then we stop.
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(err.to_string().contains("twice"));
    }

    /// Reviewer requirement #4 / #8 combined: a 200 succeeds on first
    /// try, no retry.
    #[tokio::test]
    async fn success_does_not_trigger_retry() {
        let (url, _body, hits) = spawn_mock_with_status_sequence(vec![200]).await;
        let client = client_for_mock(url);
        client
            .send_notification("clean 200")
            .await
            .expect("clean 200 must succeed");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    // ============================================================
    // Live demo — pings a real Slack webhook so a human can eyeball
    // every scenario the alerter has to handle. `#[ignore]` so CI
    // never runs it. Run on-demand with:
    //
    //   SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
    //     cargo test slack::tests::live_demo_walks_every_alert_scenario \
    //     --bin memwal-server -- --ignored --nocapture
    //
    // The test pauses between scenarios so the channel reads in order
    // and a reviewer can match each Slack message to the scenario name
    // logged in the run output.
    // ============================================================

    fn make_live_client(env_label: &str) -> Option<SlackClient> {
        let url = std::env::var("SLACK_WEBHOOK_URL").ok()?;
        let trimmed = url.trim().to_string();
        if !looks_like_slack_webhook(&trimmed) {
            return None;
        }
        Some(SlackClient::new(
            trimmed,
            format!("live-test-{}", env_label),
            Some("eng1784".to_string()),
        ))
    }

    async fn pause(label: &str, secs: u64) {
        println!("  ⏳ pausing {}s before next scenario ({})", secs, label);
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "live test — hits real Slack; run with --ignored"]
    async fn live_demo_walks_every_alert_scenario() {
        let _ = tracing_subscriber::fmt::try_init();
        println!("\n🚀 ENG-1784 Slack alerter live demo");

        // ── Scenario 1: TerminalWalletFailure with realistic Enoki error ──
        println!("\n[1/6] TerminalWalletFailure — Enoki balance::split MoveAbort");
        let client = make_live_client("scenario-1-walret").expect(
            "SLACK_WEBHOOK_URL must be set + valid for this test (see test docstring)",
        );
        client
            .notify_remember_job_failed(RememberJobFailedAlert {
                job_id: Some("live-demo-job-001"),
                owner: Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
                namespace: Some("live-test"),
                error_msg: "walrus upload failed: Internal Error: walrus upload failed: \
                    Enoki API error (400): {\"errors\":[{\"code\":\"dry_run_failed\",\
                    \"message\":\"Dry run failed, could not automatically determine a \
                    budget: MoveAbort(MoveLocation { module: 0x2::balance, function: 7, \
                    instruction: 10, function_name: split }, 2) in command 4\"}]}",
                kind: FailureKind::TerminalWalletFailure { attempts: 3 },
            })
            .await
            .expect("scenario 1 should deliver");
        pause("scenario 2", 3).await;

        // ── Scenario 2: HandoffEnqueueFailure (distinct headline) ──
        println!("\n[2/6] HandoffEnqueueFailure — queue layer down after upload succeeded");
        let client = make_live_client("scenario-2-handoff").unwrap();
        client
            .notify_remember_job_failed(RememberJobFailedAlert {
                job_id: Some("live-demo-job-002"),
                owner: Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
                namespace: Some("live-test"),
                error_msg: "failed to enqueue metadata/transfer recovery job: \
                    apalis-postgres push failed: db connection terminated",
                kind: FailureKind::HandoffEnqueueFailure,
            })
            .await
            .expect("scenario 2 should deliver");
        pause("scenario 3", 3).await;

        // ── Scenario 3: dedup ──
        // Same SlackClient, same error twice. Second call should be
        // suppressed (returns Ok with no Slack POST). Channel should
        // see exactly ONE message.
        println!("\n[3/6] Dedup — send same error twice on same client; channel should see ONE");
        let client = make_live_client("scenario-3-dedup").unwrap();
        let dup_alert = || RememberJobFailedAlert {
            job_id: Some("live-demo-job-003"),
            owner: Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
            namespace: Some("live-test"),
            error_msg: "DEDUP TEST: identical error message repeated within 5min window",
            kind: FailureKind::TerminalWalletFailure { attempts: 3 },
        };
        client.notify_remember_job_failed(dup_alert()).await.unwrap();
        println!("    → first send (should appear in Slack)");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        client.notify_remember_job_failed(dup_alert()).await.unwrap();
        println!("    → second send (should be suppressed by dedup, NO Slack message)");
        pause("scenario 4", 3).await;

        // ── Scenario 4: credential sanitization ──
        // Slack message must show `redis://***@host` not the plaintext
        // username/password.
        println!("\n[4/6] Sanitization — error string contains redis://user:pass@host");
        let client = make_live_client("scenario-4-sanitize").unwrap();
        client
            .notify_remember_job_failed(RememberJobFailedAlert {
                job_id: Some("live-demo-job-004"),
                owner: Some("0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994"),
                namespace: Some("live-test"),
                error_msg: "SANITIZE TEST: failed to enqueue: cannot connect to \
                    redis://memwal:hunter2@127.0.0.1:6379 — io error \
                    (secondary postgresql://app:s3cret@db.host:5432/memwal also down)",
                kind: FailureKind::HandoffEnqueueFailure,
            })
            .await
            .expect("scenario 4 should deliver");
        println!("    → Slack should show `redis://***@127.0.0.1:6379` and `postgresql://***@db.host...`");
        pause("scenario 5", 3).await;

        // ── Scenario 5: multi-byte UTF-8 in owner + error ──
        // Defense-in-depth: shorten_owner + truncate use char-based
        // slicing, so non-ASCII can't panic the spawn future.
        println!("\n[5/6] Multi-byte UTF-8 — Japanese chars in owner & error message");
        let client = make_live_client("scenario-5-utf8").unwrap();
        client
            .notify_remember_job_failed(RememberJobFailedAlert {
                job_id: Some("live-demo-job-005-メメメメ"),
                // Synthetic owner with 16 multi-byte chars (would panic
                // with byte-slice shortener).
                owner: Some("メメメメメメメメメメメメメメメメ"),
                namespace: Some("研究"),
                error_msg: "UTF-8 TEST: Walrus アップロード failed — endpoint \
                    返ってきたエラー: タイムアウト 🦀🦀🦀",
                kind: FailureKind::TerminalWalletFailure { attempts: 3 },
            })
            .await
            .expect("scenario 5 should deliver");
        println!("    → Slack should render JP chars + 🦀 emoji, no panic");
        pause("scenario 6", 3).await;

        // ── Scenario 6: global rate cap (30/min) ──
        // Fire 35 DISTINCT errors back-to-back on a fresh client. First
        // 30 should reach Slack, last 5 should be dropped by the global
        // cap (per-error dedup wouldn't help — every error has a unique
        // ID embedded). To avoid actually flooding the channel during
        // demo we send only ONE header "rate cap demo starting" message
        // here and tag each as part of the demo.
        println!("\n[6/6] Global rate cap — 35 distinct errors, expect 30 Slack + 5 dropped");
        let client = make_live_client("scenario-6-ratecap").unwrap();
        // Send a heads-up first so reviewers know what they're about to see.
        client
            .send_notification(
                "🧪 RATE-CAP DEMO INCOMING: about to fire 35 distinct error alerts. \
                 Expect 30 in this channel + 5 dropped by global cap. Footer says \
                 `live-test-scenario-6-ratecap`.",
            )
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let mut delivered_count = 0;
        let mut suppressed_count = 0;
        for i in 0..35 {
            // Each message has a unique number so per-error dedup can't
            // collapse them — only the global cap should stop them.
            let res = client
                .notify_remember_job_failed(RememberJobFailedAlert {
                    job_id: Some("live-demo-job-006"),
                    owner: Some(
                        "0xe5c91145cb92ac82df7285022ee4f73c40be5c995d632c74700b1fc04e5f4994",
                    ),
                    namespace: Some("live-test"),
                    error_msg: &format!(
                        "RATE-CAP TEST #{:02}/35 — unique storm entry (different msg \
                         per iteration so per-error dedup does NOT apply)",
                        i + 1
                    ),
                    kind: FailureKind::TerminalWalletFailure { attempts: 3 },
                })
                .await;
            match res {
                Ok(()) => {
                    // notify_remember_job_failed returns Ok in both
                    // "delivered" and "suppressed" cases. We can't tell
                    // from the return value alone; should_suppress
                    // logging at info level discloses it. Count both
                    // outcomes here just to confirm none errored.
                    delivered_count += 1;
                }
                Err(e) => {
                    suppressed_count += 1;
                    println!("    → entry {} returned Err: {}", i + 1, e);
                }
            }
            // Tight loop — we want all 35 inside the global window.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        println!(
            "    → loop done: {} Ok, {} Err (expect ~30 actual Slack messages — \
             check channel; suppressions are logged at INFO via tracing)",
            delivered_count, suppressed_count
        );

        println!("\n✅ Live demo complete. Verify in #target-channel that you see:");
        println!("   1× scenario 1 (wallet retries exhausted, Enoki)");
        println!("   1× scenario 2 (handoff enqueue failed)");
        println!("   1× scenario 3 (dedup — only one despite 2 sends)");
        println!("   1× scenario 4 (sanitized credentials — no passwords)");
        println!("   1× scenario 5 (UTF-8 — Japanese + emoji)");
        println!("   1× scenario 6 header + ~30× rate-cap entries (35 sent, 5 dropped)");
    }
}
