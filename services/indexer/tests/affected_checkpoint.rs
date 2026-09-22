//! Decodes the checkpoint that stalled staging, through the real ingestion client (WALM-668).
//!
//! `tests/fixtures/384534623.binpb.zst` is testnet checkpoint 384534623 exactly as the
//! remote store serves it — the sample checkpoint named in the staging incident. Serving
//! the fixture directory as a local object store runs the same
//! `StoreIngestionClient::checkpoint` path production uses (zstd -> protobuf -> types),
//! so a pin that cannot decode what testnet produces fails here offline.
//!
//! Under the previous testnet-v1.75.1 pin this checkpoint failed with
//! `Failed to convert checkpoint protobuf to checkpoint data: transaction.bcs: invalid
//! value: integer 3, expected variant index 0 <= i < 3`, because it carries a transaction
//! whose expiration is `TransactionExpiration::Validity` — variant index 3, added in
//! testnet-v1.79.0.

use std::sync::Arc;

use object_store::local::LocalFileSystem;
use sui_indexer_alt_framework::ingestion::store_client::StoreIngestionClient;
use sui_indexer_alt_framework::types::transaction::{TransactionDataAPI, TransactionExpiration};

const AFFECTED_CHECKPOINT: u64 = 384_534_623;

#[tokio::test]
async fn decodes_the_checkpoint_that_stalled_staging() {
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let store = LocalFileSystem::new_with_prefix(fixtures).expect("fixture dir should be readable");
    let client = StoreIngestionClient::new(Arc::new(store), None);

    let checkpoint = client
        .checkpoint(AFFECTED_CHECKPOINT)
        .await
        .expect("checkpoint 384534623 should decode; a pin older than testnet-v1.79.0 fails here");

    assert_eq!(
        checkpoint.summary.sequence_number, AFFECTED_CHECKPOINT,
        "fixture should be the checkpoint named in the incident"
    );

    // Guards the fixture itself: if this checkpoint stopped carrying a `Validity`
    // expiration it would still decode on the old pin, and the test above would pass
    // without exercising anything.
    let validity_transactions = checkpoint
        .transactions
        .iter()
        .filter(|tx| {
            matches!(
                tx.transaction.expiration(),
                TransactionExpiration::Validity { .. }
            )
        })
        .count();

    assert!(
        validity_transactions > 0,
        "fixture no longer carries a Validity expiration, so it no longer reproduces the failure"
    );
}
