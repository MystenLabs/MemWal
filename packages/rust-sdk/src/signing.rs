//! Ed25519 request signing for the Walrus Memory relayer, plus the
//! low-level crypto/encoding helpers used to build a SEAL session.
//!
//! Every authenticated request signs the canonical message
//!
//! ```text
//! {timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}
//! ```
//!
//! with the delegate Ed25519 private key. The relayer recomputes the same
//! string from the request headers + received body bytes and verifies the
//! signature against the on-chain delegate-key set for the account.
//!
//! Separately, decrypt-requiring endpoints (`recall`, `remember`, `analyze`,
//! `ask`) also need an `x-seal-session` header: a short-lived SEAL session
//! built by signing a Sui "personal message" with the same delegate key. See
//! [`crate::WalrusMemory::build_seal_session`] for that flow; the pure
//! encoding helpers it depends on (blake2b, uleb128, bech32) live here.

use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Lowercase hex SHA-256 of `bytes`. The GET body hash is `sha256_hex(b"")`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Build the canonical message that gets Ed25519-signed.
///
/// `method` must be upper-case (`GET`/`POST`); `path` is the request path
/// (no scheme/host) including any query string the caller embedded.
pub fn canonical_message(
    timestamp: &str,
    method: &str,
    path: &str,
    body_sha256: &str,
    nonce: &str,
    account_id: &str,
) -> String {
    format!("{timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}")
}

/// Holds a delegate Ed25519 key pair derived from a 32-byte seed.
#[derive(Clone)]
pub struct Signer {
    signing_key: SigningKey,
    seed_hex: String,
    public_key_hex: String,
}

impl Signer {
    /// Build a signer from a hex-encoded 32-byte Ed25519 seed.
    ///
    /// Accepts an optional `0x` prefix and any letter case.
    pub fn from_hex_seed(key: &str) -> Result<Self> {
        let trimmed = key.trim().trim_start_matches("0x");
        let bytes =
            hex::decode(trimmed).map_err(|e| Error::InvalidKey(format!("not valid hex: {e}")))?;
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| Error::InvalidKey(format!("expected 32 bytes, got {}", bytes.len())))?;
        let signing_key = SigningKey::from_bytes(&seed);
        let public_key_hex = hex::encode(signing_key.verifying_key().to_bytes());
        Ok(Self {
            signing_key,
            seed_hex: hex::encode(seed),
            public_key_hex,
        })
    }

    /// Hex-encoded 32-byte public key.
    pub fn public_key_hex(&self) -> &str {
        &self.public_key_hex
    }

    /// Hex-encoded 64-byte Ed25519 signature over `message`.
    pub fn sign_hex(&self, message: &[u8]) -> String {
        hex::encode(self.signing_key.sign(message).to_bytes())
    }

    /// Raw Ed25519 signature over `message` (used for Sui personal-message
    /// signing, which needs the raw 64 bytes rather than hex).
    pub fn sign(&self, message: &[u8]) -> ed25519_dalek::Signature {
        self.signing_key.sign(message)
    }

    /// The underlying verifying (public) key bytes.
    pub fn verifying_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    /// Zero the key seed material in place. After calling this, the signer
    /// must not be used again — further signing attempts will produce
    /// garbage signatures rather than panicking.
    pub fn zeroize(&mut self) {
        use zeroize::Zeroize;
        self.seed_hex.zeroize();
        // ed25519_dalek::SigningKey has no public zeroize hook; overwrite the
        // hex-encoded copy (the only owned representation we control) and
        // drop our reference so the key can be reclaimed.
        self.signing_key = SigningKey::from_bytes(&[0u8; 32]);
    }
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never leak key material in Debug output.
        f.debug_struct("Signer")
            .field("public_key_hex", &self.public_key_hex)
            .field("seed_hex", &"<redacted>")
            .finish()
    }
}

// ── SEAL session encoding helpers ──────────────────────────────────────────

/// Blake2b-256 digest, used for the Sui personal-message hash and address
/// derivation.
pub fn blake2b_256(data: &[u8]) -> [u8; 32] {
    use blake2::digest::{Update, VariableOutput};
    use blake2::Blake2bVar;
    let mut hasher = Blake2bVar::new(32).expect("32 bytes output size is valid");
    hasher.update(data);
    let mut output = [0u8; 32];
    hasher
        .finalize_variable(&mut output)
        .expect("digest output");
    output
}

/// ULEB128-encode `value` (used for the Sui `PersonalMessage` length prefix).
pub fn encode_uleb128(mut value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = (value & 0x7F) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if value == 0 {
            break;
        }
    }
    bytes
}

fn bech32_polymod(values: &[u8]) -> u32 {
    let mut generator: u32 = 1;
    for &value in values {
        let top = generator >> 25;
        generator = ((generator & 0x1ffffff) << 5) ^ (value as u32);
        for (i, &g) in [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
            .iter()
            .enumerate()
        {
            if (top >> i) & 1 != 0 {
                generator ^= g;
            }
        }
    }
    generator
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v = Vec::new();
    for c in hrp.bytes() {
        v.push(c >> 5);
    }
    v.push(0);
    for c in hrp.bytes() {
        v.push(c & 31);
    }
    v
}

fn bech32_create_checksum(hrp: &str, data: &[u8]) -> Vec<u8> {
    let mut combined = bech32_hrp_expand(hrp);
    combined.extend_from_slice(data);
    combined.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
    let polymod = bech32_polymod(&combined) ^ 1;
    let mut checksum = Vec::with_capacity(6);
    for i in 0..6 {
        checksum.push(((polymod >> (5 * (5 - i))) & 31) as u8);
    }
    checksum
}

fn convert_bits(
    data: &[u8],
    from: u32,
    to: u32,
    pad: bool,
) -> std::result::Result<Vec<u8>, &'static str> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut ret = Vec::new();
    let maxv: u32 = (1 << to) - 1;
    let max_acc: u32 = (1 << (from + to - 1)) - 1;
    for &value in data {
        let v = value as u32;
        if (v >> from) != 0 {
            return Err("Invalid value");
        }
        acc = ((acc << from) | v) & max_acc;
        bits += from;
        while bits >= to {
            bits -= to;
            ret.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            ret.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err("Invalid padding");
    }
    Ok(ret)
}

/// Bech32-encode a 32-byte Ed25519 seed as a Sui `suiprivkey1...` string.
pub fn encode_suiprivkey(seed: &[u8; 32]) -> String {
    let mut payload = Vec::with_capacity(33);
    payload.push(0x00);
    payload.extend_from_slice(seed);

    let data_5bit = convert_bits(&payload, 8, 5, true).unwrap();
    let checksum = bech32_create_checksum("suiprivkey", &data_5bit);

    let mut combined = data_5bit;
    combined.extend_from_slice(&checksum);

    let charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let encoded: String = combined
        .iter()
        .map(|&b| charset.chars().nth(b as usize).unwrap())
        .collect();

    format!("suiprivkey1{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    // 32 bytes of 0x01.
    const SEED: &str = "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn sha256_of_empty_matches_known_vector() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn from_hex_seed_accepts_0x_prefix_and_any_case() {
        let a = Signer::from_hex_seed(SEED).unwrap();
        let b = Signer::from_hex_seed(&format!("0x{}", SEED.to_uppercase())).unwrap();
        assert_eq!(a.public_key_hex(), b.public_key_hex());
        assert_eq!(a.public_key_hex().len(), 64);
    }

    #[test]
    fn from_hex_seed_rejects_bad_input() {
        assert!(Signer::from_hex_seed("zz").is_err()); // not hex
        assert!(Signer::from_hex_seed("0102").is_err()); // wrong length
    }

    #[test]
    fn signature_is_deterministic_and_verifies() {
        let signer = Signer::from_hex_seed(SEED).unwrap();
        let msg = canonical_message(
            "1700000000",
            "POST",
            "/api/remember",
            &sha256_hex(b"{\"text\":\"hi\"}"),
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            "0xacct",
        );
        let sig1 = signer.sign_hex(msg.as_bytes());
        let sig2 = signer.sign_hex(msg.as_bytes());
        assert_eq!(sig1, sig2, "ed25519 signing must be deterministic");
        assert_eq!(sig1.len(), 128, "64-byte signature as hex");

        let pk: [u8; 32] = hex::decode(signer.public_key_hex())
            .unwrap()
            .try_into()
            .unwrap();
        let vk = VerifyingKey::from_bytes(&pk).unwrap();
        let sig_bytes: [u8; 64] = hex::decode(&sig1).unwrap().try_into().unwrap();
        let sig = Signature::from_bytes(&sig_bytes);
        assert!(vk.verify(msg.as_bytes(), &sig).is_ok());

        let tampered = canonical_message(
            "1700000001", // changed timestamp
            "POST",
            "/api/remember",
            &sha256_hex(b"{\"text\":\"hi\"}"),
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
            "0xacct",
        );
        assert!(vk.verify(tampered.as_bytes(), &sig).is_err());
    }

    #[test]
    fn canonical_message_is_six_dot_separated_fields() {
        let m = canonical_message(
            "1700000000",
            "POST",
            "/api/recall",
            "abc",
            "nonce",
            "0xacct",
        );
        assert_eq!(m, "1700000000.POST./api/recall.abc.nonce.0xacct");
        assert_eq!(m.matches('.').count(), 5);
    }

    #[test]
    fn zeroize_clears_seed_hex() {
        let mut signer = Signer::from_hex_seed(SEED).unwrap();
        signer.zeroize();
        assert_eq!(signer.seed_hex, "");
    }

    #[test]
    fn uleb128_encoding() {
        assert_eq!(encode_uleb128(0), vec![0]);
        assert_eq!(encode_uleb128(127), vec![127]);
        assert_eq!(encode_uleb128(128), vec![128, 1]);
        assert_eq!(encode_uleb128(145), vec![0x91, 0x01]);
    }

    #[test]
    fn sui_address_derivation_shape() {
        let signer = Signer::from_hex_seed(SEED).unwrap();
        let mut address_input = Vec::new();
        address_input.push(0x00);
        address_input.extend_from_slice(&signer.verifying_key_bytes());
        let address_hash = blake2b_256(&address_input);
        let address = format!("0x{}", hex::encode(address_hash));

        assert!(address.starts_with("0x"));
        assert_eq!(address.len(), 66);
    }

    #[test]
    fn suiprivkey_bech32_encoding() {
        let seed: [u8; 32] = [1; 32];
        let encoded = encode_suiprivkey(&seed);
        assert!(encoded.starts_with("suiprivkey1"));

        let data_part = &encoded["suiprivkey1".len()..];
        for c in data_part.chars() {
            assert!(
                "qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(c),
                "character {c} not in bech32 charset"
            );
        }
    }
}
