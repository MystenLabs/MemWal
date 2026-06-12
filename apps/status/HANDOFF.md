# WALM-99 — Status Page — Handoff

## Linear issue
- **ID / Title:** WALM-99 — "[Monitoring] - status page"
- **Status:** In Progress (started 2026-06-08), No priority
- **Assignee:** Max Mai · **Reporter:** Henry Nguyen
- **Project / Team:** Walrus Memory
- **Reference design:** https://status.sui.io/ (Sui's Statuspage — the page should look/behave like this)
- **Linear git branch field:** `maxmai/walm-99-montoring-status-page`
- **Actual working branch:** `codex/walm-99-status-page` (NOT yet merged to `dev`)

## Branch state
7 commits ahead of `origin/dev`, all additive, all under `apps/status/` (+`package.json`, `pnpm-lock.yaml`):
```
d440f03 Match Statuspage incident typography
4d91f25 Match Statuspage routes and feeds
d3268d6 Add status history tabs
3418c58 Merge origin/dev into branch
44648f3 Add status history storage
a67314b Polish status page layout
86c528d Add standalone status service
```
~2,600 lines added. Validated: `pnpm --filter @memwal/status build` passes.

---

## What EXISTS today (done)

A **standalone status service** at `apps/status/` — its own app, separate from the rest of the monorepo.

### Backend — `server.mjs` (Node HTTP, no framework, ~800 lines)
- Serves the built Vite SPA from `dist/` with correct cache headers + SPA fallback + path-traversal guards.
- **Server-side health probe** of the relayer (`probeRelayer`): GETs `STATUS_RELAYER_URL` + `/health` with an 8s timeout. Maps result → `operational` (HTTP ok + body `status:"ok"`), `degraded` (ok but body not `ok`), or `outage` (non-ok / timeout / error). Done server-side so the relayer needs no CORS changes.
- **Background polling** (`startPolling`): when a DB is configured, polls every `STATUS_POLL_INTERVAL_MS` (default 60s) and stores each check.
- **Postgres history storage** (`postgres` lib): auto-creates `status_checks` table + index on boot. Reads back daily-bucketed uptime over `STATUS_HISTORY_DAYS` (default 90). Computes uptime % (operational+degraded counted as "up").
- **Graceful degradation:** if no `DATABASE_URL` or Postgres is down, falls back to live checks so the page + Railway healthcheck still work. DB errors are surfaced, not fatal.
- **Endpoints:**
  - `GET /health` — service liveness + DB state (for Railway healthcheck)
  - `GET /api/status` — full snapshot: relayer status, 90-day history buckets, uptime %, DB state, plus hardcoded `dependencies` (Sui network, Walrus storage) marked `monitoring`
  - `GET /history.atom` and `GET /history.rss` — Atom/RSS feeds derived from outage/degraded buckets
- Graceful SIGINT/SIGTERM shutdown; closes DB pool.

### `status_checks` table schema (automated checks only)
```
id, checked_at, target, status('operational'|'degraded'|'outage'),
http_status, latency_ms, error, payload(jsonb), created_at
```

### Frontend — `src/App.tsx` (React 19 + Vite, ~730 lines) + `src/index.css` (~770 lines)
- Statuspage-style UI, client-routed (history.pushState) across 3 routes:
  - `/` **current** — summary banner ("All Systems Operational"), per-component rows with 90-day uptime bars, "Past Incidents" (last 10 days)
  - `/history` **Incidents** tab — past incidents (last 30 days)
  - `/uptime` **Uptime** tab — 3-month uptime calendar with component selector + month pager
- Auto-refreshes `/api/status` every 60s.
- "Subscribe to Updates" dropdown linking the Atom/RSS feeds.
- **Component rows are partly derived/synthetic:** "Walrus Memory Relayer" uses real probe history; "SDK Compatibility Metadata", "Memory API Pipeline" are derived from relayer status; "Sui Network" & "Walrus Storage" are static `monitoring` placeholders (no real probing).
- Typography tuned to match Sui reference (28px heading / 20px date / 16px body; mobile no-overflow).

### Ops / packaging
- `Dockerfile`, `.dockerignore`, `docker-compose.yml` (local Postgres on port 5433)
- `railway.json` — Dockerfile builder, watches `apps/status/**`, 1 replica, restart-on-failure
- `README.md`, `.env.example`, icon asset, full TS/Vite config

### Key env vars
`STATUS_RELAYER_URL` (default `https://relayer.memory.walrus.xyz`), `STATUS_HEALTH_PATH` (`/health`), `STATUS_REQUEST_TIMEOUT_MS` (8000), `STATUS_POLL_INTERVAL_MS` (60000), `STATUS_HISTORY_DAYS` (90), `DATABASE_URL` / `STATUS_DATABASE_URL` (optional), `STATUS_SUI_STATUS_URL`, `STATUS_WALRUS_URL`, `STATUS_PUBLIC_URL`.

---

## What was COMPLETED in this session

### 1. Manual incident management ✅
Implemented full backend + frontend incident management:

**Database:**
- `incidents` table: `id, identifier, title, status, severity, component, message, started_at, resolved_at, created_at, updated_at`
- `incident_updates` table: `id, incident_id, status, message, created_at`
- Auto-created on boot alongside existing `status_checks` table

**Admin API (requires `STATUS_ADMIN_API_KEY` header):**
- `GET /api/incidents` — list all incidents
- `POST /api/incidents` — create incident
- `GET /api/incidents/:id` — get incident with updates
- `PATCH /api/incidents/:id` — update incident (resolve, edit fields)
- `POST /api/incidents/:id/updates` — post lifecycle update
- `DELETE /api/incidents/:id` — delete incident

**Frontend:**
- `/admin` route with full incident admin panel
- Create incident form (title, status, severity, component, message)
- List existing incidents with updates
- Inline update + resolve buttons
- Delete confirmation
- API key stored in `sessionStorage`
- Footer links updated to include Admin, Current Status, Incident History, Uptime

**Status payload + feeds:**
- `/api/status` now returns `incidents: { active, recent }`
- `IncidentHistory` renders real incidents when available, falls back to synthesized bucket text when empty
- Atom/RSS feeds include real incident entries

### 2. Real external dependency monitoring
Still static `monitoring` placeholders (out of scope for this session).

### 3. Deploy — still pending
- Railway service + Postgres provisioning not yet done.

### 4. Merge — still pending
- Open PR `codex/walm-99-status-page` → `dev`.

---

## Env changes
Added `STATUS_ADMIN_API_KEY` to `.env.example`:
```
STATUS_ADMIN_API_KEY=your-secret-key
```

## Tested
- `pnpm --filter @memwal/status build` passes
- Local server with Postgres: create, update, resolve, delete incidents all working
- `/api/status` correctly surfaces active + recent incidents
- Atom feed includes incident entries

## Remaining for full completion
1. Deploy to Railway with Postgres + `STATUS_ADMIN_API_KEY`
2. PR and merge to `dev`
