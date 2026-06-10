# WALM-110: Migrate Indexer off `suix_queryEvents` JSON-RPC Polling

**Date:** 2026-06-10  
**Status:** Approved  
**Owner:** TBD  
**Linear:** [WALM-110](https://linear.app/mysten-labs/issue/WALM-110/indexer-migrate-off-suix-queryevents-json-rpc-polling)

---

## 1. Problem

The MemWal indexer (`services/indexer`) currently polls Sui events by sending raw HTTP JSON-RPC `suix_queryEvents` requests via `reqwest`. This is brittle (hand-rolled JSON bodies, manual cursor parsing) and increasingly discouraged as Mysten moves first-class APIs to gRPC. WALM-110 migrates the indexer to use gRPC event queries while keeping the same polling semantics.

## 2. Goals

- Replace raw HTTP JSON-RPC `suix_queryEvents` with a typed gRPC equivalent.
- Keep the existing polling loop, cursor, and DB persistence behavior unchanged.
- Introduce an abstraction (`EventSource`) so future transport changes (checkpoints, subscriptions) do not require another loop refactor.
- Index only `AccountCreated` events on launch; structure the code so adding `DelegateKeyAdded`, `DelegateKeyRemoved`, etc. is straightforward.

## 3. Non-Goals

- Changing the PostgreSQL schema or adding new tables.
- Switching to streaming/subscriptions or checkpoint-based indexing.
- Extracting a reusable Sui client crate for other services.
- Adding backfill or re-org handling logic.

## 4. Architecture & Components

The indexer remains a standalone Rust binary. We add a `sui` module and an `extractors` module.

```
services/indexer/src/
├── main.rs          // CLI, config, DB pool, runs IndexerApp
├── app.rs           // IndexerApp loop
├── sui/
│   ├── mod.rs       // EventSource trait, EventPage, errors
│   └── grpc.rs      // GrpcEventSource implementation
└── extractors.rs    // AccountCreatedExtractor + future extractors
```

### 4.1 `EventSource` trait

```rust
#[async_trait]
trait EventSource {
    async fn query_events(
        &mut self,
        filter: EventFilter,
        cursor: Option<EventId>,
        limit: usize,
    ) -> Result<EventPage, EventSourceError>;
}
```

`EventFilter` is a small domain enum (initially only `MoveEventType`). `EventPage` contains `events: Vec<SuiEvent>`, `next_cursor: Option<EventId>`, and `has_next_page: bool`.

### 4.2 `GrpcEventSource`

Implements `EventSource` using the Sui Rust SDK gRPC client (crate TBD — likely `sui-sdk` or `mysten-sui` depending on which exposes the stable gRPC client at implementation time). It:

1. Maps our `EventFilter` to the SDK's typed filter.
2. Calls the SDK `query_events` gRPC method.
3. Normalizes the SDK response into our `EventPage` so `IndexerApp` never sees SDK-specific types.

### 4.3 `AccountCreatedExtractor`

Pure function (or small struct) that takes a `SuiEvent` and returns `AccountRow { account_id, owner }`. This is where future event types would add their own extractors.

### 4.4 `IndexerApp`

The existing main loop, refactored to accept a `Box<dyn EventSource>` instead of building raw `reqwest` bodies. It handles:

- Cursor hydration from `indexer_state`.
- Calling `event_source.query_events(...)`.
- Running extractors and persisting rows.
- Saving the new cursor.
- Pagination / sleep logic.

## 5. Data Flow

1. **Bootstrap** — Load `EventCursor` (`tx_digest` + `event_seq`) from `indexer_state`. If missing, start from `None`.
2. **Query** — `IndexerApp` calls `event_source.query_events(MoveEventType { package_id, module: "account", event: "AccountCreated" }, cursor, 50)`.
3. **Extract** — For each `SuiEvent` in the page, run `AccountCreatedExtractor::extract(event)`. On parse failure, log the event and skip.
4. **Persist** — `INSERT INTO accounts (account_id, owner) VALUES ... ON CONFLICT DO NOTHING` in a single batched statement.
5. **Cursor save** — Update `indexer_state` with the last event's `EventId`.
6. **Pagination / sleep** — If `has_next_page == true`, immediately loop to step 2 with the new cursor. Otherwise, `tokio::time::sleep(POLL_INTERVAL_SECS)`.

## 6. Error Handling

| Error | Behavior |
|-------|----------|
| **Transient gRPC errors** (`Unavailable`, `DeadlineExceeded`, connection reset) | Retry with exponential backoff (3 attempts: 1s, 2s, 4s). Log `warn!`. If all retries fail, sleep for `POLL_INTERVAL_SECS` and try the next cycle. |
| **Permanent gRPC errors** (`InvalidArgument`, `PermissionDenied`, `Unimplemented`) | Log `error!` and `std::process::exit(1)`. These indicate misconfiguration. |
| **DB errors** | Log `error!` and `std::process::exit(1)`. Same behavior as today. |
| **Parse errors** (extractor fails to deserialize an event) | Log `warn!` with the event digest and continue. Prevents a single malformed event from stalling the indexer. |

`EventSourceError` distinguishes transient vs. permanent so `IndexerApp` doesn't need to know gRPC status codes:

```rust
enum EventSourceError {
    Transient { source: Box<dyn std::error::Error + Send + Sync> },
    Permanent { source: Box<dyn std::error::Error + Send + Sync> },
}
```

## 7. Dependencies

Add to `services/indexer/Cargo.toml`:

- `sui-sdk` (or the specific `mysten-sui` gRPC client crate) — typed gRPC client.
- `async-trait` — if not already present, for the `EventSource` trait.

Remove or deprecate: none on day one. `reqwest` may be removed later if no longer used elsewhere in the indexer.

## 8. Testing Strategy

1. **Unit — Extractor**
   Uses hand-constructed `SuiEvent` structs (no network) to assert `AccountCreatedExtractor` output.

2. **Unit — IndexerApp with mock `EventSource`**
   An in-memory SQLite pool (via `sqlx::SqlitePool`) drives `IndexerApp` with a `MockEventSource` that returns pre-canned pages. Asserts DB state and cursor saving.

3. **Smoke — gRPC connectivity**
   A single `#[tokio::test]` gated behind a `grpc_smoke` feature flag that connects to `SUI_RPC_URL` and issues a harmless `query_events` call. Runs in CI to catch URL/TLS regressions.

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Sui Rust SDK gRPC API is less stable than TypeScript SDK | Pin to a specific version in `Cargo.toml`; the `EventSource` trait isolates call sites. |
| SDK dependency bloat | Use feature flags (`grpc` only, no `full`) to keep compile times and binary size reasonable. |
| Cursor format changes between JSON-RPC and gRPC | The `EventPage` normalization layer handles this; `IndexerApp` only sees our `EventId` struct. |

## 10. Rollout

1. Implement behind a feature flag or compile-time toggle if desired.
2. Deploy to testnet/Railway and monitor logs for 24h.
3. Merge to `main` once event counts and cursor progression match the JSON-RPC baseline.

---

*Approved by team. Ready for implementation planning.*
