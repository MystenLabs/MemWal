---
title: "k6 Stress Tests"
---

The relayer k6 harness lives in `services/server/scripts/k6/relayer.ts`.
It signs protected requests with the same canonical message as the Rust auth
middleware:

```text
{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}
```

The bundle sends `x-nonce`, `x-account-id`, and the legacy `x-delegate-key`
header so relayer-mode `recall`, `ask`, and `restore` can decrypt through SEAL
without needing SDK SessionKey construction inside k6.

## Build

```bash
cd services/server/scripts
npm ci
npm run k6:build
```

This writes `dist/k6/relayer.js`, which is the file k6 runs.

## Required Environment

| Variable | Notes |
| --- | --- |
| `MEMWAL_SERVER_URL` | Relayer base URL, for example `http://localhost:8000` |
| `MEMWAL_ACCOUNT_ID` | MemWal account object ID used by `x-account-id` |
| `MEMWAL_DELEGATE_KEY` | Ed25519 delegate key, as `suiprivkey`, 64-char hex, or `0x` hex |
| `MEMWAL_NAMESPACE` | Namespace to read/write. Defaults to `k6` |

The harness also accepts the existing benchmark variable names:
`BENCH_SERVER_URL`, `BENCH_ACCOUNT_ID`, and `BENCH_DELEGATE_KEY`.

## Profiles

Run from `services/server/scripts` after building:

```bash
# Health only, no auth required
K6_PROFILE=health k6 run dist/k6/relayer.js

# One end-to-end remember -> poll -> recall pass
K6_PROFILE=smoke \
MEMWAL_SERVER_URL=http://localhost:8000 \
MEMWAL_ACCOUNT_ID=0x... \
MEMWAL_DELEGATE_KEY=suiprivkey1... \
k6 run dist/k6/relayer.js

# Steady load. Defaults to 1 iteration/sec for 5 minutes.
K6_PROFILE=load K6_RATE=2 K6_DURATION=10m k6 run dist/k6/relayer.js

# Gradual ramp. Override stage rates/durations as needed.
K6_PROFILE=stress \
K6_STRESS_STAGE_1_RATE=2 \
K6_STRESS_STAGE_2_RATE=5 \
K6_STRESS_STAGE_3_RATE=10 \
k6 run dist/k6/relayer.js

# Sudden traffic burst.
K6_PROFILE=spike K6_SPIKE_RATE=30 k6 run dist/k6/relayer.js
```

The default `mixedFlow` is conservative:

| Flow | Default weight | Main bottlenecks exercised |
| --- | ---: | --- |
| `POST /api/recall` | `0.75` | query embedding, pgvector search, Walrus download/cache, SEAL decrypt |
| `POST /api/remember` + status polling | `0.25` | enqueue latency, background embedding, SEAL encrypt, Walrus upload, DB insert |
| `POST /api/ask` | `0` | recall path plus LLM completion |
| `POST /api/restore` | `0` | onchain blob query, Walrus download, SEAL decrypt, re-embedding, DB insert |

Enable expensive flows explicitly:

```bash
MEMWAL_ASK_WEIGHT=0.05 MEMWAL_RESTORE_WEIGHT=0.01 K6_PROFILE=load k6 run dist/k6/relayer.js
```

To isolate one endpoint family, set `K6_EXEC`:

```bash
K6_PROFILE=load K6_EXEC=recallOnly k6 run dist/k6/relayer.js
K6_PROFILE=load K6_EXEC=rememberOnly k6 run dist/k6/relayer.js
K6_PROFILE=load K6_EXEC=askOnly k6 run dist/k6/relayer.js
K6_PROFILE=load K6_EXEC=restoreOnly k6 run dist/k6/relayer.js
```

## Metrics

k6 already reports `http_req_duration`, `http_reqs`, `http_req_failed`, and
request throughput. The harness adds:

| Metric | Meaning |
| --- | --- |
| `memwal_remember_enqueue_duration` | Time for `POST /api/remember` to return `202` |
| `memwal_remember_worker_duration` | Time from enqueue to terminal remember job status |
| `memwal_recall_duration` | End-to-end `POST /api/recall` latency |
| `memwal_ask_duration` | End-to-end `POST /api/ask` latency |
| `memwal_restore_duration` | End-to-end `POST /api/restore` latency |
| `memwal_timeout_rate` | Requests or worker polls that timed out |
| `memwal_remember_job_failed_rate` | Remember jobs that ended failed or timed out |
| `memwal_http_errors` | HTTP status `0` or `>=400`, tagged by endpoint |

Thresholds include p95/p99 latency checks for health, remember enqueue, recall,
timeout rate, and remember job failure rate.

## Local Runs

For local capacity testing, start the relayer with the benchmark rate-limit
escape hatch so polling does not dominate the results:

```bash
RATE_LIMIT_DISABLED=1 cargo run --release
```

Use this only on local benchmark instances. Keep normal rate limits enabled for
shared staging unless the environment is isolated for a run.

## Staging Runs

Use the existing benchmark secrets:

```bash
cd services/server/scripts
npm run k6:build

BENCH_SERVER_URL=https://relayer.staging.memwal.ai \
BENCH_ACCOUNT_ID="$BENCH_ACCOUNT_ID" \
BENCH_DELEGATE_KEY="$BENCH_DELEGATE_KEY" \
MEMWAL_NAMESPACE=benchmark \
K6_PROFILE=smoke \
k6 run dist/k6/relayer.js
```

Before running load, stress, or spike against staging, seed the namespace with
several memories and agree on rate limits for OpenAI, SEAL, Walrus, and Sui RPC.
For recall-only tests, a namespace with no memories still exercises query
embedding and pgvector search, but it does not exercise Walrus download or SEAL
decrypt.

## RPC Self-Hosting

The Rust relayer honors `SUI_RPC_URL`; the sidecar now uses the same env var
before falling back to `getJsonRpcFullnodeUrl(SUI_NETWORK)`. If public Sui RPC is
blocked or rate-limited, self-hosting is viable as long as the relayer and
sidecar are both configured with the same private or paid RPC endpoint:

```bash
SUI_NETWORK=testnet
SUI_RPC_URL=https://your-sui-fullnode.example.com
```

Walrus publisher, aggregator, and upload relay are separate from Sui RPC. If
those endpoints are blocked too, override `WALRUS_PUBLISHER_URL`,
`WALRUS_AGGREGATOR_URL`, and `WALRUS_UPLOAD_RELAY_URL` separately.
