//! Native Sui transaction building, signing, and submission.
//!
//! Foundation for migrating the Walrus write path (register/upload/certify)
//! and `/sponsor/execute` off the Node sidecar (WALM-184). Uses Mysten's
//! lightweight `sui-rust-sdk` crates (sui-sdk-types, sui-crypto,
//! sui-transaction-builder, sui-rpc) — not the full `sui` node monorepo,
//! which pulls in a permanently-yanked `core2` dependency via `seal-sdk-rs`
//! and cannot currently be built (see services/server/Cargo.toml).
//!
//! This module only builds/signs/submits generic Move-call transactions; it
//! does not yet know the Walrus package's specific register/certify Move
//! function signatures — that wiring is a separate, not-yet-done step.

use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::{Address, Identifier, TypeTag};
use sui_transaction_builder::{Argument, Function, TransactionBuilder};

#[derive(Debug)]
pub enum SuiTxError {
    InvalidKey(String),
    Build(String),
    Sign(String),
    Rpc(String),
}

impl std::fmt::Display for SuiTxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidKey(m) => write!(f, "invalid Sui signing key: {m}"),
            Self::Build(m) => write!(f, "failed to build transaction: {m}"),
            Self::Sign(m) => write!(f, "failed to sign transaction: {m}"),
            Self::Rpc(m) => write!(f, "Sui RPC error: {m}"),
        }
    }
}

impl std::error::Error for SuiTxError {}

/// Wraps the server's Ed25519 signing key together with its derived Sui
/// address (`hash(0x00 || pubkey)` — see `Ed25519PublicKey::derive_address`).
pub struct SuiSignerContext {
    key: Ed25519PrivateKey,
    address: Address,
}

impl SuiSignerContext {
    /// Parse the same hex-encoded 32-byte Ed25519 secret key format already
    /// used for `SERVER_SUI_PRIVATE_KEY` elsewhere in this server.
    pub fn from_hex_key(hex_key: &str) -> Result<Self, SuiTxError> {
        let bytes = hex::decode(hex_key.trim())
            .map_err(|e| SuiTxError::InvalidKey(format!("not valid hex: {e}")))?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
            SuiTxError::InvalidKey(format!("expected 32 bytes, got {}", v.len()))
        })?;
        let key = Ed25519PrivateKey::new(bytes);
        let address = key.public_key().derive_address();
        Ok(Self { key, address })
    }

    pub fn address(&self) -> Address {
        self.address
    }
}

/// Build, sign, and submit an arbitrary PTB (any number of chained Move
/// calls) paid for by this signer's gas coin. Gas coin selection and gas
/// price are resolved automatically via RPC (see
/// `TransactionBuilder::build`).
///
/// `build_ptb` receives the in-progress builder and does all of its own
/// `tx.object()`/`tx.pure()`/`tx.move_call()` calls — e.g. chaining a
/// `reserve_space` call's returned `Argument` directly into a following
/// `register_blob` call within the same transaction, with no extra object
/// lookup in between, exactly like `walrus-sui`'s own PTB builder does.
///
/// THIS FUNCTION SIGNS AND SUBMITS A REAL TRANSACTION. Callers must treat
/// invoking it as a fund-moving action requiring the same care as any other
/// on-chain transaction — see the "Executing actions with care" guidance
/// this server's development follows.
pub async fn execute_ptb(
    client: &mut sui_rpc::Client,
    signer: &SuiSignerContext,
    build_ptb: impl FnOnce(&mut TransactionBuilder),
    gas_budget: u64,
) -> Result<sui_rpc::proto::sui::rpc::v2::ExecutedTransaction, SuiTxError> {
    let mut tx = TransactionBuilder::new();
    build_ptb(&mut tx);
    tx.set_sender(signer.address);
    tx.set_gas_budget(gas_budget);

    let transaction = tx
        .build(client)
        .await
        .map_err(|e| SuiTxError::Build(e.to_string()))?;

    let signature = signer
        .key
        .sign_transaction(&transaction)
        .map_err(|e| SuiTxError::Sign(e.to_string()))?;

    let request = sui_rpc::proto::sui::rpc::v2::ExecuteTransactionRequest::default()
        .with_transaction(transaction)
        .with_signatures(vec![signature.into()]);
    let response = client
        .execution_client()
        .execute_transaction(request)
        .await
        .map_err(|e| SuiTxError::Rpc(e.to_string()))?;

    response
        .into_inner()
        .transaction
        .ok_or_else(|| SuiTxError::Rpc("response missing executed transaction".into()))
}

/// Build, sign, and submit a single-Move-call transaction. Convenience
/// wrapper over [`execute_ptb`] for the common one-call case.
///
/// `add_inputs` receives the in-progress builder so the caller can add
/// pure/object inputs before the call arguments are assembled; it returns
/// the `Argument`s to pass to the Move function, in order.
pub async fn execute_move_call(
    client: &mut sui_rpc::Client,
    signer: &SuiSignerContext,
    package: Address,
    module: &str,
    function: &str,
    type_args: Vec<TypeTag>,
    add_inputs: impl FnOnce(&mut TransactionBuilder) -> Vec<Argument>,
    gas_budget: u64,
) -> Result<sui_rpc::proto::sui::rpc::v2::ExecutedTransaction, SuiTxError> {
    let module: Identifier = module
        .parse()
        .map_err(|e| SuiTxError::Build(format!("invalid module name {module:?}: {e}")))?;
    let function_ident: Identifier = function
        .parse()
        .map_err(|e| SuiTxError::Build(format!("invalid function name {function:?}: {e}")))?;

    execute_ptb(
        client,
        signer,
        |tx| {
            let arguments = add_inputs(tx);
            let f = Function::new(package, module, function_ident).with_type_args(type_args);
            tx.move_call(f, arguments);
        },
        gas_budget,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_derivation_matches_independently_computed_vector() {
        // Cross-checked against an independent Python computation
        // (PyNaCl Ed25519 pubkey from an all-zero seed, then
        // blake2b256(0x00 || pubkey)) matching the derivation formula
        // documented on `Ed25519PublicKey::derive_address` in sui-sdk-types.
        let hex_key = "00".repeat(32);
        let ctx = SuiSignerContext::from_hex_key(&hex_key).unwrap();
        assert_eq!(
            ctx.address().to_string(),
            "0x7a1378aafadef8ce743b72e8b248295c8f61c102c94040161146ea4d51a182b6"
        );
    }

    #[test]
    fn from_hex_key_rejects_wrong_length() {
        assert!(matches!(
            SuiSignerContext::from_hex_key("00"),
            Err(SuiTxError::InvalidKey(_))
        ));
    }

    #[test]
    fn from_hex_key_rejects_non_hex() {
        assert!(matches!(
            SuiSignerContext::from_hex_key("not-hex-at-all-not-hex-at-all-not-hex-at"),
            Err(SuiTxError::InvalidKey(_))
        ));
    }
}
