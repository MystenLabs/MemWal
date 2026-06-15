//! V2 DEK envelope — the AES-256-GCM **data leg**.
//!
//! V2 splits encryption into two legs (design: "DEK Envelope Encryption"):
//!   - **data leg** (this module): a random per-`(namespace, key_version)` DEK
//!     encrypts the payload with AES-256-GCM. The resulting container is the
//!     Walrus blob.
//!   - **DEK leg** (the TS sidecar, `@mysten/seal`): the 32-byte DEK is
//!     Seal-wrapped under the namespace-anchored identity and stored on-chain in
//!     `MemoryNamespace.wrapped_deks[key_version]`.
//!
//! Re-keying / ownership transfer re-wraps a 32-byte DEK, never the blob bytes;
//! deleting the wrapped DEK crypto-shreds the data. Neither store alone is
//! sufficient: Walrus holds only ciphertext, the chain holds only the wrapped DEK.
//!
//! ## Container layout (format v1) — finalized here (design §16 left it open)
//! ```text
//! magic[4] "WMEM" | format_version[1]=1 | header_len[2] LE
//!   | header[header_len]                       <-- v1: namespace_id[32] || key_version[4] LE
//!   | nonce[12] (fresh random per encryption)
//!   | AES-256-GCM(plaintext, key = DEK, nonce, aad = the cleartext prefix)
//!     ...where `prefix` = magic||format_version||header_len||header
//! ```
//! The prefix is cleartext (so the reader can pick the right DEK by `key_version`
//! before it has the DEK) but **authenticated**: GCM computes its tag over
//! `(ciphertext, aad=prefix)`, so any tamper of magic / version / namespace_id /
//! key_version fails decryption. The stored nonce is GCM's nonce input — swapping
//! it also fails the tag — so it needs no separate binding.
//!
//! ## The fixed-IV landmine (design §10)
//! A DEK is reused across many blobs of a `(namespace, key_version)` cohort, so
//! **every encryption MUST use a fresh random nonce** — reusing a `(key, nonce)`
//! pair in GCM is catastrophic (keystream + GHASH-subkey reuse). We therefore use
//! a standard AES-GCM impl with a CSPRNG nonce, never Seal's fixed-IV DEM (which
//! is only safe inside Seal because Seal derives a fresh key per encrypt).

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use std::fmt;

/// Container magic / format discriminator.
pub const ENVELOPE_MAGIC: [u8; 4] = *b"WMEM";
/// Current envelope format version.
pub const ENVELOPE_FORMAT_V1: u8 = 1;
/// Data-encryption-key length (AES-256).
pub const DEK_LEN: usize = 32;

const NONCE_LEN: usize = 12;
const NS_ID_LEN: usize = 32;
const KEY_VERSION_LEN: usize = 4;
/// v1 header = namespace_id(32) || key_version(4).
const HEADER_V1_LEN: usize = NS_ID_LEN + KEY_VERSION_LEN;
/// Bytes before the header: magic(4) || format_version(1) || header_len(2).
const PRECHEADER_LEN: usize = 4 + 1 + 2;

/// Cleartext, tamper-bound metadata read from a container before decryption.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeHeader {
    pub format_version: u8,
    /// Governing `MemoryNamespace` object id (the authz/identity anchor).
    pub namespace_id: [u8; NS_ID_LEN],
    /// Which `wrapped_deks[v]` decrypts this blob.
    pub key_version: u32,
}

/// Errors from envelope parsing / opening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvelopeError {
    /// Container does not begin with the `WMEM` magic.
    BadMagic,
    /// Container declares a format version this build does not understand.
    UnsupportedVersion(u8),
    /// Container is shorter than its declared structure requires.
    Truncated,
    /// AEAD authentication failed — wrong DEK, or ciphertext/header tampered.
    Decrypt,
}

impl fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnvelopeError::BadMagic => write!(f, "envelope: bad magic (not WMEM)"),
            EnvelopeError::UnsupportedVersion(v) => {
                write!(f, "envelope: unsupported format version {v}")
            }
            EnvelopeError::Truncated => write!(f, "envelope: truncated container"),
            EnvelopeError::Decrypt => {
                write!(f, "envelope: AEAD authentication failed (wrong key or tampered)")
            }
        }
    }
}

impl std::error::Error for EnvelopeError {}

/// Generate a fresh random 256-bit DEK from the OS CSPRNG. Never derive a DEK
/// from predictable material.
pub fn generate_dek() -> [u8; DEK_LEN] {
    let mut dek = [0u8; DEK_LEN];
    OsRng.fill_bytes(&mut dek);
    dek
}

/// Serialize the cleartext prefix `magic || format_version || header_len ||
/// header` that is both stored at the front of the container and fed to GCM as
/// AAD. v1 header = `namespace_id || key_version(LE)`.
fn build_prefix(namespace_id: &[u8; NS_ID_LEN], key_version: u32) -> Vec<u8> {
    let header_len = HEADER_V1_LEN as u16;
    let mut prefix = Vec::with_capacity(PRECHEADER_LEN + HEADER_V1_LEN);
    prefix.extend_from_slice(&ENVELOPE_MAGIC);
    prefix.push(ENVELOPE_FORMAT_V1);
    prefix.extend_from_slice(&header_len.to_le_bytes());
    prefix.extend_from_slice(namespace_id);
    prefix.extend_from_slice(&key_version.to_le_bytes());
    prefix
}

/// Encrypt `plaintext` under `dek` into a self-describing container (the Walrus
/// blob). Uses a fresh random nonce every call (see the fixed-IV note above).
pub fn seal_envelope(
    dek: &[u8; DEK_LEN],
    namespace_id: &[u8; NS_ID_LEN],
    key_version: u32,
    plaintext: &[u8],
) -> Vec<u8> {
    let prefix = build_prefix(namespace_id, key_version);

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(dek).expect("DEK is exactly 32 bytes");
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad: &prefix })
        // AES-GCM encryption is infallible for our message sizes (< 64 GiB).
        .expect("aes-256-gcm encrypt");

    let mut out = prefix;
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

/// Read the cleartext header (magic, version, namespace_id, key_version) without
/// the DEK — so a reader can fetch the right `wrapped_deks[key_version]` first.
/// Does NOT authenticate; integrity is only verified by [`open_envelope`].
pub fn parse_header(container: &[u8]) -> Result<EnvelopeHeader, EnvelopeError> {
    if container.len() < PRECHEADER_LEN {
        return Err(EnvelopeError::Truncated);
    }
    if container[0..4] != ENVELOPE_MAGIC {
        return Err(EnvelopeError::BadMagic);
    }
    let format_version = container[4];
    if format_version != ENVELOPE_FORMAT_V1 {
        return Err(EnvelopeError::UnsupportedVersion(format_version));
    }
    let header_len = u16::from_le_bytes([container[5], container[6]]) as usize;
    if header_len < HEADER_V1_LEN || container.len() < PRECHEADER_LEN + header_len {
        return Err(EnvelopeError::Truncated);
    }
    let h = PRECHEADER_LEN;
    let mut namespace_id = [0u8; NS_ID_LEN];
    namespace_id.copy_from_slice(&container[h..h + NS_ID_LEN]);
    let key_version = u32::from_le_bytes([
        container[h + NS_ID_LEN],
        container[h + NS_ID_LEN + 1],
        container[h + NS_ID_LEN + 2],
        container[h + NS_ID_LEN + 3],
    ]);
    Ok(EnvelopeHeader { format_version, namespace_id, key_version })
}

/// Decrypt a container with `dek`, returning the plaintext. The GCM tag verifies
/// both the ciphertext and the cleartext header (AAD), so any tamper fails here.
/// Read [`parse_header`] first to choose `dek` by `key_version`.
pub fn open_envelope(dek: &[u8; DEK_LEN], container: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    // Validates magic + version and bounds-checks the header.
    let _header = parse_header(container)?;
    let header_len = u16::from_le_bytes([container[5], container[6]]) as usize;

    let prefix_end = PRECHEADER_LEN + header_len;
    let nonce_end = prefix_end + NONCE_LEN;
    if container.len() < nonce_end {
        return Err(EnvelopeError::Truncated);
    }
    let prefix = &container[..prefix_end];
    let nonce = Nonce::from_slice(&container[prefix_end..nonce_end]);
    let ciphertext = &container[nonce_end..];

    let cipher = Aes256Gcm::new_from_slice(dek).expect("DEK is exactly 32 bytes");
    cipher
        .decrypt(nonce, Payload { msg: ciphertext, aad: prefix })
        .map_err(|_| EnvelopeError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ns(seed: u8) -> [u8; NS_ID_LEN] {
        [seed; NS_ID_LEN]
    }

    #[test]
    fn round_trip() {
        let dek = generate_dek();
        let pt = b"hello walrus memory";
        let c = seal_envelope(&dek, &ns(7), 1, pt);
        assert_eq!(open_envelope(&dek, &c).unwrap(), pt);
    }

    #[test]
    fn round_trip_empty_plaintext() {
        let dek = generate_dek();
        let c = seal_envelope(&dek, &ns(1), 3, b"");
        assert_eq!(open_envelope(&dek, &c).unwrap(), b"");
    }

    #[test]
    fn header_is_readable_without_dek() {
        let dek = generate_dek();
        let c = seal_envelope(&dek, &ns(0xAB), 42, b"x");
        let h = parse_header(&c).unwrap();
        assert_eq!(h.format_version, ENVELOPE_FORMAT_V1);
        assert_eq!(h.namespace_id, ns(0xAB));
        assert_eq!(h.key_version, 42);
    }

    /// The fixed-IV landmine guard: the SAME (dek, namespace, key_version,
    /// plaintext) must produce DIFFERENT containers (fresh nonce), while the
    /// cleartext prefix stays identical.
    #[test]
    fn nonce_is_fresh_per_encryption() {
        let dek = generate_dek();
        let (n, kv, pt) = (ns(5), 1u32, b"same plaintext" as &[u8]);
        let c1 = seal_envelope(&dek, &n, kv, pt);
        let c2 = seal_envelope(&dek, &n, kv, pt);
        assert_ne!(c1, c2, "containers must differ (fresh nonce per encryption)");
        let prefix_end = PRECHEADER_LEN + HEADER_V1_LEN;
        assert_eq!(c1[..prefix_end], c2[..prefix_end], "prefix is deterministic");
        assert_ne!(
            c1[prefix_end..prefix_end + NONCE_LEN],
            c2[prefix_end..prefix_end + NONCE_LEN],
            "nonce must be random"
        );
    }

    #[test]
    fn wrong_dek_fails() {
        let dek = generate_dek();
        let other = generate_dek();
        let c = seal_envelope(&dek, &ns(2), 1, b"secret");
        assert_eq!(open_envelope(&other, &c), Err(EnvelopeError::Decrypt));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let dek = generate_dek();
        let mut c = seal_envelope(&dek, &ns(2), 1, b"secret payload");
        let last = c.len() - 1;
        c[last] ^= 0x01;
        assert_eq!(open_envelope(&dek, &c), Err(EnvelopeError::Decrypt));
    }

    /// Tampering a header field (here, a byte of namespace_id) is readable by
    /// `parse_header` but fails the AEAD tag because the header is the AAD.
    #[test]
    fn tampered_header_fails_aead() {
        let dek = generate_dek();
        let mut c = seal_envelope(&dek, &ns(2), 1, b"secret");
        // First byte of namespace_id sits right after the precheader.
        c[PRECHEADER_LEN] ^= 0xFF;
        // Header still parses (cleartext) but now reports a different namespace...
        assert_ne!(parse_header(&c).unwrap().namespace_id, ns(2));
        // ...and decryption rejects the tamper via the AAD binding.
        assert_eq!(open_envelope(&dek, &c), Err(EnvelopeError::Decrypt));
    }

    #[test]
    fn bad_magic_and_version() {
        assert_eq!(parse_header(b"XXXX....").unwrap_err(), EnvelopeError::BadMagic);
        let mut c = seal_envelope(&generate_dek(), &ns(1), 1, b"x");
        c[4] = 0x09; // bogus format_version
        assert_eq!(parse_header(&c).unwrap_err(), EnvelopeError::UnsupportedVersion(9));
    }

    #[test]
    fn truncated_fails() {
        assert_eq!(parse_header(b"WM").unwrap_err(), EnvelopeError::Truncated);
        let c = seal_envelope(&generate_dek(), &ns(1), 1, b"data");
        // Drop the tag/nonce tail.
        assert!(matches!(
            open_envelope(&generate_dek(), &c[..PRECHEADER_LEN + HEADER_V1_LEN + 2]),
            Err(EnvelopeError::Truncated)
        ));
    }
}
