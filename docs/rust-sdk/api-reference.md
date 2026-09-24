---
title: "API Reference"
description: "Builder options, async client methods, and error types for the Walrus Memory Rust SDK."
---

See also:

- [Configuration](/reference/configuration)
- [Relayer API](/relayer/api-reference)

All client methods are `async` and return `memwal::Result<T>` (an alias for `Result<T, memwal::Error>`).

## Constructing a client

```rust
use memwal::{Env, WalrusMemory};

// Builder (recommended)
let client = WalrusMemory::builder(private_key, account_id)
    .server_url("https://relayer.memory.walrus.xyz") // or .env(Env::Staging)
    .namespace("demo")                                // optional, defaults to "default"
    .build()?;

// One-shot helper (prod defaults)
let client = WalrusMemory::create(private_key, account_id)?;
```

### `WalrusMemoryBuilder`

| Method | Description |
|--------|-------------|
| `WalrusMemory::builder(key, account_id)` | Start a builder from a delegate private key + account ID |
| `.server_url(url)` | Explicit relayer URL (wins over `.env`) |
| `.env(Env)` | Environment preset — `Prod`, `Staging`, `Dev`, `Local` |
| `.namespace(ns)` | Default namespace for reads/writes |
| `.http_client(reqwest::Client)` | Supply a custom `reqwest` client (proxies, timeouts, pools) |
| `.build()` | Validate and construct `WalrusMemory` |

## Client methods

| Method | Description |
|--------|-------------|
| `remember(text, namespace?)` | Submit a memory; returns a `job_id` (async indexing) |
| `remember_and_wait(text, namespace?, opts)` | Submit and wait until indexed |
| `wait_for_remember_job(job_id, opts)` | Poll a job until `done` |
| `get_remember_status(job_id)` | One-shot job status |
| `recall(params)` | Semantic search — `RecallParams::new(query).limit(n).max_distance(d)` |
| `embed(text)` | Embed text to a vector (requires the relayer to expose `/api/embed`) |
| `analyze(text, opts)` | Extract facts and enqueue a remember job per fact |
| `analyze_and_wait(text, opts, wait_opts)` | Analyze and wait for all fact jobs |
| `ask(question, limit?, namespace?)` | Retrieval-augmented answer over memories |
| `restore(namespace, limit?)` | Rebuild the local index from Walrus |
| `recall_manual(opts)` | Search with a pre-computed vector (blob ids + distances) |
| `remember_manual(opts)` | Index a memory you've already embedded/encrypted/uploaded yourself |
| `remember_bulk(items)` / `remember_bulk_and_wait(items, opts)` | Batch up to 20 memories |
| `get_remember_bulk_status(job_ids)` / `wait_for_remember_jobs(...)` | Batch job status |
| `health()` / `version()` | Relayer health & version metadata (unauthenticated) |
| `compatibility()` | Verify the relayer's API version is supported (cached after first success) |
| `public_key_hex()` | The delegate public key (hex) |
| `server_url()` / `namespace()` | Inspect the effective configuration |
| `destroy(self)` | Zero the delegate key's seed material and drop the cached SEAL session |

## Waiting on jobs

`remember` indexes asynchronously and returns a `job_id`. Use the `_and_wait`
variants, or poll manually:

```rust
use memwal::WaitOptions;

let accepted = client.remember("note", None).await?;
let status = client
    .wait_for_remember_job(&accepted.job_id, WaitOptions::default())
    .await?;
```

`WaitOptions` controls the poll interval and timeout (`WaitOptions::default()` is a
sensible starting point).

## Errors

Methods return `memwal::Error`, a `thiserror` enum:

| Variant | Meaning |
|---------|---------|
| `InvalidKey` | The delegate key or account ID failed to parse |
| `InvalidUrl` | The configured server URL was malformed |
| `AuthRejected` | Relayer rejected the signature/SEAL session (HTTP 401) — usually an unregistered delegate key, clock skew, or a replayed nonce |
| `Incompatible` | Relayer requires a newer SDK (HTTP 426) |
| `Compatibility` | `compatibility()` couldn't reach `/version` or the relayer's API version isn't supported |
| `SealSession` | Building the SEAL session (ephemeral key, Sui signing, `/config` lookup) failed |
| `Server { status, .. }` | Relayer returned another non-success status |
| `JobFailed` / `JobNotFound` / `JobTimeout` | A remember/analyze job failed, was not found, or didn't finish before the wait timeout |
| `InvalidArgument` | A call was made with invalid arguments (empty query, empty vector, …) before any request was sent |
| `Transport` / `Json` | HTTP transport or (de)serialization failure |

## Status / Notes

- **`embed`** mirrors the TS/Python surface and calls `POST /api/embed`; some relayer deployments embed internally and do not expose this route (returns 404).
- **`remember_manual`**'s wire route (`POST /api/remember/manual`) mirrors `recall_manual`'s pattern but hasn't been confirmed against a live relayer yet — verify before relying on it in production.
