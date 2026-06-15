//! Storage primitives: PostgreSQL+pgvector, Walrus blob storage, SEAL
//! encryption (via the TS sidecar), and Sui chain interactions.
//!
//! These are the low-level persistence and chain layers that the
//! higher-level [`crate::engine`] composes on top of. The engine owns the
//! *choreography* (encrypt → upload → index → cleanup); these modules own
//! the individual operations:
//!
//! - [`db`] — `VectorDb`: Postgres+pgvector connection pool, migrations,
//!   vector insert/search, blob-id cleanup, the delegate-key cache, storage
//!   quota accounting, the benchmark-mode `plaintext` helpers.
//! - [`walrus`] — Walrus blob upload (via the relay sidecar), HTTP aggregator
//!   download, on-chain blob metadata/transfer, blob discovery.
//! - [`seal`] — SEAL threshold encrypt/decrypt (+ batch decrypt) via the
//!   TS sidecar; the `SealCredential` resolution (session > delegate key >
//!   server fallback) and `DecryptOutcome` classification.
//! - [`envelope`] — V2 DEK envelope: AES-256-GCM data leg + container/AAD
//!   format. Seal wraps only the 32-byte DEK; this module owns the blob bytes.
//! - [`sui`] — Sui RPC: delegate-key on-chain verification, account lookup.

pub mod db;
pub mod envelope;
pub mod seal;
pub mod sui;
pub mod walrus;
