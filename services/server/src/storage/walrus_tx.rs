//! Walrus-specific Move call argument construction for `reserve_space` and
//! `register_blob` (WALM-184: Walrus write-path migration, step 2 of 3 —
//! register). Builds PTB inputs/arguments only — signing and submission are
//! the caller's responsibility via `storage::sui_tx::execute_move_call`.
//!
//! Deliberately split from `sui_tx.rs`: that module knows how to build/sign/
//! submit *any* Move call; this module knows the *specific* argument order
//! Walrus's `system` Move module expects, cross-checked directly against
//! `walrus::system` in the walrus contract source (`contracts/walrus/sources/
//! system/system.move` at the pinned walrus tag) and against
//! `walrus-sui::contracts` (`contract_ident!(fn system::reserve_space)` /
//! `contract_ident!(fn system::register_blob)`), not guessed from the old TS
//! sidecar's naming.
//!
//! `certify_blob` is not here yet — it needs the confirmation
//! signature/bitmap/message the Upload Relay's response provides, which
//! hasn't been wired up (see module doc on the not-yet-written upload_relay
//! client).

use sui_sdk_types::Address;
use sui_transaction_builder::{Argument, ObjectInput, TransactionBuilder};

/// Well-known, Mysten-published Walrus testnet contract object IDs
/// (`setup/client_config_testnet.yaml` in the walrus repo — not derived or
/// guessed). Mainnet has different IDs; do not reuse these there.
pub mod testnet {
    /// The shared `walrus::system::System` object.
    pub const SYSTEM_OBJECT: &str =
        "0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af";
    /// The shared `walrus::staking::Staking` object — its `inner.n_shards`
    /// field is the current committee's shard count needed for encoding
    /// (see `storage::walrus_encode::compute_blob_metadata`).
    pub const STAKING_OBJECT: &str =
        "0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3";
}

/// Build the PTB inputs/arguments for `walrus::system::reserve_space`:
/// `reserve_space(self: &mut System, storage_amount: u64, epochs_ahead: u32,
/// payment: &mut Coin<WAL>, ctx: &mut TxContext) -> Storage`.
/// (`ctx` is implicit — the VM supplies it, it is never a PTB argument.)
///
/// `system_initial_shared_version` and `wal_coin_object_id` must be resolved
/// by the caller beforehand (a live, read-only RPC lookup — see
/// `storage::sui::raw_rpc_call` with `sui_getObject`/`suix_getOwnedObjects`).
pub fn reserve_space_inputs(
    tx: &mut TransactionBuilder,
    system_object_id: Address,
    system_initial_shared_version: u64,
    storage_amount: u64,
    epochs_ahead: u32,
    wal_coin_object_id: Address,
) -> Vec<Argument> {
    let system_arg = tx.object(ObjectInput::shared(
        system_object_id,
        system_initial_shared_version,
        true,
    ));
    let amount_arg = tx.pure(&storage_amount);
    let epochs_arg = tx.pure(&epochs_ahead);
    let coin_arg = tx.object(ObjectInput::new(wal_coin_object_id));
    vec![system_arg, amount_arg, epochs_arg, coin_arg]
}

/// Build the PTB inputs/arguments for `walrus::system::register_blob`:
/// `register_blob(self: &mut System, storage: Storage, blob_id: u256,
/// root_hash: u256, size: u64, encoding_type: u8, deletable: bool,
/// write_payment: &mut Coin<WAL>, ctx: &mut TxContext) -> Blob`.
///
/// `blob_id`/`root_hash` are the raw 32-byte little-endian arrays from
/// `storage::walrus_encode::BlobMetadata` — Move's `u256` BCS-encodes as
/// exactly 32 raw bytes with no length prefix, the same representation
/// (verified independently: `bcs::to_bytes(&[u8; 32])` produces exactly
/// those 32 bytes unchanged), so they're passed to `pure()` directly with
/// no conversion.
///
/// `storage_arg` is the PTB `Argument` for the `Storage` object being
/// consumed — typically the `Argument` `reserve_space_inputs`' resulting
/// move-call returned earlier in the *same* PTB (chained), not a fresh
/// object lookup.
#[allow(clippy::too_many_arguments)]
pub fn register_blob_inputs(
    tx: &mut TransactionBuilder,
    system_object_id: Address,
    system_initial_shared_version: u64,
    storage_arg: Argument,
    blob_id: [u8; 32],
    root_hash: [u8; 32],
    size: u64,
    encoding_type: u8,
    deletable: bool,
    wal_coin_object_id: Address,
) -> Vec<Argument> {
    let system_arg = tx.object(ObjectInput::shared(
        system_object_id,
        system_initial_shared_version,
        true,
    ));
    let blob_id_arg = tx.pure(&blob_id);
    let root_hash_arg = tx.pure(&root_hash);
    let size_arg = tx.pure(&size);
    let encoding_type_arg = tx.pure(&encoding_type);
    let deletable_arg = tx.pure(&deletable);
    let coin_arg = tx.object(ObjectInput::new(wal_coin_object_id));
    vec![
        system_arg,
        storage_arg,
        blob_id_arg,
        root_hash_arg,
        size_arg,
        encoding_type_arg,
        deletable_arg,
        coin_arg,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_address(byte: u8) -> Address {
        Address::new([byte; 32])
    }

    #[test]
    fn reserve_space_inputs_produces_expected_argument_count() {
        // reserve_space takes 4 PTB arguments (system, amount, epochs, coin)
        // — ctx is implicit. This only checks argument *shape*: no network
        // I/O, no signing, nothing submitted.
        let mut tx = TransactionBuilder::new();
        let args = reserve_space_inputs(
            &mut tx,
            dummy_address(1),
            100,
            1_000_000,
            10,
            dummy_address(2),
        );
        assert_eq!(args.len(), 4);
    }

    #[test]
    fn register_blob_inputs_produces_expected_argument_count() {
        // register_blob takes 8 PTB arguments (system, storage, blob_id,
        // root_hash, size, encoding_type, deletable, coin) — ctx implicit.
        let mut tx = TransactionBuilder::new();
        let storage_arg = tx.object(ObjectInput::new(dummy_address(3)));
        let args = register_blob_inputs(
            &mut tx,
            dummy_address(1),
            100,
            storage_arg,
            [0u8; 32],
            [1u8; 32],
            12345,
            1, // RS2
            false,
            dummy_address(2),
        );
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn blob_id_pure_arg_bcs_round_trips_without_reencoding() {
        // The core claim this module relies on: [u8; 32] BCS-encodes as
        // exactly those 32 bytes, unchanged — verified independently
        // against a standalone bcs::to_bytes probe before writing this
        // module. Re-assert it here so a future bcs upgrade that changed
        // this would fail loudly.
        let bytes = [7u8; 32];
        let encoded = bcs::to_bytes(&bytes).unwrap();
        assert_eq!(encoded.len(), 32);
        assert_eq!(encoded, bytes.to_vec());
    }
}
