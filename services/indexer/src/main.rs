//! Walrus Memory Indexer.
//!
//! Ingests full checkpoints from the Sui checkpoint remote store via
//! `sui-indexer-alt-framework` and indexes `<package>::account::AccountCreated`
//! events into the `accounts` table (the `account_id -> owner` read-model used
//! for O(1) auth lookups, so the server never scans the on-chain registry).
//!
//! Why checkpoint ingestion: Sui sunsets JSON-RPC on 2026-07-31, and the gRPC
//! `LedgerService.ListEvents` path needs a fullnode with ledger-history indexing
//! enabled (the public fullnode disables it). Checkpoint ingestion needs no RPC
//! event index — just the public checkpoint store
//! (`--remote-store-url https://checkpoints.<net>.sui.io`). The framework owns
//! ingestion, watermarks (replacing the old `indexer_state` cursor), batching,
//! and shutdown. Pattern mirrors CommandOSSLabs/dopamint-arena `backend/explorer`.

use std::sync::Arc;

use async_trait::async_trait;
use clap::Parser;
use diesel::sql_types::Text;
use diesel_async::RunQueryDsl;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};
use move_core_types::account_address::AccountAddress;
use serde::Deserialize;
use sui_indexer_alt_framework::cluster::{Args, IndexerCluster};
use sui_indexer_alt_framework::pipeline::concurrent::ConcurrentConfig;
use sui_indexer_alt_framework::pipeline::Processor;
use sui_indexer_alt_framework::postgres::handler::Handler;
use sui_indexer_alt_framework::postgres::Connection;
use sui_indexer_alt_framework::types::full_checkpoint_content::Checkpoint;
use sui_indexer_alt_framework::FieldCount;

/// User migrations added alongside the framework's own watermark tables. Creates
/// `accounts` (identical schema to the legacy indexer).
const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// BCS shape of `account::AccountCreated`. Field order/types MUST match the Move
/// struct exactly for BCS to decode. Move `ID`/`address` are 32 raw bytes (no
/// length prefix). Mirrors the legacy indexer's decode.
#[derive(Deserialize)]
struct AccountCreatedEvent {
    account_id: [u8; 32],
    owner: [u8; 32],
}

/// One `accounts` row. `FieldCount` is required by the framework for batch sizing.
#[derive(Clone, FieldCount)]
struct AccountRow {
    account_id: String,
    owner: String,
}

/// Indexes `<package>::account::AccountCreated` into the `accounts` read-model.
struct AccountsPipeline {
    package: AccountAddress,
}

#[async_trait]
impl Processor for AccountsPipeline {
    // Bumping this name re-anchors ingestion at `--first-checkpoint` (fresh watermark).
    const NAME: &'static str = "memwal_accounts";
    type Value = AccountRow;

    async fn process(&self, checkpoint: &Arc<Checkpoint>) -> anyhow::Result<Vec<Self::Value>> {
        let mut rows = Vec::new();
        for tx in &checkpoint.transactions {
            for ev in tx.events.iter().flat_map(|evs| evs.data.iter()) {
                if ev.type_.address != self.package
                    || ev.type_.module.as_str() != "account"
                    || ev.type_.name.as_str() != "AccountCreated"
                {
                    continue;
                }
                let e: AccountCreatedEvent = bcs::from_bytes(&ev.contents)?;
                rows.push(AccountRow {
                    account_id: format!("0x{}", hex::encode(e.account_id)),
                    owner: format!("0x{}", hex::encode(e.owner)),
                });
            }
        }
        Ok(rows)
    }
}

#[async_trait]
impl Handler for AccountsPipeline {
    async fn commit<'a>(values: &[Self::Value], conn: &mut Connection<'a>) -> anyhow::Result<usize> {
        // Idempotent: an account never changes owner, and reprocessed checkpoints
        // must not error. Matches the legacy ON CONFLICT (account_id) DO NOTHING.
        let mut inserted = 0;
        for row in values {
            inserted += diesel::sql_query(
                "INSERT INTO accounts (account_id, owner) VALUES ($1, $2) \
                 ON CONFLICT (account_id) DO NOTHING",
            )
            .bind::<Text, _>(&row.account_id)
            .bind::<Text, _>(&row.owner)
            .execute(conn)
            .await?;
        }
        Ok(inserted)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Pin ring BEFORE any TLS (framework fetches checkpoints over HTTPS).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = dotenvy::dotenv();

    // Do NOT install a tracing subscriber: IndexerCluster::build() installs the
    // framework's own global subscriber (honors RUST_LOG); a second init panics.
    // Ingestion source + checkpoint range come from CLI (e.g. --remote-store-url,
    // --first-checkpoint); DB + package id come from the environment.
    let args = Args::parse();
    let package = AccountAddress::from_hex_literal(&std::env::var("MEMWAL_PACKAGE_ID")?)
        .map_err(|e| anyhow::anyhow!("invalid MEMWAL_PACKAGE_ID: {e}"))?;
    let database_url: url::Url = std::env::var("DATABASE_URL")?.parse()?;

    let mut cluster = IndexerCluster::builder()
        .with_database_url(database_url)
        .with_args(args)
        .with_migrations(&MIGRATIONS)
        .build()
        .await?;

    cluster
        .concurrent_pipeline(AccountsPipeline { package }, ConcurrentConfig::default())
        .await?;

    // Framework owns watermarks + graceful shutdown; wait for the service to finish.
    cluster.run().await?.join().await?;
    Ok(())
}
