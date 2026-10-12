# Relayer alert runbooks

Thresholds in `alerts.example.yml` are provisional. No external notification is enabled.

## scrape-missing

`absent(memwal_http_requests_total)` means the scrape target is gone or the process did not register metrics. It does not mean the product had no users.

Check the collector target, the `/metrics` response, and whether the relayer process is running. Recover by restoring the scrape or the process. Clear the alert when the series is present again.

## http-5xx

The ratio ignores windows with almost no traffic. Confirm the status label is the HTTP status, then read recent 5xx routes. Recover when the 5xx ratio stays under the threshold for the evaluation window.

## sidecar

`memwal_sidecar_failures_total` was present on the dev scrape on 2026-10-12. A non-zero rate means the sidecar client is failing. Recover when the rate returns to zero. Do not treat this as retrieval-byte loss.

## not-yet-collected

These were requested and were not in the 2026-10-12 dev scrape, so they have no alert:

- Queue depth and oldest queued-job age.
- Worker heartbeat.
- Collector write-failure counter.
- Inventory snapshot freshness.
- Cache, retry, and hedge counters.

Do not alert on a percentile until the histogram has samples. `histogram_quantile` on an empty bucket set is not a latency incident.
