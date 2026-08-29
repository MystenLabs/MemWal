# memwal — Walrus Memory Rust SDK

Privacy-first AI memory for Rust agents and server-side integrations — [memory.walrus.xyz](https://memory.walrus.xyz).

The SDK talks to the Walrus Memory **relayer** over signed HTTPS. Embedding, SEAL
encryption, Walrus upload/download, and vector search all happen server-side; the
SDK signs each request with your Ed25519 delegate key and attaches a short-lived
SEAL session for decrypt-needing calls. It mirrors the TypeScript and Python SDKs.

## Installation

```toml
# Cargo.toml
[dependencies]
memwal = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

### Prerequisites

- A delegate key and account ID, registered on-chain for your Walrus Memory account
  (generate/register one at [memory.walrus.xyz](https://memory.walrus.xyz)'s dashboard,
  which calls `account::add_delegate_key`).
- A relayer URL matching where that key was registered — see Environment Presets below.
  A delegate key only works against the relayer it was registered on.

## Quick Start

```rust
use memwal::{WalrusMemory, RecallParams, WaitOptions};

#[tokio::main]
async fn main() -> memwal::Result<()> {
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

Run the bundled end-to-end example:

```bash
export WALRUS_MEMORY_PRIVATE_KEY=... WALRUS_MEMORY_ACCOUNT_ID=0x...
export WALRUS_MEMORY_ENV=dev   # match wherever your key was registered
cargo run --example quick_start
```

## Environment Presets

Instead of a full URL, select an environment with `.env(...)`. An explicit
`.server_url(...)` always wins.

| Env             | Relayer URL                                  |
|-----------------|-----------------------------------------------|
| `Env::Prod`     | `https://relayer.memory.walrus.xyz`          |
| `Env::Staging`  | `https://relayer-staging.memory.walrus.xyz`  |
| `Env::Dev`      | `https://relayer.dev.memwal.ai` (legacy pre-WALM-86 domain) |
| `Env::Local`    | `http://127.0.0.1:8000`                      |

```rust
use memwal::{Env, WalrusMemory};
let client = WalrusMemory::builder(key, account_id).env(Env::Staging).build()?;
```

## API Reference

`WalrusMemory::builder(key, account_id)` → `WalrusMemoryBuilder` → `.build() -> Result<WalrusMemory>`
(`.server_url`, `.env`, `.namespace`, `.http_client` are optional). All client
methods are `async`.

| Method | Description |
|--------|-------------|
| `remember(text, namespace?)` | Submit a memory; returns a `job_id` (async indexing) |
| `remember_and_wait(text, namespace?, opts)` | Submit and wait until indexed |
| `wait_for_remember_job(job_id, opts)` | Poll a job until `done` |
| `get_remember_status(job_id)` | One-shot job status |
| `recall(params)` | Semantic search (`RecallParams::new(query).limit(n).max_distance(d)`) |
| `embed(text)` | Embed text to a vector (requires the relayer to expose `/api/embed`) |
| `analyze(text, opts)` | Extract facts and enqueue a remember job per fact |
| `analyze_and_wait(text, opts, opts2)` | Analyze and wait for all fact jobs |
| `ask(question, limit?, namespace?)` | Retrieval-augmented answer over memories |
| `restore(namespace, limit?)` | Rebuild the local index from Walrus |
| `recall_manual(opts)` | Search with a pre-computed vector (blob ids + distances) |
| `remember_manual(opts)` | Index a memory you've already embedded/encrypted/uploaded yourself |
| `remember_bulk(items)` / `remember_bulk_and_wait(items, opts)` | Batch up to 20 memories |
| `get_remember_bulk_status(job_ids)` / `wait_for_remember_jobs(...)` | Batch job status |
| `health()` / `version()` | Relayer health & version metadata (unauthenticated) |
| `compatibility()` | Verify the relayer's API version is supported (cached after first success) |
| `public_key_hex()` | The delegate public key (hex) |
| `destroy(self)` | Zero the delegate key's seed material and drop the cached SEAL session |

Errors are returned as [`memwal::Error`] (`AuthRejected`, `Server { status, .. }`,
`JobFailed`, `JobTimeout`, `InvalidKey`, `Compatibility`, `SealSession`, …).

## Authentication

Each request signs the canonical message

```text
{timestamp}.{method}.{path}.{sha256(body)}.{nonce}.{account_id}
```

with the delegate Ed25519 key and sends:
`x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-account-id`.

Decrypt-needing calls (`remember`, `recall`, `analyze`, `ask`, `restore`, bulk
remember) additionally attach an `x-seal-session` header: a short-lived
SEAL session built by signing an ephemeral session key as a Sui personal
message with your delegate key, cached for ~10 minutes. The raw delegate
private key is never sent over the wire — this matches the TS/Python SDKs
and the relayer's current auth contract (the legacy `x-delegate-key` header
has been removed server-side).

## Status / Notes

- **`embed`** mirrors the TS/Python surface and calls `POST /api/embed`; some
  relayer deployments embed internally and do not expose this route (returns 404).
- **`remember_manual`**'s wire route (`POST /api/remember/manual`) mirrors
  `recall_manual`'s pattern but hasn't been confirmed against a live relayer —
  verify the exact field names/route before relying on it in production.
- Publishing to crates.io is not enabled yet.

## License

Apache-2.0
