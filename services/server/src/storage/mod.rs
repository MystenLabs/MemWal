//! Storage primitives: PostgreSQL+pgvector, Walrus blob storage, SEAL encryption,
//! and Sui chain interactions. These are the low-level persistence and chain layers
//! that the higher-level engine and pipeline stages compose on top of.

pub mod db;
pub mod seal;
pub mod sui;
pub mod walrus;
