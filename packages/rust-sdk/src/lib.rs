//! # Walrus Memory Rust SDK
//!
//! A native, async Rust client for [Walrus Memory](https://memory.walrus.xyz) — a
//! privacy-first AI memory layer. Memories are embedded, SEAL-encrypted, and
//! stored on Walrus by the relayer; ownership is enforced on-chain on Sui.
//!
//! Every authenticated request is Ed25519-signed with your delegate key, and
//! decrypt-requiring endpoints additionally attach a short-lived SEAL session
//! (built by signing a Sui personal message with the same delegate key) —
//! your raw private key is never sent over the wire.
//!
//! ## Quick start
//!
//! ```no_run
//! use walrus_memory::{RecallParams, WaitOptions, WalrusMemory};
//!
//! # async fn run() -> walrus_memory::Result<()> {
//! let client = WalrusMemory::builder(
//!     "<your-ed25519-delegate-key-hex>",
//!     "<your-walrus-memory-account-id>",
//! )
//! .server_url("https://relayer.memory.walrus.xyz")
//! .namespace("demo")
//! .build()?;
//!
//! client.remember_and_wait("I live in Hanoi.", None, WaitOptions::default()).await?;
//! let hits = client.recall(RecallParams::new("Where do I live?").limit(5)).await?;
//! for m in hits.results {
//!     println!("{}", m.text);
//! }
//! # Ok(())
//! # }
//! ```

mod client;
mod error;
mod signing;
mod types;

pub use client::{WalrusMemory, WalrusMemoryBuilder};
pub use error::{Error, Result};
pub use types::*;
