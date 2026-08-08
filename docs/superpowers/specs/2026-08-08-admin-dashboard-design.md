# Admin Dashboard: Wallet Balances & Upload Errors

**Date:** 2026-08-08  
**Author:** Harry Phan  
**Status:** Design  
**Branch:** harrymove-ctrl/Dashboard-view

## Executive Summary

Build an internal admin dashboard (`/admin`) for MemWal staff to monitor wallet health (uploader pool SUI+WAL balances, sponsor wallet balance) and track recent upload errors. Currently, the codebase has **no proactive wallet-balance alerting** (the Slack "alert" is just an env-var presence check, not a real balance check), and all balance-query logic is dead-ended (sidecar snapshot is internal-only; sponsor balance check only logs to stderr). This project wires that latent capability into a real-time dashboard and adds missing proactive Slack alerting.

## Problem Statement

### Current State

1. **Uploader wallet pool** (`SERVER_SUI_PRIVATE_KEYS`) can run low on WAL or SUI with no proactive notification
2. **Sponsor wallet** (`SPONSOR_PRIVATE_KEY`, used for security-delete operations) has a real on-chain balance check (`check_sponsor_balance()` in `jobs_security_delete.rs:327-346`), but the result is never surfaced anywhere—just logged to stderr
3. **Slack alerting** for "low WAL" is reactive only: parsed out of a failed-upload error message *after* a job has already failed. There is no periodic "check every 15 min and alert if below threshold" job anywhere
4. **Upload errors** are stored in `remember_jobs` table with `error_msg` column, but there's no API or dashboard to query/browse recent failures by owner/namespace
5. **No admin auth concept** exists in the codebase. All existing auth is per-owner Sui-wallet-signature auth; staff oversight requires a new mechanism

### Why This Matters

- Henry asked for "an estimate of burn through rate so known how much we're spending per month on average" and "alerts showing the balance of the sponsor wallets dropping below a threshold"
- Thanos flagged that "walrus-memory-alert" on Slack "just send you an invite" (env-var-only check, no real monitoring)
- Current setup means the team discovers funding issues *after* uploads start failing, not before

## Solution Design

### Architecture: Three Layers

#### 1. Backend API Routes (`services/server/src/routes/admin.rs`, new)

**Authentication:** Static `ADMIN_API_KEY` env var, checked via timing-safe header comparison against `x-admin-api-key` request header. Same pattern as `apps/status/server.mjs:90-121` (the only existing admin-auth precedent in the monorepo).

**Endpoints:**

**`GET /api/admin/wallets`**
- Returns current SUI+WAL balances across all uploader pool wallets + sponsor wallet
- Implementation:
  - Call sidecar's `getWalletBalanceSnapshot(SERVER_SUI_ADDRESSES)` (already exists at `services/server/scripts/sidecar/clients.ts:271-329`) to fetch uploader pool totals
  - Call on-chain via `address_balance(SPONSOR_ADDRESS)` (same RPC call used by `check_sponsor_balance()`, `sui/client.rs:866-882`) for sponsor wallet
  - Return merged response with per-wallet details (address, SUI mist, WAL frost, % of threshold, health status)
- Response shape (example):
  ```json
  {
    "uploader_pool": {
      "total_sui_mist": 5000000000,
      "total_wal_frost": 8500000,
      "wallet_count": 3,
      "wallets": [
        { "address": "0x...", "sui_mist": 2000000000, "wal_frost": 3000000, "status": "ok" },
        { "address": "0x...", "sui_mist": 1500000000, "wal_frost": 2500000, "status": "ok" },
        { "address": "0x...", "sui_mist": 1500000000, "wal_frost": 3000000, "status": "low" }
      ],
      "threshold_wal_frost": 1000000,
      "last_updated": "2026-08-08T16:30:00Z"
    },
    "sponsor_wallet": {
      "address": "0x...",
      "sui_mist": 50000000,
      "status": "low",
      "threshold_sui_mist": 100000000,
      "last_updated": "2026-08-08T16:30:00Z"
    }
  }
  ```

**`GET /api/admin/upload-errors?limit=50&offset=0`**
- Returns paginated list of recent failed `remember_jobs` rows
- Query: `SELECT id, owner, namespace, status, error_msg, created_at, updated_at FROM remember_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT $1 OFFSET $2`
- No schema changes; reuses existing table
- Response shape:
  ```json
  {
    "total": 127,
    "limit": 50,
    "offset": 0,
    "errors": [
      { "id": "job-abc", "owner": "0x123...", "namespace": "default", "error_msg": "insufficient balance: available: 100 frost, required: 500 frost for WAL::{WAL::WAL}", "created_at": "2026-08-08T16:15:00Z", "updated_at": "2026-08-08T16:15:30Z" },
      ...
    ]
  }
  ```

**`GET /api/admin/config`**
- Static read of configured thresholds and intervals (useful for dashboard to show "alert fires below X WAL")
- Response shape:
  ```json
  {
    "wallet_balance_monitor_interval_secs": 900,
    "wallet_wal_low_threshold_frost": 1000000,
    "sponsor_sui_low_threshold_mist": 100000000,
    "admin_api_key_set": true
  }
  ```

#### 2. Proactive Balance Monitor Job (new `tokio::spawn` loop in `services/server/src/main.rs`)

**Purpose:** Replace reactive balance alerting (parsed from failed-upload error messages) with real periodic monitoring.

**Mechanism:**
- New async task, spawned at boot in `main.rs` (similar pattern to existing `sidecar_watchdog`, `upload_queue_saturation_monitor`, line 376-433, 781-856)
- Uses `tokio::time::interval(Duration::from_secs(BALANCE_MONITOR_INTERVAL_SECS))`, default 900s (15 min)
- Each tick:
  1. Fetch uploader pool balances via sidecar RPC call (reuse `getWalletBalanceSnapshot()`)
  2. Fetch sponsor wallet balance via `address_balance(SPONSOR_ADDRESS)`
  3. Compare each against configured thresholds (`WALLET_BALANCE_LOW_THRESHOLD_WAL`, `SPONSOR_BALANCE_LOW_THRESHOLD_SUI`)
  4. For each wallet below threshold, call `state.alerts.notify_wallet_low_balance(wallet_info)` (new alert type, see below)
  5. Dedup logic: use existing `AlertDedup` mechanism (`alerts.rs:29-67`) so the same wallet doesn't alert multiple times within a window (e.g., 12 hours)

**New alert type** (in `services/server/src/alerts.rs`):
- `WalletBalanceLowAlert { wallet_type: "uploader" | "sponsor", address: String, balance: u64, threshold: u64, token: "SUI" | "WAL" }`
- Slack formatting (BlockKit): wallet address (abbreviated), current balance, threshold, % remaining, "⚠️ LOW" badge
- Follows existing pattern: message formatted via `Alert` trait, subject for dedup, category for metrics

#### 3. Frontend `/admin` Route (new page in `apps/app/src`)

**Location:** `apps/app/src/pages/AdminDashboard.tsx`, routed as `/admin` in `App.tsx`  
**Auth:** Client-side key prompt (localStorage-persisted) sending `x-admin-api-key` header on all admin API calls

**Pages/Panels:**

1. **Key Entry** (if not authenticated)
   - Simple input modal: "Enter admin API key"
   - Button: "Sign in"
   - On success, store key in localStorage, redirect to dashboard
   - On failure (401), show error toast

2. **Wallet Balances** (main panel)
   - **Uploader Pool Table:**
     - Columns: Address (abbreviated), SUI (mist), WAL (frost), % of threshold, status (color-coded badge)
     - Row colors: green (ok, >80% of threshold), yellow (caution, 20-80%), red (low, <20%)
     - "Last updated" timestamp, "Refresh now" button
     - Fetches via `useQuery` from `@tanstack/react-query`, 30-second auto-refresh
   - **Sponsor Wallet Card:**
     - Display: address, SUI balance, threshold, status badge
     - Same color-coding as pool

3. **Upload Errors** (secondary panel)
   - Paginated table of recent failed jobs
   - Columns: Timestamp, Owner (first 6 chars), Namespace, Error message (truncated with "copy" icon)
   - Default limit 20 rows, dropdown to change to 50/100
   - Sort by timestamp (most recent first)
   - Click-to-expand error message in modal
   - Fetches via `useQuery`, pagination handled with `offset` param

4. **Config/Thresholds** (read-only info)
   - Display configured thresholds, check interval, whether admin key is set
   - Useful as a reference while debugging

**UI Library:** Tailwind CSS v4 (already used in existing components). No shadcn/ui installed in this codebase, so hand-roll table/card components using Tailwind utilities (similar style to existing `SecurityDeleteTable.tsx`, `Card.tsx` components).

**Data Fetching:** `@tanstack/react-query` v5.90 (already a dependency, unused)
- `useQuery('admin-wallets', fetchWallets, { refetchInterval: 30000 })`
- `useQuery(['admin-errors', limit, offset], fetchErrors, { enabled: !!adminKey })`
- Retry on 5xx, not on 401/403 (those should prompt for re-entry)

## Implementation Phases

### Phase 1: Backend Auth + Wallet API (4–6 hours)
- [ ] Add `x-admin-api-key` middleware to `services/server/src/auth.rs` or new auth module
- [ ] Implement `GET /api/admin/wallets` route (proxy sidecar + sponsor query)
- [ ] Implement `GET /api/admin/upload-errors` route (query `remember_jobs`)
- [ ] Implement `GET /api/admin/config` route
- [ ] Test manually with curl/Postman

### Phase 2: Balance Monitor Job + Slack Integration (4–6 hours)
- [ ] Add new alert type to `services/server/src/alerts.rs`
- [ ] Implement balance-monitor `tokio::spawn` loop in `main.rs`
- [ ] Wire into AlertManager for Slack payload formatting
- [ ] Test with local Slack webhook or mock

### Phase 3: Frontend Pages (6–8 hours)
- [ ] Create `/admin` route in `App.tsx`
- [ ] Build key-entry / login flow (localStorage)
- [ ] Build wallet-balances panel (table + card, react-query integration)
- [ ] Build upload-errors panel (paginated table)
- [ ] Build config panel (read-only display)
- [ ] Style with Tailwind (match existing app aesthetic)

### Phase 4: Integration + Deployment (2–4 hours)
- [ ] End-to-end test (key entry → dashboard → live data)
- [ ] Verify Slack alerts format and dedup behavior
- [ ] Load-test balance queries (do they slow down the main relayer?)
- [ ] Set env vars for staging/prod (`ADMIN_API_KEY`, `BALANCE_MONITOR_INTERVAL_SECS`, thresholds)
- [ ] Validate Railway deployment picks up new env vars

**Total:** ~16–24 hours of focused engineering work

## Implementation Status (Updated 2026-08-08)

**Phase 1: Backend Auth + Routes** — ✅ COMPLETE

- **Admin-key middleware** with constant-time comparison (timing attack + length-leak mitigations)
- **3 API routes:** `/api/admin/wallets`, `/api/admin/upload-errors`, `/api/admin/config`
- **Tests:** 36 new tests, 313/313 passing (0 failures)
- **Security:** 2 critical issues found + fixed + re-verified
- **Code review:** 0 critical issues remaining
- **Files modified:** 
  - `services/server/src/auth.rs` (modified)
  - `services/server/src/routes/admin_dashboard.rs` (new)
  - `services/server/src/routes/mod.rs` (modified)
  - `services/server/src/main.rs` (modified)

**Phase 2: Balance Monitor Job** — Ready (planned for next sprint)

**Phase 3: Frontend Dashboard** — In Progress

**Phase 4: Integration & Deployment** — Planned

## Data Sources & Existing Reuse

| What | Where | Status |
|------|-------|--------|
| Uploader pool balance snapshot | `services/server/scripts/sidecar/clients.ts:getWalletBalanceSnapshot()` | Exists, internal-only `/metrics/wallet` route |
| Sponsor wallet balance query | `services/server/src/jobs_security_delete.rs:check_sponsor_balance()` | Exists, logs-only, no API exposure |
| Failed jobs store | `services/server/migrations/005_remember_jobs.sql` table, `error_msg` column | Exists, no aggregation query today |
| Slack alert machinery | `services/server/src/alerts.rs:AlertManager`, BlockKit formatting | Exists, add new alert type |
| Admin auth precedent | `apps/status/server.mjs:timingSafeEqual` pattern | Exists, copy pattern to this relayer |

## Out of Scope (v2 features)

- Enoki gas-pool balance (Mysten-hosted, not MemWal-owned)
- Historical balance trending / graphs
- Automatic balance rebalancing or emergency top-ups
- Per-user or per-namespace error filtering
- Sentry/external error-tracking integration
- Rate limits or DDoS protection on `/api/admin/*` (assume internal-only access via reverse proxy)

## Testing Strategy

### Backend
- Unit tests: balance-threshold logic, alert dedup windows
- Integration: real Sui RPC call to testnet, verify balance fetch
- Slack: validate BlockKit payload format, test dedup behavior (same alert doesn't spam within 12h)

### Frontend
- Unit: component rendering, pagination logic
- E2E: key entry → fetch wallets → display table → error handling (401/500)
- Manual: hit staging `/admin`, verify live data refresh every 30s

## Success Criteria

1. Dashboard accessible at `https://dev.memwal.ai/admin` (staging) and `https://memwal.ai/admin` (prod) after setting `ADMIN_API_KEY`
2. Wallet balances refresh every 30 seconds, showing live SUI+WAL across pool + sponsor
3. Proactive Slack alert fires when wallet drops below threshold (not just on error), dedup within 12 hours
4. Upload errors panel lists recent failures with error text, paginated
5. No impact on relayer performance (balance queries should not block upload job processing)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Exposing sidecar data via new Rust route could introduce latency on upload path | Balance queries run on separate tokio task; admin API calls are low-frequency (human-driven), not in hot path |
| Admin key compromise | Static env-var stored as secret in Railway, rotated via redeploy; consider adding IP allowlist at reverse-proxy layer in v2 |
| Wallet threshold values out-of-sync between config/alerts | Read from same env source for both balance-monitor job and API response; no hardcoded thresholds |
| Sidecar `/metrics/wallet` call fails, blocking balance API | Admin API catches error, returns last-known value with a staleness warning or null |

## References

- Slack conversation: Henry & Thanos, Monday 2026-08-05, ~1:15 PM (self-host cost, WAL burn, sponsor wallet alerts)
- Memory: WALM-52 (self-host relay trial), WALM-76 (relay TCO), WALM-78 (VPS capacity + Neon)
- Codebase: `services/server/src/alerts.rs` (existing Slack machinery), `sidecar/clients.ts` (balance fetch), `jobs_security_delete.rs:check_sponsor_balance` (sponsor balance check)
