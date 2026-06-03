//! Storage primitives: PostgreSQL+pgvector, Walrus blob storage, native SEAL
//! encryption/decryption, and Sui chain interactions.
//!
//! These are the low-level persistence and chain layers that the
//! higher-level [`crate::engine`] composes on top of. The engine owns the
//! *choreography* (encrypt → upload → index → cleanup); these modules own
//! the individual operations:
//!
//! - [`db`] — `VectorDb`: Postgres+pgvector connection pool, migrations,
//!   vector insert/search, blob-id cleanup, the delegate-key cache, storage
//!   quota accounting, the benchmark-mode `plaintext` helpers.
//! - [`walrus`] — Walrus blob upload through the configured publisher, HTTP
//!   aggregator download, and trusted blob caching.
//! - [`seal`] — native SEAL threshold encrypt/decrypt (+ batch decrypt), the
//!   `SealCredential` resolution (session > delegate key > server fallback),
//!   and `DecryptOutcome` classification.
//! - [`sui`] — Sui RPC: delegate-key on-chain verification, account lookup.

pub mod db;
pub mod seal;
pub mod sui;
pub mod walrus;
