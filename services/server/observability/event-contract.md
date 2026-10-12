# Retrieval event contract

Status: proposal. ClickHouse and Statsig are not adopted. Do not build a second pipeline for this document.

Existing source: `retrieval_requests` and `retrieval_attempts` in migration `025_admin_measurements.sql`. Those rows can be exported later. They are not reconstructed history from before collection started.

| Field | Rule |
|---|---|
| event_id | Primary key already stored as `id`. |
| schema_version | Integer already stored. Current writer uses the relayer constant. |
| event_time | `completed_at`. |
| ingest_time | Database default when the row is inserted. Not backfilled. |
| environment | Deployment label. Not a Prometheus label with an account id. |
| operation / route / outcome | Controlled enums. `/api/recall` is the only route the writer records today. |
| duration_ms | Handler start to body encoding. Not time-to-headers and not client receipt. |
| relayer_body_bytes | Encoded JSON length. Not wire bytes, TLS, or provider billable egress. |
| upstream_bytes | Aggregator-to-relayer ingress when the request scope recorded it. |
| node_bytes | Written null. No storage-node correlation. |
| account | `owner` only when auth middleware supplied it. Never a Prometheus label. |
| delegate | Not stored on the request row today. |
| cache / retry / hedge | Columns exist for cache hits and misses. Retry and hedge counts are not written. |
| dedupe | `ON CONFLICT (id) DO NOTHING`. |
| retention | Not decided. Do not delete rows to make a dashboard look empty. |
| forbidden | Memory plaintext, ciphertext, credentials, raw error strings as metric labels. |

Node-to-aggregator percentiles stay unavailable until a provider exposes request-correlated telemetry. The 10 October 2026 storage report is a dated snapshot, not a substitute for these fields.
