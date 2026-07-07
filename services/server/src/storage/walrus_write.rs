//! `store_blob`: the complete native Walrus write-path orchestration
//! (WALM-184) — the single entry point that replaces what the old TS
//! sidecar's `POST /walrus/upload` did (`scripts/sidecar/routes/
//! walrus-upload.ts`, `flow.encode()` -> `flow.register()` ->
//! `flow.upload()` -> `flow.certify()`), assembled here from the pieces
//! verified individually elsewhere in `storage::`:
//!
//! 1. [`walrus_encode::compute_blob_metadata`] — RedStuff-encode the blob
//!    locally, no network calls.
//! 2. [`walrus_tx::fetch_n_shards_and_committee_size`] — live, read-only
//!    chain read (step 1 needs `n_shards`).
//! 3. [`sui_tx::execute_ptb`] with [`walrus_tx::reserve_space_inputs`]
//!    chained into [`walrus_tx::register_blob_inputs`] in one PTB — signs
//!    and submits a real transaction.
//! 4. A follow-up `sui_getTransactionBlock` (JSON-RPC, `showObjectChanges:
//!    true`) to find the newly-created `Blob` object's ID — the gRPC
//!    execution response's `effects.changed_objects[].object_type` is
//!    documented as not populated by the execution path itself ("Type
//!    information is not provided by the effects structure but is instead
//!    provided by an indexing layer" — `sui-rpc`'s own
//!    `ChangedObject.object_type` doc comment), so identifying which
//!    changed object is the `Blob` needs this separate, type-aware read.
//! 5. [`walrus_upload_relay::upload_blob`] — HTTP POST to the relay,
//!    returns a `ConfirmationCertificate`.
//! 6. [`sui_tx::execute_move_call`] with [`walrus_tx::certify_blob_inputs`]
//!    (using [`walrus_tx::signers_to_bitmap`] on the certificate's
//!    `signers`) — signs and submits a second real transaction.
//!
//! Steps 3 and 6 spend real WAL/SUI gas. This function is real, complete,
//! callable code — but nothing in this codebase invokes it yet (no route
//! wires it up). See the caller-facing warning on [`store_blob`] before
//! wiring this into a route.

use crate::storage::{sui, sui_tx, walrus_encode, walrus_tx, walrus_upload_relay};
use fastcrypto::traits::ToFromBytes;
use sui_sdk_types::Address;
use sui_transaction_builder::Function;

#[derive(Debug)]
pub enum StoreBlobError {
    Encode(walrus_encode::EncodeError),
    ChainRead(String),
    AddressParse(String),
    Reserve(sui_tx::SuiTxError),
    BlobObjectNotFound(String),
    Upload(walrus_upload_relay::UploadRelayError),
    Certify(sui_tx::SuiTxError),
}

impl std::fmt::Display for StoreBlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Encode(e) => write!(f, "failed to encode blob: {e}"),
            Self::ChainRead(e) => write!(f, "failed to read chain state: {e}"),
            Self::AddressParse(e) => write!(f, "invalid address: {e}"),
            Self::Reserve(e) => write!(f, "reserve_space+register_blob transaction failed: {e}"),
            Self::BlobObjectNotFound(e) => {
                write!(f, "could not find the newly-created Blob object: {e}")
            }
            Self::Upload(e) => write!(f, "upload relay failed: {e}"),
            Self::Certify(e) => write!(f, "certify_blob transaction failed: {e}"),
        }
    }
}

impl std::error::Error for StoreBlobError {}

pub struct StoreBlobResult {
    pub blob_id: [u8; 32],
    pub blob_object_id: String,
    pub register_tx_digest: String,
    pub certify_tx_digest: String,
}

/// Store `blob_bytes` on Walrus natively — no Node.js sidecar involved.
///
/// # THIS FUNCTION SPENDS REAL WAL AND SUI GAS
///
/// It signs and submits two real transactions (`reserve_space`+
/// `register_blob` combined into one PTB, then `certify_blob`) using
/// `signer`'s key. Do not call this against a real signer without the same
/// explicit, scoped confirmation any other fund-moving action in this
/// codebase requires — treat it exactly like `sui_tx::execute_ptb`, which
/// this function is built on.
///
/// It also does NOT pay the Upload Relay's tip if one is required
/// (`walrus_upload_relay::fetch_tip_config`) — call that first and handle
/// payment separately; `upload_blob` will return
/// `UploadRelayError::Rejected` if a required tip wasn't paid.
///
/// `wal_coin_object_id` must be an object ID of a `Coin<WAL>` the signer
/// owns, already resolved by the caller (e.g. via `suix_getBalance`/
/// `suix_getCoins` filtered by the network's live WAL coin type — see
/// module doc on why this isn't auto-discovered: on Sui testnet
/// specifically, multiple stale `wal::WAL` coin types can coexist in one
/// address from past testnet resets, so auto-picking "a" WAL coin risks
/// picking one for the wrong, no-longer-live package).
#[allow(clippy::too_many_arguments)]
pub async fn store_blob(
    rpc_client: &mut sui_rpc::Client,
    http_client: &reqwest::Client,
    signer: &sui_tx::SuiSignerContext,
    sui_rpc_url: &str,
    upload_relay_url: &str,
    system_object_id: &str,
    system_initial_shared_version: u64,
    staking_object_id: &str,
    wal_coin_object_id: &str,
    epochs_ahead: u32,
    deletable: bool,
    gas_budget: u64,
    blob_bytes: &[u8],
) -> Result<StoreBlobResult, StoreBlobError> {
    let system_address = parse_address(system_object_id)?;
    let wal_coin_address = parse_address(wal_coin_object_id)?;

    // 1+2. Encode locally, using the live committee size.
    let (n_shards, _) =
        walrus_tx::fetch_n_shards_and_committee_size(http_client, sui_rpc_url, staking_object_id)
            .await
            .map_err(StoreBlobError::ChainRead)?;
    let metadata = walrus_encode::compute_blob_metadata(blob_bytes, n_shards)
        .map_err(StoreBlobError::Encode)?;
    let blob_id = metadata.blob_id;

    // 3. reserve_space + register_blob, chained in one PTB.
    let storage_amount = blob_bytes.len() as u64; // TODO: real encoded-size formula, not raw length — see walrus_core::encoding::encoded_blob_length_for_n_shards.
    let root_hash = metadata.root_hash;
    let unencoded_length = metadata.unencoded_length;
    let encoding_type = metadata.encoding_type as u8;
    let executed = sui_tx::execute_ptb(
        rpc_client,
        signer,
        move |tx| {
            let reserve_args = walrus_tx::reserve_space_inputs(
                tx,
                system_address,
                system_initial_shared_version,
                storage_amount,
                epochs_ahead,
                wal_coin_address,
            );
            let storage_arg = tx.move_call(
                Function::new(
                    system_address,
                    "system".parse().expect("valid identifier"),
                    "reserve_space".parse().expect("valid identifier"),
                ),
                reserve_args,
            );

            let register_args = walrus_tx::register_blob_inputs(
                tx,
                system_address,
                system_initial_shared_version,
                storage_arg,
                blob_id,
                root_hash,
                unencoded_length,
                encoding_type,
                deletable,
                wal_coin_address,
            );
            tx.move_call(
                Function::new(
                    system_address,
                    "system".parse().expect("valid identifier"),
                    "register_blob".parse().expect("valid identifier"),
                ),
                register_args,
            );
        },
        gas_budget,
    )
    .await
    .map_err(StoreBlobError::Reserve)?;
    let register_tx_digest = executed.digest.clone().unwrap_or_default();

    // 4. Find the newly-created Blob object's ID via a type-aware
    // follow-up read (see module doc for why the execution response's
    // effects alone don't carry object types).
    let blob_object_id =
        find_created_blob_object(http_client, sui_rpc_url, &register_tx_digest).await?;

    // 5. Upload the raw bytes to the relay; get back the confirmation
    // certificate.
    let certificate =
        walrus_upload_relay::upload_blob(http_client, upload_relay_url, blob_id, blob_bytes)
            .await
            .map_err(StoreBlobError::Upload)?;

    // 6. certify_blob, using the certificate's signer indices packed into
    // a bitmap.
    let (_, committee_size) =
        walrus_tx::fetch_n_shards_and_committee_size(http_client, sui_rpc_url, staking_object_id)
            .await
            .map_err(StoreBlobError::ChainRead)?;
    let signers_bitmap = walrus_tx::signers_to_bitmap(&certificate.signers, committee_size);
    let signature = certificate.signature.as_bytes().to_vec();
    let message = certificate.serialized_message.clone();
    let blob_object_address = parse_address(&blob_object_id)?;

    let executed = sui_tx::execute_ptb(
        rpc_client,
        signer,
        move |tx| {
            let blob_arg = tx.object(sui_transaction_builder::ObjectInput::new(blob_object_address));
            let certify_args = walrus_tx::certify_blob_inputs(
                tx,
                system_address,
                system_initial_shared_version,
                blob_arg,
                signature,
                signers_bitmap,
                message,
            );
            tx.move_call(
                Function::new(
                    system_address,
                    "system".parse().expect("valid identifier"),
                    "certify_blob".parse().expect("valid identifier"),
                ),
                certify_args,
            );
        },
        gas_budget,
    )
    .await
    .map_err(StoreBlobError::Certify)?;
    let certify_tx_digest = executed.digest.unwrap_or_default();

    Ok(StoreBlobResult {
        blob_id,
        blob_object_id,
        register_tx_digest,
        certify_tx_digest,
    })
}

/// Find the `Blob` object created by a transaction, via
/// `sui_getTransactionBlock` + `showObjectChanges: true` (plain JSON-RPC —
/// same low-level caller, `storage::sui::raw_rpc_call`, every other
/// on-chain read in this codebase already uses).
async fn find_created_blob_object(
    client: &reqwest::Client,
    rpc_url: &str,
    tx_digest: &str,
) -> Result<String, StoreBlobError> {
    let result = sui::raw_rpc_call(
        client,
        rpc_url,
        "sui_getTransactionBlock",
        serde_json::json!([tx_digest, { "showObjectChanges": true }]),
    )
    .await
    .map_err(StoreBlobError::BlobObjectNotFound)?;

    let changes = result
        .get("objectChanges")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreBlobError::BlobObjectNotFound("response has no objectChanges array".into())
        })?;

    changes
        .iter()
        .find(|c| {
            c.get("objectType")
                .and_then(|v| v.as_str())
                .is_some_and(|t| t.contains("::blob::Blob"))
        })
        .and_then(|c| c.get("objectId"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| {
            StoreBlobError::BlobObjectNotFound(format!(
                "no ::blob::Blob entry in objectChanges for tx {tx_digest}"
            ))
        })
}

fn parse_address(s: &str) -> Result<Address, StoreBlobError> {
    s.parse().map_err(|e| StoreBlobError::AddressParse(format!("{s:?}: {e}")))
}
