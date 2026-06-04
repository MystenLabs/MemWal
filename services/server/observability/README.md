# MemWal observability PoC — OpenObserve (WALM-81)

Self-hosted observability stack: **OpenObserve** + an **OpenTelemetry Collector**
that scrapes the relayer Prometheus `/metrics`, tails structured JSON container
logs, and accepts OTLP (ready for future traces). Follows the OpenObserve
recommendation from WALM-79.

> Status: **PoC**. Verified locally end-to-end (collector → OpenObserve ingest
> + query). Designed to be pointed at a staging/self-hosted environment; the
> production rollout notes and known gaps are at the bottom.

## Contents

| File | Purpose |
|------|---------|
| `docker-compose.observability.yml` | OpenObserve + OTel Collector services |
| `otel-collector-config.yaml` | metrics scrape + logs tail + OTLP in → OpenObserve |

## Run

```bash
cd services/server/observability

# Credentials for the OpenObserve root user (change these).
export O2_ROOT_EMAIL=root@memwal.local
export O2_ROOT_PASSWORD='Complexpass#123'

# OTLP/HTTP Basic auth header value = base64("email:password").
export O2_AUTH=$(printf '%s' "$O2_ROOT_EMAIL:$O2_ROOT_PASSWORD" | base64)

# Where the relayer exposes /metrics (defaults to host.docker.internal:8000).
# Point this at your relayer or the main compose stack's published port.
export RELAYER_METRICS_TARGET=host.docker.internal:8000

docker compose -f docker-compose.observability.yml up -d
```

OpenObserve UI: <http://localhost:5080> (log in with `O2_ROOT_EMAIL` / `O2_ROOT_PASSWORD`).

Tear down: `docker compose -f docker-compose.observability.yml down` (add `-v` to wipe data).

## Ingestion

| Signal | Source | Path |
|--------|--------|------|
| **Metrics** | relayer Prometheus `/metrics` (`memwal_*`) | collector `prometheus` receiver → OTLP → OpenObserve |
| **Logs** | relayer/sidecar stdout with `LOG_FORMAT=json` | collector `file_log` (Docker json-file) → OpenObserve |
| **Traces** | none yet (see Gaps) | collector `otlp` receiver wired and ready |

Run the relayer and sidecar with `LOG_FORMAT=json` so the collector parses the
inner application JSON instead of opaque log lines.

### Quick ingestion smoke test (no relayer needed)

```bash
curl -X POST http://localhost:4318/v1/logs -H 'Content-Type: application/json' -d '{
  "resourceLogs":[{"scopeLogs":[{"logRecords":[{
    "timeUnixNano":"'$(date +%s)'000000000","severityText":"INFO",
    "body":{"stringValue":"poc test"}}]}]}]}'
# then query it back:
curl -u "$O2_ROOT_EMAIL:$O2_ROOT_PASSWORD" -X POST \
  "http://localhost:5080/api/default/_search" -H 'Content-Type: application/json' \
  -d '{"query":{"sql":"SELECT * FROM \"default\" ORDER BY _timestamp DESC","start_time":'$(( ($(date +%s)-600)*1000000 ))',"end_time":'$(( ($(date +%s)+60)*1000000 ))',"size":5}}'
```

## Dashboard — API health

OpenObserve runs PromQL over ingested Prometheus metrics. Create a dashboard
(Dashboards → New) with these panels. Metric labels are
`{method, route, status}` for HTTP metrics.

| Panel | PromQL |
|-------|--------|
| Request rate (req/s) | `sum(rate(memwal_http_requests_total[5m]))` |
| Request rate by route | `sum by (route) (rate(memwal_http_requests_total[5m]))` |
| Error rate (5xx %) | `sum(rate(memwal_http_requests_total{status=~"5.."}[5m])) / sum(rate(memwal_http_requests_total[5m]))` |
| p95 latency (s) | `histogram_quantile(0.95, sum by (le) (rate(memwal_http_request_duration_seconds_bucket[5m])))` |
| In-flight requests | `memwal_http_requests_in_flight` |
| Dependency failures | `sum by (service) (rate(memwal_external_request_duration_seconds_count{status!="200"}[5m]))` |
| Sidecar failures | `sum by (operation, reason) (rate(memwal_sidecar_failures_total[5m]))` |
| DB query p95 (s) | `histogram_quantile(0.95, sum by (le, operation) (rate(memwal_db_query_duration_seconds_bucket[5m])))` |
| DB pool by state | `memwal_db_pool_connections` |

## Alerts

Create under Alerts. Suggested PoC thresholds (tune per environment):

| Alert | Condition |
|-------|-----------|
| 5xx error-rate spike | `sum(rate(memwal_http_requests_total{status=~"5.."}[5m])) / sum(rate(memwal_http_requests_total[5m])) > 0.05` for 5m |
| p95 latency breach | `histogram_quantile(0.95, sum by (le) (rate(memwal_http_request_duration_seconds_bucket[5m]))) > 2` for 10m |
| Sidecar / Walrus failure | `sum(rate(memwal_sidecar_failures_total[5m])) > 0` |
| No telemetry received | `absent(memwal_http_requests_total)` for 5m |

## Production / staging rollout notes

- **Metrics**: keep the relayer `/metrics` endpoint reachable by the collector
  (private network). Set `RELAYER_METRICS_TARGET` to the staging relayer.
- **Logs on Railway**: the `file_log` receiver tails Docker json-file logs, which
  works for self-hosted / docker-compose. On Railway, forward logs via a Railway
  log drain (HTTP) into OpenObserve's `/api/<org>/<stream>/_json` ingest, or run
  the collector as a sidecar with access to the log stream.
- Set `LOG_FORMAT=json` on the relayer and sidecar.
- Replace the root credentials and pin image tags (this PoC uses `:latest`).

## Known gaps (follow-up)

1. **Traces**: the Rust relayer has no OpenTelemetry instrumentation, so no
   spans are emitted. The collector `traces` pipeline is wired; adding the
   `tracing-opentelemetry` layer + OTLP exporter to the relayer is the next step.
2. **Job-queue health**: there is no apalis/job-queue metric exposed today, so a
   queue-depth/in-flight dashboard isn't possible without adding one.
3. **External dependency status labels**: dependency failures are derived from
   `memwal_external_request_duration_seconds{status}` and
   `memwal_sidecar_failures_total`; per-dependency (Walrus vs OpenAI vs Sui)
   breakdown depends on the `service` label values the relayer emits.
