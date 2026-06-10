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
