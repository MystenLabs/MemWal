//! SEAL threshold encryption — native Rust implementation (ENG-1700).
//!
//! In-process replacement for the deleted TS sidecar's `/seal/encrypt`,
//! `/seal/decrypt`, and `/seal/decrypt-batch` HTTP routes. Behaves
//! identically (1:1 parity).
//!
//! Pipeline overview (decrypt path, mirroring the TS SDK):
//!
//! 1. **Resolve credential** to a session keypair + signed `Certificate`.
//!    - `DelegateKey` (legacy hex / `suiprivkey1...` bech32): we hold the
//!      delegate's private key, generate a fresh session keypair, build the
//!      `signed_message(packageId, session_pk, creation_time_ms, ttl_min)`,
//!      sign with the delegate key, wrap as `UserSignature::Simple`.
//!    - `Session` (modern, x-seal-session header): the SDK has already
//!      done the work — we import the exported session-key envelope. The
//!      JSON shape is `{address, packageId, mvrName, creationTimeMs,
//!      ttlMin, personalMessageSignature, sessionKey}` — see
//!      `resolve_session_envelope` for details. The user's wallet
//!      signature inside the envelope is forwarded to the key servers
//!      verbatim; we never need the user's wallet private key.
//! 2. **Parse `EncryptedObject`** to recover the SEAL `id` (the field that
//!    was passed to `seal_encrypt` and the chain's `seal_approve` policy).
//! 3. **Build a `seal_approve` PTB** (one MoveCall per unique id) targeting
//!    `{packageId}::account::seal_approve(id, account)`.
//! 4. **ElGamal ephemeral keypair** for receiving wrapped server keys.
//! 5. **`signed_request`**: BCS-pack the (ptb, enc_key, enc_verification_key)
//!    triple, sign it with the *session* private key.
//! 6. **Resolve the key-server committee** from chain (cached). For each
//!    server, POST `FetchKeyRequest` JSON to `/v1/fetch_key` in parallel.
//! 7. **Threshold check**: need ≥ threshold successful responses.
//! 8. **`decrypt_seal_responses`**: ElGamal-decrypt the wrapped IBE keys.
//! 9. **`seal_decrypt_object`**: combine threshold shares → AES-decrypt the
//!    payload.
//!
//! Encrypt is the inverse: resolve committee, call `crypto::seal_encrypt`
//! with `EncryptionInput::Hmac256Ctr` (the cipher mode the TS SDK defaults
//! to), BCS-encode the resulting `EncryptedObject` and return.

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use crypto::{
    ibe::PublicKey as IBEPublicKey, EncryptionInput, IBEPublicKeys, ObjectID,
};
use ed25519_dalek::Signer as _;
use fastcrypto::{
    ed25519::{Ed25519PublicKey, Ed25519Signature},
    traits::ToFromBytes,
};
use rand::thread_rng;
use seal_sdk::{
    decrypt_seal_responses, genkey, seal_decrypt_object, seal_encrypt as crypto_seal_encrypt,
    signed_message, signed_request,
    types::{Certificate, ElGamalPublicKey, ElgamalVerificationKey, FetchKeyRequest},
    EncryptedObject,
};
use sui_sdk_types::{
    Address, Argument, Command, Digest, Ed25519PublicKey as SuiEd25519PublicKey, Ed25519Signature as SuiEd25519Signature,
    Identifier, Input, MoveCall, Mutability, ObjectReference, ProgrammableTransaction, SharedInput,
    SimpleSignature, UserSignature,
};

use crate::seal_keyserver::{
    fetch_key, key_server_ids_from_env, resolve_committee, seal_threshold_from_env,
    KeyServerInfo,
};
use crate::types::{AppError, AuthInfo};

// ============================================================
// Public types (preserved API)
// ============================================================

/// Credential used to authorize a SEAL decrypt request.
///
/// ENG-1697: `Session` (an exported `SessionKey`, built on the client) is
/// preferred. `DelegateKey` is the legacy path where the SDK transmits the
/// raw Ed25519 private key — retained temporarily so existing clients keep
/// working. At EOL the `DelegateKey` variant will be removed.
///
/// Owned so it can be cheaply cloned into async tasks.
#[derive(Debug, Clone)]
pub enum SealCredential {
    Session(String),
    DelegateKey(String),
}

impl SealCredential {
    /// Build the credential from an `AuthInfo`, preferring `seal_session`
    /// when present. Falls back to `delegate_key` (legacy), then to a
    /// server-side fallback private key (used when a route lacks a user
    /// context). Returns `None` if no credential is available.
    pub fn from_auth_or_fallback(
        auth: &AuthInfo,
        fallback_private_key: Option<&str>,
    ) -> Option<Self> {
        if let Some(s) = auth.seal_session.as_deref() {
            return Some(SealCredential::Session(s.to_string()));
        }
        if let Some(k) = auth.delegate_key.as_deref() {
            return Some(SealCredential::DelegateKey(k.to_string()));
        }
        fallback_private_key.map(|k| SealCredential::DelegateKey(k.to_string()))
    }
}

// ============================================================
// Native SEAL pipeline
// ============================================================

/// SEAL key ID used by `crypto::seal_encrypt` and the on-chain
/// `seal_approve` policy. Mirrors the TS sidecar (`id: owner` ⇒ raw owner
/// address bytes), so encrypt/decrypt agree on what bytes go through the
/// IBE hash.
///
/// `owner_address` here is a `0x`-prefixed hex string (40 bytes after the
/// prefix); we strip the prefix and hex-decode to raw bytes.
fn id_bytes_from_owner(owner_address: &str) -> Result<Vec<u8>, AppError> {
    let s = owner_address.trim_start_matches("0x");
    if s.is_empty() {
        return Err(AppError::BadRequest("owner address is empty".into()));
    }
    hex::decode(s).map_err(|e| AppError::BadRequest(format!("invalid owner address: {}", e)))
}

/// Encrypt `data` using SEAL threshold encryption.
///
/// Returns BCS-serialized `EncryptedObject` bytes — same wire format the
/// TS SDK produced with `sealClient.encrypt(...)`.
pub async fn seal_encrypt(
    client: &reqwest::Client,
    data: &[u8],
    owner_address: &str,
    package_id: &str,
) -> Result<Vec<u8>, AppError> {
    let id = id_bytes_from_owner(owner_address)?;
    let pkg = parse_address(package_id, "package_id")?;
    let pkg_id: ObjectID = pkg;

    let key_server_ids = key_server_ids_from_env();
    if key_server_ids.is_empty() {
        return Err(AppError::Internal(
            "SEAL_KEY_SERVERS env var is empty — cannot encrypt".into(),
        ));
    }
    let threshold = seal_threshold_from_env();
    let sui_rpc_url = sui_rpc_url_from_env();

    let committee = resolve_committee(client, &sui_rpc_url, &key_server_ids)
        .await
        .map_err(|e| AppError::Internal(format!("seal encrypt: resolve committee: {}", e)))?;
    if (threshold as usize) > committee.len() || threshold == 0 {
        return Err(AppError::Internal(format!(
            "seal encrypt: invalid threshold {} for committee of {}",
            threshold,
            committee.len()
        )));
    }

    let server_object_ids: Vec<ObjectID> = committee.iter().map(|c| c.object_id).collect();
    let public_keys: Vec<IBEPublicKey> = committee.iter().map(|c| c.public_key).collect();

    // Hmac256Ctr matches the TS SDK default cipher mode (the seal-sdk crypto
    // crate offers Aes256Gcm + Hmac256Ctr; @mysten/seal uses HMAC-CTR by
    // default — see node_modules/@mysten/seal/dist/encrypt.mjs).
    let (encrypted_object, _dem_key) = crypto_seal_encrypt(
        pkg_id,
        id,
        server_object_ids,
        &IBEPublicKeys::BonehFranklinBLS12381(public_keys),
        threshold,
        EncryptionInput::Hmac256Ctr {
            data: data.to_vec(),
            aad: None,
        },
    )
    .map_err(|e| AppError::Internal(format!("seal encrypt: crypto error: {}", e)))?;

    let encrypted_bytes = bcs::to_bytes(&encrypted_object)
        .map_err(|e| AppError::Internal(format!("seal encrypt: bcs encode: {}", e)))?;

    tracing::info!(
        "seal encrypt ok: {} bytes -> {} encrypted bytes (threshold={}, servers={})",
        data.len(),
        encrypted_bytes.len(),
        threshold,
        committee.len(),
    );
    Ok(encrypted_bytes)
}

/// Decrypt one SEAL-encrypted blob.
///
/// `credential` is either a delegate private key or an exported
/// `@mysten/seal` SessionKey envelope (`x-seal-session` header).
pub async fn seal_decrypt(
    client: &reqwest::Client,
    encrypted_data: &[u8],
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<u8>, AppError> {
    let plaintexts =
        seal_decrypt_batch(client, vec![encrypted_data], credential, package_id, account_id)
            .await?;
    let mut iter = plaintexts.into_iter();
    let first = iter.next().ok_or_else(|| {
        AppError::Internal("seal decrypt: batch returned empty result".into())
    })?;
    first.map_err(AppError::Internal)
}

/// Decrypt many SEAL-encrypted blobs in one round-trip.
///
/// Builds **one** `seal_approve` PTB containing one MoveCall per *unique*
/// SEAL id, makes **one** `/v1/fetch_key` call to each key server, then
/// uses the cached IBE user-secret-keys to decrypt each blob locally.
/// Results are returned in the same order as `items`.
#[allow(unused_variables)]
pub async fn seal_decrypt_batch(
    client: &reqwest::Client,
    items: Vec<&[u8]>,
    credential: &SealCredential,
    package_id: &str,
    account_id: &str,
) -> Result<Vec<Result<Vec<u8>, String>>, AppError> {
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // ── 1. Parse encrypted objects + collect unique SEAL ids ───────────
    let mut parsed: Vec<Result<EncryptedObject, String>> = Vec::with_capacity(items.len());
    for bytes in &items {
        match bcs::from_bytes::<EncryptedObject>(bytes) {
            Ok(eo) => parsed.push(Ok(eo)),
            Err(e) => parsed.push(Err(format!("EncryptedObject parse: {}", e))),
        }
    }
    // Unique ids in stable order (so the PTB build is deterministic).
    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut unique_ids: Vec<Vec<u8>> = Vec::new();
    for eo in parsed.iter().flatten() {
        if seen.insert(eo.id.clone()) {
            unique_ids.push(eo.id.clone());
        }
    }
    if unique_ids.is_empty() {
        // Every item failed to parse — propagate one error per item.
        return Ok(parsed
            .into_iter()
            .map(|r| r.map(|_| Vec::new()).map_err(|e| e))
            .collect::<Vec<_>>());
    }

    // ── 2. Resolve credential → (session_kp, certificate) ──────────────
    let pkg_addr = parse_address(package_id, "package_id")?;
    let account_addr = parse_address(account_id, "account_id")?;
    let resolved = resolve_credential_to_session(client, credential, &pkg_addr).await?;

    // ── 3. Resolve committee + threshold ───────────────────────────────
    let key_server_ids = key_server_ids_from_env();
    if key_server_ids.is_empty() {
        return Err(AppError::Internal(
            "SEAL_KEY_SERVERS env var is empty — cannot decrypt".into(),
        ));
    }
    let threshold = seal_threshold_from_env();
    let sui_rpc_url = sui_rpc_url_from_env();

    let committee = resolve_committee(client, &sui_rpc_url, &key_server_ids)
        .await
        .map_err(|e| AppError::Internal(format!("seal decrypt: resolve committee: {}", e)))?;
    if (threshold as usize) > committee.len() || threshold == 0 {
        return Err(AppError::Internal(format!(
            "seal decrypt: invalid threshold {} for committee of {}",
            threshold,
            committee.len()
        )));
    }

    // ── 4. Build seal_approve PTB (one call per unique id) ─────────────
    let ptb = build_seal_approve_ptb(pkg_addr, account_addr, &unique_ids, client, &sui_rpc_url).await?;

    // ── 5. ElGamal ephemeral keypair + signed request ──────────────────
    let (eg_sk, eg_pk, eg_vk): (
        seal_sdk::types::ElGamalSecretKey,
        ElGamalPublicKey,
        ElgamalVerificationKey,
    ) = genkey(&mut thread_rng());
    let request_bytes = signed_request(&ptb, &eg_pk, &eg_vk);
    // Sign request with session keypair using ed25519-dalek (raw Ed25519,
    // no intent prefix — matches what the key server verifies).
    let sig_bytes = resolved
        .session_signing_key
        .sign(&request_bytes)
        .to_bytes();
    let request_signature = Ed25519Signature::from_bytes(&sig_bytes)
        .map_err(|e| AppError::Internal(format!("seal decrypt: signature encode: {}", e)))?;

    // ── 6. Build FetchKeyRequest body (BCS PTB → base64) ───────────────
    let ptb_b64 = BASE64.encode(
        bcs::to_bytes(&ptb)
            .map_err(|e| AppError::Internal(format!("seal decrypt: ptb bcs: {}", e)))?,
    );
    let fetch_key_request = FetchKeyRequest {
        ptb: ptb_b64,
        enc_key: eg_pk.clone(),
        enc_verification_key: eg_vk.clone(),
        request_signature,
        certificate: resolved.certificate.clone(),
    };
    let body_json = fetch_key_request
        .to_json_string()
        .map_err(|e| AppError::Internal(format!("seal decrypt: fetch req json: {}", e)))?;

    // ── 7. Fan out POST /v1/fetch_key ──────────────────────────────────
    let server_pk_map: HashMap<ObjectID, IBEPublicKey> = committee
        .iter()
        .map(|c| (c.object_id, c.public_key))
        .collect();

    let server_responses = parallel_fetch_keys(client, &committee, &body_json, threshold).await?;

    // ── 8. ElGamal-decrypt the wrapped IBE keys ────────────────────────
    let cached_keys = decrypt_seal_responses(&eg_sk, &server_responses, &server_pk_map)
        .map_err(|e| AppError::Internal(format!("seal decrypt: elgamal decrypt: {}", e)))?;

    // ── 9. Local seal_decrypt for each blob ────────────────────────────
    let mut out: Vec<Result<Vec<u8>, String>> = Vec::with_capacity(items.len());
    for parsed_one in parsed {
        match parsed_one {
            Err(e) => out.push(Err(e)),
            Ok(encrypted_object) => match seal_decrypt_object(
                &encrypted_object,
                &cached_keys,
                &server_pk_map,
            ) {
                Ok(plaintext) => out.push(Ok(plaintext)),
                Err(e) => out.push(Err(format!("seal decrypt: {}", e))),
            },
        }
    }

    let ok_count = out.iter().filter(|r| r.is_ok()).count();
    tracing::info!(
        "seal decrypt batch ok: {} of {} blobs (committee_size={}, threshold={})",
        ok_count,
        items.len(),
        committee.len(),
        threshold,
    );
    Ok(out)
}

// ============================================================
// Helpers — credential resolution
// ============================================================

/// Resolved credential: session signing key + certificate ready to embed in
/// a `FetchKeyRequest`.
struct ResolvedCredential {
    /// Ephemeral Ed25519 *session* signing key (used to sign each
    /// `signed_request`). For the delegate-key path this is freshly
    /// generated; for the session path it's deserialized from the export.
    session_signing_key: ed25519_dalek::SigningKey,
    /// Pre-built certificate (signed by the user / delegate).
    certificate: Certificate,
}

impl std::fmt::Debug for ResolvedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedCredential")
            .field("session_signing_key", &"<redacted>")
            .field("certificate.user", &self.certificate.user)
            .finish()
    }
}

async fn resolve_credential_to_session(
    _client: &reqwest::Client,
    credential: &SealCredential,
    package_id: &Address,
) -> Result<ResolvedCredential, AppError> {
    match credential {
        SealCredential::DelegateKey(k) => resolve_delegate_key(k, package_id),
        SealCredential::Session(envelope) => resolve_session_envelope(envelope),
    }
}

/// Import an exported `SessionKey` (the JSON envelope produced by
/// `@mysten/seal`'s `SessionKey.export()`, base64-encoded for the
/// `x-seal-session` header) into a `ResolvedCredential` ready to be embedded
/// in a `FetchKeyRequest`.
///
/// The TS export shape is (verbatim from
/// `node_modules/@mysten/seal/dist/session-key.mjs::export()` —
/// SDK v1.1.1):
///
/// ```text
/// {
///   "address":           string,           // user wallet address (0x...)
///   "packageId":         string,           // 0x... package id
///   "mvrName":           string | null,
///   "creationTimeMs":    number,           // u64 ms since epoch
///   "ttlMin":            number,           // u16 minutes
///   "personalMessageSignature": string,    // base64 GenericSignature
///   "sessionKey":        string            // suiprivkey1... bech32 (Ed25519 secret)
/// }
/// ```
///
/// The `personalMessageSignature` is a base64-encoded `GenericSignature`
/// (flag-prefixed: `0x00 || sig(64) || pubkey(32)` for Ed25519). It signs
/// the `getPersonalMessage()` bytes — i.e. the same string the Rust
/// `seal_sdk::signed_message` produces. We trust the Mysten key servers to
/// verify the signature; here we only parse it into a `UserSignature` so
/// the `Certificate` is wire-ready.
fn resolve_session_envelope(token_b64: &str) -> Result<ResolvedCredential, AppError> {
    // 1. base64 → utf8 JSON.
    let raw = BASE64
        .decode(token_b64.trim())
        .map_err(|e| AppError::BadRequest(format!("invalid x-seal-session: base64 decode: {}", e)))?;
    let json_str = std::str::from_utf8(&raw).map_err(|e| {
        AppError::BadRequest(format!("invalid x-seal-session: not utf-8: {}", e))
    })?;
    let v: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
        AppError::BadRequest(format!("invalid x-seal-session: not json: {}", e))
    })?;

    // 2. Pull required fields.
    let address_str = v
        .get("address")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::BadRequest("invalid x-seal-session: missing 'address'".into()))?;
    let creation_time_ms = v
        .get("creationTimeMs")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| {
            AppError::BadRequest("invalid x-seal-session: missing/bad 'creationTimeMs'".into())
        })?;
    let ttl_min_u64 = v
        .get("ttlMin")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| {
            AppError::BadRequest("invalid x-seal-session: missing/bad 'ttlMin'".into())
        })?;
    if ttl_min_u64 > u16::MAX as u64 {
        return Err(AppError::BadRequest(format!(
            "invalid x-seal-session: ttlMin {} exceeds u16::MAX",
            ttl_min_u64
        )));
    }
    let ttl_min = ttl_min_u64 as u16;
    let session_priv_str = v
        .get("sessionKey")
        .and_then(|x| x.as_str())
        .ok_or_else(|| {
            AppError::BadRequest("invalid x-seal-session: missing 'sessionKey'".into())
        })?;
    // `personalMessageSignature` is technically optional in the TS type
    // (you can build a SessionKey without one), but the SDK always sets it
    // before exporting, and the key servers reject a Certificate without
    // it. Treat absence as a 400.
    let pms_b64 = v
        .get("personalMessageSignature")
        .and_then(|x| x.as_str())
        .ok_or_else(|| {
            AppError::BadRequest(
                "invalid x-seal-session: missing 'personalMessageSignature' (the SDK must call setPersonalMessageSignature before export)".into(),
            )
        })?;
    // mvrName: TS exports it as `mvrName` (camelCase). May be null/undefined.
    let mvr_name = v
        .get("mvrName")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    // 3. Parse the user wallet address.
    let user = Address::from_hex(address_str).map_err(|e| {
        AppError::BadRequest(format!(
            "invalid x-seal-session: bad address '{}': {}",
            address_str, e
        ))
    })?;

    // 4. Decode the session private key (always `suiprivkey1...` bech32 from
    // the SDK — `Ed25519Keypair.getSecretKey()` always returns bech32).
    // Reuse the existing decoder so hex would also work if a custom client
    // sent it that way.
    let session_sk_bytes = decode_delegate_private_key(session_priv_str).map_err(|e| match e {
        AppError::BadRequest(s) => {
            AppError::BadRequest(format!("invalid x-seal-session sessionKey: {}", s))
        }
        other => other,
    })?;
    let session_signing = ed25519_dalek::SigningKey::from_bytes(&session_sk_bytes);

    // 5. Derive session_vk (public key) from the private key.
    let session_pubkey_bytes = session_signing.verifying_key().to_bytes();
    let session_vk = Ed25519PublicKey::from_bytes(&session_pubkey_bytes).map_err(|e| {
        AppError::Internal(format!("seal session: vk encode: {}", e))
    })?;

    // 6. Parse the user's personalMessageSignature. The TS SDK stores it as
    // a base64 `GenericSignature` (the same wire format
    // `UserSignature::to_base64()` produces and `from_base64()` consumes).
    // We deliberately do NOT verify it here — the Mysten key servers
    // re-verify `signature` against `signed_message(packageId, session_vk,
    // creation_time, ttl_min)` on every fetch_key call. Local verification
    // would also require a Sui RPC roundtrip for zkLogin/multisig
    // signers (see verifyPersonalMessageSignature in the TS SDK).
    let user_signature = UserSignature::from_base64(pms_b64).map_err(|e| {
        AppError::BadRequest(format!(
            "invalid x-seal-session: personalMessageSignature parse: {}",
            e
        ))
    })?;

    // 7. Build the certificate the key server expects.
    let certificate = Certificate {
        user,
        session_vk,
        creation_time: creation_time_ms,
        ttl_min,
        signature: user_signature,
        mvr_name,
    };

    Ok(ResolvedCredential {
        session_signing_key: session_signing,
        certificate,
    })
}

fn resolve_delegate_key(key_str: &str, package_id: &Address) -> Result<ResolvedCredential, AppError> {
    let delegate_sk_bytes = decode_delegate_private_key(key_str)?;
    let delegate_signing = ed25519_dalek::SigningKey::from_bytes(&delegate_sk_bytes);
    let delegate_verifying = delegate_signing.verifying_key();
    let delegate_pubkey_sui = SuiEd25519PublicKey::new(delegate_verifying.to_bytes());
    let delegate_address = derive_ed25519_sui_address(&delegate_verifying.to_bytes());

    // Generate a fresh session keypair. This is the keypair that signs the
    // `signed_request` for each call to a key server — it never leaves the
    // server process, and its public key is recorded on the certificate.
    use rand::RngCore as _;
    let mut session_seed = [0u8; 32];
    thread_rng().fill_bytes(&mut session_seed);
    let session_signing = ed25519_dalek::SigningKey::from_bytes(&session_seed);
    let session_pubkey_bytes = session_signing.verifying_key().to_bytes();
    let session_vk_fc = Ed25519PublicKey::from_bytes(&session_pubkey_bytes).map_err(|e| {
        AppError::Internal(format!("seal: session vk encode: {}", e))
    })?;

    let creation_time_ms = chrono::Utc::now().timestamp_millis() as u64;
    let ttl_min: u16 = 5;

    // The `signed_message` format is fixed by seal-sdk and the key server
    // validates it byte-for-byte (see seal-sdk lib.rs::signed_message).
    let msg = signed_message(
        package_id.to_string(),
        &session_vk_fc,
        creation_time_ms,
        ttl_min,
    );

    // Sui personal-message signing: hash the bcs-prefixed `PersonalMessage`
    // intent. We delegate to the dalek key directly; the seal-sdk decodes
    // the resulting `UserSignature::Simple` against the same prefix. The
    // simplest path is to sign the *raw* personal message bytes and let the
    // server's `verify_personal_message` apply the prefix during checking.
    //
    // For the delegate path the trust chain is "delegate signed this
    // session-vk's authority"; the server-side `seal_approve` uses
    // `tx_context::sender == delegate_addr` because we set the sender to
    // the delegate's address via the certificate.
    let personal_msg_bytes = msg.as_bytes().to_vec();
    let signature_raw = delegate_signing.sign(&personal_msg_bytes).to_bytes();
    let signature_sdk = SuiEd25519Signature::new(signature_raw);
    let user_signature = UserSignature::Simple(SimpleSignature::Ed25519 {
        signature: signature_sdk,
        public_key: delegate_pubkey_sui,
    });

    let certificate = Certificate {
        user: delegate_address,
        session_vk: session_vk_fc,
        creation_time: creation_time_ms,
        ttl_min,
        signature: user_signature,
        mvr_name: None,
    };

    Ok(ResolvedCredential {
        session_signing_key: session_signing,
        certificate,
    })
}

/// Decode a delegate private key string (hex 64 or `suiprivkey1...` bech32)
/// into the raw 32-byte Ed25519 secret key.
fn decode_delegate_private_key(key_str: &str) -> Result<[u8; 32], AppError> {
    let key_str = key_str.trim();
    if key_str.starts_with("suiprivkey") {
        let (hrp, data, _variant) = bech32::decode(key_str)
            .map_err(|e| AppError::BadRequest(format!("delegate key bech32: {}", e)))?;
        if hrp != "suiprivkey" {
            return Err(AppError::BadRequest(format!(
                "delegate key wrong HRP: {}",
                hrp
            )));
        }
        use bech32::FromBase32;
        let bytes = Vec::<u8>::from_base32(&data)
            .map_err(|e| AppError::BadRequest(format!("delegate key base32: {}", e)))?;
        if bytes.len() != 33 {
            return Err(AppError::BadRequest(format!(
                "delegate key bech32 payload length {}, expected 33",
                bytes.len()
            )));
        }
        if bytes[0] != 0x00 {
            return Err(AppError::BadRequest(format!(
                "delegate key scheme flag 0x{:02x}, only Ed25519 (0x00) is supported",
                bytes[0]
            )));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes[1..33]);
        Ok(out)
    } else {
        // Hex path. Validate both length AND charset before parsing — keeps
        // accidentally-leaked secrets out of error messages and matches the
        // TS sidecar's input rejection.
        if key_str.len() != 64 {
            return Err(AppError::BadRequest(format!(
                "delegate key hex must be 64 chars, got {}",
                key_str.len()
            )));
        }
        if !key_str.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::BadRequest(
                "delegate key hex contains non-hex chars".into(),
            ));
        }
        let mut out = [0u8; 32];
        hex::decode_to_slice(key_str, &mut out).map_err(|e| {
            AppError::BadRequest(format!("delegate key hex decode: {}", e))
        })?;
        Ok(out)
    }
}

/// Derive a Sui address from an Ed25519 public key. Uses sui-sdk-types'
/// built-in derivation: `address = blake2b-256(0x00 || pubkey_bytes)`.
fn derive_ed25519_sui_address(pubkey_bytes: &[u8; 32]) -> Address {
    SuiEd25519PublicKey::new(*pubkey_bytes).derive_address()
}

// ============================================================
// Helpers — PTB construction
// ============================================================

/// Build a `ProgrammableTransaction` containing one
/// `{package}::account::seal_approve(id, account)` MoveCall per unique id.
///
/// We construct the PTB manually rather than going through
/// `TransactionBuilder::try_build` because that requires sender + gas, and
/// the SEAL committee only validates the inner `ProgrammableTransaction`
/// (the TS SDK uses `tx.build({ onlyTransactionKind: true })` and the key
/// server then strips the `TransactionKind` discriminator).
async fn build_seal_approve_ptb(
    package_id: Address,
    account_id: Address,
    ids: &[Vec<u8>],
    http: &reqwest::Client,
    sui_rpc_url: &str,
) -> Result<ProgrammableTransaction, AppError> {
    // Resolve the account object's owned-ref (version + digest).
    let account_ref = get_object_ref(http, sui_rpc_url, &account_id.to_string()).await?;

    // Move id `vector<u8>`s are encoded as Pure inputs with BCS bytes.
    // BCS for `vector<u8>` is ULEB128 length || raw bytes.
    let mut inputs: Vec<Input> = Vec::with_capacity(ids.len() + 1);
    let mut id_input_indices: Vec<u16> = Vec::with_capacity(ids.len());
    for id_bytes in ids {
        // The SDK pure encoding for vector<u8> is BCS of the byte vector.
        let pure_bytes = bcs::to_bytes(id_bytes)
            .map_err(|e| AppError::Internal(format!("ptb id pure: {}", e)))?;
        id_input_indices.push(inputs.len() as u16);
        inputs.push(Input::Pure(pure_bytes));
    }
    let account_input_idx = inputs.len() as u16;
    let account_input = match account_ref.shared_initial_version {
        // `MemWalAccount` is created via `transfer::share_object`, so the
        // canonical path is `Input::Shared`. `seal_approve` takes
        // `&MemWalAccount` (immutable ref) → `Mutability::Immutable`.
        Some(initial_shared_version) => Input::Shared(SharedInput::new(
            account_id,
            initial_shared_version,
            Mutability::Immutable,
        )),
        // Defensive fallback if owner parsing fails — preserves prior
        // behavior. Logged so a regression here is visible in production
        // (key servers will reject with "Object used as owned is not owned").
        None => {
            tracing::warn!(
                "ptb: account {} fell back to ImmutableOrOwned (owner not parsed)",
                account_id
            );
            Input::ImmutableOrOwned(ObjectReference::new(
                account_id,
                account_ref.version,
                account_ref.digest,
            ))
        }
    };
    inputs.push(account_input);

    // `Identifier::new` validates the Move identifier rules (alphanumeric +
    // underscore, can't start with a digit). Both names are static so this
    // never fails in practice — an Internal error here means the source
    // string was tampered with at compile time.
    let module = Identifier::new("account")
        .map_err(|e| AppError::Internal(format!("ptb identifier 'account': {}", e)))?;
    let function = Identifier::new("seal_approve")
        .map_err(|e| AppError::Internal(format!("ptb identifier 'seal_approve': {}", e)))?;

    let commands: Vec<Command> = id_input_indices
        .iter()
        .map(|id_idx| {
            Command::MoveCall(MoveCall {
                package: package_id,
                module: module.clone(),
                function: function.clone(),
                type_arguments: vec![],
                arguments: vec![
                    Argument::Input(*id_idx),
                    Argument::Input(account_input_idx),
                ],
            })
        })
        .collect();

    Ok(ProgrammableTransaction { inputs, commands })
}

// ============================================================
// Helpers — Sui JSON-RPC (read-only)
// ============================================================

#[derive(Debug, Clone)]
struct ObjectRef {
    version: u64,
    digest: Digest,
    /// `Some(initial_shared_version)` if this object was shared via
    /// `transfer::share_object`. PTB inputs for shared objects must use
    /// `Input::Shared(SharedInput::new(id, initial_shared_version, mutability))`,
    /// not `Input::ImmutableOrOwned` — otherwise the validator rejects with
    /// "Object used as owned is not owned".
    shared_initial_version: Option<u64>,
}

async fn get_object_ref(
    http: &reqwest::Client,
    sui_rpc_url: &str,
    object_id: &str,
) -> Result<ObjectRef, AppError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sui_getObject",
        "params": [object_id, { "showOwner": true }],
    });
    let resp = http
        .post(sui_rpc_url)
        .timeout(std::time::Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("sui_getObject http: {}", e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("sui_getObject body: {}", e)))?;
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "sui_getObject HTTP {}: {}",
            status, text
        )));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("sui_getObject json: {}", e)))?;
    if let Some(err) = v.get("error") {
        return Err(AppError::Internal(format!(
            "sui_getObject rpc error: {}",
            err
        )));
    }
    let data = v
        .pointer("/result/data")
        .ok_or_else(|| AppError::Internal(format!("sui_getObject no data for {}", object_id)))?;
    let version = data
        .get("version")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::Internal("sui_getObject missing version".into()))?
        .parse::<u64>()
        .map_err(|e| AppError::Internal(format!("sui_getObject version parse: {}", e)))?;
    let digest_str = data
        .get("digest")
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::Internal("sui_getObject missing digest".into()))?;
    let digest = Digest::from_base58(digest_str)
        .map_err(|e| AppError::Internal(format!("sui_getObject digest parse: {}", e)))?;
    // owner: `{ "Shared": { "initial_shared_version": <num|string> } }` for
    // shared objects; absent / `AddressOwner` / `ObjectOwner` / `Immutable`
    // otherwise. Sui fullnode RPC currently returns the version as a JSON
    // number, but historically (and for huge versions) it can be a string —
    // accept both.
    let shared_initial_version = data
        .pointer("/owner/Shared/initial_shared_version")
        .and_then(|x| {
            x.as_u64()
                .or_else(|| x.as_str().and_then(|s| s.parse::<u64>().ok()))
        });
    Ok(ObjectRef {
        version,
        digest,
        shared_initial_version,
    })
}

/// Parse a `0x...` Sui address from a string into an `Address`. Accepts
/// short forms (Sui CLI sometimes drops leading zeros for display).
fn parse_address(s: &str, name: &str) -> Result<Address, AppError> {
    Address::from_hex(s).map_err(|e| AppError::BadRequest(format!("invalid {} '{}': {}", name, s, e)))
}

fn sui_rpc_url_from_env() -> String {
    if let Ok(v) = std::env::var("SUI_RPC_URL") {
        return v;
    }
    let net = std::env::var("SUI_NETWORK").unwrap_or_else(|_| "mainnet".into());
    match net.as_str() {
        "testnet" => "https://fullnode.testnet.sui.io:443".into(),
        "devnet" => "https://fullnode.devnet.sui.io:443".into(),
        _ => "https://fullnode.mainnet.sui.io:443".into(),
    }
}

// ============================================================
// Helpers — fan out fetch_key
// ============================================================

async fn parallel_fetch_keys(
    client: &reqwest::Client,
    committee: &[std::sync::Arc<KeyServerInfo>],
    body_json: &str,
    threshold: u8,
) -> Result<Vec<(ObjectID, seal_sdk::FetchKeyResponse)>, AppError> {
    use futures::future::join_all;

    let futs = committee.iter().map(|info| {
        let client = client.clone();
        let body = body_json.to_owned();
        let info = info.clone();
        async move {
            let res = fetch_key(&client, &info, &body).await;
            (info.object_id, res)
        }
    });
    let results = join_all(futs).await;

    let mut out = Vec::with_capacity(results.len());
    let mut errors: Vec<String> = Vec::new();
    for (server_id, res) in results {
        match res {
            Ok(resp) => out.push((server_id, resp)),
            Err(e) => {
                tracing::warn!("seal: key server {} returned error: {}", server_id, e);
                errors.push(format!("{}: {}", server_id, e));
            }
        }
    }
    if out.len() < threshold as usize {
        return Err(AppError::Internal(format!(
            "seal decrypt: insufficient key servers responded ({}/{}); errors: {}",
            out.len(),
            threshold,
            errors.join(" | ")
        )));
    }
    Ok(out)
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AuthInfo;

    #[test]
    fn id_bytes_strips_0x_prefix() {
        let b = id_bytes_from_owner("0xabcd").unwrap();
        assert_eq!(b, vec![0xab, 0xcd]);
    }

    #[test]
    fn id_bytes_works_without_prefix() {
        let b = id_bytes_from_owner("ff00").unwrap();
        assert_eq!(b, vec![0xff, 0x00]);
    }

    #[test]
    fn id_bytes_rejects_empty() {
        assert!(id_bytes_from_owner("").is_err());
        assert!(id_bytes_from_owner("0x").is_err());
    }

    #[test]
    fn id_bytes_rejects_non_hex() {
        assert!(id_bytes_from_owner("0xZZZZ").is_err());
    }

    #[test]
    fn delegate_key_decode_hex_64() {
        let k = "00".repeat(32);
        let out = decode_delegate_private_key(&k).unwrap();
        assert_eq!(out, [0u8; 32]);
    }

    #[test]
    fn delegate_key_rejects_wrong_hex_length() {
        let k = "00".repeat(31);
        let err = decode_delegate_private_key(&k).unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("64 chars")),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn delegate_key_rejects_non_hex_chars() {
        let k = "z".repeat(64);
        let err = decode_delegate_private_key(&k).unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("non-hex")),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn delegate_key_decode_bech32_round_trip() {
        // Build a `suiprivkey1...` from a known 32-byte secret and verify
        // the decoded bytes match.
        use bech32::{ToBase32, Variant};
        let secret = [0x42u8; 32];
        let mut data = Vec::with_capacity(33);
        data.push(0x00); // Ed25519 scheme flag
        data.extend_from_slice(&secret);
        let bech =
            bech32::encode("suiprivkey", data.to_base32(), Variant::Bech32).expect("encode");
        let decoded = decode_delegate_private_key(&bech).unwrap();
        assert_eq!(decoded, secret);
    }

    #[test]
    fn delegate_key_rejects_non_ed25519_scheme_flag() {
        use bech32::{ToBase32, Variant};
        let mut data = Vec::with_capacity(33);
        data.push(0x01); // Secp256k1 — not Ed25519
        data.extend_from_slice(&[0u8; 32]);
        let bech =
            bech32::encode("suiprivkey", data.to_base32(), Variant::Bech32).unwrap();
        let err = decode_delegate_private_key(&bech).unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("scheme flag")),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn credential_from_auth_prefers_session() {
        let auth = AuthInfo {
            public_key: "aabb".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            delegate_key: Some("hexkey".into()),
            seal_session: Some("session_blob".into()),
        };
        let c = SealCredential::from_auth_or_fallback(&auth, None).unwrap();
        match c {
            SealCredential::Session(s) => assert_eq!(s, "session_blob"),
            other => panic!("expected Session, got {:?}", other),
        }
    }

    #[test]
    fn credential_falls_back_to_delegate() {
        let auth = AuthInfo {
            public_key: "aabb".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            delegate_key: Some("hexkey".into()),
            seal_session: None,
        };
        let c = SealCredential::from_auth_or_fallback(&auth, None).unwrap();
        match c {
            SealCredential::DelegateKey(s) => assert_eq!(s, "hexkey"),
            other => panic!("expected DelegateKey, got {:?}", other),
        }
    }

    #[test]
    fn credential_falls_back_to_server_key() {
        let auth = AuthInfo {
            public_key: "aabb".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            delegate_key: None,
            seal_session: None,
        };
        let c = SealCredential::from_auth_or_fallback(&auth, Some("server_fallback")).unwrap();
        match c {
            SealCredential::DelegateKey(s) => assert_eq!(s, "server_fallback"),
            other => panic!("expected DelegateKey, got {:?}", other),
        }
    }

    #[test]
    fn credential_returns_none_when_no_creds() {
        let auth = AuthInfo {
            public_key: "aabb".into(),
            owner: "0xowner".into(),
            account_id: "0xaccount".into(),
            delegate_key: None,
            seal_session: None,
        };
        assert!(SealCredential::from_auth_or_fallback(&auth, None).is_none());
    }

    // ── x-seal-session import tests ────────────────────────────────────

    /// Build a deterministic SessionKey envelope for tests (matches the
    /// shape `@mysten/seal`'s `SessionKey.export()` produces — verbatim).
    /// The signature is intentionally a real Ed25519 signature (so the
    /// `UserSignature::from_base64` parser succeeds), but it is signed by
    /// a *test* keypair — Mysten key servers would reject it. That's fine
    /// for unit testing: we only verify the envelope is parsed correctly
    /// and translated into a `Certificate` whose fields match.
    fn make_test_envelope() -> (
        String,
        /* expected user addr */ Address,
        /* session vk hex */ String,
        /* creation_time_ms */ u64,
        /* ttl_min */ u16,
    ) {
        use bech32::{ToBase32, Variant};

        // Deterministic session keypair (Ed25519, 32-byte secret).
        let session_secret = [0x11u8; 32];
        let mut bech_payload = Vec::with_capacity(33);
        bech_payload.push(0x00); // Ed25519 scheme flag
        bech_payload.extend_from_slice(&session_secret);
        let session_priv_bech32 =
            bech32::encode("suiprivkey", bech_payload.to_base32(), Variant::Bech32).unwrap();

        // Recompute session_vk from the secret (same path the SDK takes).
        let session_signing = ed25519_dalek::SigningKey::from_bytes(&session_secret);
        let session_vk_bytes = session_signing.verifying_key().to_bytes();

        // User-wallet keypair (used to "sign" the personal-message
        // envelope — only structurally; key-server rejection is fine).
        let user_secret = [0x22u8; 32];
        let user_signing = ed25519_dalek::SigningKey::from_bytes(&user_secret);
        let user_pubkey_bytes = user_signing.verifying_key().to_bytes();
        let user_addr = SuiEd25519PublicKey::new(user_pubkey_bytes).derive_address();

        // Sign *some* bytes (the parser doesn't verify the signature; we
        // only need it to be a syntactically-valid 0x00 || sig || pk
        // GenericSignature so `UserSignature::from_base64` accepts it).
        let dummy = b"unit-test personal message";
        let sig_bytes = user_signing.sign(dummy).to_bytes();
        let mut generic = Vec::with_capacity(1 + 64 + 32);
        generic.push(0x00); // Ed25519 scheme flag
        generic.extend_from_slice(&sig_bytes);
        generic.extend_from_slice(&user_pubkey_bytes);
        let pms_b64 = BASE64.encode(&generic);

        let creation_time_ms: u64 = 1_700_000_000_000;
        let ttl_min: u16 = 5;
        let envelope = serde_json::json!({
            "address": user_addr.to_string(),
            "packageId": "0x0000000000000000000000000000000000000000000000000000000000000001",
            "mvrName": null,
            "creationTimeMs": creation_time_ms,
            "ttlMin": ttl_min,
            "personalMessageSignature": pms_b64,
            "sessionKey": session_priv_bech32,
        });
        let envelope_b64 = BASE64.encode(envelope.to_string().as_bytes());
        (
            envelope_b64,
            user_addr,
            hex::encode(session_vk_bytes),
            creation_time_ms,
            ttl_min,
        )
    }

    #[test]
    fn import_session_key_parses_known_shape() {
        let (b64, expected_user, expected_vk_hex, expected_ct, expected_ttl) =
            make_test_envelope();

        let resolved = resolve_session_envelope(&b64).expect("envelope must parse");

        assert_eq!(resolved.certificate.user, expected_user, "user addr");
        assert_eq!(
            hex::encode(resolved.certificate.session_vk.as_ref()),
            expected_vk_hex,
            "session_vk derived from sessionKey",
        );
        assert_eq!(
            resolved.certificate.creation_time, expected_ct,
            "creation_time from creationTimeMs"
        );
        assert_eq!(
            resolved.certificate.ttl_min, expected_ttl,
            "ttl_min from ttlMin"
        );
        assert!(resolved.certificate.mvr_name.is_none(), "mvr_name nullable");
        // Sanity: signature must be Simple/Ed25519 (matches our test fixture)
        assert!(
            matches!(
                &resolved.certificate.signature,
                UserSignature::Simple(SimpleSignature::Ed25519 { .. })
            ),
            "signature should round-trip as Ed25519 Simple"
        );

        // session_signing_key must derive the same public key embedded in the
        // certificate — this is what's used to sign each per-request
        // `signed_request` payload.
        let signing_pub = resolved.session_signing_key.verifying_key().to_bytes();
        let cert_vk_bytes = resolved.certificate.session_vk.as_ref().to_vec();
        assert_eq!(
            signing_pub.as_ref(),
            cert_vk_bytes.as_slice(),
            "session signing key matches session_vk on cert",
        );
    }

    #[test]
    fn import_session_key_rejects_garbage_base64() {
        let err = resolve_session_envelope("!!!not base64!!!").unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("base64"), "got: {}", s),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn import_session_key_rejects_non_json() {
        // Valid base64, but the decoded bytes aren't JSON.
        let bad = BASE64.encode(b"this is not json");
        let err = resolve_session_envelope(&bad).unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("not json") || s.contains("json")),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn import_session_key_rejects_missing_fields() {
        // Valid JSON object but missing `sessionKey`, `address`, etc.
        let bad = BASE64.encode(b"{\"creationTimeMs\":1, \"ttlMin\":5}");
        let err = resolve_session_envelope(&bad).unwrap_err();
        match err {
            AppError::BadRequest(s) => {
                assert!(
                    s.contains("address")
                        || s.contains("sessionKey")
                        || s.contains("personalMessageSignature"),
                    "expected missing-field error, got: {}",
                    s,
                );
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn import_session_key_rejects_bad_address() {
        let mut env = serde_json::json!({
            "address": "not_a_hex_address",
            "packageId": "0x1",
            "creationTimeMs": 1_700_000_000_000u64,
            "ttlMin": 5,
            "personalMessageSignature": BASE64.encode(b"\x00fake"),
            "sessionKey": "00".repeat(32),
        });
        // ttlMin should still parse; bad address is the failure we want to
        // surface.
        env["personalMessageSignature"] = serde_json::Value::String(BASE64.encode({
            let mut v = vec![0x00u8];
            v.extend_from_slice(&[0u8; 96]);
            v
        }));
        let bad = BASE64.encode(env.to_string().as_bytes());
        let err = resolve_session_envelope(&bad).unwrap_err();
        match err {
            AppError::BadRequest(s) => assert!(s.contains("address")),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    /// Live end-to-end check that `get_object_ref` correctly extracts
    /// `Shared.initial_shared_version` from a real `MemWalAccount` on
    /// testnet. Regression for ENG-1700 / Phase 2 bug where the parser
    /// expected a JSON string but Sui returns a JSON number, causing the
    /// PTB to fall back to `Input::ImmutableOrOwned` and key servers to
    /// reject with HTTP 403 "Object used as owned is not owned".
    /// Skip in CI (no network); run locally with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn get_object_ref_extracts_shared_initial_version_for_real_account() {
        let http = reqwest::Client::new();
        let rpc = "https://fullnode.testnet.sui.io:443";
        let memwal_account = "0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392";
        let r = get_object_ref(&http, rpc, memwal_account).await.expect("rpc");
        assert!(
            r.shared_initial_version.is_some(),
            "MemWalAccount must be Shared, but parser returned None — regression of \
             the JSON Number vs String bug. Owner is `{{Shared:{{initial_shared_version:NUMBER}}}}` \
             on testnet."
        );
    }

    #[tokio::test]
    async fn session_credential_dispatches_to_envelope_parser() {
        // Confirm the dispatch from SealCredential::Session → resolve_session_envelope.
        // We pass garbage so we get a BadRequest fast — the important thing
        // is that we no longer return the "not yet supported" stub error.
        let pkg = Address::ZERO;
        let cred = SealCredential::Session("###".into());
        let client = reqwest::Client::new();
        let err = resolve_credential_to_session(&client, &cred, &pkg)
            .await
            .unwrap_err();
        match err {
            AppError::BadRequest(s) => {
                assert!(
                    !s.contains("not yet supported"),
                    "must not return the deprecated stub error: {}",
                    s,
                );
                assert!(
                    s.contains("x-seal-session"),
                    "error should mention x-seal-session for caller context: {}",
                    s,
                );
            }
            other => panic!("expected BadRequest, got {:?}", other),
        }
    }
}
