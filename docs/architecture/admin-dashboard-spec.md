> Internal specification. Not a docs-site page; do not add this file to `docs/docs.json`.
> Code anchors rechecked against `origin/dev` @ `3e0534e6` (11 October 2026). No production data was queried.

# Walrus Memory admin dashboard — specification and ticket plan

Date: 11 October 2026. Status: proposed, ready for ticket creation.
Reference: https://stride-dashboard-two.vercel.app/?ws=vantage-admin and supplied screenshot.
Scope: plan the dashboard and measurement pipeline; implementation and external ticket publication are separate steps. No production data was queried. No actual storage totals or historical percentiles are asserted here.

## 1. Product outcome

Give operators, builders, and approved insiders one place to answer: how much memory exists, how much storage it occupies, who uses it, how much traffic retrieval generates, and what changed during an incident. Every number must identify its scope, time window, source, freshness, and coverage.

Primary user stories:
- As an operator, I can compare live plaintext, encrypted payload, and Walrus encoded storage so I can explain growth and overhead.
- As an incident investigator, I can compare p50/p90/p99 retrieval bytes and latency before, during, and after an incident and identify the accounts and paths driving it.
- As a builder, I can inspect my accounts and delegates over today, yesterday, three days, and seven days to understand integration behavior.
- As an insider, I can view approved aggregate adoption and reliability without accessing memory content or other builders' private account detail.

Proposed success criteria: a reviewer can answer these three operational questions in under two minutes; supported metrics refresh within five minutes; counts and bytes reconcile against controlled test workloads; unsupported historical periods display unavailable rather than zero. Performance target: overview responds within two seconds at the agreed production scale, established during the data audit.

## 2. Reference UI/UX analysis and adaptation

The live reference exposes workspace switching, grouped sidebar navigation, breadcrumbs, notifications, date selection, comparison controls, three scope tabs, six KPI cells, a series-toggle trend chart, a sortable table with clickable rows and sparklines, a pipeline, source distribution, and leaderboard. These interactions and the supplied screenshot informed this plan; the reference's other pages have not been exhaustively inspected.

| Reference pattern | Walrus adaptation | Interaction |
|---|---|---|
| Dark workspace shell and grouped navigation | Walrus Memory / Admin; environment selector | Mainnet/testnet and production/staging remain explicit |
| Six bordered KPI cells | Live memories; plaintext bytes; encrypted bytes; encoded storage bytes; retrieval requests; active accounts | Metric definition tooltip and detail link |
| Personal/team/leadership tabs | Overview / Storage / Retrieval / Accounts | Same global filters, URL-preserved state |
| Large central trend | Retrieval volume, egress, storage growth, or activity | Toggle compatible series; separate units into panels |
| Team performance table | Account and delegate activity | Sort, search, filter, expand row or open detail drawer |
| Conversion pipeline | Write lifecycle: accepted → encrypted → uploaded → certified → indexed | Cohort-based stages; pending/failed counts |
| Source donut | Activity by trusted integration source | Legend filters; Unknown is explicit |
| Leaderboard | Top storage consumers / egress contributors | Choose ranking; click into account; private by role |
| Notifications and prior comparison | Incident annotations, telemetry gaps, operational warnings | Severity and timestamp; link to investigation |

Visual direction: near-black canvas (#181818), slightly lighter panels (#202020), thin neutral borders (#303030), off-white type, muted secondary labels, violet accent around #8055FF. These are proposed tokens based on the screenshot, not extracted source values. Use Walrus branding and domain labels. Keep the compact segmented KPI strip and roughly 2:1 main/right column balance. Sidebar approximately 232–256 px; 16–24 px content padding; 8 px spacing scale; restrained 8–12 px corners; tabular numerals. Use accessible chart colors and text/icons as well as color for status.

The browser chrome and the far-left app icon rail in the screenshot are outside the product; do not reproduce them. Avoid copying irrelevant sales labels, decorative ranking badges, or a funnel that mixes unrelated event totals. Lower egress can be favorable; larger values are not automatically green. Use percentage points for success-rate changes and percentages for count/byte changes; a zero baseline renders 'No baseline'.

Responsive behavior: six KPI columns on wide screens, three on medium screens, two on narrow screens; right rail stacks below charts; collapsible sidebar; tables scroll horizontally with account identity pinned. Keyboard-accessible filters, drawers, sortable headings, chart summaries, focus states, and reduced-motion support. Define loading skeletons, no-activity, partial coverage, unavailable source, stale data, forbidden access, and retry states individually.

## 3. Navigation and overview layout

Sidebar groups:
- Analytics: Overview, Storage, Retrieval & Egress, Accounts & Delegates, Activity & Adoption.
- Operations: Upload Jobs, Wallets & Costs, Incidents, Data Quality.
- Administration: Configuration, Access & Audit.

Header: breadcrumb, environment/network, date range, timezone (default Asia/Ho_Chi_Minh), account/namespace/source filters, compare period, last complete data timestamp, export.

Overview wireframe:

```text
Sidebar | Walrus Memory overview        Environment  Date  Compare  Export
        | Live memories | Plain bytes | Encrypted bytes | Encoded bytes | Reads | Active accounts
        | Retrieval trend + incident markers           | Write lifecycle
        | Bytes / Requests / Latency tabs               | Integration distribution
        | Account activity table + sparklines           | Top egress contributors
        | Recent failures and telemetry coverage        | Wallet health
```

Separate cumulative inventory from selected-period flows. Inventory is labeled 'As of [timestamp]'; requests and activity are labeled with the selected range. A historical inventory date requires a snapshot or reconstructed ledger, not a current-table query. Custom range filters apply consistently to every flow panel and export.

## 4. Storage metrics: three distinct sizes

'Encoded size' needs a precise definition. The dashboard should expose all three sizes so encryption and Walrus erasure coding are not confused.

| Metric | Definition | Proposed source |
|---|---|---|
| Plaintext memory bytes | UTF-8 bytes of the canonical memory payload before encryption, with payload schema version recorded | Record length at write/encryption boundary |
| Encrypted payload bytes | Actual binary ciphertext blob bytes uploaded, excluding JSON/base64 transport | Existing blob_size_bytes is a candidate, subject to reconciliation |
| Walrus encoded storage bytes | Encoded/allocated size reported by the supported Walrus SDK/on-chain storage metadata | Verify deployed protocol and SDK field semantics in discovery |
| Encryption overhead | encrypted / plaintext for the same fully measured cohort | Weighted sums, not average row ratios |
| Encoding overhead | encoded / encrypted for the same fully measured cohort | Report source and encoding version |
| Total amplification | encoded / plaintext for the same fully measured cohort | Unknown denominator or zero → unavailable |

Never label ciphertext bytes as erasure-coded bytes. Never assume a fixed multiplier establishes exact encoded storage. If only a protocol-based estimate is possible, show 'Estimated encoded storage' with version, method, and coverage.

Show these inventories separately:
- Live logical memory count and plaintext size.
- Unique referenced blobs and their encrypted/encoded sizes.
- Storage leases/allocations, including multiple paid allocations for a shared blob where applicable.
- Retained expired, deleted, unindexed, or orphaned blobs still occupying storage.
- Lifetime uploaded bytes and storage expenditure, which are flows rather than current inventory.

Use network + blob ID for content identity and network + storage object/lease ID for paid allocations. Sum a shared blob once for unique content storage; do not sum its repeated size across vector rows. Logical memories and chunks can have different counts; document the actual write model. For per-account attribution of shared storage, choose and label a policy; global totals cannot sum duplicated per-account figures.

Breakdowns: owner/account, namespace, trusted application source, package version, encryption mode, age bucket, retention/end epoch, live/expired/deleted/pending, size bucket. Show added/removed bytes, net growth, unindexed/orphaned share, unknown-size count, next-epoch expiration, and quota utilization separately from physically allocated storage.

Store numeric sizes only; analytics must not decrypt historical memories merely to fill missing plaintext lengths. Backfill plaintext size only from existing authorized metadata. A known subtotal must say 'Known bytes: X; coverage: Y% of eligible items', not imply a complete total. For historical inventory, maintain daily snapshots plus lifecycle events; mark periods whose deletions/expirations cannot be reconstructed.

## 5. Retrieval and egress: percentile contract

Default meaning of p50/p90/p99 egress: **bytes transferred per logical retrieval request**. Also show latency percentiles in milliseconds and traffic rate in bytes/second in separately labeled panels.

| Transfer boundary | Measurement | Limit |
|---|---|---|
| Relayer → client | Actual response-body bytes emitted per logical request, including errors and partial streams | Body bytes differ from full wire bytes and provider billable egress |
| Aggregator/CDN → relayer | Bytes received across every attempted blob download, including fallback/hedged/error/partial responses | This is upstream service egress and relayer ingress |
| Walrus storage nodes → aggregator/client | Node or aggregator telemetry correlated to the logical request, covering fetched fragments and retries | Cannot infer actual node egress from decrypted payload or aggregator response size |
| Internal relayer ↔ sidecar/cache | Separate internal traffic if collected | Excluded from public egress default |
| Infrastructure billing | Provider-reported outbound bytes/cost | Reconciliation view; attribution may be coarse |

Display boundary-specific numbers first. A combined 'Cross-boundary bytes' metric may sum distinct measured hops for each correlated request, but must explicitly explain that the same content can travel through several hops. Do not present that sum as unique payload bytes or the relayer's bill. Never add a node metric twice when an upstream provider already includes it in an aggregate measurement.

For each boundary display request count, measured count, coverage, total bytes, average bytes/request, p50/p90/p99 bytes/request, maximum, latency p50/p90/p99, error rate, retry/fallback rate, cache-hit rate, bytes per returned memory, and upstream amplification. Pair byte totals with the number of returned memories and top-k so legitimate large recalls are distinguishable from waste.

Population rules:
- Logical request groups internal retries and child blob fetches under one root request ID. External client retries are separate requests unless a stable operation ID permits an explicitly labeled operation view.
- Default: all completed retrieval requests, with successful-only comparison available; count failures and cancellations separately and measure partial bytes where possible.
- Include verified cache-hit zeros in upstream distributions. Keep a separate cache-miss-only distribution.
- Unsupported node telemetry is null/unknown, not zero. A known cache hit with no node fetch may legitimately be zero.
- Calculate each request's total before calculating its percentile. Do not add p99 values across hops or average daily p99 values.
- Aggregate compatible histogram buckets or mergeable quantile sketches over the selected range. Disclose approximation and suppress/flag unstable tails for small samples.
- Streaming measurement counts bytes actually emitted/received; Content-Length alone is insufficient. Cancellation cleanup must finalize counters, including losing hedged downloads.
- If provider correlation is incomplete, show node-level time series separately; do not fabricate request-level node p99.

Breakdowns: endpoint/operation (recall, restore, memory read, ask retrieval phase where applicable), account, delegate, namespace, source, network, cache hit/miss, aggregator/CDN, status, payload-size bucket, returned count/top-k, retry and hedge count, encryption mode, deployment/version, time bucket. Mark self-reported client/source labels unverified; prefer registered application identity. Account rankings use controlled access.

### April/May incident investigation

The incident's year and exact start/end remain unconfirmed. Permit arbitrary historical ranges; do not silently pick April/May 2026. Discovery must locate the incident timeline and retained relayer, aggregator, node, infrastructure, and deployment data.

Compare matched windows before/during/after: total requests, active accounts, p50/p90/p99 bytes and latency, cache misses, fetches/request, retries, returned count, payload size, rate limits, top contributors, and release markers. Baseline should match weekdays, duration, and comparable route/account mix. Offer normalized bytes/request and separate request-volume growth. Show observations and correlations without asserting a root cause.

Historical capability matrix:
- Per-request byte records → request percentiles and attribution possible.
- Retained byte histograms → approximate percentiles for dimensions recorded at collection.
- Correlated successful download logs → partial upstream body-byte reconstruction, with gaps for failed/losing attempts and missing root IDs.
- Daily bandwidth totals only → totals/rates, not request p50/p90/p99.
- No retained data → unavailable; instrumentation cannot recreate it retrospectively.

## 6. Account and delegated-key analytics

Entity model: owner wallet → MemWal account → registered public delegate keys → activity. Keep account state, key registration/revocation state, and observed usage as separate dimensions. An auth cache is not the delegate registry; unused registered keys and historical revoked keys must remain discoverable.

Time presets: Today = local midnight to now; Yesterday = preceding local calendar day; Last 3 days = rolling 72 hours; Last 7 days = rolling 168 hours; This week = Monday local midnight to now. Labels must distinguish rolling and calendar windows. Store UTC; apply selected timezone for grouping. Today comparisons use the same elapsed portion of yesterday by default.

Account table: account ID, owner, status, registered key count, used key count, last activity, today's operations, yesterday's operations, last-3-day and last-7-day operations, successful writes, retrievals, returned memories, errors, encrypted storage, relayer bytes, upstream bytes, p99 retrieval bytes, seven-day sparkline. Column selector keeps the default table readable.

Delegate table/detail: public-key fingerprint and optional label, account/owner, current status, registration/revocation timestamps if available, first/last observed activity, verified source, operation counts for each window, success/error rate, retrieval bytes and latency percentiles, failed authentication/rate-limit counts, and activity timeline. Requests authenticated as owner/session or without a delegate appear in their own category; never invent a delegate attribution. Unverified attempts are excluded from authenticated account activity.

Define activity as authenticated product operations, with separate accepted/completed/failed counters. One user write may emit multiple worker stages: count the logical operation once and expose stages separately. Distinct active accounts/keys require at least one authenticated product operation in the range; dashboard views, health checks, polling, and administrative requests are excluded. Writes accepted today but completed tomorrow affect different counters. Preserve verified actor identity when asynchronous jobs execute.

Additional builder/adoption views: new and returning accounts, D1/D7/D30 retention cohorts, write-to-first-retrieval activation, namespaces used, integration mix, read/write ratio, unused delegates, active accounts without reads/writes, account concentration, quota pressure. Never equate one delegate with one person or attribute automated traffic to humans.

## 7. Operations and access

Retain existing wallet balances, sponsor balance, upload errors, and configuration. Add queue depth/oldest job age, upload stage timing, failure reason, retry state, restore failures, indexer lag, metadata/expiry synchronization lag, cache health, and low-wallet warnings. Define costs from measured WAL/SUI transactions and provider invoices, with price timestamp for fiat conversion; do not infer spend from storage size alone.

Access scopes: operator sees approved global metadata; insider sees aggregate data; builder sees only authorized account scopes. Enforce server-side authorization on every endpoint and export. Current shared admin-key access does not implement these personas; scoped access must precede builder/insider rollout. Analytics never expose plaintext memories, private keys, session secrets, authorization headers, or raw sensitive errors. Audit drilldowns, exports, and configuration changes. Escape labels in UI and spreadsheet exports. Initial dashboard is read-only; account quarantine, delegate revocation, and financial actions need separate workflows.

## 8. Existing code and data gaps

Verified repository anchors:
- apps/app/src/pages/AdminDashboard.tsx: existing admin shell and session handling.
- apps/app/src/utils/admin-api.ts: existing admin API client and wire mapping.
- services/server/src/routes/admin_dashboard.rs: wallets, failed upload jobs, configuration.
- services/server/src/observability.rs: request counters and latency histograms; not evidence of request-egress histograms.
- services/server/src/storage/walrus.rs: multiple-aggregator retrieval and successful download body-byte logging. Dependency timing is observed before body consumption; full download timing needs separate instrumentation.
- services/server/src/engine/walrus_seal.rs: ciphertext cache warming and blob_size_bytes set from uploaded byte length.
- services/server/migrations/003_rate_limiter.sql: per-vector-row encrypted size for quota accounting.
- services/server/migrations/017_memory_expiry_columns.sql and 020_read_api_followups.sql: expiry fields and memory tombstones.
- services/indexer/src/handler.rs: AccountCreated indexing, not a complete key lifecycle ledger. Database created_at is ingestion-time default, not proven on-chain creation time.
- services/server/observability/README.md: OpenObserve/OTel path and production rollout notes; production retention/coverage must be verified.

Extend the current React/Vite app, Rust API, PostgreSQL read models, and observability integration. Avoid an unrelated second dashboard backend until scale evidence requires it. No chart library is declared in the app manifest; select an accessible React chart package during UI discovery.

## 9. Proposed analytics architecture and API

Write durable, idempotent metadata events, then aggregate into hourly/daily read models. Use a bounded non-blocking emitter with durable delivery/replay and explicit drop/lag metrics; operational requests must not wait for a remote analytics backend. Keep per-account/delegate dimensions in controlled event/read-model storage, not high-cardinality Prometheus labels.

Proposed records:
- retrieval_request: root ID, UTC timestamps, verified account/delegate/source, operation, network/environment, status, returned count, cache outcome, per-hop byte values and measurement states, complete latency, telemetry version.
- retrieval_attempt: attempt ID + root ID, blob ID, upstream ID, start/end, response bytes observed, retries/hedging outcome, cancellation, and provider correlation when supported.
- memory_inventory / storage_lease: logical memory ID, content and lease identities, ownership, namespace, lengths, lifecycle state, schema/protocol version, provenance, expiry, reconciliation timestamp.
- delegate_registry + lifecycle: network/account/public key identity, state, chain checkpoint, verified timestamps, source confidence.
- hourly/daily_rollups: counters, bytes, mergeable distributions and distinct-count method; snapshot inventory separately.
- telemetry_coverage: per metric/source, earliest/latest complete timestamps, expected/observed counts, gaps and collection version.

Proposed endpoints under existing protected /api/admin:
- GET /analytics/overview
- GET /analytics/storage and /analytics/storage/breakdown
- GET /analytics/retrieval and /analytics/retrieval/breakdown
- GET /analytics/accounts and /analytics/accounts/:id
- GET /analytics/accounts/:id/delegates and /analytics/activity
- GET /analytics/incidents/:id/comparison
- GET /analytics/coverage
- POST /analytics/exports for bounded export jobs if synchronous exports exceed agreed limits.

Common query contract: UTC start/end using half-open [start,end), timezone, network/environment, account/namespace/source/operation/status filters, granularity, comparison range, supported sort and cursor. Bound ranges and pagination; allowlist sort fields. Common response metadata: generated_at, data_complete_through, definition_version, units, source, coverage, approximation, warnings. Return large integer byte amounts as decimal strings. Use consistent snapshots so KPI/table/export reconcile; exports include the same definitions and coverage metadata. Do not send observability backend credentials to the browser.

Retention proposal to review against incident needs and volume: 90 days raw metadata, 13 months hourly/daily distributions and inventory snapshots, longer daily summaries only if approved. Retained rollups must preserve the requested percentile dimensions; otherwise explicitly limit historical filters. Historical incident backfill has a separate availability outcome, not a promise.

## 10. Ticket-ready backlog

Each section below can become one ticket. Estimates are relative size (S/M/L), not delivery commitments. Owner is a discipline, not an assigned person.

### ADM-01 — Audit data sources and historical incident coverage
P0 · M · Backend/Data · No dependencies.
Deliver a metric dictionary, actual retrieval path diagram, storage/SDK field validation, production telemetry retention matrix, verified incident dates/year, and account/key timestamp provenance.
Acceptance: each requested metric marked measured, derivable, estimated, or unavailable; historical p50/p90/p99 supported only with distributions/request records; node/provider telemetry ownership identified; follow-up gaps documented.

### ADM-02 — Instrument logical retrieval requests and all download attempts
P0 · L · Backend · Depends ADM-01 definitions.
Capture verified actor/root IDs, response bytes, full-body timing, cache outcome, retries, fallbacks, losing hedges, errors and cancellations; add histograms and durable metadata events.
Acceptance: controlled cache-hit/miss, multi-blob, fallback, failed, canceled and hedged workloads yield correct per-root totals; unknown is distinguishable from zero; telemetry delivery failure does not fail memory operations; secrets/content absent.

### ADM-03 — Integrate Walrus node/aggregator egress telemetry
P0 investigation; integration depends on provider support · L · Infrastructure/Data · ADM-01/02.
Establish aggregator and storage-node counters/correlation or document exact limits. Keep body, wire, and billed byte boundaries separate.
Acceptance: correlated node data supports per-request distributions with coverage; unsupported data shows unavailable; aggregate provider totals never masquerade as request percentiles; partial/canceled transfer limitations stated.

### ADM-04 — Build storage inventory and lifecycle accounting
P0 · L · Backend · ADM-01.
Record plaintext length at write boundary, encrypted length, verified encoded/allocated size, logical/content/lease identities, expiry/deletion and daily inventory snapshots. Reconcile existing rows and storage metadata without bulk memory decryption.
Acceptance: shared blob counted once in content inventory; paid leases counted by allocation; deleted index rows can remain allocated; expired/unknown states explicit; lifetime uploads differ from live inventory; exact/estimated totals and coverage rendered separately.

### ADM-05 — Index account and delegate lifecycle with verified timestamps
P0 · L · Backend/Indexer · ADM-01.
Extend account read model to key registration/removal and account status using available chain events or checkpoint-based object reconciliation. Verify contract event availability before choosing ingestion method.
Acceptance: unused registered keys appear; revoked keys preserve historical activity; replay is idempotent; chain lag visible; auth cache is not authoritative; chain creation time is not replaced by ingestion time.

### ADM-06 — Build analytics rollups and historical backfill
P0 · L · Data/Backend · ADM-02/04/05; ADM-03 where supported.
Create replayable events, UTC hourly/daily aggregation, merged percentile distributions, distinct counts, inventory snapshots, and a documented incident backfill report.
Acceptance: no duplicate events after replay; timezone boundaries and late events correct; percentiles computed from merged populations; zero baselines and sparse tails handled; known gaps survive export; backfill distinguishes recoverable and unavailable metrics.

### ADM-07 — Provide protected analytics query APIs and exports
P0 · L · Backend · ADM-06.
Implement overview/storage/retrieval/account/activity/coverage contracts; bounded pagination, consistent filter semantics, safe byte serialization, server caching scoped to authorized identity, and export parity.
Acceptance: unauthorized scopes denied; KPI/table/export agree for one snapshot; range and sort validation enforced; partial source failure returns clearly scoped warnings; agreed-scale overview meets two-second target.

### ADM-08 — Create reference-inspired admin shell and overview
P0 · M · Frontend/Design · Can begin after ADM-01; integrate ADM-07.
Build Walrus sidebar, filters, scope tabs, six KPI strip, large trends, account table, right rail and responsive behavior. Reuse existing admin session validation and wallet/error components.
Acceptance: reference visual hierarchy recognizable with Walrus branding; units never mixed silently; filters persist in URL; keyboard navigation and contrast reviewed; loading/empty/stale/unavailable/error states present; explicit demo labeling for any fixtures.

### ADM-09 — Implement storage analytics and inventory drilldowns
P0 · M · Frontend · ADM-04/07/08.
Build three-size view, amplification, lifecycle inventories, breakdowns and date snapshots.
Acceptance: unknown plaintext/encoded size never displays zero; stock versus flow labels clear; breakdowns reconcile; deduplication/attribution method visible in definition drawer.

### ADM-10 — Implement retrieval egress and incident comparison
P0 · L · Frontend/Data · ADM-02/06/07/08; ADM-03 optional coverage.
Build byte p50/p90/p99, separate latency/rate charts, hop breakdowns, top contributors, cache/retry views, and matched before/during/after comparisons.
Acceptance: no percentile addition/averaging; measured population and sample size visible; incomplete node data explicit; incident annotation and arbitrary historical date selection work; April/May year is verified before any preset is named.

### ADM-11 — Implement accounts, delegates and activity windows
P0 · M · Frontend · ADM-05/06/07/08.
Build searchable account/delegate tables, detail drawers, operation timeline and Today/Yesterday/72h/168h/This-week views; preserve asynchronous operation actor.
Acceptance: distinct active counts and operation counts differ; calendar/rolling windows tested; owner/session/no-delegate buckets present; revoked-key history retained; private keys/content absent; filter context retained on drilldown.

### ADM-12 — Add scoped builder/insider access and audit
P0 before wider access · L · Backend/Security · ADM-07; parallel design possible.
Implement operator, aggregate insider and own-account builder scopes, authenticated sessions or approved existing identity integration, audit trail and safe exports.
Acceptance: cross-account API/export attempts denied; browser query caches cleared on logout/scope change; aggregate insiders cannot drill into private account data; export labels cannot inject spreadsheet formulas; sensitive credential logging excluded.

### ADM-13 — Add operational health and cost reconciliation
P1 · M · Backend/Frontend · ADM-07/08.
Surface queue health, upload stage failures, indexer lag, synchronization, cache health, wallet depletion and measured spend/provider billing.
Acceptance: stage counts use a consistent operation cohort; stale balances identified; cost estimates labeled; alert thresholds agreed with operator and avoid noisy low-volume triggers.

### ADM-14 — Validate and roll out the dashboard
P0 · M · QA/Infrastructure · All enabled P0 tickets.
Run measurement reconciliation, access tests, realistic-scale query benchmarks, responsive/accessibility checks and staged rollout with rollback switch. Validate partial observability outage behavior.
Acceptance: controlled request populations reproduce byte totals and percentile tolerance; storage inventory reconciles by content and lease; read-only canary passes; telemetry lag/drop monitor live; supported/missing historical metrics documented for operators.

## 11. Delivery order and decisions

Phase A: ADM-01 discovery; agree dictionary, incident window, provider feasibility and volume. Build shell fixtures in parallel after definitions are stable, clearly marked as demo.
Phase B: ADM-02/04/05 collection, ADM-03 provider integration where possible, ADM-06 read models and backfill.
Phase C: ADM-07 APIs and ADM-08/09/10/11 UI. Retain existing operational panels throughout.
Phase D: ADM-12 scoped access, ADM-14 validation and staged launch. ADM-13 and advanced adoption cohorts follow as P1.

Backend collection can ship before UI to begin preserving history. Dashboard release may include an unavailable node-egress panel if provider integration is blocked, but must not claim the full node-level requirement is satisfied.

Open decisions and suggested owners:
- Operator/Data: exact incident year, dates, and comparable baseline; confirm retained data locations.
- Backend/Walrus integration: which encoded-size and node-egress fields are authoritative for the deployed protocol?
- Product/Security: which insiders may see named account data versus aggregates; builder ownership mapping.
- Product/Data: plaintext scope (memory record versus original submitted conversation), shared-blob attribution, authoritative integration identity.
- Infrastructure: expected data volume, retention budget, billing-byte boundaries and aggregation performance.

Future scope: forecasting, configurable anomaly detection, cost optimization recommendations, wider public aggregate dashboard, and destructive account/key actions. These should not delay measured storage, egress and delegate activity.
