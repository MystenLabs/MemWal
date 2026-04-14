# MemWal Indexer -- STRIDE Threat Model

**Date:** 2026-04-02
**Commit:** 5bb1669 (branch `dev`)
**Scope:** `services/indexer/` -- Rust service that syncs on-chain Sui events to PostgreSQL
**Source file:** `services/indexer/src/main.rs` (single-file service, ~310 lines)

---

## 1. Service Overview

The MemWal indexer is a long-running Rust daemon that polls Sui blockchain events via JSON-RPC and writes account data into a shared PostgreSQL database. Its purpose is to provide the server with O(1) account lookups instead of requiring on-chain registry scans during authentication.

### What It Indexes

Currently, the indexer tracks a **single event type**:

- **`AccountCreated`** -- emitted by the Move contract when `create_account()` is called. Contains `account_id` (object ID) and `owner` (Sui address). Stored in the `accounts` table.

### What It Does NOT Index (Gap)

The Move contract emits five event types, but the indexer only processes one:

| Event | Indexed? | Impact of Gap |
|-------|----------|---------------|
| `AccountCreated` | Yes | -- |
| `DelegateKeyAdded` | **No** | Server cannot look up delegate keys from index; must scan on-chain |
| `DelegateKeyRemoved` | **No** | Revoked keys not reflected in index; stale cache risk |
| `AccountDeactivated` | **No** | Deactivated accounts remain as active in the `accounts` table |
| `AccountReactivated` | **No** | No deactivation tracking means reactivation is moot |

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    owner      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### Polling Mechanism

- Uses `suix_queryEvents` JSON-RPC method against configured `SUI_RPC_URL`
- Fetches 50 events per page, oldest first
- Persists cursor (`txDigest` + `eventSeq`) in `indexer_state` table
- Configurable poll interval via `POLL_INTERVAL_SECS` (default: 5 seconds)
- On RPC error, logs and retries after sleep interval

---

## 2. Trust Boundaries

```
+-------------------+          +------------------+          +------------------+
|   Sui Blockchain  |  JSON-   |                  |  sqlx    |                  |
|   (via RPC node)  | -------> |  MemWal Indexer   | -------> |   PostgreSQL     |
|                   |  RPC/    |                  |  TCP     |   (shared DB)    |
+-------------------+  HTTPS   +------------------+          +------------------+
                                                                     ^
                                                                     |
                                                              +------+-------+
                                                              | MemWal Server |
                                                              | (reads same  |
                                                              |  tables)     |
                                                              +--------------+
```

| Boundary | Transport | Trust Level | Notes |
|----------|-----------|-------------|-------|
| Indexer <-> Sui RPC | HTTPS (configurable) | **Semi-trusted, external** | RPC node is the sole source of truth. A compromised or rogue node can feed arbitrary event data. No independent verification of event authenticity. |
| Indexer <-> PostgreSQL | TCP (sqlx) | **Internal, high trust** | Direct database access with full write to `accounts` and `indexer_state` tables. Connection string from env var. |
| Server <-> PostgreSQL | TCP (sqlx) | **Internal, high trust** | Server reads from same `accounts` table. Currently `find_account_by_owner()` exists but is `#[allow(dead_code)]`. The `delegate_key_cache` table is separately managed. |
| Indexer <-> Indexer (state) | In-process | **Self** | Cursor state held in memory and persisted to DB. |

### Critical Observation: No Authentication Between Indexer and Server

The indexer and server share a PostgreSQL database with no application-level authentication or integrity checks on the indexed data. The server trusts whatever is in the `accounts` table as ground truth. There is no HMAC, signature, or provenance marker on indexed rows.

---

## 3. Data Flow Diagrams

### 3.1 Event Ingestion Flow

```
                        Sui RPC Node
                             |
                    suix_queryEvents
                    (MoveEventType filter,
                     cursor, limit=50)
                             |
                             v
                    +------------------+
                    |  poll_events()   |
                    |  (main.rs:180)   |
                    +--------+---------+
                             |
                    Parse JSON-RPC response
                    Deserialize EventPage
                             |
                             v
                    +------------------+
                    | process_event()  |  <-- for each event in page
                    |  (main.rs:236)   |
                    +--------+---------+
                             |
                    Extract account_id, owner
                    from parsed_json
                             |
                             v
                    +------------------+
                    | INSERT INTO      |
                    | accounts         |
                    | ON CONFLICT      |
                    | DO NOTHING       |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | save_cursor()    |
                    | (main.rs:279)    |
                    +------------------+
                             |
                    UPSERT into indexer_state
                    key = 'event_cursor'
```

### 3.2 Account Resolution Flow (Server Side -- Consumer of Indexed Data)

```
    Incoming request with Ed25519 signature
                    |
                    v
    auth.rs: resolve_account()
                    |
    Strategy 1: delegate_key_cache table (NOT accounts table)
                    |  miss
                    v
    Strategy 2: On-chain registry scan via SUI RPC
                    |  miss
                    v
    Strategy 3: Header hint / config fallback
                    |
                    v
    verify_delegate_key_onchain() -- always verifies on-chain
```

**Important finding:** The server's `find_account_by_owner()` method that reads the indexed `accounts` table is currently `#[allow(dead_code)]` and unused. This means the indexer's data is **not yet consumed by the auth flow**. However, the comment in `auth.rs:24` mentions "indexed accounts" as a resolution strategy, suggesting planned integration.

### 3.3 Cursor Persistence Flow

```
    load_cursor() at startup
         |
    SELECT value FROM indexer_state WHERE key = 'event_cursor'
         |
    Deserialize JSON -> EventCursor { tx_digest, event_seq }
         |
         v
    [Main loop iteration]
         |
    poll_events() with cursor
         |
    On success with new events:
         |
    save_cursor() -- UPSERT new cursor
    (happens AFTER processing events but
     cursor comes from page.next_cursor,
     NOT from last processed event)
```

---

## 4. Assets

| Asset | Location | Sensitivity | Description |
|-------|----------|-------------|-------------|
| Account-to-owner mappings | `accounts` table | **Medium** | Maps Sui object IDs to owner addresses. Public on-chain but aggregated here for fast lookup. |
| Event cursor | `indexer_state` table | **High (integrity)** | Controls which events have been processed. Manipulation causes missed or re-processed events. |
| Database credentials | `DATABASE_URL` env var | **Critical** | Full PostgreSQL connection string with password. |
| RPC endpoint | `SUI_RPC_URL` env var | **Medium** | Controls which node the indexer trusts as source of truth. |
| Package ID | `MEMWAL_PACKAGE_ID` env var | **High (integrity)** | Determines which contract's events are indexed. Wrong value = indexing wrong contract. |

---

## 5. STRIDE Analysis

### 5.1 Spoofing

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| S-1 | **Rogue RPC node feeds fabricated events** | `poll_events()` (line 180) sends request to `config.sui_rpc_url` | The indexer performs zero verification of event authenticity. It trusts the RPC response completely. A MITM or rogue node could inject fake `AccountCreated` events with arbitrary `account_id` and `owner` values. The indexer would dutifully write them to `accounts`. |
| S-2 | **DNS hijack of RPC endpoint** | `Config::from_env()` (line 27) reads `SUI_RPC_URL` | Default is `https://fullnode.mainnet.sui.io:443`. DNS spoofing or BGP hijack could redirect to attacker-controlled node. TLS mitigates this IF certificate validation is enforced (reqwest default: yes). |
| S-3 | **Environment variable poisoning** | `Config::from_env()` (line 27) | If attacker can modify env vars (`SUI_RPC_URL`, `MEMWAL_PACKAGE_ID`), they control what the indexer indexes. No runtime validation that `MEMWAL_PACKAGE_ID` matches the expected contract. |
| S-4 | **Spoofed events via wrong package ID** | `main()` line 139: `format!("{}::account::AccountCreated", config.package_id)` | If `MEMWAL_PACKAGE_ID` is set to a different (attacker-controlled) contract, the indexer would index events from that contract instead, populating `accounts` with attacker-chosen data. |

### 5.2 Tampering

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| T-1 | **Direct database manipulation** | Shared PostgreSQL instance | Any process with DB credentials can INSERT/UPDATE/DELETE rows in `accounts`. No row-level integrity (no HMAC, no signature). The indexer uses `ON CONFLICT DO NOTHING` (line 250), so pre-inserted malicious rows would persist and never be overwritten. |
| T-2 | **Cursor manipulation to skip events** | `indexer_state` table, key `event_cursor` | An attacker with DB access can advance the cursor to skip future events, or reset it to cause mass re-processing. The cursor is a JSON blob with `txDigest` and `eventSeq` -- no integrity protection. |
| T-3 | **Cursor manipulation to replay events** | `save_cursor()` (line 279) | Setting cursor backward would cause re-processing. The `ON CONFLICT DO NOTHING` on account inserts means replays are idempotent for creates, but an attacker could delete rows then reset cursor to selectively re-index. |
| T-4 | **Race condition: cursor saved before all events processed** | Lines 150-163 | The cursor is updated to `page.next_cursor` after the loop, not after each individual event. If the process crashes mid-page, events could be lost (cursor not yet advanced) or re-processed (cursor advanced before crash on save). Current code: cursor only updates when `page.next_cursor` is Some, which is correct -- but `process_event` errors are logged and skipped (line 151-153), meaning a failed insert advances past that event. |
| T-5 | **Immutable account records** | `ON CONFLICT (account_id) DO NOTHING` (line 251) | Once an account is indexed, its owner mapping cannot be updated by the indexer. If the on-chain account ownership changes (not currently possible in the contract, but a future concern), the indexed data becomes stale and unamendable. |

### 5.3 Repudiation

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| R-1 | **No audit trail of processed events** | `process_event()` (line 236) | Events are logged at INFO level (`indexed account: {} (owner: {})` on line 260) but there is no persistent audit log table. If the indexer processes a malicious event, the only record is in ephemeral logs (if retained). |
| R-2 | **No provenance tracking** | `accounts` table schema (line 78) | The table stores `created_at` (DB timestamp) but not: which transaction emitted the event, the event sequence number, or a reference to the on-chain object. An attacker who inserts rows directly cannot be distinguished from legitimately indexed rows. |
| R-3 | **Error events are logged but skipped** | Lines 151-153 | Failed event processing is logged at ERROR level but the indexer continues. There is no dead-letter queue or failed-event table. Events that consistently fail are silently dropped after one attempt. |

### 5.4 Information Disclosure

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| I-1 | **Database URL partially logged** | `redact_url()` (line 299) logs redacted URL at startup | Password is redacted, but hostname, port, and database name are exposed in logs. This aids lateral movement if logs are compromised. |
| I-2 | **Account-owner mappings aggregated** | `accounts` table | While individual account-owner links are public on-chain, the indexer creates a queryable aggregate. This lowers the cost of enumerating all MemWal users and their Sui addresses. |
| I-3 | **RPC URL disclosed in logs** | Line 109: `tracing::info!("  sui rpc: {}", config.sui_rpc_url)` | If using a private/authenticated RPC endpoint with API key in URL, this would be leaked to logs. |
| I-4 | **Error messages may leak internal state** | Lines 168, 211, 219, 226 | RPC errors and parse errors are logged with full detail. A rogue RPC could send crafted error messages that end up in logs, potentially exploiting log injection. |

### 5.5 Denial of Service

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| D-1 | **RPC node returns massive event pages** | `poll_events()` (line 180) | The indexer requests limit=50 but does not validate the response respects this limit. A malicious RPC could return millions of events in one response. The entire response is loaded into memory as `serde_json::Value` (line 213). No response size limit on the reqwest client. |
| D-2 | **Indexer falls behind event production** | Main loop (line 142) | If events are produced faster than the indexer can process them, it accumulates unbounded lag. There is no alerting, no metrics, and no backpressure mechanism. The server would rely on stale data. |
| D-3 | **RPC node returns errors indefinitely** | Error path (line 168) | The indexer logs the error and sleeps for `poll_interval_secs`, then retries. No backoff, no circuit breaker. If the RPC is down, the indexer generates one error log per interval indefinitely while making no progress. |
| D-4 | **Database connection exhaustion** | `PgPoolOptions::new().max_connections(3)` (line 114) | Pool is small (3 connections). If the database is slow, the indexer blocks on DB writes. No timeout on individual queries. A slow DB could cause the indexer to stall completely. |
| D-5 | **Unbounded memory from malformed events** | `process_event()` (line 236) | `parsed_json` is a `serde_json::Value` which can be arbitrarily nested. A crafted event with deeply nested JSON could consume excessive memory during parsing. |
| D-6 | **Poll interval of 0 causes tight loop** | `Config::from_env()` (line 35) | `POLL_INTERVAL_SECS=0` is valid and creates a zero-duration sleep, causing a CPU-burning tight loop if no events are returned. No minimum interval validation. |

### 5.6 Elevation of Privilege

| ID | Threat | Code Path | Analysis |
|----|--------|-----------|----------|
| E-1 | **Poisoned index data influences auth decisions** | Server `auth.rs` line 24 mentions "indexed accounts" strategy | If the server begins using `find_account_by_owner()` (currently dead code in `db.rs:233`), a poisoned `accounts` table could map an attacker's address to a victim's `account_id`, potentially granting access to the victim's memories. The server does verify on-chain, but the indexed lookup could direct it to the wrong account object. |
| E-2 | **Pre-populated accounts table blocks legitimate indexing** | `ON CONFLICT (account_id) DO NOTHING` (line 250) | An attacker with DB write access could pre-insert rows with correct `account_id` values but wrong `owner` addresses. The indexer would skip these (DO NOTHING), leaving malicious mappings in place permanently. |
| E-3 | **Shared database credentials grant full access** | `DATABASE_URL` env var | The indexer connects with the same credentials as the server. It has write access to all tables, not just `accounts` and `indexer_state`. A compromised indexer process could modify `vector_entries`, `delegate_key_cache`, or any other server table. |

---

## 6. Attack Scenarios

### Scenario 1: Rogue RPC Node Feeding Fake Events

**Threat IDs:** S-1, T-1, E-1, E-2

**Attack:** An attacker compromises the Sui RPC endpoint (via DNS hijack, env var manipulation, or operating a malicious fullnode). They respond to `suix_queryEvents` with fabricated `AccountCreated` events mapping victim `account_id` values to attacker-controlled `owner` addresses.

**Execution:**
1. Attacker gains control of the RPC endpoint the indexer queries
2. RPC returns events: `{ account_id: "<victim_id>", owner: "<attacker_address>" }`
3. Indexer writes these to `accounts` table without verification
4. If/when the server uses indexed lookups for auth, it would associate the victim's account with the attacker's address

**Impact:** HIGH -- Could enable account takeover if server trusts indexed data for auth decisions.

**Current Mitigation:** The server's `find_account_by_owner()` is dead code. The server always verifies on-chain via `verify_delegate_key_onchain()`. This significantly reduces current exploitability, but the code path exists and is documented as a planned feature.

### Scenario 2: Database Poisoning via Shared Credentials

**Threat IDs:** T-1, T-2, E-2, E-3

**Attack:** An attacker who compromises any service with `DATABASE_URL` access (server, indexer, or any other service sharing the DB) can:

1. Insert fake rows into `accounts` with crafted `account_id` -> `owner` mappings
2. Advance the cursor in `indexer_state` to skip legitimate future events
3. Modify `delegate_key_cache` to influence server auth decisions directly

**Impact:** HIGH -- Direct influence on authentication and authorization state.

**Current Mitigation:** None beyond network segmentation. No row-level integrity, no per-service DB credentials, no write restrictions.

### Scenario 3: Indexer Lag Causing Stale Auth State

**Threat IDs:** D-2, D-3

**Attack (passive):** The indexer falls behind due to RPC issues, database slowness, or high event volume. New accounts created on-chain are not reflected in the index.

**Execution:**
1. User creates account on-chain
2. Indexer is lagging (e.g., RPC returning errors for hours)
3. User attempts to authenticate with server
4. Server's Strategy 2 (on-chain scan) and Strategy 3 (header hint) still work, so auth succeeds
5. However, any future feature relying on the `accounts` table for fast lookup would fail

**Impact:** LOW (currently) -- The server has fallback strategies that bypass the index entirely. But if the index becomes a primary auth source, this becomes MEDIUM.

### Scenario 4: Event-Skipping via Process Crash

**Threat IDs:** T-4, R-3

**Attack (passive, reliability):** The indexer crashes during event processing mid-page.

**Execution:**
1. Indexer fetches a page of 50 events
2. Processes events 1-25 successfully
3. Event 26 causes a panic (e.g., unexpected JSON structure)
4. Process restarts, loads last saved cursor (from before this page)
5. Re-processes events 1-25 (idempotent due to `ON CONFLICT DO NOTHING`)
6. Event 26 causes panic again -- infinite crash loop

**Impact:** MEDIUM -- The indexer would be permanently stuck if any single event causes a panic. The `process_event` function handles errors gracefully (returns Result), but a panic in deserialization or a tokio/sqlx panic would halt progress.

### Scenario 5: Resource Exhaustion via Malicious RPC Response

**Threat IDs:** D-1, D-5

**Attack:** A malicious RPC node returns an enormous JSON response to `suix_queryEvents`.

**Execution:**
1. Attacker controls RPC endpoint
2. Returns a response with `data` array containing millions of events, each with deeply nested `parsed_json`
3. Indexer attempts to deserialize entire response into memory
4. OOM kill or extreme memory pressure

**Impact:** MEDIUM -- Causes indexer downtime. No cascade to server auth since server has independent on-chain verification.

---

## 7. Threat Matrix

| ID | Threat | Category | Likelihood | Impact | Risk | Current Mitigation |
|----|--------|----------|------------|--------|------|--------------------|
| **S-1** | Rogue RPC feeds fake events | Spoofing | Low | High | **MEDIUM** | Server verifies on-chain; `find_account_by_owner()` is dead code |
| **S-2** | DNS hijack of RPC endpoint | Spoofing | Very Low | High | **LOW** | TLS certificate validation (reqwest default) |
| **S-3** | Environment variable poisoning | Spoofing | Low | Critical | **MEDIUM** | OS-level access controls |
| **S-4** | Wrong package ID in config | Spoofing | Low | High | **MEDIUM** | Manual config validation |
| **T-1** | Direct DB manipulation | Tampering | Low | High | **MEDIUM** | Network segmentation only |
| **T-2** | Cursor manipulation to skip events | Tampering | Low | Medium | **LOW** | DB access controls |
| **T-3** | Cursor reset causes replay | Tampering | Low | Low | **LOW** | `ON CONFLICT DO NOTHING` makes replays idempotent |
| **T-4** | Crash mid-page loses/replays events | Tampering | Medium | Low | **LOW** | Events are re-processed on restart; inserts are idempotent |
| **T-5** | Immutable account records become stale | Tampering | Low | Medium | **LOW** | Server always verifies on-chain |
| **R-1** | No persistent audit trail | Repudiation | High | Medium | **MEDIUM** | Ephemeral tracing logs only |
| **R-2** | No provenance on indexed rows | Repudiation | High | Medium | **MEDIUM** | None |
| **R-3** | Failed events silently dropped | Repudiation | Medium | Medium | **MEDIUM** | Error logging only; no dead-letter queue |
| **I-1** | DB hostname leaked in logs | Info Disclosure | Medium | Low | **LOW** | Password redacted; host exposed |
| **I-2** | User enumeration via aggregated data | Info Disclosure | Medium | Low | **LOW** | Data is public on-chain; index lowers query cost |
| **I-3** | RPC URL with API key in logs | Info Disclosure | Low | Medium | **LOW** | Only if API key is embedded in URL |
| **I-4** | Log injection via crafted RPC errors | Info Disclosure | Low | Low | **LOW** | Structured logging (tracing) mitigates |
| **D-1** | Massive RPC response causes OOM | DoS | Low | Medium | **LOW** | None; no response size limit |
| **D-2** | Indexer falls behind event production | DoS | Medium | Low | **LOW** | Server has fallback auth strategies |
| **D-3** | RPC errors cause infinite retry without backoff | DoS | Medium | Low | **LOW** | Logs errors but no exponential backoff |
| **D-4** | DB connection exhaustion | DoS | Low | Medium | **LOW** | Pool limited to 3 connections |
| **D-5** | Deeply nested JSON causes memory pressure | DoS | Very Low | Medium | **LOW** | None |
| **D-6** | Poll interval of 0 causes CPU burn | DoS | Very Low | Low | **VERY LOW** | Misconfiguration; trivial fix |
| **E-1** | Poisoned index enables account takeover | EoP | Low | Critical | **MEDIUM** | Dead code path; server verifies on-chain |
| **E-2** | Pre-inserted rows block legitimate indexing | EoP | Low | High | **MEDIUM** | Requires DB write access |
| **E-3** | Shared DB creds grant cross-service access | EoP | Low | Critical | **MEDIUM** | Single credential for all services |

### Risk Summary

| Risk Level | Count | Key Items |
|------------|-------|-----------|
| **HIGH** | 0 | -- (mitigated by server's on-chain verification and dead code status of index lookups) |
| **MEDIUM** | 8 | Rogue RPC (S-1), env poisoning (S-3), wrong package (S-4), DB tampering (T-1), no audit trail (R-1, R-2), failed event drops (R-3), poisoned index EoP (E-1), pre-inserted rows (E-2), shared creds (E-3) |
| **LOW** | 12 | DNS hijack, cursor manipulation, stale records, info disclosure, DoS vectors |
| **VERY LOW** | 1 | Poll interval misconfiguration |

---

## 8. Recommendations

### Priority 1: Before Integrating Index into Auth Flow

1. **Add on-chain verification for indexed data** -- If `find_account_by_owner()` is activated, always verify the returned `account_id` on-chain before trusting it (similar to existing cache strategy).
2. **Use separate DB credentials** -- The indexer should have INSERT-only access to `accounts` and `indexer_state`, not full access to the server's database.
3. **Add provenance columns** -- Store `tx_digest`, `event_seq`, and `indexed_at` in the `accounts` table for audit and verification.

### Priority 2: Reliability

4. **Index all event types** -- Track `DelegateKeyAdded`, `DelegateKeyRemoved`, `AccountDeactivated`, and `AccountReactivated` to provide a complete picture.
5. **Add exponential backoff** on RPC errors instead of fixed-interval retry.
6. **Add a dead-letter table** for events that fail processing, instead of silently skipping.
7. **Validate poll interval minimum** (e.g., >= 1 second).
8. **Add health check endpoint** or metrics (e.g., current lag, last successful poll, events processed).

### Priority 3: Hardening

9. **Set reqwest response size limit** to prevent OOM from malicious RPC responses.
10. **Add query timeouts** to sqlx operations to prevent indefinite blocking.
11. **Validate `MEMWAL_PACKAGE_ID` format** at startup (should be a valid Sui object ID).
12. **Consider cursor-per-event persistence** instead of cursor-per-page to minimize re-processing on crash.
13. **Use `ON CONFLICT DO UPDATE`** instead of `DO NOTHING` for the accounts table, so that legitimate corrections from the chain can overwrite stale entries.
