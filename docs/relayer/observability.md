---
title: "Observability"
---

Production relayers should emit structured logs, scrape Prometheus metrics, and send alerts for the external systems MemWal depends on: PostgreSQL, Redis, Sui RPC, OpenAI-compatible embedding/LLM APIs, SEAL, Walrus, and the TypeScript sidecar.

## Request Correlation

Every relayer request gets an `x-request-id`.

- If the client sends `x-request-id`, the relayer reuses it.
- If the client sends only `x-correlation-id`, the relayer uses that value.
- If neither is present, the relayer generates a UUID.
- The response includes `x-request-id`.
- Rust logs, internal error `traceId` values, outbound sidecar requests, and sidecar error responses use the same ID.

Use this ID when searching logs across the Rust relayer and TypeScript sidecar.

## Logs

For production, run with JSON logs:

```bash
RUST_LOG=memwal_server=info,tower_http=info
LOG_FORMAT=json
```

Useful fields include:

| Field | Meaning |
| --- | --- |
| `request_id` | Request/correlation ID shared across relayer and sidecar |
| `route` | Low-cardinality route label such as `/api/recall` |
| `method` | HTTP method |
| `status` | HTTP status code |
| `latency_ms` | Request latency in milliseconds |
| `owner`, `namespace` | User and namespace fields on selected route logs |

The relayer avoids logging memory text, recall queries, and ask/analyze prompts. It logs byte or character lengths instead.

## Prometheus Metrics

The Rust relayer exposes Prometheus metrics at:

```text
GET /metrics
```

The TypeScript sidecar also exposes wallet-specific counters at:

```text
GET <SIDECAR_URL>/metrics/wallet
```

Core relayer metrics:

| Metric | Labels | Notes |
| --- | --- | --- |
| `memwal_http_requests_total` | `method`, `route`, `status` | Request volume and status mix |
| `memwal_http_request_duration_seconds` | `method`, `route`, `status` | HTTP latency histogram |
| `memwal_http_requests_in_flight` | none | Current in-flight request count |
| `memwal_errors_total` | `kind`, `route` | Application error counts |
| `memwal_rate_limit_denials_total` | `bucket`, `route` | Rate-limit denials |
| `memwal_rate_limit_fallbacks_total` | `scope` | Redis fallback usage |
| `memwal_external_request_duration_seconds` | `service`, `operation`, `status` | OpenAI, Sui RPC, SEAL sidecar, Walrus latency |
| `memwal_sidecar_failures_total` | `operation`, `reason` | Sidecar transport and HTTP failures |
| `memwal_db_query_duration_seconds` | `operation`, `status` | PostgreSQL and pgvector query latency |
| `memwal_db_pool_connections` | `state` | PostgreSQL pool `open` and `idle` gauges |

Example Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: memwal-relayer
    metrics_path: /metrics
    static_configs:
      - targets: ["relayer.example.com"]
```

## Recommended Dashboards

Create panels for:

- HTTP request rate by route and status.
- p50/p95/p99 HTTP latency by route.
- Error rate from `memwal_errors_total` and 5xx statuses.
- Rate-limit denials by bucket.
- External service p95 latency by `service` and `operation`.
- Sidecar failures by operation.
- PostgreSQL query latency and pool open/idle connections.
- Sidecar wallet counters: `walletSubmittedTotal`, `walletLockErrorsTotal`, `walletPermanentFailuresTotal`.

## Recommended Alerts

| Alert | Suggested Condition |
| --- | --- |
| High 5xx rate | 5xx responses exceed 1% for 5 minutes |
| Route latency regression | p95 `/api/recall` or `/api/remember` latency exceeds the normal SLO for 10 minutes |
| Redis degraded | `memwal_rate_limit_fallbacks_total` increases in production |
| Sidecar unhealthy | `memwal_sidecar_failures_total` increases for SEAL or Walrus operations |
| OpenAI latency/errors | External `service="openai"` p95 latency or non-2xx status rate spikes |
| Walrus download/upload failures | External `service="walrus"` or sidecar Walrus failures increase |
| Sui RPC failures | `service="sui_rpc"` transport errors or non-2xx statuses increase |
| DB saturation | PostgreSQL pool open connections near configured max, or idle connections stay at 0 |
| Wallet lock canary | Sidecar `walletLockErrorsTotal` is greater than 0 |
| Permanent wallet failures | Sidecar `walletPermanentFailuresTotal` increases |

## APM Integration

MemWal emits structured logs and Prometheus metrics in vendor-neutral formats. For Datadog, New Relic, Grafana Cloud, or OpenTelemetry Collector based setups:

1. Scrape `/metrics` from the Rust relayer.
2. Collect stdout/stderr logs from both the Rust process and sidecar.
3. Parse JSON logs when `LOG_FORMAT=json`.
4. Treat `request_id` and `traceId` as the correlation key.
5. Scrape or poll sidecar `/metrics/wallet` when the sidecar is reachable from the monitoring agent.

If your APM supports custom spans, map `memwal_external_request_duration_seconds` operations to dependencies:

- `openai / embeddings`
- `openai / chat_completions`
- `sui_rpc / sui_getObject`
- `sidecar / seal_encrypt`
- `sidecar / seal_decrypt_batch`
- `sidecar / walrus_upload`
- `walrus / download_blob`

## WALM-52: Upload-Relay Tip Spend

The sidecar emits two Prometheus counters that track SUI MIST paid as Walrus upload-relay tip. Use these to decide whether self-hosting the upload relay reduces pool burn (Henry's hypothesis is "at high usage, self-host wins"). Gas for register/certify is Enoki-sponsored separately and is **not** part of this metric.

### Scrape

The counters are exposed in Prometheus text format at `GET <SIDECAR_URL>/metrics/walrus` — separate from the JSON `/metrics/wallet` endpoint and reachable without the sidecar bearer token (same posture as `/metrics/wallet`). Add a second scrape target:

```yaml
scrape_configs:
  - job_name: memwal-sidecar-walrus
    metrics_path: /metrics/walrus
    static_configs:
      - targets: ["sidecar.example.com:9000"]
```

### Metrics

| Metric | Labels | Notes |
| --- | --- | --- |
| `walrus_upload_relay_uploads_total` | `host`, `send_tip` | Successful uploads since sidecar start. `host` is the parsed hostname from `WALRUS_UPLOAD_RELAY_URL`. `send_tip` is `"true"` / `"false"` from `WALRUS_UPLOAD_RELAY_SEND_TIP`. |
| `walrus_upload_relay_tip_mist_total` | `host`, `send_tip` | Sum of MIST attributed to the relay tip recipient in register-tx balance changes. Increments by 0 in no-tip mode. |

Each sidecar process emits a single label combination (the config is per-instance), so multi-instance comparison is by **deploy**, not by relabeling — i.e. run a canary sidecar with a different `WALRUS_UPLOAD_RELAY_URL` / `WALRUS_UPLOAD_RELAY_SEND_TIP` to get a second label combination in Grafana.

### Panels

All PromQL examples below are copy-paste valid for Prometheus / Grafana — aggregation operators (`sum by`) wrap the `rate(...)` calls so labels are explicit, and division aggregates each side before dividing.

| Panel | PromQL |
| --- | --- |
| Tip burn rate per host | `sum by (host, send_tip) (rate(walrus_upload_relay_tip_mist_total[1h]))` |
| Upload rate per host | `sum by (host, send_tip) (rate(walrus_upload_relay_uploads_total[1h]))` |
| Tip per upload (MIST) | `sum by (host, send_tip) (rate(walrus_upload_relay_tip_mist_total[1h])) / sum by (host, send_tip) (rate(walrus_upload_relay_uploads_total[1h]))` |
| Daily SUI projection | `sum by (host, send_tip) (rate(walrus_upload_relay_tip_mist_total[1h])) * 86400 / 1e9` |

### Alerts

| Alert | Condition |
| --- | --- |
| Public relay tip spike | `sum(rate(walrus_upload_relay_tip_mist_total{send_tip="true"}[1h])) > 2 * quantile_over_time(0.5, sum(rate(walrus_upload_relay_tip_mist_total{send_tip="true"}[1h]))[7d:1h])` for 30m |
| Canary tip non-zero | `sum(rate(walrus_upload_relay_tip_mist_total{send_tip="false"}[5m])) > 0` (means a misconfigured self-hosted relay is still charging a tip) |

### Independent on-chain audit

The Prometheus counter is an observed proxy. For ground truth (and for one-off reporting like Henry's "2.67 SUI in 12h" measurement), run the standalone audit. The relay tip recipient is configurable per relay and can change — always fetch it from `<relay>/v1/tip-config` rather than hardcoding:

```bash
# 1. Fetch the live tip recipient (per network; verify before each audit).
TIP_ADDR=$(curl -s https://upload-relay.mainnet.walrus.space/v1/tip-config | jq -r '.send_tip.address')
echo "$TIP_ADDR"  # e.g. 0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256

# 2. Run the audit against the pool wallets for the window of interest.
npx tsx services/server/scripts/walrus-tip-audit.ts \
  --pool-address 0x<pool-wallet-1> --pool-address 0x<pool-wallet-2> \
  --relay-tip-address "$TIP_ADDR" \
  --from 2026-05-24T05:00:00Z --to 2026-05-25T05:00:00Z
```

Current known recipients (verify with the `curl` above — they are not part of any static config):

| Network | Relay tip address (as of this writing) |
| --- | --- |
| mainnet | `0x765a6ff2c13b47e2603416d0b5a156df498a5c51bc8085be3838e43e06086256` |
| testnet | `0x4b6a7439159cf10533147fc3d678cf10b714f2bc998f6cb1f1b0b9594cdc52b6` |

Output is CSV: `date,pool_address,relay_tip_mist,relay_tip_sui,upload_count_estimate,other_mist`. The script queries Sui RPC directly and does not depend on the sidecar. See [WALM-52 Canary](/relayer/walm-52-canary) for the trial procedure.
