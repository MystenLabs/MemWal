use crate::sui::SuiEvent;
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExtractorError {
    #[error("missing field: {0}")]
    MissingField(&'static str),
    #[error("bcs decode error: {0}")]
    Bcs(#[from] bcs::Error),
}

#[derive(Debug, Clone)]
pub struct AccountRow {
    pub account_id: String,
    pub owner: String,
}

pub struct AccountCreatedExtractor;

impl AccountCreatedExtractor {
    pub fn extract(event: &SuiEvent) -> Result<AccountRow, ExtractorError> {
        // Prefer JSON if available (JSON-RPC path)
        if let Some(json) = &event.json {
            let account_id = json
                .get("account_id")
                .and_then(|v| v.as_str())
                .ok_or(ExtractorError::MissingField("account_id"))?;
            let owner = json
                .get("owner")
                .and_then(|v| v.as_str())
                .ok_or(ExtractorError::MissingField("owner"))?;
            return Ok(AccountRow {
                account_id: account_id.to_string(),
                owner: owner.to_string(),
            });
        }

        // Fall back to BCS (gRPC path)
        #[derive(Deserialize)]
        struct AccountCreatedEvent {
            account_id: [u8; 32],
            owner: [u8; 32],
        }

        let parsed: AccountCreatedEvent = bcs::from_bytes(&event.bcs)?;
        Ok(AccountRow {
            account_id: format!("0x{}", hex::encode(parsed.account_id)),
            owner: format!("0x{}", hex::encode(parsed.owner)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sui::EventId;

    #[test]
    fn extract_from_json() {
        let event = SuiEvent {
            id: EventId {
                tx_digest: "0x1234".to_string(),
                event_seq: 0,
            },
            package_id: "0xpkg".to_string(),
            module: "account".to_string(),
            event_type: "0xpkg::account::AccountCreated".to_string(),
            bcs: vec![],
            json: Some(serde_json::json!({
                "account_id": "0xabc",
                "owner": "0xdef"
            })),
            timestamp_ms: None,
        };
        let row = AccountCreatedExtractor::extract(&event).unwrap();
        assert_eq!(row.account_id, "0xabc");
        assert_eq!(row.owner, "0xdef");
    }

    #[test]
    fn extract_from_bcs() {
        #[derive(serde::Serialize)]
        struct AccountCreatedEvent {
            account_id: [u8; 32],
            owner: [u8; 32],
        }
        let payload = AccountCreatedEvent {
            account_id: [1u8; 32],
            owner: [2u8; 32],
        };
        let bcs = bcs::to_bytes(&payload).unwrap();

        let event = SuiEvent {
            id: EventId {
                tx_digest: "0x1234".to_string(),
                event_seq: 0,
            },
            package_id: "0xpkg".to_string(),
            module: "account".to_string(),
            event_type: "0xpkg::account::AccountCreated".to_string(),
            bcs,
            json: None,
            timestamp_ms: None,
        };
        let row = AccountCreatedExtractor::extract(&event).unwrap();
        assert_eq!(row.account_id, format!("0x{}", hex::encode([1u8; 32])));
        assert_eq!(row.owner, format!("0x{}", hex::encode([2u8; 32])));
    }
}
