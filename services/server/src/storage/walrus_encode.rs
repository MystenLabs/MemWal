//! Native RedStuff erasure-coding metadata computation (WALM-184: Walrus
//! write-path migration, step 1 of 3 — encode).
//!
//! Uses Mysten's own `walrus-core` crate (not a reimplementation of the
//! encoding/Merkle-tree scheme) with `default-features = false`, which skips
//! the optional `sui-types` feature — that feature pulls the full Sui
//! monorepo and conflicts with this server's own sqlx/pgvector dependency
//! pins (see `services/server/Cargo.toml` comment on the `walrus-core` line,
//! and the git history of this file's introducing commit for the full
//! investigation: `walrus-sui`, which bundles register/upload/certify
//! end-to-end, does NOT build alongside this server's dependencies; plain
//! `walrus-core` alone does).
//!
//! This module is intentionally read-only / side-effect-free: it computes
//! the `blob_id`/`root_hash`/`size`/`encoding_type` values that
//! `register_blob` needs, but does not build or submit any transaction.
//! Wiring this into the actual register/upload/certify flow (which spends
//! real WAL and moves funds) is a deliberately separate, not-yet-done step —
//! it additionally requires confirming the exact BCS `u256` argument
//! encoding accepted by `sui-transaction-builder`'s `pure()`, which has not
//! been verified yet.

use std::num::NonZeroU16;
use walrus_core::encoding::{EncodingConfig, EncodingFactory};
use walrus_core::metadata::BlobMetadataApi;
use walrus_core::{BlobId, EncodingType};

#[derive(Debug)]
pub struct BlobMetadata {
    /// Raw 32-byte blob ID, matching `walrus_core::BlobId`'s internal
    /// representation. `Display`-formats to the same base64url string
    /// Walrus aggregators/publishers use (cross-checked against
    /// `BlobId`'s own `Display` impl, which is `Base64Display` with
    /// `URL_SAFE_NO_PAD` — the same encoding `blob_id_from_raw` in
    /// `storage::walrus` decodes on the read path).
    pub blob_id: [u8; 32],
    /// Raw 32-byte Merkle root over the blob's sliver pairs.
    pub root_hash: [u8; 32],
    pub unencoded_length: u64,
    pub encoding_type: EncodingType,
}

#[derive(Debug)]
pub enum EncodeError {
    /// The blob is too large to encode for the given shard count (see
    /// `walrus_core::encoding::DataTooLargeError`).
    TooLarge(String),
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge(msg) => write!(f, "blob too large to encode: {msg}"),
        }
    }
}

impl std::error::Error for EncodeError {}

/// Compute the RS2-encoded metadata for `blob` without producing or
/// uploading any slivers — the Upload Relay does that from the raw,
/// unencoded bytes once the blob is registered on-chain with these values.
///
/// `n_shards` is the current Walrus committee's shard count, read from the
/// on-chain `System::n_shards()` view function (not hardcoded — it changes
/// across epochs).
pub fn compute_blob_metadata(blob: &[u8], n_shards: NonZeroU16) -> Result<BlobMetadata, EncodeError> {
    let config = EncodingConfig::new(n_shards);
    let verified = config
        .reed_solomon
        .compute_metadata(blob)
        .map_err(|e| EncodeError::TooLarge(e.to_string()))?;

    let blob_id: BlobId = *verified.blob_id();
    let metadata = verified.metadata();
    let root_hash = metadata.compute_root_hash();

    let root_hash: [u8; 32] = root_hash
        .as_ref()
        .try_into()
        .expect("Merkle root is always DIGEST_LEN (32) bytes");

    Ok(BlobMetadata {
        blob_id: blob_id.0,
        root_hash,
        unencoded_length: metadata.unencoded_length(),
        encoding_type: metadata.encoding_type(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_blob_metadata_is_deterministic() {
        let n_shards = NonZeroU16::new(100).unwrap();
        let blob = b"hello walrus, this is a test blob for metadata computation";
        let a = compute_blob_metadata(blob, n_shards).unwrap();
        let b = compute_blob_metadata(blob, n_shards).unwrap();
        assert_eq!(a.blob_id, b.blob_id);
        assert_eq!(a.root_hash, b.root_hash);
        assert_eq!(a.unencoded_length, blob.len() as u64);
        assert_eq!(a.encoding_type, EncodingType::RS2);
    }

    #[test]
    fn compute_blob_metadata_differs_for_different_blobs() {
        let n_shards = NonZeroU16::new(100).unwrap();
        let a = compute_blob_metadata(b"blob one", n_shards).unwrap();
        let b = compute_blob_metadata(b"blob two", n_shards).unwrap();
        assert_ne!(a.blob_id, b.blob_id);
        assert_ne!(a.root_hash, b.root_hash);
    }

    #[test]
    fn compute_blob_metadata_matches_blob_id_display_format() {
        // Cross-check: BlobId's own Display impl (base64url, URL_SAFE_NO_PAD)
        // must round-trip through our raw-byte extraction unchanged — this
        // confirms `blob_id: [u8; 32]` from this module is byte-for-byte
        // walrus_core's BlobId, not a reinterpretation.
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;

        let n_shards = NonZeroU16::new(100).unwrap();
        let blob = b"cross-check blob";
        let result = compute_blob_metadata(blob, n_shards).unwrap();
        let reconstructed = BlobId(result.blob_id);
        let expected_display = URL_SAFE_NO_PAD.encode(result.blob_id);
        assert_eq!(reconstructed.to_string(), expected_display);
    }
}
