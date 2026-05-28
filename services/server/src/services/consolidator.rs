//! Consolidator service — **placeholder module**.
//!
//! Reserves the namespace for memory deduplication and supersede logic that
//! follow-up tasks will introduce. There is no consolidator on the current
//! dev base: dedup happens implicitly because Walrus blob IDs are content-
//! addressed (same plaintext → same SEAL ciphertext → same blob ID), so
//! identical writes naturally collide at the storage layer.
//!
//! This module is intentionally empty in Phase 2. The trait, types, and
//! implementations land when a real caller exists. Likely first uses:
//!
//! - **`linked_memory_ids` resolution** — when ingesting a new
//!   fact, fetch top-K semantically similar existing memories so the
//!   extractor LLM can cross-reference them.
//! - **Explicit supersede logic** — when a user contradicts earlier
//!   statements, mark the older memory's `valid_until` rather than appending
//!   a new contradicting row.
//! - **Hash-based dedup** — track an `existing_hashes` set per request and
//!   skip writes that would duplicate a hash already in the request batch.
//!
//! Adding any of these is the work of a follow-up task (the AI-improvement
//! track). This file exists so the structural home is named and discoverable.
