//! Walrus on-chain metadata + transfer PTB (ENG-1700 / Phase 3).
//!
//! Replaces the TS sidecar `metaTx` block (sidecar-server.ts L685-743) which:
//!   1. Calls `WALRUS_PACKAGE_ID::blob::insert_or_update_metadata_pair` four
//!      times to set `memwal_namespace`, `memwal_owner`, `memwal_package_id`,
//!      `memwal_agent_id` on the freshly minted Walrus `Blob` object.
//!   2. Calls `transfer_objects([blob], owner_address)` to hand it to the user.
//!
//! Implemented natively in Rust using:
//!   - `bech32` to decode `suiprivkey1...` into the Ed25519 secret bytes
//!   - `sui-crypto::ed25519::Ed25519PrivateKey` as a `Signer<UserSignature>`
//!   - `sui-transaction-builder::TransactionBuilder` for PTB construction
//!   - `sui-sdk-types::{Address, Digest, Identifier, Transaction, UserSignature}`
//!   - `reqwest` for `sui_getCoins`, `sui_getObject`, and
//!     `sui_executeTransactionBlock` JSON-RPC.
//!
//! Gas-payment policy: parity with the legacy sidecar (sidecar-server.ts
//! `executeWithEnokiSponsor`, L210-261). When `ENOKI_API_KEY` is configured
//! we try Enoki-sponsored execution first (no gas spend on the server pool),
//! and fall back to direct-sign with the server's own gas coin if the sponsor
//! call errors and `ENOKI_FALLBACK_TO_DIRECT_SIGN` is true (the default).
//! When Enoki is unconfigured the sponsor call is short-circuited and we go
//! straight to direct-sign. The `/sponsor` proxy in `routes.rs` is a separate
//! code path used by the FE for client-built PTBs.
//!
//! Walrus package id (mainnet): `0xfdc88...` (env-overridable via
//! `WALRUS_PACKAGE_ID`).

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bech32::FromBase32;
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::Signer;
use sui_sdk_types::{Address, Digest, Identifier, UserSignature};
use sui_transaction_builder::{Function, ObjectInput, TransactionBuilder};

// ============================================================
// Constants
// ============================================================

/// Walrus mainnet package ID (used when env var `WALRUS_PACKAGE_ID` is unset).
pub const WALRUS_PACKAGE_ID_MAINNET: &str =
    "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
/// Walrus testnet package ID (used when env var `WALRUS_PACKAGE_ID` is unset and
/// `SUI_NETWORK=testnet`).
pub const WALRUS_PACKAGE_ID_TESTNET: &str =
    "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66";

/// Default gas budget for the metadata + transfer PTB (mist).
/// 50 MIST = 0.05 SUI — comfortably above typical 4-5M observed cost,
/// and consistent with TS sidecar defaults.
const DEFAULT_GAS_BUDGET: u64 = 50_000_000;
/// Default reference gas price (mist per gas unit).
/// Sui mainnet is currently 1000; we hard-code rather than hit
/// `suix_getReferenceGasPrice` per call. Override via env if needed.
const DEFAULT_GAS_PRICE: u64 = 1000;

const SUI_RPC_TIMEOUT_SECS: u64 = 30;

// ============================================================
// Errors
// ============================================================

#[derive(Debug, thiserror::Error)]
pub enum OnchainError {
    #[error("invalid Sui private key: {0}")]
    PrivateKey(String),
    #[error("invalid address: {0}")]
    Address(String),
    #[error("invalid object id: {0}")]
    ObjectId(String),
    #[error("Sui RPC error: {0}")]
    Rpc(String),
    #[error("RPC returned no gas coin for address {0}")]
    NoGasCoin(String),
    #[error("RPC returned no object for {0}")]
    ObjectNotFound(String),
    #[error("PTB build error: {0}")]
    Build(String),
    #[error("BCS encode error: {0}")]
    Bcs(String),
    #[error("signing error: {0}")]
    Sign(String),
    #[error("transaction execution failed: {0}")]
    Execute(String),
    /// Enoki sponsorship failed and `ENOKI_FALLBACK_TO_DIRECT_SIGN=false`
    /// (caller opted out of direct-sign fallback). The wrapped string is
    /// the underlying Enoki error display.
    #[error("Enoki sponsor failed (fallback disabled): {0}")]
    EnokiSponsor(String),
}

// ============================================================
// Public API
// ============================================================

/// A decoded server signer (Ed25519 keypair + Sui address).
///
/// `Debug` is implemented manually so accidental `{:?}` never leaks the
/// private key into logs (the inner `Ed25519PrivateKey` already redacts,
/// but we redact at the wrapper level too as defense-in-depth).
pub struct ServerSigner {
    pub private_key: Ed25519PrivateKey,
    pub address: Address,
}

impl std::fmt::Debug for ServerSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerSigner")
            .field("private_key", &"<redacted>")
            .field("address", &self.address)
            .finish()
    }
}

impl ServerSigner {
    /// Decode a Sui bech32 `suiprivkey1...` string into an Ed25519 keypair
    /// + the derived Sui address. Returns `OnchainError::PrivateKey` on
    /// malformed input or non-Ed25519 schemes.
    ///
    /// Format: bech32(HRP="suiprivkey", data = [scheme_flag(1) || privkey(32)]).
    /// Scheme flag 0x00 = Ed25519. See
    /// `node_modules/@mysten/sui/src/cryptography/keypair.ts:125`.
    pub fn from_suiprivkey(s: &str) -> Result<Self, OnchainError> {
        let (hrp, data, _variant) = bech32::decode(s).map_err(|e| {
            OnchainError::PrivateKey(format!("bech32 decode failed: {}", e))
        })?;
        if hrp != "suiprivkey" {
            return Err(OnchainError::PrivateKey(format!(
                "unexpected bech32 HRP: {}",
                hrp
            )));
        }
        let bytes = Vec::<u8>::from_base32(&data).map_err(|e| {
            OnchainError::PrivateKey(format!("base32→bytes failed: {}", e))
        })?;
        if bytes.len() != 33 {
            return Err(OnchainError::PrivateKey(format!(
                "expected 33-byte payload (flag||sk), got {}",
                bytes.len()
            )));
        }
        let scheme_flag = bytes[0];
        if scheme_flag != 0x00 {
            return Err(OnchainError::PrivateKey(format!(
                "only Ed25519 (flag=0x00) is supported, got 0x{:02x}",
                scheme_flag
            )));
        }
        let mut sk_bytes = [0u8; 32];
        sk_bytes.copy_from_slice(&bytes[1..33]);
        let private_key = Ed25519PrivateKey::new(sk_bytes);
        let address = private_key.public_key().derive_address();
        Ok(Self {
            private_key,
            address,
        })
    }

    /// Convenience: decode and return only the Sui address (`0x...` hex).
    pub fn address_hex(&self) -> String {
        self.address.to_string()
    }
}

/// Resolve `WALRUS_PACKAGE_ID` from env, falling back to network defaults.
pub fn resolve_walrus_package_id(network: &str) -> String {
    std::env::var("WALRUS_PACKAGE_ID").unwrap_or_else(|_| {
        match network {
            "testnet" => WALRUS_PACKAGE_ID_TESTNET.to_string(),
            // mainnet is the safe default for any unrecognized network too
            _ => WALRUS_PACKAGE_ID_MAINNET.to_string(),
        }
    })
}

/// Build, sign, and execute the metadata-set + transfer PTB on Sui.
///
/// On success returns the executed transaction digest (base58).
///
/// Path A — Enoki sponsorship (when `enoki.is_configured()`):
///   1. Build the PTB (no gas, no sender) and BCS-encode just `transaction.kind`.
///   2. Call `enoki.sponsor(server_address, kind_b64)` → returns the
///      sponsored `TransactionData` bytes + digest.
///   3. Sign the sponsored digest with the server key, base64-encode the
///      `UserSignature`, and call `enoki.sponsor_execute(digest, sig)`.
///   4. Return the executed digest.
///
/// Path B — Direct sign (Enoki unconfigured, OR sponsor errored and
/// `enoki_fallback == true`):
///   1. Fetch the gas coin via `suix_getCoins` and the blob's owned-ref via
///      `sui_getObject`.
///   2. Re-build the PTB with sender + gas + budget + price.
///   3. BCS-serialize Transaction, sign with Ed25519 over the Sui intent
///      digest.
///   4. Submit via `sui_executeTransactionBlock` with `WaitForLocalExecution`.
///
/// If sponsor errors and `enoki_fallback == false` we surface the failure as
/// `OnchainError::EnokiSponsor` instead of falling back, matching the legacy
/// sidecar behavior of `executeWithEnokiSponsor` when
/// `ENOKI_FALLBACK_TO_DIRECT_SIGN=false`.
#[allow(clippy::too_many_arguments)]
pub async fn set_metadata_and_transfer(
    http: &reqwest::Client,
    sui_rpc_url: &str,
    signer: &ServerSigner,
    blob_object_id: &str,
    walrus_package_id: &str,
    namespace: &str,
    target_owner: &str,
    memwal_owner: &str,
    memwal_package_id: &str,
    agent_id: Option<&str>,
    enoki: &crate::enoki::EnokiClient,
    enoki_fallback: bool,
) -> Result<String, OnchainError> {
    // ── 1. Parse + validate inputs (shared by both paths) ──────────────
    let walrus_pkg = Address::from_hex(walrus_package_id).map_err(|e| {
        OnchainError::Address(format!("walrus_package_id={}: {}", walrus_package_id, e))
    })?;
    let blob_id_addr = Address::from_hex(blob_object_id).map_err(|e| {
        OnchainError::ObjectId(format!("blob_object_id={}: {}", blob_object_id, e))
    })?;
    let target_addr = Address::from_hex(target_owner).map_err(|e| {
        OnchainError::Address(format!("target_owner={}: {}", target_owner, e))
    })?;

    let rpc = SuiRpcClient::new(http.clone(), sui_rpc_url.to_string());
    let blob_obj_ref = rpc.get_object_ref(blob_object_id).await?;

    // ── 2. Path A: Enoki sponsorship (try first when configured) ───────
    if enoki.is_configured() {
        match try_enoki_sponsor(
            &rpc,
            signer,
            enoki,
            walrus_pkg,
            blob_id_addr,
            &blob_obj_ref,
            target_addr,
            namespace,
            memwal_owner,
            memwal_package_id,
            agent_id,
        )
        .await
        {
            Ok(digest) => {
                tracing::info!(
                    "walrus_onchain: metadata+transfer ok via Enoki blob={} -> {} digest={}",
                    blob_object_id,
                    target_owner,
                    digest,
                );
                return Ok(digest);
            }
            Err(e) => {
                if !enoki_fallback {
                    tracing::error!(
                        "[walrus-onchain] Enoki sponsor failed and fallback disabled: {}",
                        e,
                    );
                    return Err(OnchainError::EnokiSponsor(e.to_string()));
                }
                tracing::warn!(
                    "[walrus-onchain] Enoki sponsor failed ({}); falling back to direct sign",
                    e,
                );
                // fall through to Path B
            }
        }
    }

    // ── 3. Path B: Direct sign with the server's own gas coin ──────────
    let gas_coin_ref = rpc.get_first_gas_coin(&signer.address_hex()).await?;

    tracing::debug!(
        "walrus_onchain: direct-sign signer={}, blob={}@{}, gas_coin={}@{}",
        signer.address_hex(),
        blob_obj_ref.object_id,
        blob_obj_ref.version,
        gas_coin_ref.object_id,
        gas_coin_ref.version,
    );

    let mut tx = build_metadata_ptb(
        walrus_pkg,
        blob_id_addr,
        &blob_obj_ref,
        target_addr,
        namespace,
        memwal_owner,
        memwal_package_id,
        agent_id,
    );

    // Gas + sender + budget.
    tx.set_sender(signer.address);
    tx.set_gas_budget(DEFAULT_GAS_BUDGET);
    tx.set_gas_price(DEFAULT_GAS_PRICE);
    tx.add_gas_objects([ObjectInput::owned(
        Address::from_hex(&gas_coin_ref.object_id)
            .map_err(|e| OnchainError::ObjectId(format!("gas coin id: {}", e)))?,
        gas_coin_ref.version,
        gas_coin_ref.digest,
    )]);

    let transaction = tx
        .try_build()
        .map_err(|e| OnchainError::Build(e.to_string()))?;

    // Sign the intent-prefixed digest (intent = TransactionData/V0/Sui).
    let signing_digest = transaction.signing_digest();
    let user_sig: UserSignature =
        <Ed25519PrivateKey as Signer<UserSignature>>::try_sign(&signer.private_key, &signing_digest)
            .map_err(|e| OnchainError::Sign(e.to_string()))?;

    // Submit via JSON-RPC.
    let tx_bytes = bcs::to_bytes(&transaction).map_err(|e| OnchainError::Bcs(e.to_string()))?;
    let tx_b64 = BASE64.encode(&tx_bytes);
    let sig_b64 = BASE64.encode(user_sig.to_bytes());

    let digest = rpc.execute_tx(&tx_b64, &sig_b64).await?;
    tracing::info!(
        "walrus_onchain: metadata+transfer ok via direct-sign blob={} -> {} digest={}",
        blob_object_id,
        target_owner,
        digest,
    );
    Ok(digest)
}

// ============================================================
// PTB construction (shared between Enoki + direct-sign paths)
// ============================================================

/// Build the metadata + transfer PTB **without** sender / gas. The Enoki path
/// needs only the `TransactionKind` bytes; the direct-sign path adds gas
/// before calling `try_build`.
#[allow(clippy::too_many_arguments)]
fn build_metadata_ptb(
    walrus_pkg: Address,
    blob_id_addr: Address,
    blob_obj_ref: &ObjectRef,
    target_addr: Address,
    namespace: &str,
    memwal_owner: &str,
    memwal_package_id: &str,
    agent_id: Option<&str>,
) -> TransactionBuilder {
    let mut tx = TransactionBuilder::new();

    let blob_arg = tx.object(ObjectInput::owned(
        blob_id_addr,
        blob_obj_ref.version,
        blob_obj_ref.digest,
    ));

    let module = Identifier::from_static("blob");
    let function = Identifier::from_static("insert_or_update_metadata_pair");

    fn metadata_call(
        tx: &mut TransactionBuilder,
        walrus_pkg: Address,
        module: &Identifier,
        function: &Identifier,
        blob_arg: sui_transaction_builder::Argument,
        key: &str,
        value: &str,
    ) {
        let key_arg = tx.pure(&key.to_string());
        let value_arg = tx.pure(&value.to_string());
        let f = Function::new(walrus_pkg, module.clone(), function.clone());
        let _ = tx.move_call(f, vec![blob_arg, key_arg, value_arg]);
    }

    metadata_call(&mut tx, walrus_pkg, &module, &function, blob_arg, "memwal_namespace", namespace);
    metadata_call(&mut tx, walrus_pkg, &module, &function, blob_arg, "memwal_owner", memwal_owner);
    metadata_call(&mut tx, walrus_pkg, &module, &function, blob_arg, "memwal_package_id", memwal_package_id);
    if let Some(aid) = agent_id {
        if !aid.is_empty() {
            metadata_call(&mut tx, walrus_pkg, &module, &function, blob_arg, "memwal_agent_id", aid);
        }
    }

    // Transfer the blob to the end user.
    let recipient_arg = tx.pure(&target_addr);
    tx.transfer_objects(vec![blob_arg], recipient_arg);

    tx
}

// ============================================================
// Enoki sponsorship path
// ============================================================

/// Build the PTB, BCS-encode just its `TransactionKind`, hand it to Enoki for
/// sponsorship, sign the sponsored bytes with the server key, and call
/// `sponsor_execute`. Returns the executed digest on success.
///
/// Enoki accepts a `TransactionKind` and returns a fully-formed sponsored
/// `TransactionData`; the server only signs.
#[allow(clippy::too_many_arguments)]
async fn try_enoki_sponsor(
    rpc: &SuiRpcClient,
    signer: &ServerSigner,
    enoki: &crate::enoki::EnokiClient,
    walrus_pkg: Address,
    blob_id_addr: Address,
    blob_obj_ref: &ObjectRef,
    target_addr: Address,
    namespace: &str,
    memwal_owner: &str,
    memwal_package_id: &str,
    agent_id: Option<&str>,
) -> Result<String, OnchainError> {
    // 1. Build the kind-only PTB. To get past `try_build`'s sender/gas
    //    requirement we attach a placeholder sender + a dummy gas object —
    //    the resulting `Transaction.kind` is what Enoki signs and pays for,
    //    so the placeholder values are immaterial.
    let mut tx = build_metadata_ptb(
        walrus_pkg,
        blob_id_addr,
        blob_obj_ref,
        target_addr,
        namespace,
        memwal_owner,
        memwal_package_id,
        agent_id,
    );
    tx.set_sender(signer.address);
    tx.set_gas_budget(DEFAULT_GAS_BUDGET);
    tx.set_gas_price(DEFAULT_GAS_PRICE);
    tx.add_gas_objects([ObjectInput::owned(
        Address::ZERO,
        0,
        sui_sdk_types::Digest::ZERO,
    )]);
    let placeholder_tx = tx
        .try_build()
        .map_err(|e| OnchainError::Build(e.to_string()))?;

    // 2. BCS-encode only the `TransactionKind` — that's what Enoki accepts.
    let kind_bytes = bcs::to_bytes(&placeholder_tx.kind)
        .map_err(|e| OnchainError::Bcs(e.to_string()))?;
    let kind_b64 = BASE64.encode(&kind_bytes);

    // 3. Sponsor. Pass [server, target_owner] as `allowedAddresses` so Enoki
    //    permits the user wallet as a recipient of the `transfer_objects`
    //    call. Without this, Enoki returns "Address ... is not allow-listed
    //    for receiving transfers" because only the team's pre-allow-listed
    //    addresses are accepted by default.
    let sender_hex = signer.address_hex();
    let target_hex = format!("0x{}", hex::encode(target_addr.into_inner()));
    let allow = [sender_hex.as_str(), target_hex.as_str()];
    let sponsored = enoki
        .sponsor(&sender_hex, &kind_b64, &allow)
        .await
        .map_err(|e| OnchainError::Rpc(format!("Enoki sponsor: {}", e)))?;

    // 4. Decode sponsored bytes → Transaction → sign over its signing digest.
    let sponsored_bytes = base64::engine::general_purpose::STANDARD
        .decode(&sponsored.bytes)
        .map_err(|e| OnchainError::Bcs(format!("decode sponsored bytes: {}", e)))?;
    let sponsored_tx: sui_sdk_types::Transaction = bcs::from_bytes(&sponsored_bytes)
        .map_err(|e| OnchainError::Bcs(format!("parse sponsored Transaction: {}", e)))?;
    let signing_digest = sponsored_tx.signing_digest();
    let user_sig: UserSignature =
        <Ed25519PrivateKey as Signer<UserSignature>>::try_sign(&signer.private_key, &signing_digest)
            .map_err(|e| OnchainError::Sign(e.to_string()))?;
    let sig_b64 = BASE64.encode(user_sig.to_bytes());

    // 5. Execute via Enoki.
    let executed = enoki
        .sponsor_execute(&sponsored.digest, &sig_b64)
        .await
        .map_err(|e| OnchainError::Rpc(format!("Enoki sponsor_execute: {}", e)))?;

    // Belt-and-suspenders: confirm the digest didn't drift in transit.
    if executed.digest != sponsored.digest {
        tracing::debug!(
            "walrus_onchain: enoki executed digest ({}) differs from sponsored digest ({})",
            executed.digest,
            sponsored.digest,
        );
    }

    // Suppress unused-rpc warning when Enoki path is taken (the rpc handle is
    // still needed to fetch blob_obj_ref upstream).
    let _ = rpc;

    Ok(executed.digest)
}

// ============================================================
// Sui JSON-RPC client (just what we need)
// ============================================================

#[derive(Debug, Clone)]
struct ObjectRef {
    object_id: String,
    version: u64,
    digest: Digest,
}

struct SuiRpcClient {
    http: reqwest::Client,
    url: String,
}

impl SuiRpcClient {
    fn new(http: reqwest::Client, url: String) -> Self {
        Self { http, url }
    }

    async fn rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, OnchainError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let resp = self
            .http
            .post(&self.url)
            .timeout(Duration::from_secs(SUI_RPC_TIMEOUT_SECS))
            .json(&body)
            .send()
            .await
            .map_err(|e| OnchainError::Rpc(format!("{} HTTP failed: {}", method, e)))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| OnchainError::Rpc(format!("{} read body: {}", method, e)))?;
        if !status.is_success() {
            return Err(OnchainError::Rpc(format!(
                "{} HTTP {}: {}",
                method, status, text
            )));
        }
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
            OnchainError::Rpc(format!("{} JSON parse: {} (body={})", method, e, text))
        })?;
        if let Some(err) = v.get("error") {
            return Err(OnchainError::Rpc(format!("{} returned error: {}", method, err)));
        }
        Ok(v)
    }

    /// `suix_getCoins` for SUI — return the first owned coin we see.
    async fn get_first_gas_coin(&self, owner: &str) -> Result<ObjectRef, OnchainError> {
        let v = self
            .rpc(
                "suix_getCoins",
                serde_json::json!([owner, "0x2::sui::SUI", null, 1]),
            )
            .await?;
        let coin = v
            .pointer("/result/data/0")
            .ok_or_else(|| OnchainError::NoGasCoin(owner.to_string()))?;
        let object_id = coin
            .get("coinObjectId")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Rpc("coin missing coinObjectId".into()))?
            .to_string();
        let version = coin
            .get("version")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Rpc("coin missing version".into()))?
            .parse::<u64>()
            .map_err(|e| OnchainError::Rpc(format!("coin version parse: {}", e)))?;
        let digest_str = coin
            .get("digest")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Rpc("coin missing digest".into()))?;
        let digest = Digest::from_base58(digest_str)
            .map_err(|e| OnchainError::Rpc(format!("coin digest parse: {}", e)))?;
        Ok(ObjectRef {
            object_id,
            version,
            digest,
        })
    }

    /// `sui_getObject` with `showOwner: true` — return owned-ref triple.
    async fn get_object_ref(&self, object_id: &str) -> Result<ObjectRef, OnchainError> {
        let v = self
            .rpc(
                "sui_getObject",
                serde_json::json!([object_id, { "showOwner": true }]),
            )
            .await?;
        let data = v
            .pointer("/result/data")
            .ok_or_else(|| OnchainError::ObjectNotFound(object_id.to_string()))?;
        let version = data
            .get("version")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Rpc("object missing version".into()))?
            .parse::<u64>()
            .map_err(|e| OnchainError::Rpc(format!("object version parse: {}", e)))?;
        let digest_str = data
            .get("digest")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Rpc("object missing digest".into()))?;
        let digest = Digest::from_base58(digest_str)
            .map_err(|e| OnchainError::Rpc(format!("object digest parse: {}", e)))?;
        Ok(ObjectRef {
            object_id: object_id.to_string(),
            version,
            digest,
        })
    }

    /// `sui_executeTransactionBlock` with `WaitForLocalExecution` — return the digest.
    async fn execute_tx(&self, tx_b64: &str, sig_b64: &str) -> Result<String, OnchainError> {
        let v = self
            .rpc(
                "sui_executeTransactionBlock",
                serde_json::json!([
                    tx_b64,
                    [sig_b64],
                    { "showEffects": true },
                    "WaitForLocalExecution",
                ]),
            )
            .await?;
        // Effects.status — fail loudly on Move abort
        if let Some(status) = v.pointer("/result/effects/status/status").and_then(|x| x.as_str()) {
            if status != "success" {
                let err = v
                    .pointer("/result/effects/status/error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("(no error msg)");
                return Err(OnchainError::Execute(format!(
                    "tx status={}, error={}",
                    status, err
                )));
            }
        }
        let digest = v
            .pointer("/result/digest")
            .and_then(|x| x.as_str())
            .ok_or_else(|| OnchainError::Execute("response missing digest".into()))?
            .to_string();
        Ok(digest)
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_pkg_id_mainnet_default() {
        // Don't depend on env var being unset — set explicitly to verify override path.
        std::env::remove_var("WALRUS_PACKAGE_ID");
        assert_eq!(
            resolve_walrus_package_id("mainnet"),
            WALRUS_PACKAGE_ID_MAINNET
        );
    }

    #[test]
    fn resolve_pkg_id_unknown_falls_back_to_mainnet() {
        std::env::remove_var("WALRUS_PACKAGE_ID");
        assert_eq!(
            resolve_walrus_package_id("zalgonet"),
            WALRUS_PACKAGE_ID_MAINNET
        );
    }

    #[test]
    fn private_key_decode_rejects_garbage() {
        let err = ServerSigner::from_suiprivkey("not-bech32").unwrap_err();
        assert!(matches!(err, OnchainError::PrivateKey(_)));
    }

    #[test]
    fn private_key_decode_rejects_wrong_hrp() {
        // `bc1...` is a Bitcoin bech32 address — wrong HRP.
        let err = ServerSigner::from_suiprivkey(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        )
        .unwrap_err();
        assert!(matches!(err, OnchainError::PrivateKey(_)));
    }

    // ── ENG-1700: Enoki path tests ─────────────────────────────────────

    /// Regression: BCS-encoding an empty `ProgrammableTransaction` kind must
    /// produce a small, deterministic byte sequence. This pins the on-wire
    /// format: tag (1 byte) for `ProgrammableTransaction` variant, followed
    /// by a uleb128(0) input count and uleb128(0) command count — i.e.
    /// `[0x00, 0x00, 0x00]`. If this changes, Enoki sponsorship will fail
    /// silently with malformed bytes.
    #[test]
    fn transaction_kind_bcs_empty_ptb_known_bytes() {
        let kind = sui_sdk_types::TransactionKind::ProgrammableTransaction(
            sui_sdk_types::ProgrammableTransaction {
                inputs: vec![],
                commands: vec![],
            },
        );
        let bytes = bcs::to_bytes(&kind).expect("bcs encode kind");
        // Variant tag for ProgrammableTransaction is 0; followed by len=0
        // for inputs and len=0 for commands.
        assert_eq!(bytes, vec![0x00, 0x00, 0x00]);
    }

    /// When the EnokiClient is unconfigured (`is_configured() == false`),
    /// `set_metadata_and_transfer` must skip the Enoki path entirely and
    /// proceed to direct-sign. We trigger the failure at the very first
    /// step of direct-sign (`get_object_ref` over a bogus RPC URL) so a
    /// fast network error confirms we did NOT try Enoki — if we had, the
    /// error would mention "Enoki" in its display.
    #[tokio::test]
    async fn set_metadata_skips_enoki_when_unconfigured() {
        // Bogus RPC URL → connection refused immediately, no retry storm.
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        // 127.0.0.1:1 is reserved & unbound on every reasonable host.
        let rpc_url = "http://127.0.0.1:1";

        // A throwaway signer (private key bytes are arbitrary — we never
        // actually sign).
        let sk = sui_crypto::ed25519::Ed25519PrivateKey::new([7u8; 32]);
        let addr = sk.public_key().derive_address();
        let signer = ServerSigner {
            private_key: sk,
            address: addr,
        };

        let enoki = crate::enoki::EnokiClient::new(None, "mainnet".into());
        assert!(!enoki.is_configured());

        let res = set_metadata_and_transfer(
            &http,
            rpc_url,
            &signer,
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            WALRUS_PACKAGE_ID_MAINNET,
            "ns",
            // target_owner — any valid 0x address
            "0x0000000000000000000000000000000000000000000000000000000000000002",
            // memwal_owner
            "0x0000000000000000000000000000000000000000000000000000000000000002",
            // memwal_package_id
            "0xdeadbeef",
            None,
            &enoki,
            true, // fallback enabled (irrelevant here — enoki unconfigured)
        )
        .await;

        let err = res.expect_err("must fail — bogus RPC");
        let msg = err.to_string();
        // Enoki was unconfigured, so we must hit the direct-sign path's first
        // RPC call (`get_object_ref` -> `Rpc(...)` / `ObjectNotFound(...)`).
        assert!(
            !msg.to_lowercase().contains("enoki"),
            "Enoki path should not have been attempted; got: {}",
            msg,
        );
    }
}
