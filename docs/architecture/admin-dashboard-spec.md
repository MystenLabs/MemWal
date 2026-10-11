> Internal specification. Not a docs-site page; do not add this file to `docs/docs.json`.
> Code anchors rechecked against `origin/dev` @ `3e0534e6` (11 October 2026). No production data was queried.
> Sign-in flow is unchanged: the existing admin API key, `sessionStorage` session, and server check on `/api/admin/config`. A key is required before any dashboard view. There is no dev bypass.

# Walrus Memory admin dashboard — specification and ticket plan

Date: 11 October 2026. Status: proposed. Audience: authenticated admins only.
Reference: https://stride-dashboard-two.vercel.app/?ws=vantage-admin. Live reference inspected 11 October 2026 at 1440×900: Geist, page background `#1a1a1a`, sidebar 238px, continuous 110px KPI strip, 6px controls, violet selected indicator. Browser chrome and the external app icon rail are out of scope.
Scope: plan the dashboard and measurement pipeline. Implementation of collection, rollups, and external ticket publication are separate from this document. No production data was queried. No actual storage totals or historical percentiles are asserted here.

## 1. Product outcome

Give authenticated admins one private site with global totals and full operational detail for every user account and delegate to answer: how much memory exists, how much storage it occupies, who uses it, how much traffic retrieval generates, and what changed during an incident. Every number must identify its scope, time window, source, freshness, and coverage.

Audience: admins only. All account, delegate, storage, retrieval, incident, and export views are available to authenticated admins across the selected environment. Builders, insiders, and ordinary users do not receive dashboard access. “Full detail” means operational metadata and measured sizes, not plaintext memory content or credentials.

Primary user stories:
- As an admin, I can compare live plaintext, encrypted payload, and Walrus encoded storage so I can explain growth and overhead.
- As an admin, I can compare p50/p90/p99 retrieval bytes and latency before, during, and after an incident and identify the accounts and paths driving it.
- As an admin, I can select any day and inspect every user account and delegate active that day, their requests, storage changes, transfer paths, errors, and contribution to an incident.
- As an admin, I can compare today, yesterday, three days, and seven days across all users or a selected account to understand integration behavior.

Proposed success criteria: a reviewer can answer these operational questions in under two minutes; supported metrics refresh within five minutes; counts and bytes reconcile against controlled test workloads; unsupported historical periods display unavailable rather than zero. Performance target: overview responds within two seconds at the agreed production scale, established during the data audit.

## 2. Reference UI/UX analysis and adaptation

The live reference exposes workspace switching, grouped sidebar navigation, breadcrumbs, notifications, date selection, comparison controls, scope tabs, a continuous six-cell KPI strip, a series-toggle trend chart with axes and hover, a sortable table with clickable rows and sparklines, a horizontal pipeline, a source donut, and a ranked contributor list. These interactions were inspected on the live page; other reference pages were not exhaustively inspected. Dropdown open/close and chart hover were visible as restrained opacity and color changes, not bouncing motion.

| Reference pattern | Walrus adaptation | Interaction |
|---|---|---|
| Dark workspace shell and grouped navigation | Walrus Memory / Administration; environment selector | Mainnet/testnet stay explicit. Admin key required before this shell. |
| Continuous six-cell KPI strip | Live memories; plaintext bytes; encrypted bytes; encoded storage bytes; retrieval requests; active accounts | Definition in a tooltip, not a page banner |
| Personal/team/leadership tabs | Overview / Storage / Retrieval / Accounts | Same global filters, URL-preserved state |
| Large central trend | Retrieval volume, egress, storage growth, or latency | Separate units into tabs. Axes, dates, gridlines, hover |
| Team performance table | Account and delegate activity | Sort, search, click row into detail. Sparkline column |
| Conversion pipeline | Write lifecycle: accepted → encrypted → uploaded → certified → indexed | Horizontal bars. Cohort stages, not mixed event totals |
| Source donut | Activity by trusted integration source | Legend filters. Unknown is explicit |
| Leaderboard | Top storage consumers / egress contributors | Click into account. Admin-only |
| Notifications and prior comparison | Incident annotations, telemetry gaps, operational warnings | Compact badge. Detail in a popover or Data Quality |

Visual system observed on the reference, adapted with Walrus labels: page `#1a1a1a`, surfaces near `#232323`, borders `#2e2e2e`, text `#ededed`, muted secondary labels, violet accent on the selected nav item and primary series. Sidebar 238px. Controls 32px tall, 6px radius. KPI strip is one bordered row, not detached cards. Main column about two-thirds, right rail about one-third, sharing one border grid. Tabular numerals. Lower egress is not automatically green. A zero baseline renders “No baseline”. Unavailable is an em dash or “Unavailable” with a tooltip, never a fake zero.

Do not reproduce browser chrome or the far-left app icon rail. Avoid sales labels, decorative ranking badges, and a funnel that mixes unrelated event totals.

## 3. Navigation and overview layout

Sidebar groups:
- Analytics: Overview, Storage, Retrieval & Egress, Accounts & Delegates, Activity & Adoption.
- Operations: Upload Jobs, Wallets & Costs, Incidents, Data Quality.
- Administration: Configuration, Access & Audit.

The unauthenticated route is the existing admin key entry. It is not this shell. After a valid key, the header shows the admin session and sign-out. Logout clears the admin query cache.

Header after sign-in: breadcrumb, clock and timezone (default Asia/Ho_Chi_Minh), notification button, date range, compare period, custom date, environment. Export stays available from the session or page actions without a large instructional banner.

Overview composition:

```text
Sidebar | Breadcrumb                         Time  Notifications
        | Memory overview              Date  Compare  Calendar  Env
        | Storage, retrieval and account activity
        | Overview / Storage / Retrieval / Accounts
        | Live memories | Plaintext | Encrypted | Encoded | Retrievals | Accounts
        | Retrieval trend                         | Write lifecycle
        |                                         | Integration donut
        | Account activity table + sparklines     | Top contributors
```

Separate cumulative inventory from selected-period flows. Inventory is labeled as of a timestamp. Requests and activity use the selected range. A historical inventory date requires a snapshot or reconstructed ledger, not a current-table query.

## 4. Storage metrics: three distinct sizes

| Metric | Definition | Proposed source |
|---|---|---|
| Plaintext memory bytes | UTF-8 bytes of the canonical memory payload before encryption, with payload schema version recorded | Record length at write/encryption boundary |
| Encrypted payload bytes | Actual binary ciphertext blob bytes uploaded, excluding JSON/base64 transport | Existing blob_size_bytes is a candidate, subject to reconciliation |
| Walrus encoded storage bytes | Encoded/allocated size reported by the supported Walrus SDK/on-chain storage metadata | Verify deployed protocol and SDK field semantics in discovery |
| Encryption overhead | encrypted / plaintext for the same fully measured cohort | Weighted sums, not average row ratios |
| Encoding overhead | encoded / encrypted for the same fully measured cohort | Report source and encoding version |
| Total amplification | encoded / plaintext for the same fully measured cohort | Unknown denominator or zero → unavailable |

Never label ciphertext bytes as erasure-coded bytes. Never assume a fixed multiplier establishes exact encoded storage. If only a protocol-based estimate is possible, show “Estimated” with version, method, and coverage in the tooltip.

Show these inventories separately: live logical memories, unique referenced blobs, storage leases/allocations, retained expired or orphaned blobs, and lifetime upload flows. Use network + blob ID for content identity and network + storage object/lease ID for paid allocations. Sum a shared blob once for unique content storage. Global totals cannot sum duplicated per-account figures.

A known subtotal must say the coverage, not imply a complete total. Store numeric sizes only. Analytics must not decrypt historical memories to fill missing plaintext lengths.

### Admin storage comparison view

Side-by-side for Now, selected day end, and comparison day end: live logical memories, unique blobs, plaintext, encrypted, encoded, allocated lease bytes, coverage, added/removed bytes, and net change. Today uses the latest complete snapshot. Overhead percents use the same fully measured cohort. If the representations do not map to the same cohort, the comparison is unavailable. Admins can identify the accounts and new blobs responsible for a day's growth.

## 5. Retrieval and egress: percentile contract

Default meaning of p50/p90/p99 egress: **bytes transferred per logical retrieval request**. Latency percentiles are milliseconds. Rate is bytes/second. These stay in separately labeled panels.

| Transfer boundary | Measurement | Limit |
|---|---|---|
| Relayer → client | Actual response-body bytes emitted per logical request, including errors and partial streams | Body bytes differ from full wire bytes and provider billable egress |
| Aggregator/CDN → relayer | Bytes received across every attempted blob download, including fallback, hedge, error, and partial responses | Upstream service egress and relayer ingress |
| Walrus storage nodes → aggregator/client | Node or aggregator telemetry correlated to the logical request | Cannot infer node egress from decrypted payload or aggregator response size |
| Internal relayer ↔ sidecar/cache | Separate internal traffic if collected | Excluded from the public egress default |
| Infrastructure billing | Provider-reported outbound bytes/cost | Reconciliation view. Attribution may be coarse |

Do not present a cross-boundary sum as unique payload bytes or the relayer's bill. Do not add p99 values across hops or average daily p99 values. Calculate each request's total before its percentile. Unsupported node telemetry is unavailable, not zero. A known cache hit with no node fetch may legitimately be zero.

Historical capability: per-request records can support request percentiles; histograms support approximate percentiles for recorded dimensions; daily totals cannot support request p50/p90/p99; no retained data stays unavailable. Instrumentation cannot recreate it retrospectively.

The incident year and exact start/end remain unconfirmed. Permit arbitrary historical ranges. Do not silently pick April/May 2026.

## 6. Account and delegated-key analytics

Entity model: owner wallet → MemWal account → registered public delegate keys → activity. Account state, key registration/revocation, and observed usage stay separate. An auth cache is not the delegate registry.

Time presets: Today = local midnight to now; Yesterday = preceding local calendar day; Last 3 days = rolling 72 hours; Last 7 days = rolling 168 hours; This week = Monday local midnight to now. Store UTC. Apply the selected timezone for grouping. Today comparisons use the same elapsed portion of yesterday by default.

Selected-day investigation, required:
1. Select a calendar date and timezone. That day is local midnight inclusive to the next local midnight exclusive. Today stops at the latest complete timestamp. Show the resolved UTC boundaries in the detail, not as a page banner.
2. List accounts active that day, with owner, delegates used, reads/writes, returned count, errors, measured egress, and byte/latency percentiles. An All accounts option includes inactive accounts with verified zero activity.
3. Rank by egress, change versus baseline, request volume, storage growth, or tail latency. A tail view lists requests above the global day's p99. An account's own p99 is not its share of global p99.
4. Open day detail: hourly timeline, delegates, namespace/source mix, storage start/end, retrieval distributions, failures, incident overlap. Preserve date, timezone, environment, and comparison.
5. Drill account → delegate → request → transfer attempts. Provider details the relayer does not have stay unavailable.
6. Compare the selected account or the same cohort before/during/after. Include new and inactive accounts separately.
7. Export uses the same filters, definitions, and coverage. Paginate requests. Never silently truncate “full details.”

User identity is the verified owner wallet and account ID. Do not invent human names or email. Requests without a delegate stay in an owner/session bucket.

## 7. Operations and access

Retain existing wallet balances, sponsor balance, upload errors, and configuration behind the same admin key. Add queue depth, upload stage timing, indexer lag, cache health, and low-wallet warnings when those sources exist. Define costs from measured WAL/SUI transactions and provider invoices. Do not infer spend from storage size.

Access model: one admin-only site. The existing admin API key is the credential. Ordinary user, builder, insider, owner-wallet, and delegate credentials do not grant access. Enforce that key server-side on every page API, drilldown, export creation, export status, and download. Do not replace this flow with a multi-persona permission system in this plan. Network and environment access still follow the admin credential’s authorized deployment.

Analytics never expose plaintext memories, private keys, session secrets, authorization headers, or raw sensitive errors. Audit drilldowns, exports, and configuration changes. Escape labels in spreadsheet exports. The initial dashboard is read-only.

## 8. Existing code and data gaps

Verified repository anchors:
- `apps/app/src/pages/AdminDashboard.tsx`: admin key session. Unauthenticated visitors stay on the key entry screen.
- `apps/app/src/utils/admin-api.ts`: admin API client. Header `x-admin-api-key`.
- `services/server/src/routes/admin_dashboard.rs`: wallets, failed upload jobs, configuration.
- `services/server/src/observability.rs`: request counters and latency histograms. Not request-egress histograms.
- `services/server/src/storage/walrus.rs`: successful download body-byte logging. Full download timing needs separate instrumentation.
- `services/server/src/engine/walrus_seal.rs`: `blob_size_bytes` set from uploaded byte length.
- `services/server/migrations/003_rate_limiter.sql`: per-row encrypted size for quota accounting.
- `services/server/migrations/017_memory_expiry_columns.sql` and `020_read_api_followups.sql`: expiry fields and memory tombstones.
- `services/indexer/src/handler.rs`: AccountCreated indexing, not a complete key lifecycle ledger.
- `services/server/observability/README.md`: OpenObserve/OTel path. Production retention must be verified.

No chart library is declared in the app manifest. The admin shell draws charts in SVG so the page does not add a new dependency. Encoded size, plaintext length, request-level egress, and delegate lifecycle are not stored as analytics sources today. Those cells stay unavailable in live mode.

## 9. Proposed analytics architecture and API

Write durable, idempotent metadata events, then aggregate into hourly and daily read models. Operational requests must not wait for a remote analytics backend. Keep per-account dimensions out of high-cardinality Prometheus labels.

Proposed endpoints under the existing protected `/api/admin` key gate:
- `GET /analytics/overview`
- `GET /analytics/storage` and `/analytics/storage/breakdown`
- `GET /analytics/retrieval` and `/analytics/retrieval/breakdown`
- `GET /analytics/accounts` and `/analytics/accounts/:id`
- `GET /analytics/accounts/:id/delegates` and `/analytics/activity`
- `GET /analytics/accounts/:id/day`
- `GET /analytics/retrieval/requests` and `/analytics/retrieval/requests/:request_id`
- `GET /analytics/incidents/:id/comparison`
- `GET /analytics/coverage`
- `POST /analytics/exports` when synchronous export exceeds agreed limits.

Query contract: UTC half-open `[start,end)`, timezone, network, filters, granularity, comparison range, allowlisted sort, cursor. Response metadata: `generated_at`, `data_complete_through`, `definition_version`, units, source, coverage, approximation, warnings. Large byte amounts are decimal strings. Do not send observability credentials to the browser.

Retention proposal to review: 13 months of searchable request and attempt metadata and daily inventory snapshots, so a same-year April/May investigation can have request paths. Confirm the incident year before choosing the horizon. A shorter raw retention period is an explicit scope change, because rollups cannot supply individual request paths.

## 10. Ticket-ready backlog

Each section can become one ticket. Estimates are relative size, not commitments. Owner is a discipline. These IDs are plan names, not tracker issues.

### ADM-01 — Audit data sources and historical incident coverage
P0 · M · Backend/Data. Metric dictionary, retrieval path, storage field validation, retention matrix, incident dates, timestamp provenance. Acceptance: each metric marked measured, derivable, estimated, or unavailable.

### ADM-02 — Instrument logical retrieval requests and download attempts
P0 · L · Backend · ADM-01. Root IDs, response bytes, full-body timing, cache, retries, hedges, errors, cancellations. Unknown is distinct from zero. Telemetry failure does not fail memory operations. No secrets or content.

### ADM-03 — Integrate Walrus node and aggregator egress telemetry
P0 investigation · L · Infrastructure · ADM-01/02. Correlated node data supports per-request distributions with coverage. Unsupported data shows unavailable. Provider totals never masquerade as request percentiles.

### ADM-04 — Build storage inventory and lifecycle accounting
P0 · L · Backend · ADM-01. Plaintext length at the write boundary, encrypted length, verified encoded size, content and lease identities, daily snapshots. No bulk decryption. Shared blob counted once. Deleted index rows can remain allocated.

### ADM-05 — Index account and delegate lifecycle with verified timestamps
P0 · L · Backend/Indexer · ADM-01. Unused registered keys appear. Revoked keys keep history. Replay is idempotent. Auth cache is not authoritative. Ingestion time does not replace chain time.

### ADM-06 — Build analytics rollups and historical backfill
P0 · L · Data/Backend · ADM-02/04/05. Replayable events, merged percentiles, distinct counts, inventory snapshots, incident backfill report. Gaps survive export.

### ADM-07 — Provide protected analytics query APIs and exports
P0 · L · Backend · ADM-06. Same admin-key gate as the existing admin routes. KPI, table, and export agree for one snapshot. Non-admin requests denied.

### ADM-08 — Create the reference-matched admin shell
P0 · M · Frontend · After ADM-01 definitions; integrate ADM-07. Shell matches the inspected reference composition with Walrus labels. Key entry stays the existing screen. Demo fixtures, if any, use a compact badge, not a page essay.

### ADM-09 — Storage analytics and inventory drilldowns
P0 · M · Frontend · ADM-04/07/08. Three sizes, overhead, lifecycle, account growth. Unknown size never displays as zero.

### ADM-10 — Retrieval egress and incident comparison
P0 · L · Frontend · ADM-02/06/07/08. No percentile addition or averaging. Node gaps explicit. Arbitrary dates. April/May year verified before any preset is named.

### ADM-11 — Accounts, delegates, and activity windows
P0 · M · Frontend · ADM-05/06/07/08. Calendar and rolling windows. Owner/session bucket. Revoked-key history. No private keys or content. No silent truncation.

### ADM-12 — Keep admin-key access and audit
P0 before launch · M · Backend/Security · ADM-07. Do not add builder or insider roles. Missing, invalid, or rotated keys are rejected. Export downloads are not public URLs. Spreadsheet labels cannot inject formulas.

### ADM-13 — Operational health and cost reconciliation
P1 · M · Backend/Frontend · ADM-07/08. Queue, upload stages, indexer lag, cache, wallet depletion, measured spend. Cost estimates labeled.

### ADM-14 — Validate and roll out
P0 · M · QA/Infrastructure · Enabled P0 tickets. Controlled populations reproduce byte totals and percentile tolerance. Read-only canary. Supported and missing historical metrics documented.

## 11. Delivery order and decisions

Phase A: ADM-01. Phase B: ADM-02/04/05 collection and ADM-06 read models. Phase C: ADM-07 and ADM-08/09/10/11. Phase D: ADM-12 audit of the existing key gate, then ADM-14. ADM-13 follows as P1.

Backend collection can ship before UI so history starts accumulating. A release may show an unavailable node-egress cell if provider integration is blocked. It must not claim that requirement is satisfied.

Open decisions:
- Operator/Data: incident year, dates, baseline, and retained data locations.
- Backend/Walrus: which encoded-size and node-egress fields are authoritative.
- Backend/Security: confirm the existing admin-key mechanism and export download protection. Audience is already admin-only.
- Product/Data: plaintext scope, shared-blob attribution, integration identity.
- Infrastructure: volume, retention budget, billing-byte boundaries.

Future scope: forecasting, anomaly detection, cost recommendations, and destructive account or key actions. Builder, insider, and public dashboards are outside this admin-only plan.
