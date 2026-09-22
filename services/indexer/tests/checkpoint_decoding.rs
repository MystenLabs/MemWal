//! Wire-compatibility guard for the pinned Sui types (WALM-668).
//!
//! The indexer does not read individual events off a fullnode — it decodes whole
//! checkpoint files, so *every* transaction in a checkpoint has to deserialize before
//! `AccountPipeline` ever sees an event. A transaction field the pinned types don't
//! know is therefore a hard stop for the checkpoint, not a field that gets skipped:
//! `accounts_v1` retries the same checkpoint forever and its watermark backlog grows.
//!
//! That is what happened on staging. testnet-v1.79.0 added
//! `TransactionExpiration::Validity` as variant index 3; the indexer was pinned to
//! testnet-v1.75.1, which knows variants 0..=2, so once testnet started producing
//! `Validity` transactions every affected checkpoint failed with
//! `transaction.bcs: invalid value: integer 3, expected variant index 0 <= i < 3`.
//!
//! These tests fail on any pin that trails the network in the same way. Run them after
//! bumping the `rev` in Cargo.toml.

use sui_indexer_alt_framework::types::digests::{ChainIdentifier, CheckpointDigest};
use sui_indexer_alt_framework::types::transaction::TransactionExpiration;

fn testnet_chain() -> ChainIdentifier {
    ChainIdentifier::from(CheckpointDigest::new([0x11; 32]))
}

/// The regression: the pinned types must decode the expiration variant testnet emits.
#[test]
fn decodes_validity_expiration() {
    let expiration = TransactionExpiration::Validity {
        min_epoch: Some(42),
        max_epoch: Some(43),
        min_timestamp: None,
        max_timestamp: None,
        chain: testnet_chain(),
        nonce: 7,
        allowed_proposers: None,
    };

    let bytes = bcs::to_bytes(&expiration).expect("Validity should serialize");
    assert_eq!(
        bytes.first(),
        Some(&3u8),
        "Validity must stay at variant index 3 — that index is what testnet puts on the wire"
    );

    let decoded: TransactionExpiration =
        bcs::from_bytes(&bytes).expect("Validity should decode; a pin older than testnet-v1.79.0 fails here");
    assert_eq!(decoded, expiration);
}

/// Bumping the pin must not renumber the older variants: the checkpoint bucket still
/// serves the whole history, and the indexer replays it from its saved watermark.
#[test]
fn preserves_earlier_expiration_variant_indices() {
    let cases: [(u8, TransactionExpiration); 3] = [
        (0, TransactionExpiration::None),
        (1, TransactionExpiration::Epoch(99)),
        (
            2,
            TransactionExpiration::ValidDuring {
                min_epoch: Some(42),
                max_epoch: Some(43),
                min_timestamp: None,
                max_timestamp: None,
                chain: testnet_chain(),
                nonce: 7,
            },
        ),
    ];

    for (index, expiration) in cases {
        let bytes = bcs::to_bytes(&expiration).expect("expiration should serialize");
        assert_eq!(
            bytes.first(),
            Some(&index),
            "{expiration:?} moved off variant index {index}, breaking already-indexed history"
        );

        let decoded: TransactionExpiration =
            bcs::from_bytes(&bytes).expect("expiration should round-trip");
        assert_eq!(decoded, expiration);
    }
}
