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
use std::num::NonZeroU16;
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
    /// The published `wal` Move package (`testnet-contracts/wal/Published.toml`
    /// in the walrus repo — `published-at`, not derived or guessed).
    pub const WAL_PACKAGE: &str =
        "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a";
    /// Fully-qualified `Coin<WAL>` type tag, for `suix_getCoins` balance
    /// queries when selecting a payment coin for `reserve_space`/`register_blob`.
    pub const WAL_COIN_TYPE: &str =
        "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";
}

/// Build the PTB inputs/arguments for the metadata-stamp + transfer step that
/// follows `certify_blob` — ported 1:1 from the TS sidecar's
/// `scripts/sidecar/blob-metadata.ts` (`setMetadataAndTransferBlobs`), not new
/// business logic. For each `(key, value)` pair calls
/// `{walrus_package}::blob::insert_or_update_metadata_pair(blob, key, value)`,
/// then transfers the blob to `owner` via `tx.transfer_objects`.
///
/// `blob_arg` is the PTB `Argument` for the `Blob` object `register_blob`
/// returned earlier in the same PTB (chained, like `certify_blob_inputs`).
/// Returns nothing — the last command is the transfer, which has no result
/// arguments callers need.
pub fn stamp_metadata_and_transfer(
    tx: &mut TransactionBuilder,
    walrus_package_id: Address,
    blob_arg: Argument,
    owner: Address,
    metadata: &[(&str, &str)],
) {
    use sui_transaction_builder::Function;

    for (key, value) in metadata {
        let key_arg = tx.pure(&(*key).to_string());
        let value_arg = tx.pure(&(*value).to_string());
        tx.move_call(
            Function::new(
                walrus_package_id,
                "blob".parse().expect("valid identifier"),
                "insert_or_update_metadata_pair"
                    .parse()
                    .expect("valid identifier"),
            ),
            vec![blob_arg, key_arg, value_arg],
        );
    }

    let owner_arg = tx.pure(&owner);
    tx.transfer_objects(vec![blob_arg], owner_arg);
}

/// Select a single `Coin<WAL>` object owned by `owner` with balance >=
/// `min_balance`, via `sui-rpc`'s own official `Client::select_coins`
/// (gRPC `list_owned_objects`, not hand-rolled JSON-RPC parsing). Returns
/// just the object ID — like `register_blob_inputs`'s `wal_coin_object_id:
/// Address` param, callers pass this straight to `ObjectInput::new`, which
/// resolves version/digest itself when the transaction is built.
///
/// `select_coins` can return *multiple* smaller coins summing to
/// `min_balance` — this wrapper only supports the single-coin case (returns
/// an error naming the total available otherwise) since
/// `reserve_space_inputs`/`register_blob_inputs` take one coin object, not a
/// list to merge. If the wallet only holds fragmented WAL, top up / merge
/// out-of-band (matching the TS sidecar's wallet-refill runbook).
pub async fn select_wal_coin(
    rpc_client: &sui_rpc::Client,
    owner: Address,
    min_balance: u64,
) -> Result<Address, String> {
    let coin_type: sui_sdk_types::TypeTag = testnet::WAL_COIN_TYPE
        .parse()
        .map_err(|e| format!("invalid WAL coin type {}: {e}", testnet::WAL_COIN_TYPE))?;
    let coins = rpc_client
        .select_coins(&owner, &coin_type, min_balance, &[])
        .await
        .map_err(|e| format!("select_coins failed: {e}"))?;
    if coins.len() != 1 {
        return Err(format!(
            "need a single Coin<WAL> with balance >= {min_balance}, but the wallet only has \
             fragmented balances across {} coins — merge them out-of-band first",
            coins.len()
        ));
    }
    coins[0]
        .object_id()
        .parse::<Address>()
        .map_err(|e| format!("invalid coinObjectId {}: {e}", coins[0].object_id()))
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

/// Build the PTB inputs/arguments for `walrus::system::certify_blob`:
/// `certify_blob(self: &System, blob: &mut Blob, signature: vector<u8>,
/// signers_bitmap: vector<u8>, message: vector<u8>)`.
///
/// Note `self: &System` is an *immutable* shared reference here (unlike
/// `reserve_space`/`register_blob`'s `&mut System`) — `mutable: false` on
/// the `ObjectInput::shared` call reflects that.
///
/// `blob_arg` is the PTB `Argument` for the `Blob` object `register_blob`
/// returned — typically chained from the same PTB's earlier command, not a
/// fresh object lookup, since a freshly-registered `Blob` has no separate
/// on-chain object ref to look up yet within the same transaction.
///
/// `signature`/`signers_bitmap`/`message` come from the Upload Relay's
/// confirmation response once the blob's slivers have been stored by a
/// quorum of storage nodes — not built by this server. Wiring the Upload
/// Relay client that produces these is a separate, not-yet-done step (see
/// `crates/walrus-upload-relay/upload_relay_openapi.yaml` in the walrus
/// repo for the wire protocol).
pub fn certify_blob_inputs(
    tx: &mut TransactionBuilder,
    system_object_id: Address,
    system_initial_shared_version: u64,
    blob_arg: Argument,
    signature: Vec<u8>,
    signers_bitmap: Vec<u8>,
    message: Vec<u8>,
) -> Vec<Argument> {
    let system_arg = tx.object(ObjectInput::shared(
        system_object_id,
        system_initial_shared_version,
        false,
    ));
    let signature_arg = tx.pure(&signature);
    let signers_bitmap_arg = tx.pure(&signers_bitmap);
    let message_arg = tx.pure(&message);
    vec![
        system_arg,
        blob_arg,
        signature_arg,
        signers_bitmap_arg,
        message_arg,
    ]
}

/// Read the current Walrus committee's shard count from the on-chain
/// `staking::Staking` object.
///
/// `n_shards` isn't a direct field on the `Staking` object — it lives in a
/// `StakingInnerV1` value stored behind a `u64`-keyed dynamic field (the
/// same "inner state behind a dynamic field, bump the key to migrate"
/// pattern `system.move`'s own `System`/`SystemStateInnerV1` uses — see
/// `storage::sui::verify_delegate_key_onchain`'s doc for the analogous
/// MemWalAccount case). Two RPC round-trips: `suix_getDynamicFields` to
/// find the current inner-state object, then `sui_getObject` on it to read
/// `value.fields.n_shards`.
///
/// Also returns `committee_size` (the number of distinct committee member
/// entries in `committee.pos0.contents`) — needed by
/// [`signers_to_bitmap`], which mirrors `walrus-sui`'s own
/// `committee_size()` (`self.inner.committee.members.len()` there; the same
/// value, read from the JSON field path instead of a typed BCS struct).
///
/// Cross-checked live against Walrus testnet (`staking_object` from
/// `setup/client_config_testnet.yaml`): returned n_shards=1000 (matching
/// that config's separately-published static value) and committee_size=101
/// at the time this was written.
pub async fn fetch_n_shards_and_committee_size(
    client: &reqwest::Client,
    rpc_url: &str,
    staking_object_id: &str,
) -> Result<(NonZeroU16, u16), String> {
    let fields = super::sui::raw_rpc_call(
        client,
        rpc_url,
        "suix_getDynamicFields",
        serde_json::json!([staking_object_id, serde_json::Value::Null, 1]),
    )
    .await?;
    let inner_object_id = fields
        .pointer("/data/0/objectId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "staking object has no StakingInnerV1 dynamic field".to_string())?;

    let inner = super::sui::raw_rpc_call(
        client,
        rpc_url,
        "sui_getObject",
        serde_json::json!([inner_object_id, { "showContent": true }]),
    )
    .await?;
    let value_fields = inner
        .pointer("/data/content/fields/value/fields")
        .ok_or_else(|| "StakingInnerV1 object has no value.fields".to_string())?;

    let n_shards = value_fields
        .get("n_shards")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| "StakingInnerV1 has no n_shards field".to_string())?;
    let n_shards = u16::try_from(n_shards)
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or_else(|| format!("n_shards {n_shards} is not a valid non-zero u16"))?;

    let committee_size = value_fields
        .pointer("/committee/fields/pos0/fields/contents")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "StakingInnerV1 has no committee.pos0.contents".to_string())?
        .len();
    let committee_size = u16::try_from(committee_size)
        .map_err(|_| format!("committee_size {committee_size} does not fit in u16"))?;

    Ok((n_shards, committee_size))
}

/// Read a shared object's `initial_shared_version` — required by
/// `ObjectInput::shared` for every shared-object reference in a PTB
/// (`reserve_space_inputs`/`register_blob_inputs`/`certify_blob_inputs`'s
/// `system_initial_shared_version` param, and the equivalent for the
/// staking object). `sui_getObject` with `showOwner: true` returns
/// `data.owner.Shared.initial_shared_version`; the object's *current*
/// `data.version` field is a different value (bumped on every mutation) and
/// must not be used here.
pub async fn fetch_initial_shared_version(
    client: &reqwest::Client,
    rpc_url: &str,
    object_id: &str,
) -> Result<u64, String> {
    let resp = super::sui::raw_rpc_call(
        client,
        rpc_url,
        "sui_getObject",
        serde_json::json!([object_id, { "showOwner": true }]),
    )
    .await?;
    resp.pointer("/data/owner/Shared/initial_shared_version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| format!("{object_id} has no owner.Shared.initial_shared_version — is it actually a shared object?"))
}

/// Pack a list of signer indices (0-based, into the committee) into the
/// bit-packed `signers_bitmap: vector<u8>` `certify_blob` expects.
///
/// Verbatim port of `walrus-sui`'s own
/// `SuiContractClient::signers_to_bitmap` (`crates/walrus-sui/src/client/
/// transaction_builder/owned_blob_ops.rs`): one bit per committee member,
/// packed LSB-first within each byte, `committee_size.div_ceil(8)` bytes
/// total.
pub fn signers_to_bitmap(signers: &[u16], committee_size: u16) -> Vec<u8> {
    let mut bitmap = vec![0u8; (committee_size as usize).div_ceil(8)];
    for &signer in signers {
        let byte_index = (signer / 8) as usize;
        let bit_index = signer % 8;
        bitmap[byte_index] |= 1 << bit_index;
    }
    bitmap
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

    #[test]
    fn certify_blob_inputs_produces_expected_argument_count() {
        // certify_blob takes 5 PTB arguments (system, blob, signature,
        // signers_bitmap, message).
        let mut tx = TransactionBuilder::new();
        let blob_arg = tx.object(ObjectInput::new(dummy_address(3)));
        let args = certify_blob_inputs(
            &mut tx,
            dummy_address(1),
            100,
            blob_arg,
            vec![1, 2, 3],
            vec![4, 5],
            vec![6, 7, 8, 9],
        );
        assert_eq!(args.len(), 5);
    }

    #[tokio::test]
    #[ignore = "hits the live Sui testnet fullnode — run explicitly with `cargo test -- --ignored`"]
    async fn fetch_n_shards_and_committee_size_reads_the_real_testnet_values() {
        // Live read-only check against the official Mysten testnet staking
        // object. No signing, no funds — just confirms this module's RPC
        // navigation (suix_getDynamicFields -> sui_getObject -> field path)
        // actually matches the real on-chain StakingInnerV1 layout, not
        // just the JSON shape I read once by hand while writing this.
        let client = reqwest::Client::new();
        let (n_shards, committee_size) = fetch_n_shards_and_committee_size(
            &client,
            "https://fullnode.testnet.sui.io:443",
            testnet::STAKING_OBJECT,
        )
        .await
        .unwrap();
        // n_shards=1000 and committee_size=101 as of writing (n_shards
        // matches setup/client_config_testnet.yaml's separately-published
        // static value) — both can change across epochs, so this asserts
        // sane ranges rather than exact figures, in case they move before
        // this test is next run.
        assert!(
            n_shards.get() >= 100,
            "n_shards={n_shards} looks implausibly small"
        );
        assert!(
            committee_size >= 10,
            "committee_size={committee_size} looks implausibly small"
        );
    }

    #[tokio::test]
    #[ignore = "hits the live Sui testnet fullnode — run explicitly with `cargo test -- --ignored`"]
    async fn fetch_initial_shared_version_reads_the_real_testnet_system_object() {
        // Live read-only check against the official Mysten testnet system
        // object. No signing, no funds — confirms the owner.Shared field
        // path actually matches what sui_getObject returns for a real
        // shared object, not just the JSON shape read once by hand.
        let client = reqwest::Client::new();
        let version = fetch_initial_shared_version(
            &client,
            "https://fullnode.testnet.sui.io:443",
            testnet::SYSTEM_OBJECT,
        )
        .await
        .unwrap();
        assert!(
            version >= 1,
            "initial_shared_version={version} looks implausible"
        );
    }

    #[test]
    fn signers_to_bitmap_matches_hand_computed_expected_bytes() {
        // committee_size=10 -> ceil(10/8) = 2 bytes.
        // signer 0 -> byte 0, bit 0 -> 0b0000_0001
        // signer 3 -> byte 0, bit 3 -> 0b0000_1000
        // signer 9 -> byte 1, bit 1 -> 0b0000_0010
        let bitmap = signers_to_bitmap(&[0, 3, 9], 10);
        assert_eq!(bitmap, vec![0b0000_1001, 0b0000_0010]);
    }

    #[test]
    fn signers_to_bitmap_empty_signers_gives_zeroed_bitmap() {
        let bitmap = signers_to_bitmap(&[], 20);
        assert_eq!(bitmap, vec![0u8; 3]); // ceil(20/8) = 3
    }
}
