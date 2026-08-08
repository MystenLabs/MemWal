use super::{ObjectInfo, SharedObjectInfo, SuiEpoch, WalrusCallPackage};
use base64::Engine as _;
use sui_crypto::{SuiSigner, SuiVerifier};
use sui_sdk_types::{Address, Digest, Identifier, Transaction, TransactionExpiration};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};
use uuid::Uuid;

/// Leaves several KiB of headroom under Sui's 128-KiB TransactionData limit.
/// A 1000-blob transaction is ~138 KiB with SDK 0.3.1 and is invalid.
pub const MAX_DELETE_BLOBS_PER_TX: usize = 900;

/// Max reclaimed Storage objects per TransferObjects command. Sui caps a
/// single PTB command at `max_arguments = 512` (protocol v126) — measured
/// live: a 750-blob batch (751 transfer arguments) was rejected before
/// execution while 500 blobs (501 arguments) executed fine; see
/// docs-eng/reports/security-delete-benchmarks.md. 500 per chunk keeps each
/// command at ≤501 arguments (the largest empirically-executed size) and
/// total commands well under `max_programmable_tx_commands = 1024`:
/// N move calls + ceil(N/500) transfers = 902 at N=900.
const TRANSFER_OBJECTS_CHUNK: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltTx {
    pub tx_bytes: Vec<u8>,
    pub digest: String,
    pub nonce: u32,
    pub expire_epoch: u64,
    /// Blob ordering corresponding to owned PTB inputs 1..=N. Input zero is
    /// the shared Walrus System object.
    pub input_blob_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxBuildError(pub String);

impl std::fmt::Display for TxBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TxBuildError {}

#[allow(clippy::too_many_arguments)]
pub fn build_delete_tx(
    sender: &str,
    sponsor: &str,
    blobs: &[ObjectInfo],
    walrus_pkg: WalrusCallPackage<'_>,
    system_obj: &SharedObjectInfo,
    // SUI epoch — bounds the transaction via `ValidDuring`. The type makes it impossible to
    // pass the Walrus clock here: doing so (457 while Sui is at 1159) builds a transaction
    // already ~700 epochs expired, which every validator rejects before execution.
    epoch: SuiEpoch,
    gas_price: u64,
    gas_budget: u64,
    chain_digest: &[u8; 32],
    nonce: u32,
) -> Result<BuiltTx, TxBuildError> {
    if blobs.is_empty() {
        return Err(TxBuildError(
            "cannot build an empty delete transaction".into(),
        ));
    }
    if blobs.len() > MAX_DELETE_BLOBS_PER_TX {
        return Err(TxBuildError(format!(
            "delete transaction exceeds safe batch maximum of {MAX_DELETE_BLOBS_PER_TX}"
        )));
    }

    let sender = parse_address("sender", sender)?;
    let sponsor = parse_address("sponsor", sponsor)?;
    let package = parse_address("Walrus package", walrus_pkg.as_str())?;
    let system_id = parse_address("Walrus system object", &system_obj.object_id)?;

    let mut ordered = blobs.to_vec();
    ordered.sort_by(|left, right| {
        left.blob_id
            .as_deref()
            .unwrap_or_default()
            .cmp(right.blob_id.as_deref().unwrap_or_default())
            .then_with(|| left.object_id.cmp(&right.object_id))
    });
    if ordered
        .windows(2)
        .any(|pair| pair[0].object_id == pair[1].object_id)
    {
        return Err(TxBuildError(
            "duplicate blob object in delete transaction".into(),
        ));
    }

    let mut builder = TransactionBuilder::new();
    let system = builder.object(ObjectInput::shared(
        system_id,
        system_obj.initial_shared_version,
        system_obj.mutable,
    ));
    let module: Identifier = "system"
        .parse()
        .map_err(|error| TxBuildError(format!("invalid module: {error}")))?;
    let function_name: Identifier = "delete_blob"
        .parse()
        .map_err(|error| TxBuildError(format!("invalid function: {error}")))?;

    let mut reclaimed = Vec::with_capacity(ordered.len());
    let mut input_blob_ids = Vec::with_capacity(ordered.len());
    for blob in &ordered {
        let object_id = parse_address("blob object", &blob.object_id)?;
        let digest = blob
            .digest
            .parse::<Digest>()
            .map_err(|error| TxBuildError(format!("invalid blob object digest: {error}")))?;
        let object = builder.object(ObjectInput::owned(object_id, blob.version, digest));
        reclaimed.push(builder.move_call(
            Function::new(package, module.clone(), function_name.clone()),
            vec![system, object],
        ));
        input_blob_ids.push(
            blob.blob_id
                .clone()
                .ok_or_else(|| TxBuildError("blob object is missing blob_id".into()))?,
        );
    }
    let recipient = builder.pure(&sender);
    for chunk in reclaimed.chunks(TRANSFER_OBJECTS_CHUNK) {
        builder.transfer_objects(chunk.to_vec(), recipient);
    }
    builder.set_sender(sender);
    builder.set_sponsor(sponsor);
    builder.set_gas_price(gas_price);
    builder.set_gas_budget(gas_budget);
    builder.set_expiration(TransactionExpiration::ValidDuring {
        min_epoch: Some(epoch.get()),
        max_epoch: Some(epoch.get()),
        min_timestamp: None,
        max_timestamp: None,
        chain: Digest::new(*chain_digest),
        nonce,
    });

    // Builder 0.3.1 still validates legacy coin-gas presence even when the
    // final Transaction uses ValidDuring/address-balance gas. Supply a
    // validation-only reference, then remove it from the protocol object.
    builder.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    let mut transaction = builder
        .try_build()
        .map_err(|error| TxBuildError(format!("failed to build delete transaction: {error}")))?;
    transaction.gas_payment.objects.clear();

    let digest = transaction.digest().to_string();
    let tx_bytes = bcs::to_bytes(&transaction).map_err(|error| {
        TxBuildError(format!("failed to serialize delete transaction: {error}"))
    })?;
    Ok(BuiltTx {
        tx_bytes,
        digest,
        nonce,
        expire_epoch: epoch.get(),
        input_blob_ids,
    })
}

pub fn derive_nonce(batch_id: &Uuid) -> u32 {
    let bytes = batch_id.as_bytes();
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

/// Sign TransactionData intent bytes with a raw 32-byte Ed25519 secret key
/// encoded as standard or URL-safe base64. The returned bytes are the Sui
/// serialized user signature (scheme flag + signature + public key).
pub fn sponsor_signature(sponsor_key_b64: &str, tx_bytes: &[u8]) -> Result<Vec<u8>, TxBuildError> {
    let secret = decode_sponsor_key(sponsor_key_b64)?;
    let transaction: Transaction = bcs::from_bytes(tx_bytes)
        .map_err(|error| TxBuildError(format!("invalid transaction BCS: {error}")))?;
    let key = sui_crypto::ed25519::Ed25519PrivateKey::new(secret);
    let signature = key
        .sign_transaction(&transaction)
        .map_err(|error| TxBuildError(format!("failed to sign transaction: {error}")))?;
    key.verifying_key()
        .verify_transaction(&transaction, &signature)
        .map_err(|error| TxBuildError(format!("sponsor signature self-check failed: {error}")))?;
    Ok(signature.to_bytes())
}

pub fn sponsor_address(sponsor_key_b64: &str) -> Result<String, TxBuildError> {
    let key = sui_crypto::ed25519::Ed25519PrivateKey::new(decode_sponsor_key(sponsor_key_b64)?);
    Ok(key.public_key().derive_address().to_string())
}

fn decode_sponsor_key(sponsor_key_b64: &str) -> Result<[u8; 32], TxBuildError> {
    let secret = base64::engine::general_purpose::STANDARD
        .decode(sponsor_key_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sponsor_key_b64))
        .map_err(|error| TxBuildError(format!("invalid sponsor key base64: {error}")))?;
    secret
        .try_into()
        .map_err(|_| TxBuildError("sponsor Ed25519 key must be exactly 32 bytes".into()))
}

fn parse_address(label: &str, value: &str) -> Result<Address, TxBuildError> {
    value
        .parse()
        .map_err(|error| TxBuildError(format!("invalid {label} address: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sui::SuiEpoch;
    use crate::sui::WalrusCallPackage;
    use crate::sui::WalrusEpoch;
    use sui_sdk_types::{Command, TransactionKind, UserSignature};

    fn address(n: u8) -> String {
        format!("0x{n:02x}")
    }
    fn blob(n: u8) -> ObjectInfo {
        ObjectInfo {
            object_id: address(n),
            version: 1,
            digest: Digest::new([n; 32]).to_string(),
            owner: Some(address(200)),
            blob_id: Some(format!("blob-{n:04}")),
            end_epoch: Some(WalrusEpoch(500)),
            package_id: None,
        }
    }
    fn system() -> SharedObjectInfo {
        SharedObjectInfo {
            object_id: address(250),
            initial_shared_version: 7,
            mutable: true,
            package_id: None,
        }
    }
    fn build(blobs: &[ObjectInfo]) -> BuiltTx {
        build_delete_tx(
            &address(200),
            &address(201),
            blobs,
            WalrusCallPackage::from_chain(&address(202)),
            &system(),
            SuiEpoch(42),
            1000,
            10_000_000,
            &[9; 32],
            7,
        )
        .unwrap()
    }

    #[test]
    fn command_count_gas_and_expiration_are_correct() {
        let built = build(&[blob(3), blob(1), blob(2)]);
        let tx: Transaction = bcs::from_bytes(&built.tx_bytes).unwrap();
        let TransactionKind::ProgrammableTransaction(ptb) = &tx.kind else {
            panic!("expected PTB")
        };
        assert_eq!(ptb.commands.len(), 4);
        assert!(matches!(
            ptb.commands.last(),
            Some(Command::TransferObjects(_))
        ));
        assert!(tx.gas_payment.objects.is_empty());
        assert_eq!(tx.gas_payment.owner, address(201).parse().unwrap());
        assert!(matches!(
            tx.expiration,
            TransactionExpiration::ValidDuring {
                min_epoch: Some(42),
                max_epoch: Some(42),
                nonce: 7,
                ..
            }
        ));
        assert_eq!(
            built.input_blob_ids,
            ["blob-0001", "blob-0002", "blob-0003"]
        );
    }

    #[test]
    fn maximum_batch_stays_below_transaction_size_limit() {
        let blobs = (0..MAX_DELETE_BLOBS_PER_TX)
            .map(|n| ObjectInfo {
                object_id: format!("0x{:064x}", n + 1),
                version: 1,
                digest: Digest::new([(n % 251) as u8; 32]).to_string(),
                owner: Some(address(200)),
                blob_id: Some(format!("blob-{n:04}")),
                end_epoch: Some(WalrusEpoch(500)),
                package_id: None,
            })
            .collect::<Vec<_>>();
        let built = build(&blobs);
        assert!(
            built.tx_bytes.len() < 128 * 1024,
            "{} bytes",
            built.tx_bytes.len()
        );
        // All 900 blobs must survive chunking into `input_blob_ids`, not just
        // get silently dropped by an off-by-one in the chunk loop.
        assert_eq!(built.input_blob_ids.len(), MAX_DELETE_BLOBS_PER_TX);

        // Sui protocol limits (v126, confirmed live — see
        // security-delete-benchmarks.md): every command must take
        // <= max_arguments (512) and the PTB must stay under
        // max_programmable_tx_commands (1024). The chunked transfers are
        // what keep a 900-blob batch executable.
        let tx: Transaction = bcs::from_bytes(&built.tx_bytes).unwrap();
        let TransactionKind::ProgrammableTransaction(ptb) = &tx.kind else {
            panic!("expected PTB")
        };
        assert_eq!(
            ptb.commands.len(),
            MAX_DELETE_BLOBS_PER_TX + MAX_DELETE_BLOBS_PER_TX.div_ceil(TRANSFER_OBJECTS_CHUNK)
        );
        assert!(ptb.commands.len() <= 1024);
        let mut transferred_objects = 0;
        for command in &ptb.commands {
            if let Command::TransferObjects(transfer) = command {
                assert!(
                    transfer.objects.len() + 1 <= 512,
                    "TransferObjects with {} objects exceeds max_arguments",
                    transfer.objects.len()
                );
                transferred_objects += transfer.objects.len();
            }
        }
        // Every reclaimed Storage object actually lands in a TransferObjects
        // command — the chunking can't quietly leave some behind.
        assert_eq!(transferred_objects, MAX_DELETE_BLOBS_PER_TX);
    }

    #[test]
    fn offline_fixture_1000_blobs_exceeds_transaction_size_limit() {
        // Task 6 (empirical limits probe, Step 3): a synthetic, offline-only
        // fixture — no on-chain claim is made for N=1000, since
        // `build_delete_tx`'s guard rejects it before execution (see
        // `rejects_batch_that_would_exceed_safe_size` below). This
        // independently re-derives the same PTB shape at N=1000, bypassing
        // the guard, to confirm the module doc comment's "~138 KiB" claim
        // with a real measurement instead of a recalled estimate.
        let blobs = (0..1000)
            .map(|n| ObjectInfo {
                object_id: format!("0x{:064x}", n + 1),
                version: 1,
                digest: Digest::new([(n % 251) as u8; 32]).to_string(),
                owner: Some(address(200)),
                blob_id: Some(format!("blob-{n:04}")),
                end_epoch: Some(WalrusEpoch(500)),
                package_id: None,
            })
            .collect::<Vec<_>>();

        let sender: Address = address(200).parse().unwrap();
        let sponsor: Address = address(201).parse().unwrap();
        let package: Address = address(202).parse().unwrap();
        let sys = system();
        let system_id: Address = sys.object_id.parse().unwrap();

        let mut builder = TransactionBuilder::new();
        let system_input = builder.object(ObjectInput::shared(
            system_id,
            sys.initial_shared_version,
            sys.mutable,
        ));
        let module: Identifier = "system".parse().unwrap();
        let function_name: Identifier = "delete_blob".parse().unwrap();
        let mut reclaimed = Vec::with_capacity(blobs.len());
        for blob in &blobs {
            let object_id: Address = blob.object_id.parse().unwrap();
            let digest: Digest = blob.digest.parse().unwrap();
            let object = builder.object(ObjectInput::owned(object_id, blob.version, digest));
            reclaimed.push(builder.move_call(
                Function::new(package, module.clone(), function_name.clone()),
                vec![system_input, object],
            ));
        }
        let recipient = builder.pure(&sender);
        for chunk in reclaimed.chunks(TRANSFER_OBJECTS_CHUNK) {
            builder.transfer_objects(chunk.to_vec(), recipient);
        }
        builder.set_sender(sender);
        builder.set_sponsor(sponsor);
        builder.set_gas_price(1000);
        builder.set_gas_budget(10_000_000);
        builder.set_expiration(TransactionExpiration::ValidDuring {
            min_epoch: Some(42),
            max_epoch: Some(42),
            min_timestamp: None,
            max_timestamp: None,
            chain: Digest::new([9; 32]),
            nonce: 7,
        });
        builder.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
        let mut transaction = builder.try_build().unwrap();
        transaction.gas_payment.objects.clear();
        let tx_bytes = bcs::to_bytes(&transaction).unwrap();

        println!(
            "[fixture] N=1000 offline tx_bytes = {} bytes ({:.1} KiB)",
            tx_bytes.len(),
            tx_bytes.len() as f64 / 1024.0
        );
        assert!(
            tx_bytes.len() > 128 * 1024,
            "expected the N=1000 fixture to exceed Sui's 128 KiB TransactionData limit, got {} bytes",
            tx_bytes.len()
        );
    }

    #[test]
    fn rejects_batch_that_would_exceed_safe_size() {
        let blobs = (0..=MAX_DELETE_BLOBS_PER_TX)
            .map(|n| ObjectInfo {
                object_id: format!("0x{:064x}", n + 1),
                version: 1,
                digest: Digest::new([(n % 251) as u8; 32]).to_string(),
                owner: Some(address(200)),
                blob_id: Some(format!("blob-{n:04}")),
                end_epoch: Some(WalrusEpoch(500)),
                package_id: None,
            })
            .collect::<Vec<_>>();
        assert!(build_delete_tx(
            &address(200),
            &address(201),
            &blobs,
            WalrusCallPackage::from_chain(&address(202)),
            &system(),
            SuiEpoch(42),
            1000,
            10_000_000,
            &[9; 32],
            7
        )
        .is_err());
    }

    #[test]
    fn nonce_is_stable() {
        let id = Uuid::parse_str("11223344-0000-0000-0000-000000000000").unwrap();
        assert_eq!(derive_nonce(&id), 0x11223344);
    }

    #[test]
    fn sponsor_signature_is_deterministic_and_valid() {
        let built = build(&[blob(1)]);
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        let first = sponsor_signature(&key, &built.tx_bytes).unwrap();
        let second = sponsor_signature(&key, &built.tx_bytes).unwrap();
        assert_eq!(first, second);
        let signature = UserSignature::from_bytes(&first).unwrap();
        let tx: Transaction = bcs::from_bytes(&built.tx_bytes).unwrap();
        let private = sui_crypto::ed25519::Ed25519PrivateKey::new([7u8; 32]);
        private
            .verifying_key()
            .verify_transaction(&tx, &signature)
            .unwrap();
    }
}
