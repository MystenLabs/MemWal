//! Decodes `<package>::account::AccountCreated` out of each checkpoint into the
//! `accounts` read-model. One event -> one row; no cross-row enrichment.
use std::sync::Arc;

use async_trait::async_trait;
use diesel::prelude::*;
use diesel::upsert::excluded;
use diesel_async::RunQueryDsl;
use move_core_types::account_address::AccountAddress;
use serde::Deserialize;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::postgres::handler::Handler;
use sui_indexer_alt_framework::postgres::Connection;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;
use sui_indexer_alt_framework::FieldCount;

use crate::schema::accounts;

/// BCS layout of `account::AccountCreated { account_id: ID, owner: address }`.
/// `ID` is a single-field wrapper over `address`, so both serialize as 32 bytes.
#[derive(Deserialize)]
struct AccountCreatedEvent {
    account_id: [u8; 32],
    owner: [u8; 32],
}

#[derive(Insertable, FieldCount, Clone)]
#[diesel(table_name = crate::schema::accounts)]
pub struct StoredAccount {
    pub account_id: String,
    pub owner: String,
}

pub struct AccountPipeline {
    pub package: AccountAddress,
}

#[async_trait]
impl Processor for AccountPipeline {
    const NAME: &'static str = "accounts_v1";
    type Value = StoredAccount;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> anyhow::Result<Vec<Self::Value>> {
        let mut rows = Vec::new();
        for tx in &checkpoint.transactions {
            for ev in tx.events.iter().flat_map(|e| e.data.iter()) {
                if ev.type_.address == self.package
                    && ev.type_.module.as_str() == "account"
                    && ev.type_.name.as_str() == "AccountCreated"
                {
                    let parsed: AccountCreatedEvent = bcs::from_bytes(&ev.contents)?;
                    rows.push(StoredAccount {
                        account_id: format!("0x{}", hex::encode(parsed.account_id)),
                        owner: format!("0x{}", hex::encode(parsed.owner)),
                    });
                }
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl Handler for AccountPipeline {
    async fn commit<'a>(
        values: &[Self::Value],
        conn: &mut Connection<'a>,
    ) -> anyhow::Result<usize> {
        let inserted = diesel::insert_into(accounts::table)
            .values(values)
            // One row per owner across package deployments. If the indexer is
            // repointed at a new package while keeping its DB, update that
            // owner's account id instead of stalling on the owner UNIQUE key.
            .on_conflict(accounts::owner)
            .do_update()
            .set(accounts::account_id.eq(excluded(accounts::account_id)))
            .execute(conn)
            .await?;
        Ok(inserted)
    }
}
