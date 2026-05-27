use serde::Serialize;

const ALERT_TO_SLACK_ENV: &str = "ALERT_TO_SLACK";
const MAX_SLACK_ERROR_LEN: usize = 1_500;

#[derive(Clone, Debug)]
pub struct AlertManager {
    slack: Option<SlackNotifier>,
}

impl AlertManager {
    pub fn from_env(http_client: reqwest::Client) -> Self {
        let slack = std::env::var(ALERT_TO_SLACK_ENV)
            .ok()
            .and_then(|raw| SlackNotifier::from_env_value(http_client, &raw));

        Self { slack }
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

        slack.send(&alert).await
    }
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

    async fn send(&self, alert: &WalrusUploadExhaustedAlert) -> Result<(), AlertError> {
        let payload = SlackPayload::for_walrus_upload_exhausted(alert);
        let resp = self
            .http_client
            .post(&self.webhook_url)
            .json(&payload)
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
}
