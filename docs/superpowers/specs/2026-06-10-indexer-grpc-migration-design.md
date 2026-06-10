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
- Introduce an abstraction (`EventSource`) to isolate the unstable SDK behind a stable domain boundary and enable `MockEventSource` for unit tests.
- Index only `AccountCreated` events on launch; structure the code so adding `DelegateKeyAdded`, `DelegateKeyRemoved`, etc. is straightforward.

## 3. Non-Goals

- Changing the PostgreSQL schema or adding new tables.
- Switching to streaming/subscriptions or checkpoint-based indexing.
> **Note on cursors:** The current `indexer_state` table stores a single cursor. Future multi-event support will query all events from the `account` module with a single monotonic cursor and dispatch client-side; no schema change is required.
- Extracting a reusable Sui client crate for other services.
- Adding backfill or re-org handling logic.

## 3.5 Acceptance Criteria

The migration is complete when all of the following are true:

1. **Event parity:** The gRPC indexer produces an `accounts` row count within `≤0.1%` of the JSON-RPC indexer over a continuous 24-hour testnet run.
2. **Latency bound:** P99 `query_events` round-trip latency does not exceed the JSON-RPC baseline by `>20%`.
3. **Zero permanent errors:** No `Permanent` `EventSourceError` or DB error occurs during the 24-hour observation window.
4. **Smoke test passes:** The `grpc_smoke` test successfully connects to the target gRPC endpoint in CI.

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

`SuiEvent` is a domain struct owned by the `sui` module (not the SDK type). It contains a stable subset of fields needed by extractors:

```rust
struct SuiEvent {
    id: EventId,               // tx_digest + event_seq
    package_id: String,
    module: String,
    event_type: String,
    bcs: Vec<u8>,              // move event payload
    timestamp_ms: Option<u64>,
}
```

`GrpcEventSource` maps the SDK response into this struct before returning `EventPage`.

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
   - `limit` must be `> 0`; if `limit == 0`, treat as a permanent error.
3. **Extract** — For each `SuiEvent` in the page, run `AccountCreatedExtractor::extract(event)`.
   - On parse failure, increment `indexer_parse_failures_total` counter, log the event digest at `warn!`, and continue.
   - If `indexer_parse_failures_total` exceeds `10` within any 5-minute window, treat as a permanent error (systematic schema mismatch).
4. **Persist** — Inside a single SQL transaction:
   - `INSERT INTO accounts (account_id, owner) VALUES ... ON CONFLICT DO NOTHING`.
   - Update `indexer_state` with the `EventId` of the **last event in the page**.
   - Commit atomically.
5. **Pagination / sleep** — If `has_next_page == true`:
   - If `events.is_empty()`, increment a consecutive-empty-page counter. After `3` consecutive empty pages, treat as a permanent error (malformed SDK response).
   - Otherwise, immediately loop to step 2 with the new cursor.
   - Otherwise, `tokio::time::sleep(POLL_INTERVAL_SECS)`.

## 6. Error Handling

| Error | Behavior |
|-------|----------|
| **Transient gRPC errors** (`Unavailable`, `DeadlineExceeded`, connection reset) | Retry with exponential backoff (3 attempts: 1s, 2s, 4s). Log `warn!`. If all retries fail, sleep for `POLL_INTERVAL_SECS` and try the next cycle. |
| **Permanent gRPC errors** (`InvalidArgument`, `PermissionDenied`, `Unimplemented`) | Log `error!` and return a fatal error up to `main`, which performs controlled shutdown (await pending tasks, close DB pool) before exiting. |
| **DB errors** | Log `error!` and return a fatal error up to `main` for controlled shutdown. Same user-visible behavior as today, but connections flush cleanly. |
| **Parse errors** (extractor fails to deserialize an event) | Increment `indexer_parse_failures_total` counter, log the event digest at `warn!`, and continue. If `>10` parse failures occur within 5 minutes, treat as a permanent error (likely schema mismatch). |

`EventSourceError` distinguishes transient vs. permanent so `IndexerApp` doesn't need to know gRPC status codes:

```rust
enum EventSourceError {
    Transient { source: Box<dyn std::error::Error + Send + Sync> },
    Permanent { source: Box<dyn std::error::Error + Send + Sync> },
}
```

## 7. Dependencies

Add to `services/indexer/Cargo.toml`:

- `sui-sdk` (or the specific `mysten-sui` gRPC client crate) — typed gRPC client. **Spike required:** resolve exact crate by implementation kickoff; fallback to raw `tonic`/`prost` if the SDK gRPC client is not yet stable in Rust.
- `async-trait` — if not already present, for the `EventSource` trait.

Operational dependencies:
- The target Sui fullnode must expose the gRPC event-query endpoint in **dev, testnet, and mainnet** environments.
- TLS certificates must be valid and reachable from the Railway deployment; the `grpc_smoke` test validates this in CI.

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

1. **Feature flag** — Gate the gRPC path behind a compile-time `grpc` feature (default off) so the existing JSON-RPC binary can still be built from the same branch.
2. **Canary deploy** — Deploy the gRPC build to **one** Railway indexer replica alongside the existing JSON-RPC replica. Run for 24h.
3. **Rollback triggers** — Automatically revert to the JSON-RPC replica if any of the following occur:
   - Event count divergence between gRPC and JSON-RPC exceeds `1%` over any 1-hour window.
   - `Permanent` gRPC errors persist for `>5` minutes (indicates misconfiguration or endpoint outage).
   - `indexer_parse_failures_total` exceeds `10` in 5 minutes.
   - P99 query latency exceeds JSON-RPC baseline by `>50%` (not just the `20%` acceptance threshold).
4. **Cursor compatibility check** — Before rollback, verify that the JSON-RPC cursor format is byte-compatible with the gRPC cursor (both use `tx_digest + event_seq`). No cursor migration is needed.
5. **Merge criteria** — Merge to `main` only after the 24h canary passes all Acceptance Criteria (§3.5) with zero rollback triggers.
6. **Clean-up** — After 1 week of stable mainnet operation, remove the `grpc` feature flag and delete the JSON-RPC code path.

---

*Approved by team. Ready for implementation planning.*
