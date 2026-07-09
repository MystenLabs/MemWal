---
title: "Quick Start"
description: "Install the Walrus Memory Rust SDK and store your first memory in under a minute."
---

The Walrus Memory Rust SDK (`walrus-memory` on crates.io) is a native client for Rust-based AI agents and server-side integrations. It mirrors the [TypeScript](/sdk/quick-start) and [Python](/python-sdk/quick-start) SDKs: same relayer, same Ed25519 + SEAL-session auth, same methods.

The SDK talks to the Walrus Memory **relayer** over signed HTTPS. Embedding, SEAL encryption, Walrus upload/download, and vector search all happen server-side; the SDK signs each request with your Ed25519 delegate key and attaches a short-lived SEAL session for decrypt-needing calls.

## Installation

```toml
# Cargo.toml
[dependencies]
walrus-memory = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The client is async-first and runs on the [Tokio](https://tokio.rs) runtime. HTTP is handled by [`reqwest`](https://docs.rs/reqwest) (rustls TLS) and signing by [`ed25519-dalek`](https://docs.rs/ed25519-dalek).

### Prerequisites

- A delegate key and account ID, registered on-chain for your Walrus Memory account (generate/register one at [memory.walrus.xyz](https://memory.walrus.xyz)'s dashboard).
- A relayer URL matching where that key was registered — see Environment Presets below. A delegate key only works against the relayer it was registered on.

## Quick Start

```rust
use walrus_memory::{WalrusMemory, RecallParams, WaitOptions};

#[tokio::main]
async fn main() -> walrus_memory::Result<()> {
    let client = WalrusMemory::builder(
        std::env::var("WALRUS_MEMORY_PRIVATE_KEY").unwrap(),
        std::env::var("WALRUS_MEMORY_ACCOUNT_ID").unwrap(),
    )
    .server_url("https://relayer.memory.walrus.xyz")
    .namespace("demo")
    .build()?;

    client.health().await?;

    // Store a memory and wait for it to be indexed.
    let stored = client
        .remember_and_wait("User prefers dark mode and TypeScript.", None, WaitOptions::default())
        .await?;
    println!("stored {}", stored.blob_id);

    // Recall it.
    let hits = client
        .recall(RecallParams::new("What are the user's preferences?").limit(5))
        .await?;
    for m in hits.results {
        println!("{:.3}  {}", 1.0 - m.distance, m.text);
    }

    // Ask a question over stored memories (RAG).
    let answer = client.ask("Where does the user live?", Some(5), None).await?;
    println!("{}", answer.answer);
    Ok(())
}
```

Run the bundled end-to-end example from the [package source](https://github.com/MystenLabs/MemWal/tree/dev/packages/rust-sdk):

```bash
export WALRUS_MEMORY_PRIVATE_KEY=... WALRUS_MEMORY_ACCOUNT_ID=0x...
export WALRUS_MEMORY_ENV=dev   # match wherever your key was registered
cargo run --example quick_start
```

## Environment Presets

Instead of a full URL, select an environment with `.env(...)`. An explicit `.server_url(...)` always wins.

| Env             | Relayer URL                                  |
|-----------------|-----------------------------------------------|
| `Env::Prod`     | `https://relayer.memory.walrus.xyz`          |
| `Env::Staging`  | `https://relayer-staging.memory.walrus.xyz`  |
| `Env::Dev`      | `https://relayer.dev.memwal.ai` (legacy pre-rebrand domain) |
| `Env::Local`    | `http://127.0.0.1:8000`                      |

```rust
use walrus_memory::{Env, WalrusMemory};

let client = WalrusMemory::builder(key, account_id)
    .env(Env::Staging)
    .build()?;
```

## Authentication

Each request signs the canonical message

```text
{timestamp}.{method}.{path}.{sha256(body)}.{nonce}.{account_id}
```

with the delegate Ed25519 key and sends these headers:
`x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-account-id`.

Decrypt-needing calls (`remember`, `recall`, `analyze`, `ask`, `restore`, bulk remember) additionally attach an `x-seal-session` header — a short-lived SEAL session built by signing an ephemeral session key as a Sui personal message with your delegate key. Your raw delegate private key is never sent over the wire.

## Next Steps

- [API Reference](/rust-sdk/api-reference) — full method list, builder options, and error types
- [Configuration](/reference/configuration) — environment variables and relayer settings
- [Relayer API](/relayer/api-reference) — the HTTP surface the SDK signs against
